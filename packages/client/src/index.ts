import type {
  FeedbackRequestInput,
  FeedbackResponse,
  SearchRequestInput,
  SearchResponse,
  Solution,
  SubmitResponse,
  SubmitSolutionRequestInput,
} from '@firefinder/core';

export type {
  FeedbackRequestInput,
  FeedbackResponse,
  SearchRequestInput,
  SearchResponse,
  SearchResult,
  Solution,
  SubmitResponse,
  SubmitSolutionRequestInput,
} from '@firefinder/core';

export interface FireFinderClientOptions {
  /** e.g. http://localhost:8787 or https://<ref>.supabase.co/functions/v1/firefinder */
  baseUrl: string;
  apiKey: string;
  /** Random per-install identifier; lets the server count one vote per install without knowing who you are. */
  clientId?: string;
  /**
   * Supabase Edge Functions only: run the API in this region (e.g. "ap-southeast-1"),
   * normally the database's region, so each database round trip stays local.
   */
  region?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  userAgent?: string;
}

export class FireFinderApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'FireFinderApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Minimal typed client for the FireFinder HTTP API. Every integration (Claude
 * via MCP today; ChatGPT, browser extensions and other assistants later) talks
 * to the same API through this client.
 */
export class FireFinderClient {
  readonly #baseUrl: string;
  readonly #options: FireFinderClientOptions;
  readonly #fetch: typeof fetch;

  constructor(options: FireFinderClientOptions) {
    if (!options.baseUrl) throw new Error('FireFinder baseUrl is required');
    if (!options.apiKey) throw new Error('FireFinder apiKey is required');
    this.#options = options;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  search(request: SearchRequestInput): Promise<SearchResponse> {
    return this.#call('POST', '/search', request);
  }

  submit(request: SubmitSolutionRequestInput): Promise<SubmitResponse> {
    return this.#call('POST', '/solutions', request);
  }

  async get(ref: string | number): Promise<Solution> {
    const body = await this.#call<{ solution: Solution }>('GET', `/solutions/${encodeURIComponent(String(ref))}`);
    return body.solution;
  }

  confirm(ref: string | number, request: FeedbackRequestInput = {}): Promise<FeedbackResponse> {
    return this.#call('POST', `/solutions/${encodeURIComponent(String(ref))}/confirm`, request);
  }

  report(ref: string | number, request: FeedbackRequestInput = {}): Promise<FeedbackResponse> {
    return this.#call('POST', `/solutions/${encodeURIComponent(String(ref))}/report`, request);
  }

  health(): Promise<{ status: string; version: string; embedding_model: string }> {
    return this.#call('GET', '/health');
  }

  async #call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      // X-API-Key (not Authorization) so it never collides with a gateway's own auth header.
      'x-api-key': this.#options.apiKey,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.#options.clientId) headers['x-firefinder-client'] = this.#options.clientId;
    if (this.#options.region) headers['x-region'] = this.#options.region;
    if (this.#options.userAgent) headers['user-agent'] = this.#options.userAgent;

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#options.timeoutMs ?? 15_000),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'is unreachable';
      throw new FireFinderApiError(0, 'network_error', `FireFinder API at ${this.#baseUrl} ${reason}.`);
    }

    const text = await response.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // fall through: non-JSON body
    }
    if (!response.ok) {
      const error = json?.error;
      throw new FireFinderApiError(
        response.status,
        error?.code ?? 'http_error',
        error?.message ?? `FireFinder API returned HTTP ${response.status}.`,
        error?.details,
      );
    }
    return json as T;
  }
}
