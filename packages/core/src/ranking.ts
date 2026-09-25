/**
 * Result ranking. Kept deliberately small and pure so it can be tuned (or
 * replaced) without touching storage or the API. See docs/RANKING.md.
 *
 *   score = relevance    * w.relevance      semantic similarity (+ exact error-code overlap)
 *         + verification * w.verification   Wilson lower bound of the confirmation rate
 *         + environment  * w.environment    software / OS / version match, -1..1
 *         + recency      * w.recency        half-life decay since last confirmation
 *         - failureRate  * w.failure        smoothed share of "didn't work" reports
 *
 * Verification is bounded (0..1) and saturates, so popularity alone cannot beat
 * a clearly more relevant solution or one that matches the user's environment.
 */
import type { EnvironmentMatch, MatchLevel } from './schemas.ts';
import { parseVersion, type NormalizedEnvironment, type OperatingSystemInfo, type VersionInfo } from './normalize.ts';

export interface RankingWeights {
  relevance: number;
  verification: number;
  environment: number;
  recency: number;
  failure: number;
}

export const DEFAULT_WEIGHTS: RankingWeights = {
  relevance: 0.55,
  verification: 0.15,
  environment: 0.2,
  recency: 0.05,
  failure: 0.2,
};

export interface RankingOptions {
  weights: RankingWeights;
  /**
   * Similarity that maps to zero relevance. gte-small scores unrelated
   * technical sentences around 0.70-0.80 and paraphrases above 0.90.
   */
  similarityFloor: number;
  recencyHalfLifeDays: number;
  /** Multiplier applied to solutions flagged for moderation. */
  underReviewMultiplier: number;
  now: Date;
}

export const DEFAULT_RANKING_OPTIONS: Omit<RankingOptions, 'now'> = {
  weights: DEFAULT_WEIGHTS,
  similarityFloor: 0.8,
  recencyHalfLifeDays: 180,
  underReviewMultiplier: 0.6,
};

export interface RankingQuery {
  environment: NormalizedEnvironment;
  errorSignature: string[];
}

export interface RankableCandidate {
  similarity: number;
  error_overlap: number;
  confirmation_count: number;
  failure_count: number;
  status: string;
  created_at: string;
  last_confirmed_at: string | null;
  software_key: string | null;
  os_family: string | null;
  os_version: string | null;
  software_version: string | null;
  version_major: string | null;
}

export interface ScoreBreakdown {
  score: number;
  relevance: number;
  verification: number;
  environment: number;
  recency: number;
  failureRate: number;
  environmentMatch: EnvironmentMatch;
}

/** Lower bound of the Wilson score interval: "how good is this rate, given the sample size?" */
export function wilsonLowerBound(positive: number, total: number, z = 1.96): number {
  if (total <= 0) return 0;
  const p = positive / total;
  const z2 = z * z;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return Math.max(0, (centre - margin) / (1 + z2 / total));
}

const LEVEL_SCORE: Record<MatchLevel, number> = {
  match: 1,
  partial: 0.5,
  different_version: -0.4,
  mismatch: -1,
  unknown: 0,
};

const DIMENSION_WEIGHTS = { software: 0.45, operating_system: 0.35, software_version: 0.2 } as const;

export function compareSoftware(query: string | null, candidate: string | null): MatchLevel {
  if (!query || !candidate) return 'unknown';
  if (query === candidate) return 'match';
  const contains = (a: string, b: string) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(b)}([^a-z0-9]|$)`).test(a);
  return contains(query, candidate) || contains(candidate, query) ? 'partial' : 'mismatch';
}

export function compareOperatingSystem(query: OperatingSystemInfo | null, candidate: OperatingSystemInfo | null): MatchLevel {
  if (!query || !candidate) return 'unknown';
  if (query.family !== candidate.family) return 'mismatch';
  if (!query.version || !candidate.version) return 'partial';
  return query.version === candidate.version ? 'match' : 'different_version';
}

export function compareVersion(query: VersionInfo | null, candidate: VersionInfo | null): MatchLevel {
  if (!query || !candidate) return 'unknown';
  if (query.full === candidate.full) return 'match';
  return query.major === candidate.major ? 'partial' : 'different_version';
}

export function environmentMatch(
  query: NormalizedEnvironment,
  candidate: NormalizedEnvironment,
): { levels: EnvironmentMatch; score: number } {
  const software = compareSoftware(query.software_key, candidate.software_key);
  const levels: EnvironmentMatch = {
    software,
    operating_system: compareOperatingSystem(query.os, candidate.os),
    // Versions of different products are not comparable.
    software_version: software === 'mismatch' ? 'unknown' : compareVersion(query.version, candidate.version),
  };

  // Average only over the dimensions the query specified: a user who told us
  // their OS gets OS-aware ranking even if they did not name the software.
  let weighted = 0;
  let totalWeight = 0;
  if (query.software_key) {
    weighted += DIMENSION_WEIGHTS.software * LEVEL_SCORE[levels.software];
    totalWeight += DIMENSION_WEIGHTS.software;
  }
  if (query.os) {
    weighted += DIMENSION_WEIGHTS.operating_system * LEVEL_SCORE[levels.operating_system];
    totalWeight += DIMENSION_WEIGHTS.operating_system;
  }
  if (query.version) {
    weighted += DIMENSION_WEIGHTS.software_version * LEVEL_SCORE[levels.software_version];
    totalWeight += DIMENSION_WEIGHTS.software_version;
  }
  return { levels, score: totalWeight > 0 ? weighted / totalWeight : 0 };
}

export function candidateEnvironment(candidate: RankableCandidate): NormalizedEnvironment {
  const major = candidate.version_major;
  return {
    software_key: candidate.software_key,
    os: candidate.os_family ? { family: candidate.os_family, version: candidate.os_version } : null,
    version: parseVersion(candidate.software_version) ?? (major ? { full: major, major } : null),
  };
}

export function scoreCandidate(
  query: RankingQuery,
  candidate: RankableCandidate,
  candidateEnv: NormalizedEnvironment,
  options: RankingOptions,
): ScoreBreakdown {
  const { weights } = options;

  const semantic = clamp01((candidate.similarity - options.similarityFloor) / (1 - options.similarityFloor));
  const relevance =
    query.errorSignature.length > 0
      ? 0.75 * semantic + 0.25 * clamp01(candidate.error_overlap / query.errorSignature.length)
      : semantic;

  const votes = candidate.confirmation_count + candidate.failure_count;
  const verification = wilsonLowerBound(candidate.confirmation_count, votes);
  // Laplace-smoothed: one failure on a brand-new solution is not a verdict.
  const failureRate = candidate.failure_count / (votes + 2);

  const lastActivity = Date.parse(candidate.last_confirmed_at ?? candidate.created_at);
  const ageDays = Math.max(0, (options.now.getTime() - lastActivity) / 86_400_000);
  const recency = Math.pow(0.5, ageDays / options.recencyHalfLifeDays);

  const env = environmentMatch(query.environment, candidateEnv);

  let score =
    weights.relevance * relevance +
    weights.verification * verification +
    weights.environment * env.score +
    weights.recency * recency -
    weights.failure * failureRate;
  if (candidate.status === 'under_review' && score > 0) score *= options.underReviewMultiplier;

  return {
    score: round(score),
    relevance: round(relevance),
    verification: round(verification),
    environment: round(env.score),
    recency: round(recency),
    failureRate: round(failureRate),
    environmentMatch: env.levels,
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
