import type { ApiScope, FeedbackResult, SolutionStatus } from './constants.ts';
import type { Solution } from './schemas.ts';

/** A solution plus the normalized metadata used internally for matching. */
export interface SolutionRecord extends Solution {
  software_key: string | null;
  os_family: string | null;
  os_version: string | null;
  version_major: string | null;
  error_signature: string[];
}

export interface CandidateRecord extends SolutionRecord {
  similarity: number;
  solution_similarity: number | null;
  error_overlap: number;
}

export interface NewSolution {
  id: string;
  problem: string;
  solution: string;
  software: string | null;
  operating_system: string | null;
  software_version: string | null;
  error_message: string | null;
  software_key: string | null;
  os_family: string | null;
  os_version: string | null;
  version_major: string | null;
  error_signature: string[];
  embedding: number[];
  solution_embedding: number[];
  embedding_model: string;
  source: string | null;
}

export interface Vote {
  result: FeedbackResult;
  /** HMAC of an anonymous voter identity; null when unknown. */
  voterHash: string | null;
  operatingSystem?: string | null;
  softwareVersion?: string | null;
  note?: string | null;
}

export interface ModerationPolicy {
  /** Minimum failure reports before a solution can be flagged for review. */
  minFailures: number;
  /** Share of failure reports (0..1) at which it is flagged. */
  failureRatio: number;
}

export type FeedbackOutcome = 'recorded' | 'changed' | 'duplicate' | 'not_found';

export interface ApiKeyRecord {
  id: string;
  name: string;
  key_prefix: string;
  scopes: ApiScope[];
  revoked_at: string | null;
}

export type SolutionRef = { id: string } | { fireNumber: number };

/**
 * Persistence boundary. The PostgreSQL implementation lives in
 * postgres-store.ts; anything that satisfies this interface (another database,
 * a future community mirror) can back the same API.
 */
export interface SolutionStore {
  searchCandidates(query: {
    embedding: number[];
    errorSignature: string[];
    limit: number;
    solutionEmbedding?: number[];
  }): Promise<CandidateRecord[]>;
  insertSolution(solution: NewSolution, initialVote: Vote | null): Promise<SolutionRecord>;
  getSolution(ref: SolutionRef): Promise<SolutionRecord | null>;
  recordFeedback(solutionId: string, vote: Vote, moderation: ModerationPolicy): Promise<FeedbackOutcome>;
  listSolutions(query: {
    limit: number;
    before?: number;
    status?: SolutionStatus;
    includeDisabled: boolean;
  }): Promise<SolutionRecord[]>;
  setStatus(id: string, status: SolutionStatus): Promise<SolutionRecord | null>;

  findApiKeyByHash(keyHash: string): Promise<ApiKeyRecord | null>;
  touchApiKey(id: string): Promise<void>;
  createApiKey(input: { name: string; keyPrefix: string; keyHash: string; scopes: ApiScope[] }): Promise<ApiKeyRecord>;

  /** Increments each key's counter in the current fixed window; returns the counts in input order. */
  rateLimitHits(keys: string[], windowSeconds: number): Promise<number[]>;
}
