import { LIMITS, type FeedbackResult, type SolutionStatus } from './constants.ts';
import { hmacSha256Hex, uuidv7 } from './crypto.ts';
import { DEFAULT_DUPLICATE_THRESHOLDS, findDuplicate, type DuplicateThresholds } from './dedupe.ts';
import { problemEmbeddingText, type Embedder } from './embedding.ts';
import { notFound } from './errors.ts';
import { extractErrorSignature, normalizeEnvironment } from './normalize.ts';
import { redactSensitive, type RedactionKind } from './privacy.ts';
import {
  candidateEnvironment,
  DEFAULT_RANKING_OPTIONS,
  scoreCandidate,
  type RankingOptions,
} from './ranking.ts';
import type {
  FeedbackRequest,
  FeedbackResponse,
  SearchRequest,
  SearchResponse,
  SearchResult,
  Solution,
  SubmitResponse,
  SubmitSolutionRequest,
} from './schemas.ts';
import type { CandidateRecord, ModerationPolicy, SolutionRecord, SolutionStore } from './store.ts';

export interface ServiceConfig {
  /** Nearest neighbours fetched from the database before ranking. */
  candidateLimit: number;
  /** Results returned when the request does not specify a limit. */
  defaultLimit: number;
  /** Minimum cosine similarity for a result to be returned. */
  minSimilarity: number;
  /** Results sharing an exact error code may be this much less similar and still be returned. */
  errorMatchSimilarityMargin: number;
  ranking: Omit<RankingOptions, 'now'>;
  duplicates: DuplicateThresholds;
  moderation: ModerationPolicy;
  /**
   * Secret used to derive anonymous voter hashes. Changing it resets
   * one-vote-per-voter protection for existing votes.
   */
  voterSecret: string;
}

export const DEFAULT_SERVICE_CONFIG: Omit<ServiceConfig, 'voterSecret'> = {
  candidateLimit: 30,
  defaultLimit: 5,
  minSimilarity: 0.83,
  errorMatchSimilarityMargin: 0.08,
  ranking: DEFAULT_RANKING_OPTIONS,
  duplicates: DEFAULT_DUPLICATE_THRESHOLDS,
  moderation: { minFailures: 5, failureRatio: 0.75 },
};

/** Who is calling. Never contains personal data: an API key id and a random install id. */
export interface Actor {
  keyId: string;
  clientId: string | null;
}

export interface ServiceDeps {
  store: SolutionStore;
  embedder: Embedder;
  config: Partial<ServiceConfig> & Pick<ServiceConfig, 'voterSecret'>;
  now?: () => Date;
}

export class FireFinderService {
  readonly #store: SolutionStore;
  readonly #embedder: Embedder;
  readonly #config: ServiceConfig;
  readonly #now: () => Date;

  constructor(deps: ServiceDeps) {
    this.#store = deps.store;
    this.#embedder = deps.embedder;
    this.#config = { ...DEFAULT_SERVICE_CONFIG, ...deps.config };
    this.#now = deps.now ?? (() => new Date());
    if (this.#config.voterSecret.length < 16) {
      throw new Error('voterSecret must be at least 16 characters');
    }
  }

  get embeddingModel(): string {
    return this.#embedder.model;
  }

  /**
   * Find previously solved problems similar to this one, best first.
   * `onTiming` receives per-stage durations (embed, db, rank) for monitoring.
   */
  async search(request: SearchRequest, onTiming?: (stage: string, ms: number) => void): Promise<SearchResponse> {
    const started = performance.now();
    // Queries are never stored, but they are filtered the same way as
    // submissions so both sides of the comparison look alike.
    const { fields } = redactFields(request);
    const environment = normalizeEnvironment(fields);
    const errorSignature = extractErrorSignature(fields.error_message, fields.problem);

    let mark = performance.now();
    const [embedding] = await this.#embedder.embed([problemEmbeddingText(fields)]);
    onTiming?.('embed', performance.now() - mark);

    mark = performance.now();
    const candidates = await this.#store.searchCandidates({
      embedding: embedding!,
      errorSignature,
      limit: this.#config.candidateLimit,
    });
    onTiming?.('db', performance.now() - mark);
    mark = performance.now();

    const minSimilarity = request.min_similarity ?? this.#config.minSimilarity;
    const options: RankingOptions = { ...this.#config.ranking, now: this.#now() };
    const query = { environment, errorSignature };

    const results: SearchResult[] = candidates
      .filter((candidate) => !request.verified_only || candidate.verification_status === 'verified')
      .filter((candidate) => this.#isRelevantEnough(candidate, minSimilarity))
      .map((candidate) => ({ candidate, breakdown: scoreCandidate(query, candidate, candidateEnvironment(candidate), options) }))
      // Metadata filter: a fix for different software is noise unless the exact error code matches.
      .filter(({ candidate, breakdown }) => breakdown.environmentMatch.software !== 'mismatch' || candidate.error_overlap > 0)
      .sort((a, b) => b.breakdown.score - a.breakdown.score || b.candidate.similarity - a.candidate.similarity)
      .slice(0, request.limit ?? this.#config.defaultLimit)
      .map(({ candidate, breakdown }) => ({
        ...toPublicSolution(candidate),
        similarity: Math.round(candidate.similarity * 1000) / 1000,
        score: breakdown.score,
        environment_match: breakdown.environmentMatch,
      }));
    onTiming?.('rank', performance.now() - mark);

    return { results, took_ms: Math.round(performance.now() - started) };
  }

  /**
   * Store a problem/solution pair. If an equivalent solution already exists,
   * it receives this confirmation instead of creating a duplicate record.
   */
  async submit(request: SubmitSolutionRequest, actor: Actor): Promise<SubmitResponse> {
    const { fields, redactions } = redactFields(request);
    const environment = normalizeEnvironment(fields);
    const errorSignature = extractErrorSignature(fields.error_message, fields.problem);

    const [embedding, solutionEmbedding] = await this.#embedder.embed([problemEmbeddingText(fields), fields.solution]);
    const candidates = await this.#store.searchCandidates({
      embedding: embedding!,
      errorSignature,
      limit: 10,
      solutionEmbedding: solutionEmbedding!,
    });
    const voterHash = await this.#voterHash(actor);
    const vote = {
      result: 'worked' as const,
      voterHash,
      operatingSystem: fields.operating_system ?? null,
      softwareVersion: fields.software_version ?? null,
    };

    const duplicate = findDuplicate({ solution: fields.solution, environment }, candidates, this.#config.duplicates);
    if (duplicate) {
      if (!request.worked) {
        return { outcome: 'duplicate', solution: toPublicSolution(duplicate), redactions };
      }
      const outcome = await this.#store.recordFeedback(duplicate.id, vote, this.#config.moderation);
      const updated = await this.#store.getSolution({ id: duplicate.id });
      if (outcome !== 'not_found' && updated) {
        return { outcome: outcome === 'duplicate' ? 'duplicate' : 'merged', solution: toPublicSolution(updated), redactions };
      }
      // The match was disabled in the meantime: store this one as new.
    }

    const record = await this.#store.insertSolution(
      {
        id: uuidv7(this.#now().getTime()),
        problem: fields.problem,
        solution: fields.solution,
        software: fields.software ?? null,
        operating_system: fields.operating_system ?? null,
        software_version: fields.software_version ?? environment.version?.full ?? null,
        error_message: fields.error_message ?? null,
        software_key: environment.software_key,
        os_family: environment.os?.family ?? null,
        os_version: environment.os?.version ?? null,
        version_major: environment.version?.major ?? null,
        error_signature: errorSignature,
        embedding: embedding!,
        solution_embedding: solutionEmbedding!,
        embedding_model: this.#embedder.model,
        source: request.source ?? null,
      },
      request.worked ? vote : null,
    );
    return { outcome: 'created', solution: toPublicSolution(record), redactions };
  }

  async get(ref: string, options: { includeDisabled: boolean } = { includeDisabled: false }): Promise<Solution> {
    const record = await this.#resolve(ref);
    if (!record || (record.status === 'disabled' && !options.includeDisabled)) throw notFound();
    return toPublicSolution(record);
  }

  /** "It worked": adds a confirmation. */
  confirm(ref: string, request: FeedbackRequest, actor: Actor): Promise<FeedbackResponse> {
    return this.#feedback(ref, 'worked', request, actor);
  }

  /** "It didn't work": adds a failure report. Never deletes anything. */
  report(ref: string, request: FeedbackRequest, actor: Actor): Promise<FeedbackResponse> {
    return this.#feedback(ref, 'failed', request, actor);
  }

  async list(
    query: { limit: number; before?: number; status?: SolutionStatus },
    options: { includeDisabled: boolean },
  ): Promise<Solution[]> {
    const records = await this.#store.listSolutions({ ...query, includeDisabled: options.includeDisabled });
    return records.map(toPublicSolution);
  }

  async setStatus(ref: string, status: SolutionStatus): Promise<Solution> {
    const record = await this.#resolve(ref);
    if (!record) throw notFound();
    const updated = await this.#store.setStatus(record.id, status);
    if (!updated) throw notFound();
    return toPublicSolution(updated);
  }

  async #feedback(ref: string, result: FeedbackResult, request: FeedbackRequest, actor: Actor): Promise<FeedbackResponse> {
    const id = isFireNumber(ref) ? (await this.#resolve(ref))?.id : ref;
    if (!id) throw notFound();
    const { fields } = redactFields(request);
    const outcome = await this.#store.recordFeedback(
      id,
      {
        result,
        voterHash: await this.#voterHash(actor),
        operatingSystem: fields.operating_system ?? null,
        softwareVersion: fields.software_version ?? null,
        note: fields.note ?? null,
      },
      this.#config.moderation,
    );
    if (outcome === 'not_found') throw notFound();
    const updated = await this.#store.getSolution({ id });
    if (!updated) throw notFound();
    return { outcome, solution: toPublicSolution(updated) };
  }

  #resolve(ref: string): Promise<SolutionRecord | null> {
    return this.#store.getSolution(isFireNumber(ref) ? { fireNumber: Number(ref) } : { id: ref });
  }

  #isRelevantEnough(candidate: CandidateRecord, minSimilarity: number): boolean {
    if (candidate.similarity >= minSimilarity) return true;
    return candidate.error_overlap > 0 && candidate.similarity >= minSimilarity - this.#config.errorMatchSimilarityMargin;
  }

  #voterHash(actor: Actor): Promise<string> {
    return hmacSha256Hex(this.#config.voterSecret, `voter:${actor.keyId}:${actor.clientId ?? ''}`);
  }
}

function isFireNumber(ref: string): boolean {
  return /^\d+$/.test(ref);
}

const FIELD_LIMITS: Record<string, number> = {
  problem: LIMITS.problem.max,
  solution: LIMITS.solution.max,
  software: LIMITS.software,
  operating_system: LIMITS.operatingSystem,
  software_version: LIMITS.softwareVersion,
  error_message: LIMITS.errorMessage,
  note: LIMITS.note,
};

/** Runs the privacy filter over every free-text field of a request. */
function redactFields<T extends object>(input: T): { fields: T; redactions: RedactionKind[] } {
  const found = new Set<RedactionKind>();
  const fields = { ...input } as Record<string, unknown>;
  for (const [key, max] of Object.entries(FIELD_LIMITS)) {
    const value = fields[key];
    if (typeof value !== 'string') continue;
    const { text, redactions } = redactSensitive(value);
    redactions.forEach((kind) => found.add(kind));
    // Placeholders can be longer than what they replace; stay within the column limit.
    fields[key] = text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }
  return { fields: fields as T, redactions: [...found] };
}

/** Strips internal matching metadata before a record leaves the API. */
export function toPublicSolution(record: SolutionRecord): Solution {
  return {
    id: record.id,
    fire_number: record.fire_number,
    problem: record.problem,
    solution: record.solution,
    software: record.software,
    operating_system: record.operating_system,
    software_version: record.software_version,
    error_message: record.error_message,
    confirmation_count: record.confirmation_count,
    failure_count: record.failure_count,
    status: record.status,
    verification_status: record.verification_status,
    created_at: record.created_at,
    updated_at: record.updated_at,
    last_confirmed_at: record.last_confirmed_at,
    last_failed_at: record.last_failed_at,
  };
}
