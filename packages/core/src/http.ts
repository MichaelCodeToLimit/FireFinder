import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import { ApiKeyAuthenticator, extractApiKey, hasScope } from './auth.ts';
import { FIREFINDER_VERSION, type ApiScope } from './constants.ts';
import { FireFinderError, type ErrorCode } from './errors.ts';
import {
  DEFAULT_RATE_LIMITS,
  type RateLimitCheck,
  type RateLimitDecision,
  type RateLimiter,
  type RateLimitPolicy,
} from './rate-limit.ts';
import {
  FeedbackRequestSchema,
  ListSolutionsQuerySchema,
  SearchRequestSchema,
  SolutionRefSchema,
  StatusUpdateRequestSchema,
  SubmitSolutionRequestSchema,
} from './schemas.ts';
import type { Actor, FireFinderService } from './service.ts';
import type { ApiKeyRecord } from './store.ts';

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Structured JSON logs. Request bodies are never logged. */
export const consoleLogger: Logger = {
  info: (msg, meta) => console.log(JSON.stringify({ level: 'info', msg, ...meta })),
  warn: (msg, meta) => console.warn(JSON.stringify({ level: 'warn', msg, ...meta })),
  error: (msg, meta) => console.error(JSON.stringify({ level: 'error', msg, ...meta })),
};

export interface AppOptions {
  service: FireFinderService;
  authenticator: ApiKeyAuthenticator;
  rateLimiter: RateLimiter;
  rateLimits?: Partial<RateLimitPolicy>;
  /** Browser origins allowed to call the API. Default: none (same-origin only). */
  corsOrigins?: string[];
  /** Resolves the caller's IP for per-IP rate limits; return null when unknown. */
  clientIp?: (c: Context) => string | null | Promise<string | null>;
  logger?: Logger;
  maxBodyBytes?: number;
}

export type AppEnv = {
  Variables: {
    apiKey: ApiKeyRecord;
    clientId: string | null;
  };
};

/** Random per-install identifier sent by integrations (never tied to a person). */
const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function errorBody(code: ErrorCode, message: string, details?: unknown) {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

export function createApp(options: AppOptions): Hono<AppEnv> {
  const { service } = options;
  const limits: RateLimitPolicy = { ...DEFAULT_RATE_LIMITS, ...options.rateLimits };
  const logger = options.logger ?? consoleLogger;
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    const started = performance.now();
    await next();
    c.header('Server-Timing', `app;dur=${(performance.now() - started).toFixed(1)}`, { append: true });
  });
  app.use('*', secureHeaders());
  if (options.corsOrigins?.length) {
    app.use(
      '*',
      cors({
        origin: options.corsOrigins,
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Authorization', 'X-API-Key', 'Content-Type', 'X-FireFinder-Client'],
        maxAge: 600,
      }),
    );
  }
  app.use(
    '*',
    bodyLimit({
      maxSize: options.maxBodyBytes ?? 64 * 1024,
      onError: (c) => c.json(errorBody('payload_too_large', 'Request body is too large.'), 413),
    }),
  );

  const requireKey =
    (scope: ApiScope): MiddlewareHandler<AppEnv> =>
    async (c, next) => {
      const raw = extractApiKey({ authorization: c.req.header('authorization'), apiKey: c.req.header('x-api-key') });
      if (!raw) throw new FireFinderError(401, 'unauthorized', 'Missing API key. Send "Authorization: Bearer <key>".');
      const started = performance.now();
      const key = await options.authenticator.authenticate(raw);
      c.header('Server-Timing', `auth;dur=${(performance.now() - started).toFixed(1)}`, { append: true });
      if (!key) throw new FireFinderError(401, 'unauthorized', 'Invalid or revoked API key.');
      if (!hasScope(key, scope)) throw new FireFinderError(403, 'forbidden', `This API key lacks the "${scope}" scope.`);

      const clientId = c.req.header('x-firefinder-client') ?? null;
      if (clientId !== null && !CLIENT_ID.test(clientId)) {
        throw new FireFinderError(400, 'invalid_request', 'X-FireFinder-Client must be 8-64 characters of [A-Za-z0-9_-].');
      }
      c.set('apiKey', key);
      c.set('clientId', clientId);
      await next();
    };

  const rateLimit =
    (bucket: 'read' | 'write'): MiddlewareHandler<AppEnv> =>
    async (c, next) => {
      const rule = limits[bucket];
      const checks: RateLimitCheck[] = [
        { key: `${bucket}:client:${c.get('apiKey').id}:${c.get('clientId') ?? '-'}`, limit: rule.limit },
      ];
      const ip = await options.clientIp?.(c);
      if (ip) checks.push({ key: `${bucket}:ip:${ip}`, limit: rule.limit * limits.perIpMultiplier });

      let decisions: RateLimitDecision[];
      const started = performance.now();
      try {
        decisions = await options.rateLimiter.hit(checks, rule.windowSeconds);
        c.header('Server-Timing', `ratelimit;dur=${(performance.now() - started).toFixed(1)}`, { append: true });
      } catch (error) {
        // Fail open: a limiter outage should not take search down with it.
        logger.warn('rate limiter unavailable', { error: String(error) });
        return next();
      }
      const denied = decisions.find((decision) => !decision.allowed);
      const shown = denied ?? decisions.reduce((a, b) => (b.remaining < a.remaining ? b : a));
      c.header('RateLimit-Limit', String(shown.limit));
      c.header('RateLimit-Remaining', String(shown.remaining));
      c.header('RateLimit-Reset', String(shown.resetSeconds));
      if (denied) {
        c.header('Retry-After', String(denied.resetSeconds));
        throw new FireFinderError(429, 'rate_limited', 'Too many requests. Please retry later.');
      }
      await next();
    };

  const actorOf = (c: Context<AppEnv>): Actor => ({ keyId: c.get('apiKey').id, clientId: c.get('clientId') });
  const isAdmin = (c: Context<AppEnv>) => c.get('apiKey').scopes.includes('admin');

  app.get('/health', (c) =>
    c.json({ status: 'ok', service: 'firefinder', version: FIREFINDER_VERSION, embedding_model: service.embeddingModel }),
  );

  app.post('/search', requireKey('read'), rateLimit('read'), async (c) => {
    const request = validate(SearchRequestSchema, await readJson(c));
    const response = await service.search(request, (stage, ms) =>
      c.header('Server-Timing', `${stage};dur=${ms.toFixed(1)}`, { append: true }),
    );
    return c.json(response);
  });

  app.post('/solutions', requireKey('write'), rateLimit('write'), async (c) => {
    const request = validate(SubmitSolutionRequestSchema, await readJson(c));
    const result = await service.submit(request, actorOf(c));
    return c.json(result, result.outcome === 'created' ? 201 : 200);
  });

  app.get('/solutions', requireKey('read'), rateLimit('read'), async (c) => {
    const query = validate(ListSolutionsQuerySchema, c.req.query());
    return c.json({ solutions: await service.list(query, { includeDisabled: isAdmin(c) }) });
  });

  app.get('/solutions/:id', requireKey('read'), rateLimit('read'), async (c) => {
    const ref = validate(SolutionRefSchema, c.req.param('id'));
    return c.json({ solution: await service.get(ref, { includeDisabled: isAdmin(c) }) });
  });

  app.post('/solutions/:id/confirm', requireKey('write'), rateLimit('write'), async (c) => {
    const ref = validate(SolutionRefSchema, c.req.param('id'));
    const request = validate(FeedbackRequestSchema, await readJson(c, { allowEmpty: true }));
    return c.json(await service.confirm(ref, request, actorOf(c)));
  });

  app.post('/solutions/:id/report', requireKey('write'), rateLimit('write'), async (c) => {
    const ref = validate(SolutionRefSchema, c.req.param('id'));
    const request = validate(FeedbackRequestSchema, await readJson(c, { allowEmpty: true }));
    return c.json(await service.report(ref, request, actorOf(c)));
  });

  // Moderation hook: hide (disabled), flag (under_review) or restore (active).
  app.post('/admin/solutions/:id/status', requireKey('admin'), rateLimit('write'), async (c) => {
    const ref = validate(SolutionRefSchema, c.req.param('id'));
    const { status } = validate(StatusUpdateRequestSchema, await readJson(c));
    return c.json({ solution: await service.setStatus(ref, status) });
  });

  app.notFound((c) => c.json(errorBody('not_found', 'Route not found.'), 404));

  app.onError((error, c) => {
    if (error instanceof FireFinderError) {
      return c.json(errorBody(error.code, error.message, error.details), error.status as ContentfulStatusCode);
    }
    if (error instanceof HTTPException) {
      return c.json(errorBody(error.status === 413 ? 'payload_too_large' : 'invalid_request', error.message), error.status);
    }
    logger.error('unhandled error', {
      method: c.req.method,
      path: c.req.path,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    return c.json(errorBody('internal_error', 'Internal server error.'), 500);
  });

  return app;
}

async function readJson(c: Context, options: { allowEmpty?: boolean } = {}): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) {
    if (options.allowEmpty) return {};
    throw new FireFinderError(400, 'invalid_json', 'Request body must be a JSON object.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new FireFinderError(400, 'invalid_json', 'Request body is not valid JSON.');
  }
}

function validate<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new FireFinderError(
      400,
      'invalid_request',
      'Request validation failed.',
      result.error.issues.map((issue) => ({ path: issue.path.join('.') || '(root)', message: issue.message })),
    );
  }
  return result.data;
}

/** Validates input against a request schema, throwing a 400 FireFinderError with field details. */
export { validate as validateRequest };
