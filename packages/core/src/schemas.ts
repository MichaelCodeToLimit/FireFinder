import * as z from 'zod';
import { LIMITS, SOLUTION_STATUSES, type SolutionStatus, type VerificationStatus } from './constants.ts';
import { sanitizeText } from './privacy.ts';

// Every text field is sanitized (control characters, invisible characters,
// whitespace) *before* its length is validated, so limits apply to what we store.

const multilineText = (min: number, max: number) =>
  z
    .string()
    .max(max * 2)
    .transform((value) => sanitizeText(value, { multiline: true }))
    .pipe(z.string().min(min).max(max));

const optionalLine = (max: number) =>
  z
    .string()
    .max(max * 2)
    .nullish()
    .transform((value) => (value == null ? undefined : sanitizeText(value, { multiline: false }) || undefined))
    .pipe(z.string().max(max).optional());

const optionalMultiline = (max: number) =>
  z
    .string()
    .max(max * 2)
    .nullish()
    .transform((value) => (value == null ? undefined : sanitizeText(value, { multiline: true }) || undefined))
    .pipe(z.string().max(max).optional());

const environmentFields = {
  software: optionalLine(LIMITS.software),
  operating_system: optionalLine(LIMITS.operatingSystem),
  software_version: optionalLine(LIMITS.softwareVersion),
  error_message: optionalMultiline(LIMITS.errorMessage),
};

export const SearchRequestSchema = z.strictObject({
  problem: multilineText(LIMITS.searchProblem.min, LIMITS.searchProblem.max),
  ...environmentFields,
  limit: z.number().int().min(1).max(20).optional(),
  min_similarity: z.number().min(0).max(1).optional(),
  /** Only return solutions at least one person confirmed (the AI integrations use this). */
  verified_only: z.boolean().optional(),
});
export type SearchRequest = z.output<typeof SearchRequestSchema>;
export type SearchRequestInput = z.input<typeof SearchRequestSchema>;

export const SubmitSolutionRequestSchema = z.strictObject({
  problem: multilineText(LIMITS.problem.min, LIMITS.problem.max),
  solution: multilineText(LIMITS.solution.min, LIMITS.solution.max),
  ...environmentFields,
  /**
   * Must be explicit. `true` only when the user confirmed the fix worked; the
   * solution is then stored as verified with one confirmation. `false` stores
   * an unverified candidate.
   */
  worked: z.boolean(),
  source: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,39}$/, 'source must be a short lowercase identifier like "claude-mcp"')
    .optional(),
});
export type SubmitSolutionRequest = z.output<typeof SubmitSolutionRequestSchema>;
export type SubmitSolutionRequestInput = z.input<typeof SubmitSolutionRequestSchema>;

export const FeedbackRequestSchema = z.strictObject({
  operating_system: optionalLine(LIMITS.operatingSystem),
  software_version: optionalLine(LIMITS.softwareVersion),
  note: optionalMultiline(LIMITS.note),
});
export type FeedbackRequest = z.output<typeof FeedbackRequestSchema>;
export type FeedbackRequestInput = z.input<typeof FeedbackRequestSchema>;

export const StatusUpdateRequestSchema = z.strictObject({
  status: z.enum(SOLUTION_STATUSES),
});

export const ListSolutionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  before: z.coerce.number().int().positive().optional(),
  status: z.enum(SOLUTION_STATUSES).optional(),
});

/** Solution id in a URL: a UUID or a FIRE number ("18492"). */
export const SolutionRefSchema = z.union([
  z.uuid(),
  z.string().regex(/^[1-9][0-9]{0,15}$/, 'expected a solution UUID or FIRE number'),
]);

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface Solution {
  id: string;
  fire_number: number;
  problem: string;
  solution: string;
  software: string | null;
  operating_system: string | null;
  software_version: string | null;
  error_message: string | null;
  confirmation_count: number;
  failure_count: number;
  status: SolutionStatus;
  verification_status: VerificationStatus;
  created_at: string;
  updated_at: string;
  last_confirmed_at: string | null;
  last_failed_at: string | null;
}

/**
 * match: same value. partial: compatible but less specific (same OS family with
 * an unknown version, same major version). different_version: same product,
 * different version. mismatch: different product/OS. unknown: not specified.
 */
export type MatchLevel = 'match' | 'partial' | 'different_version' | 'mismatch' | 'unknown';

export interface EnvironmentMatch {
  software: MatchLevel;
  operating_system: MatchLevel;
  software_version: MatchLevel;
}

export interface SearchResult extends Solution {
  /** Cosine similarity between the query and the stored problem (0..1). */
  similarity: number;
  /** Final ranking score; see docs/RANKING.md. */
  score: number;
  environment_match: EnvironmentMatch;
}

export interface SearchResponse {
  results: SearchResult[];
  took_ms: number;
}

export interface SubmitResponse {
  /** `created`: new record. `merged`: an equivalent solution already existed and received this confirmation. `duplicate`: already known, nothing changed. */
  outcome: 'created' | 'merged' | 'duplicate';
  solution: Solution;
  /** Kinds of sensitive data removed before storage, e.g. ["email", "api_key"]. */
  redactions: string[];
}

export interface FeedbackResponse {
  /** `recorded`: new vote. `changed`: this voter changed their vote. `duplicate`: same vote already counted. */
  outcome: 'recorded' | 'changed' | 'duplicate';
  solution: Solution;
}
