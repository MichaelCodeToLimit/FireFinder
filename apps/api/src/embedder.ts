import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, type Embedder } from '@firefinder/core';

export interface TransformersEmbedderOptions {
  /** Hugging Face model id. Must produce gte-small compatible vectors. */
  modelId?: string;
  /** q8 (default) is ~4x smaller and ~2x faster than fp32 with near-identical similarities. */
  dtype?: 'q8' | 'fp16' | 'fp32';
  /** Where model files are cached after the first download. */
  cacheDir?: string;
}

type Extractor = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

/**
 * gte-small running in-process via transformers.js (ONNX runtime). The model
 * (~34 MB for q8) is downloaded once from Hugging Face, then everything runs
 * locally: no API calls, ~2-5 ms per embedding on a laptop CPU.
 *
 * Produces the same vectors as Supabase Edge Functions' built-in
 * `new Supabase.ai.Session('gte-small')` with mean pooling + normalization.
 */
export class TransformersEmbedder implements Embedder {
  readonly model = EMBEDDING_MODEL;
  readonly dimensions = EMBEDDING_DIMENSIONS;
  readonly #options: Required<Omit<TransformersEmbedderOptions, 'cacheDir'>> & { cacheDir?: string };
  #extractor: Promise<Extractor> | null = null;

  constructor(options: TransformersEmbedderOptions = {}) {
    this.#options = { modelId: 'Supabase/gte-small', dtype: 'q8', ...options };
  }

  /** Loads the model ahead of the first request. */
  async warmup(): Promise<void> {
    await this.embed(['warmup']);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.#load();
    const output = await extractor(texts, { pooling: 'mean', normalize: true });
    return output.tolist();
  }

  #load(): Promise<Extractor> {
    this.#extractor ??= (async () => {
      const transformers = await import('@huggingface/transformers');
      if (this.#options.cacheDir) transformers.env.cacheDir = this.#options.cacheDir;
      const extractor = await transformers.pipeline('feature-extraction', this.#options.modelId, {
        dtype: this.#options.dtype,
      });
      return extractor as unknown as Extractor;
    })().catch((error) => {
      this.#extractor = null; // allow a retry after e.g. a transient download failure
      throw error;
    });
    return this.#extractor;
  }
}
