import type { ApiScope } from './constants.ts';
import { randomBase62, sha256Hex } from './crypto.ts';
import type { ApiKeyRecord, SolutionStore } from './store.ts';

/**
 * API keys look like `ff_<40 base62 chars>`. Only the SHA-256 hash is stored;
 * the key itself is shown once, when it is created.
 */
const API_KEY_FORMAT = /^ff_[A-Za-z0-9]{20,100}$/;

export function generateApiKey(): { key: string; prefix: string } {
  const key = `ff_${randomBase62(40)}`;
  return { key, prefix: key.slice(0, 11) };
}

export const hashApiKey = sha256Hex;

/** Reads the key from `Authorization: Bearer <key>` or `X-API-Key: <key>`. */
export function extractApiKey(headers: { authorization?: string | null; apiKey?: string | null }): string | null {
  const bearer = headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const key = bearer ?? headers.apiKey?.trim();
  return key || null;
}

export function hasScope(key: ApiKeyRecord, scope: ApiScope): boolean {
  return key.scopes.includes('admin') || key.scopes.includes(scope);
}

interface CacheEntry {
  record: ApiKeyRecord | null;
  expiresAt: number;
}

export interface AuthenticatorOptions {
  /** How long a valid key lookup is cached. Revocations take effect within this window. */
  cacheTtlMs: number;
  /** How long an unknown key is cached (protects the database from key-guessing floods). */
  negativeCacheTtlMs: number;
  maxEntries: number;
}

const DEFAULT_OPTIONS: AuthenticatorOptions = {
  cacheTtlMs: 60_000,
  negativeCacheTtlMs: 10_000,
  maxEntries: 5_000,
};

export class ApiKeyAuthenticator {
  readonly #store: SolutionStore;
  readonly #options: AuthenticatorOptions;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #now: () => number;

  constructor(store: SolutionStore, options: Partial<AuthenticatorOptions> = {}, now: () => number = Date.now) {
    this.#store = store;
    this.#options = { ...DEFAULT_OPTIONS, ...options };
    this.#now = now;
  }

  /** Returns the key record, or null if the key is malformed, unknown or revoked. */
  async authenticate(rawKey: string): Promise<ApiKeyRecord | null> {
    if (!API_KEY_FORMAT.test(rawKey)) return null;
    const hash = await hashApiKey(rawKey);
    const now = this.#now();

    const cached = this.#cache.get(hash);
    if (cached && cached.expiresAt > now) return cached.record;

    const record = await this.#store.findApiKeyByHash(hash);
    const valid = record && !record.revoked_at ? record : null;
    this.#remember(hash, valid, now);

    // Best-effort usage tracking, at most once per cache period per key.
    if (valid) this.#store.touchApiKey(valid.id).catch(() => {});
    return valid;
  }

  #remember(hash: string, record: ApiKeyRecord | null, now: number): void {
    if (this.#cache.size >= this.#options.maxEntries) {
      this.#cache.delete(this.#cache.keys().next().value!);
    }
    const ttl = record ? this.#options.cacheTtlMs : this.#options.negativeCacheTtlMs;
    this.#cache.set(hash, { record, expiresAt: now + ttl });
  }
}
