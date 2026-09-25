/**
 * Duplicate detection. A new submission is merged into an existing solution
 * (as an extra confirmation) only when all of these hold:
 *
 *  1. the problems are semantically near-identical,
 *  2. the solutions are semantically near-identical or share nearly all words,
 *  3. the environments do not contradict each other
 *     (a Windows 10 fix and a Windows 11 fix stay separate),
 *  4. the solutions do not differ in an important detail
 *     (enable vs disable, version 16 vs 18).
 */
import {
  hasConflictingDetails,
  jaccard,
  wordSet,
  type NormalizedEnvironment,
} from './normalize.ts';
import { candidateEnvironment, compareOperatingSystem, compareSoftware, compareVersion, type RankableCandidate } from './ranking.ts';

export interface DuplicateThresholds {
  /** Minimum cosine similarity between the problem descriptions. */
  problemSimilarity: number;
  /** Minimum cosine similarity between the solution texts... */
  solutionSimilarity: number;
  /** ...or minimum word-set overlap (Jaccard) between the solution texts. */
  solutionWordOverlap: number;
}

export const DEFAULT_DUPLICATE_THRESHOLDS: DuplicateThresholds = {
  problemSimilarity: 0.9,
  solutionSimilarity: 0.93,
  solutionWordOverlap: 0.85,
};

export interface DuplicateCandidate extends RankableCandidate {
  id: string;
  solution: string;
  solution_similarity: number | null;
}

/** Environments conflict when both sides specify a dimension with different values. */
export function environmentsCompatible(a: NormalizedEnvironment, b: NormalizedEnvironment): boolean {
  const software = compareSoftware(a.software_key, b.software_key);
  if (software === 'mismatch') return false;
  const os = compareOperatingSystem(a.os, b.os);
  if (os === 'mismatch' || os === 'different_version') return false;
  if (compareVersion(a.version, b.version) === 'different_version') return false;
  return true;
}

export function findDuplicate<T extends DuplicateCandidate>(
  submission: { solution: string; environment: NormalizedEnvironment },
  candidates: T[],
  thresholds: DuplicateThresholds = DEFAULT_DUPLICATE_THRESHOLDS,
): T | null {
  const submittedWords = wordSet(submission.solution);
  let best: T | null = null;
  let bestScore = -Infinity;

  for (const candidate of candidates) {
    if (candidate.similarity < thresholds.problemSimilarity) continue;

    const semanticMatch = (candidate.solution_similarity ?? 0) >= thresholds.solutionSimilarity;
    const wordMatch = jaccard(submittedWords, wordSet(candidate.solution)) >= thresholds.solutionWordOverlap;
    if (!semanticMatch && !wordMatch) continue;

    if (!environmentsCompatible(submission.environment, candidateEnvironment(candidate))) continue;
    if (hasConflictingDetails(submission.solution, candidate.solution)) continue;

    const score = candidate.similarity + (candidate.solution_similarity ?? 0);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}
