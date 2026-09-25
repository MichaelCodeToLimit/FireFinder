export type ErrorCode =
  | 'invalid_request'
  | 'invalid_json'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'payload_too_large'
  | 'rate_limited'
  | 'internal_error';

/** An error that is safe to show to API clients. */
export class FireFinderError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'FireFinderError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (message = 'Solution not found') => new FireFinderError(404, 'not_found', message);
