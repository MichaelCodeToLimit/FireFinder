import { Hono, type Context } from 'hono';
import {
  ApiKeyAuthenticator,
  CachedEmbedder,
  createApp,
  errorBody,
  FireFinderService,
  PostgresStore,
  StoreRateLimiter,
  type Embedder,
  type Logger,
  type SqlClient,
} from '@firefinder/core';
import { createRemoteMcpApp, PostgresOAuthStore, TokenSigner } from '@firefinder/mcp/remote';

export interface EdgeEnv {
  get(name: string): string | undefined;
}

export interface EdgeDeps {
  env: EdgeEnv;
  embedder: Embedder;
  /** Creates the SQL client for the given connection string. */
  connect(databaseUrl: string): SqlClient;
  /** Path the function is served under: /functions/v1/<name> reaches the function as /<name>. */
  basePath?: string;
  logger?: Logger;
}

/** Header carrying the original caller's IP when a request is forwarded to the database region. */
export const FORWARDED_HEADER = 'x-firefinder-forwarded';

/** Public URL of the function: where OAuth metadata and the MCP endpoint are advertised. */
export function edgePublicUrl(env: EdgeEnv, functionName = 'firefinder'): string | null {
  const explicit = env.get('FIREFINDER_PUBLIC_URL');
  if (explicit) return explicit.replace(/\/+$/, '');
  const supabaseUrl = env.get('SUPABASE_URL');
  return supabaseUrl ? `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/${functionName}` : null;
}

/** Secret for OAuth tokens. Defaults to the voter secret; keys are domain-separated per purpose. */
function oauthSecret(env: EdgeEnv): string | undefined {
  return env.get('FIREFINDER_OAUTH_SECRET') ?? env.get('FIREFINDER_VOTER_SECRET');
}

/**
 * The FireFinder API as it runs on Supabase Edge Functions: same core app as
 * the Node server, with a database-backed rate limiter (instances are
 * short-lived and many) and the platform's built-in gte-small embeddings.
 * Also serves the remote MCP endpoint for claude.ai and Claude mobile.
 * Kept free of Deno globals so it can be tested under Node.
 */
export function createEdgeApp(deps: EdgeDeps): Hono {
  const { env } = deps;
  const root = new Hono();
  root.notFound((c) => c.json(errorBody('not_found', 'Route not found.'), 404));
  // Which region handled the request (shows whether region forwarding happened).
  const region = env.get('SB_REGION');
  if (region) {
    root.use('*', async (c, next) => {
      await next();
      c.header('x-firefinder-region', region);
    });
  }

  const databaseUrl = env.get('FIREFINDER_DATABASE_URL') ?? env.get('SUPABASE_DB_URL');
  const voterSecret = env.get('FIREFINDER_VOTER_SECRET');
  const missing = [
    !databaseUrl && 'SUPABASE_DB_URL',
    (!voterSecret || voterSecret.length < 16) && 'FIREFINDER_VOTER_SECRET (16+ characters)',
  ].filter(Boolean);
  if (missing.length > 0 || !databaseUrl || !voterSecret) {
    root.all('*', (c) =>
      c.json(errorBody('internal_error', `FireFinder is not configured. Missing secret(s): ${missing.join(', ')}.`), 503),
    );
    return root;
  }

  const sql = deps.connect(databaseUrl);
  const store = new PostgresStore(sql);
  const service = new FireFinderService({
    store,
    embedder: new CachedEmbedder(deps.embedder, 500),
    config: { voterSecret },
  });
  const rateLimiter = new StoreRateLimiter(store, voterSecret);
  const perMinute = (name: string, fallback: number) => {
    const value = Number(env.get(name));
    return Number.isInteger(value) && value > 0 ? value : fallback;
  };
  const forwardedIps = new TokenSigner(oauthSecret(env)!);
  const clientIp = async (c: Context) => callerIp(c.req.raw.headers, forwardedIps);

  const api = createApp({
    service,
    authenticator: new ApiKeyAuthenticator(store),
    rateLimiter,
    rateLimits: {
      read: { limit: perMinute('RATE_LIMIT_READ_PER_MINUTE', 60), windowSeconds: 60 },
      write: { limit: perMinute('RATE_LIMIT_WRITE_PER_MINUTE', 20), windowSeconds: 60 },
    },
    corsOrigins: (env.get('CORS_ORIGINS') ?? '').split(',').map((o) => o.trim()).filter(Boolean),
    clientIp: (c) => clientIp(c),
    logger: deps.logger,
  });

  const basePath = deps.basePath ?? '/firefinder';
  root.route(basePath, api);

  const publicUrl = edgePublicUrl(env, basePath.replace(/^\//, ''));
  if (publicUrl) {
    root.route(
      basePath,
      createRemoteMcpApp({
        service,
        oauthStore: new PostgresOAuthStore(sql),
        rateLimiter,
        publicUrl,
        secret: oauthSecret(env)!,
        clientIp,
        logger: deps.logger,
        config: {
          readPerMinute: perMinute('MCP_READ_PER_MINUTE', 60),
          writePerMinute: perMinute('MCP_WRITE_PER_MINUTE', 20),
          identitiesPerIpPerHour: perMinute('MCP_IDENTITIES_PER_IP_PER_HOUR', 10),
        },
      }),
    );
  } else {
    deps.logger?.warn('remote MCP disabled: set SUPABASE_URL or FIREFINDER_PUBLIC_URL');
  }
  return root;
}

/**
 * The caller's IP: taken from a signed forwarding header when this request was
 * forwarded by another FireFinder instance, otherwise from X-Forwarded-For
 * (set by Supabase's gateway).
 */
export async function verifiedForwardedIp(headers: Headers, signer: TokenSigner, nowMs = Date.now()): Promise<string | null> {
  const value = headers.get(FORWARDED_HEADER);
  if (!value) return null;
  const payload = await signer.verify<{ ip: string; t: number }>('fwd_', 'forwarded-ip', value);
  if (!payload || typeof payload.ip !== 'string' || Math.abs(nowMs - payload.t) > 60_000) return null;
  return payload.ip;
}

async function callerIp(headers: Headers, signer: TokenSigner): Promise<string | null> {
  const forwarded = await verifiedForwardedIp(headers, signer);
  return forwarded || headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
}

// -----------------------------------------------------------------------------
// Region forwarding
// -----------------------------------------------------------------------------

export interface RegionForwardingOptions {
  /** Region of the database (e.g. ap-southeast-1). Forwarding is off when unset. */
  databaseRegion: string | undefined;
  /** Region this instance runs in (Supabase sets SB_REGION). */
  currentRegion: string | undefined;
  /** Public URL of this function, e.g. https://<ref>.supabase.co/functions/v1/firefinder. */
  publicUrl: string;
  /** Path prefix of the function inside the runtime (e.g. /firefinder). */
  basePath: string;
  signer: TokenSigner;
  fetch: typeof fetch;
  now?: () => number;
}

/** True for requests that do database work (worth running next to the database). */
export function needsDatabase(method: string, path: string, body: string | undefined): boolean {
  if (path.startsWith('/.well-known/') || path === '/health' || path === '/oauth/register' || method === 'OPTIONS') return false;
  if (path === '/mcp') {
    if (method !== 'POST' || !body) return false;
    try {
      const message = JSON.parse(body) as unknown;
      const messages = Array.isArray(message) ? message : [message];
      // initialize, tools/list and notifications need no database: answer them locally.
      return messages.some((m) => (m as { method?: unknown } | null)?.method === 'tools/call');
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Runs database-bound requests in the database's region. Supabase runs a
 * function close to the *caller* (for claude.ai: Anthropic's servers); every
 * database round trip then crosses continents. One forwarded hop is much
 * cheaper than several cross-region round trips. Returns the forwarded
 * response, or a request to handle locally. Never forwards twice.
 */
export async function routeByRegion(request: Request, options: RegionForwardingOptions): Promise<Response | Request> {
  const now = options.now ?? Date.now;
  // Already forwarded once: handle here, never forward again. (Its caller-IP
  // claim is only trusted if the signature verifies; see callerIp.)
  if (request.headers.has(FORWARDED_HEADER)) return request;
  const { databaseRegion, currentRegion } = options;
  if (!databaseRegion || !currentRegion || databaseRegion === currentRegion) return request;

  const url = new URL(request.url);
  const path = url.pathname.startsWith(options.basePath) ? url.pathname.slice(options.basePath.length) || '/' : url.pathname;
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
  if (!needsDatabase(request.method, path, body)) {
    return new Request(request.url, { method: request.method, headers: request.headers, body });
  }

  const headers = new Headers(request.headers);
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
  headers.set(FORWARDED_HEADER, await options.signer.sign('fwd_', 'forwarded-ip', { ip, t: now() }));
  headers.set('x-region', databaseRegion);
  headers.set('accept-encoding', 'identity');
  headers.delete('host');
  headers.delete('content-length');
  const local = () => new Request(request.url, { method: request.method, headers: request.headers, body });
  try {
    const response = await options.fetch(`${options.publicUrl}${path}${url.search}`, {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
    });
    // Forwarding is only an optimization: if the platform could not run the
    // forwarded request (cold boot, capacity, network), handle it here instead.
    if (PLATFORM_FAILURES.has(response.status)) return local();
    return response;
  } catch {
    return local();
  }
}

/** Gateway/runtime statuses meaning the forwarded function did not handle the request. */
const PLATFORM_FAILURES = new Set([502, 503, 504, 546]);
