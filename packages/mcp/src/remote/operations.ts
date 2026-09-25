import {
  FeedbackRequestSchema,
  FireFinderError,
  SearchRequestSchema,
  SolutionRefSchema,
  SubmitSolutionRequestSchema,
  validateRequest,
  type Actor,
  type FeedbackRequestInput,
  type FeedbackResponse,
  type FireFinderService,
  type Logger,
  type RateLimiter,
  type RateLimitRule,
  type SearchRequestInput,
  type SearchResponse,
  type Solution,
  type SubmitResponse,
  type SubmitSolutionRequestInput,
} from '@firefinder/core';
import type { FireFinderOperations } from '../server.ts';

export const SCOPES = { read: 'firefinder:read', write: 'firefinder:write' } as const;

/** The authenticated caller of the remote MCP endpoint: an anonymous identity and its granted scopes. */
export interface McpIdentity {
  subject: string;
  scopes: string[];
}

export interface ServiceOperationsDeps {
  service: FireFinderService;
  identity: McpIdentity;
  rateLimiter: RateLimiter;
  limits: { read: RateLimitRule; write: RateLimitRule };
  logger?: Logger;
}

/**
 * FireFinder operations for the remote MCP endpoint, running in-process on
 * the same service as the REST API (no extra network hop). Every call goes
 * through the same validation, privacy filtering and ranking, plus:
 *   - scope checks (firefinder:read / firefinder:write),
 *   - per-identity rate limits,
 *   - the identity as the anonymous voter (one vote per identity).
 * Nothing else is reachable: no moderation, no raw database access.
 */
export class ServiceOperations implements FireFinderOperations {
  readonly #deps: ServiceOperationsDeps;
  readonly #actor: Actor;

  constructor(deps: ServiceOperationsDeps) {
    this.#deps = deps;
    this.#actor = { keyId: 'mcp', clientId: deps.identity.subject };
  }

  async search(request: SearchRequestInput): Promise<SearchResponse> {
    await this.#guard('read');
    return this.#deps.service.search(validateRequest(SearchRequestSchema, request));
  }

  async get(ref: string | number): Promise<Solution> {
    await this.#guard('read');
    return this.#deps.service.get(validateRequest(SolutionRefSchema, String(ref)));
  }

  async submit(request: SubmitSolutionRequestInput): Promise<SubmitResponse> {
    await this.#guard('write');
    return this.#deps.service.submit(validateRequest(SubmitSolutionRequestSchema, request), this.#actor);
  }

  async confirm(ref: string | number, request: FeedbackRequestInput = {}): Promise<FeedbackResponse> {
    await this.#guard('write');
    const id = validateRequest(SolutionRefSchema, String(ref));
    return this.#deps.service.confirm(id, validateRequest(FeedbackRequestSchema, request), this.#actor);
  }

  async report(ref: string | number, request: FeedbackRequestInput = {}): Promise<FeedbackResponse> {
    await this.#guard('write');
    const id = validateRequest(SolutionRefSchema, String(ref));
    return this.#deps.service.report(id, validateRequest(FeedbackRequestSchema, request), this.#actor);
  }

  async #guard(kind: 'read' | 'write'): Promise<void> {
    const { identity, rateLimiter, limits, logger } = this.#deps;
    if (!identity.scopes.includes(SCOPES[kind])) {
      throw new FireFinderError(403, 'forbidden', `This connection was not granted the ${SCOPES[kind]} scope.`);
    }
    const rule = limits[kind];
    try {
      const [decision] = await rateLimiter.hit([{ key: `mcp:${kind}:${identity.subject}`, limit: rule.limit }], rule.windowSeconds);
      if (decision && !decision.allowed) {
        throw new FireFinderError(429, 'rate_limited', `Too many FireFinder requests; try again in ${decision.resetSeconds}s.`);
      }
    } catch (error) {
      if (error instanceof FireFinderError) throw error;
      // Fail open, like the REST API: a limiter outage should not break search.
      logger?.warn('rate limiter unavailable', { error: String(error) });
    }
  }
}
