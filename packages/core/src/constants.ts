export const FIREFINDER_VERSION = '0.1.0';

/** gte-small: runs locally in Node (transformers.js) and natively in Supabase Edge Functions. */
export const EMBEDDING_MODEL = 'gte-small';
export const EMBEDDING_DIMENSIONS = 384;

/** Field limits. Mirrored by CHECK constraints in the database migration. */
export const LIMITS = {
  problem: { min: 10, max: 1000 },
  searchProblem: { min: 3, max: 1000 },
  solution: { min: 10, max: 5000 },
  software: 100,
  operatingSystem: 100,
  softwareVersion: 50,
  errorMessage: 1000,
  note: 500,
  source: 40,
} as const;

export const SOLUTION_STATUSES = ['active', 'under_review', 'disabled'] as const;
export type SolutionStatus = (typeof SOLUTION_STATUSES)[number];

export const VERIFICATION_STATUSES = ['candidate', 'verified'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const API_SCOPES = ['read', 'write', 'admin'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const FEEDBACK_RESULTS = ['worked', 'failed'] as const;
export type FeedbackResult = (typeof FEEDBACK_RESULTS)[number];
