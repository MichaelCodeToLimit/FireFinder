import { EMBEDDING_DIMENSIONS } from './constants.ts';

/**
 * Turns text into vectors. Implementations must produce normalized gte-small
 * (384-dimension) embeddings so every FireFinder instance stays compatible:
 *   - Node: transformers.js running Supabase/gte-small locally (apps/api)
 *   - Supabase Edge Functions: the built-in Supabase.ai gte-small session
 * Neither makes a network call to an external AI service.
 */
export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

/** Text embedded for a problem. The same shape is used for stored records and queries. */
export function problemEmbeddingText(fields: {
  problem: string;
  error_message?: string | null;
  software?: string | null;
}): string {
  return [fields.software, fields.problem, fields.error_message].filter(Boolean).join('\n');
}

export function assertEmbedding(vector: unknown, dimensions = EMBEDDING_DIMENSIONS): asserts vector is number[] {
  if (!Array.isArray(vector) || vector.length !== dimensions || !vector.every((x) => Number.isFinite(x))) {
    throw new Error(`embedding must be ${dimensions} finite numbers`);
  }
}

/** pgvector text literal: [0.1,0.2,...] */
export function toVectorLiteral(vector: number[]): string {
  assertEmbedding(vector, vector.length);
  return `[${vector.join(',')}]`;
}

/**
 * Small in-memory LRU cache in front of an embedder. Repeated searches for the
 * same text skip inference entirely.
 */
export class CachedEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  readonly #inner: Embedder;
  readonly #cache = new Map<string, number[]>();
  readonly #maxEntries: number;

  constructor(inner: Embedder, maxEntries = 2000) {
    this.#inner = inner;
    this.model = inner.model;
    this.dimensions = inner.dimensions;
    this.#maxEntries = maxEntries;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const missing = [...new Set(texts.filter((text) => !this.#cache.has(text)))];
    if (missing.length > 0) {
      const vectors = await this.#inner.embed(missing);
      missing.forEach((text, i) => {
        const vector = vectors[i];
        assertEmbedding(vector, this.dimensions);
        this.#cache.set(text, vector);
      });
      while (this.#cache.size > this.#maxEntries) {
        this.#cache.delete(this.#cache.keys().next().value!);
      }
    }
    return texts.map((text) => {
      const vector = this.#cache.get(text)!;
      // Refresh LRU position.
      this.#cache.delete(text);
      this.#cache.set(text, vector);
      return vector;
    });
  }
}
