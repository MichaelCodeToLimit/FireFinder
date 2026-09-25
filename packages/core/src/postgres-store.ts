import type { ApiScope, SolutionStatus } from './constants.ts';
import { toVectorLiteral } from './embedding.ts';
import type {
  ApiKeyRecord,
  CandidateRecord,
  FeedbackOutcome,
  ModerationPolicy,
  NewSolution,
  SolutionRecord,
  SolutionRef,
  SolutionStore,
  Vote,
} from './store.ts';

/**
 * The only thing the store needs from a Postgres driver: run one parameterized
 * statement and return its rows. Adapters exist for postgres.js (production),
 * PGlite (zero-setup local development and tests) and Deno (Edge Functions).
 */
export interface SqlClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

const SOLUTION_COLUMNS = `id, fire_number, problem, solution, software, operating_system, software_version,
  error_message, software_key, os_family, os_version, version_major, error_signature,
  confirmation_count, failure_count, status, verification_status,
  created_at, updated_at, last_confirmed_at, last_failed_at`;

// Arrays and vectors are passed as text and converted in SQL. The explicit
// `::text` matters: drivers that serialize by inferred parameter type
// (postgres.js) would otherwise JSON-encode an already-encoded string for a
// `$n::jsonb` parameter. As text, every driver sends the value unchanged.
const TEXT_ARRAY = (param: string) => `array(select jsonb_array_elements_text(${param}::text::jsonb))`;
const VECTOR = (param: string) => `${param}::text::extensions.vector`;

export class PostgresStore implements SolutionStore {
  readonly #sql: SqlClient;

  constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  async searchCandidates(query: {
    embedding: number[];
    errorSignature: string[];
    limit: number;
    solutionEmbedding?: number[];
  }): Promise<CandidateRecord[]> {
    const rows = await this.#sql.query(
      `select * from firefinder.search_candidates(
         ${VECTOR('$1')}, ${TEXT_ARRAY('$2')}, $3::integer, ${VECTOR('$4')})`,
      [
        toVectorLiteral(query.embedding),
        JSON.stringify(query.errorSignature),
        query.limit,
        query.solutionEmbedding ? toVectorLiteral(query.solutionEmbedding) : null,
      ],
    );
    return rows.map((row) => ({
      ...mapSolution(row),
      similarity: Number(row.similarity),
      solution_similarity: row.solution_similarity == null ? null : Number(row.solution_similarity),
      error_overlap: Number(row.error_overlap ?? 0),
    }));
  }

  async insertSolution(solution: NewSolution, initialVote: Vote | null): Promise<SolutionRecord> {
    const rows = await this.#sql.query(
      `with inserted as (
         insert into firefinder.solutions (
           id, problem, solution, software, operating_system, software_version, error_message,
           software_key, os_family, os_version, version_major, error_signature,
           embedding, solution_embedding, embedding_model, source,
           confirmation_count, last_confirmed_at
         ) values (
           $1::uuid, $2, $3, $4, $5, $6, $7,
           $8, $9, $10, $11, ${TEXT_ARRAY('$12')},
           ${VECTOR('$13')}, ${VECTOR('$14')}, $15, $16,
           case when $17::boolean then 1 else 0 end,
           case when $17::boolean then now() end
         )
         returning ${SOLUTION_COLUMNS}
       ),
       vote as (
         insert into firefinder.solution_confirmations
           (solution_id, result, voter_hash, operating_system, software_version, note)
         select inserted.id, 'worked', $18, $19, $20, null
         from inserted
         where $17::boolean
       )
       select * from inserted`,
      [
        solution.id,
        solution.problem,
        solution.solution,
        solution.software,
        solution.operating_system,
        solution.software_version,
        solution.error_message,
        solution.software_key,
        solution.os_family,
        solution.os_version,
        solution.version_major,
        JSON.stringify(solution.error_signature),
        toVectorLiteral(solution.embedding),
        toVectorLiteral(solution.solution_embedding),
        solution.embedding_model,
        solution.source,
        initialVote?.result === 'worked',
        initialVote?.voterHash ?? null,
        initialVote?.operatingSystem ?? null,
        initialVote?.softwareVersion ?? null,
      ],
    );
    return mapSolution(rows[0]!);
  }

  async getSolution(ref: SolutionRef): Promise<SolutionRecord | null> {
    const [column, value] = 'id' in ref ? ['id', ref.id] : ['fire_number', ref.fireNumber];
    const rows = await this.#sql.query(
      `select ${SOLUTION_COLUMNS} from firefinder.solutions where ${column} = $1`,
      [value],
    );
    return rows[0] ? mapSolution(rows[0]) : null;
  }

  async recordFeedback(solutionId: string, vote: Vote, moderation: ModerationPolicy): Promise<FeedbackOutcome> {
    const rows = await this.#sql.query<{ outcome: FeedbackOutcome }>(
      `select outcome from firefinder.record_feedback($1::uuid, $2, $3, $4, $5, $6, $7::integer, $8::double precision)`,
      [
        solutionId,
        vote.result,
        vote.voterHash,
        vote.operatingSystem ?? null,
        vote.softwareVersion ?? null,
        vote.note ?? null,
        moderation.minFailures,
        moderation.failureRatio,
      ],
    );
    return rows[0]?.outcome ?? 'not_found';
  }

  async listSolutions(query: {
    limit: number;
    before?: number;
    status?: SolutionStatus;
    includeDisabled: boolean;
  }): Promise<SolutionRecord[]> {
    const rows = await this.#sql.query(
      `select ${SOLUTION_COLUMNS} from firefinder.solutions
       where ($1::bigint is null or fire_number < $1::bigint)
         and ($2::text is null or status = $2::text)
         and ($3::boolean or status <> 'disabled')
       order by fire_number desc
       limit $4::integer`,
      [query.before ?? null, query.status ?? null, query.includeDisabled, query.limit],
    );
    return rows.map(mapSolution);
  }

  async setStatus(id: string, status: SolutionStatus): Promise<SolutionRecord | null> {
    const rows = await this.#sql.query(
      `update firefinder.solutions set status = $2 where id = $1::uuid returning ${SOLUTION_COLUMNS}`,
      [id, status],
    );
    return rows[0] ? mapSolution(rows[0]) : null;
  }

  async findApiKeyByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    const rows = await this.#sql.query(
      `select id, name, key_prefix, scopes, revoked_at from firefinder.api_keys where key_hash = $1`,
      [keyHash],
    );
    return rows[0] ? mapApiKey(rows[0]) : null;
  }

  async touchApiKey(id: string): Promise<void> {
    // Hour granularity is plenty for "last used" and avoids a write per request.
    await this.#sql.query(
      `update firefinder.api_keys set last_used_at = now()
       where id = $1::uuid and (last_used_at is null or last_used_at < now() - interval '1 hour')`,
      [id],
    );
  }

  async createApiKey(input: { name: string; keyPrefix: string; keyHash: string; scopes: ApiScope[] }): Promise<ApiKeyRecord> {
    const rows = await this.#sql.query(
      `insert into firefinder.api_keys (name, key_prefix, key_hash, scopes)
       values ($1, $2, $3, ${TEXT_ARRAY('$4')})
       returning id, name, key_prefix, scopes, revoked_at`,
      [input.name, input.keyPrefix, input.keyHash, JSON.stringify(input.scopes)],
    );
    return mapApiKey(rows[0]!);
  }

  async rateLimitHits(keys: string[], windowSeconds: number): Promise<number[]> {
    const rows = await this.#sql.query<{ hits: number }>(
      `select firefinder.rate_limit_hit(bucket.key, $2::integer) as hits
       from unnest(${TEXT_ARRAY('$1')}) with ordinality as bucket(key, position)
       order by bucket.position`,
      [JSON.stringify(keys), windowSeconds],
    );
    return rows.map((row) => Number(row.hits));
  }
}

// ---------------------------------------------------------------------------
// Row mapping: drivers differ in how they return bigint, timestamptz and
// arrays, so normalize everything here.
// ---------------------------------------------------------------------------

function mapSolution(row: Record<string, unknown>): SolutionRecord {
  return {
    id: String(row.id),
    fire_number: Number(row.fire_number),
    problem: String(row.problem),
    solution: String(row.solution),
    software: nullableString(row.software),
    operating_system: nullableString(row.operating_system),
    software_version: nullableString(row.software_version),
    error_message: nullableString(row.error_message),
    software_key: nullableString(row.software_key),
    os_family: nullableString(row.os_family),
    os_version: nullableString(row.os_version),
    version_major: nullableString(row.version_major),
    error_signature: toStringArray(row.error_signature),
    confirmation_count: Number(row.confirmation_count),
    failure_count: Number(row.failure_count),
    status: row.status as SolutionRecord['status'],
    verification_status: row.verification_status as SolutionRecord['verification_status'],
    created_at: toIso(row.created_at)!,
    updated_at: toIso(row.updated_at)!,
    last_confirmed_at: toIso(row.last_confirmed_at),
    last_failed_at: toIso(row.last_failed_at),
  };
}

function mapApiKey(row: Record<string, unknown>): ApiKeyRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    key_prefix: String(row.key_prefix),
    scopes: toStringArray(row.scopes) as ApiScope[],
    revoked_at: toIso(row.revoked_at),
  };
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return typeof value === 'string' ? parseTextArray(value) : [];
}

/**
 * Parses a one-dimensional Postgres text[] literal such as {a,"b c","d\"e"}.
 * Drivers that skip type lookups (postgres.js with fetch_types: false) return
 * arrays in this form.
 */
export function parseTextArray(literal: string): string[] {
  if (!literal.startsWith('{') || !literal.endsWith('}')) return [];
  const body = literal.slice(1, -1);
  const items: string[] = [];
  let i = 0;
  while (i < body.length) {
    let item = '';
    if (body[i] === '"') {
      i++;
      while (i < body.length && body[i] !== '"') {
        if (body[i] === '\\') i++;
        item += body[i++] ?? '';
      }
      i++; // closing quote
    } else {
      while (i < body.length && body[i] !== ',') item += body[i++];
    }
    items.push(item);
    i++; // comma
  }
  return items;
}
