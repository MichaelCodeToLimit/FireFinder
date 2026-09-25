import { resolve } from 'node:path';
import {
  ApiKeyAuthenticator,
  CachedEmbedder,
  createApp,
  FireFinderService,
  generateApiKey,
  hashApiKey,
  NoopRateLimiter,
  PostgresStore,
  type ApiScope,
  type Logger,
  type RateLimiter,
  type RateLimitPolicy,
  type ServiceConfig,
} from '@firefinder/core';
import { migrate, openDatabase, type Database } from '../../apps/api/src/db.ts';
import { TransformersEmbedder } from '../../apps/api/src/embedder.ts';

export const REPO_ROOT = resolve(import.meta.dirname, '../..');

let sharedEmbedder: CachedEmbedder | undefined;

/** The real gte-small model, loaded once per test worker. */
export function realEmbedder(): CachedEmbedder {
  sharedEmbedder ??= new CachedEmbedder(new TransformersEmbedder({ cacheDir: resolve(REPO_ROOT, '.cache/models') }));
  return sharedEmbedder;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** Fresh in-memory PostgreSQL (PGlite + pgvector) with the real migrations applied. */
export async function createTestDatabase(): Promise<Database> {
  const db = await openDatabase('pglite://memory');
  // Recreate Supabase's Data API roles so the migration's lock-down is exercised.
  await db.exec('create role anon nologin; create role authenticated nologin;');
  await migrate(db);
  return db;
}

export interface TestContextOptions {
  rateLimiter?: RateLimiter;
  rateLimits?: Partial<RateLimitPolicy>;
  now?: () => Date;
  config?: Partial<ServiceConfig>;
}

export interface RequestOptions {
  key?: string | null;
  body?: unknown;
  rawBody?: string;
  clientId?: string;
  headers?: Record<string, string>;
}

export async function createTestContext(options: TestContextOptions = {}) {
  const db = await createTestDatabase();
  const store = new PostgresStore(db.sql);
  const service = new FireFinderService({
    store,
    embedder: realEmbedder(),
    config: { voterSecret: 'test-voter-secret-0123456789', ...options.config },
    now: options.now,
  });
  const app = createApp({
    service,
    authenticator: new ApiKeyAuthenticator(store),
    rateLimiter: options.rateLimiter ?? new NoopRateLimiter(),
    rateLimits: options.rateLimits,
    logger: silentLogger,
  });

  const createKey = async (scopes: ApiScope[], name = 'test') => {
    const { key, prefix } = generateApiKey();
    await store.createApiKey({ name, keyPrefix: prefix, keyHash: await hashApiKey(key), scopes });
    return key;
  };

  const keys = {
    read: await createKey(['read'], 'read-only'),
    write: await createKey(['read', 'write'], 'read-write'),
    admin: await createKey(['admin'], 'admin'),
  };

  async function request(method: string, path: string, opts: RequestOptions = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
    const key = opts.key === undefined ? keys.write : opts.key;
    if (key) headers.authorization = `Bearer ${key}`;
    if (opts.clientId) headers['x-firefinder-client'] = opts.clientId;
    const body = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
    const response = await app.request(path, { method, headers, body });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  }

  return { db, store, service, app, keys, createKey, request, close: () => db.close() };
}

export type TestContext = Awaited<ReturnType<typeof createTestContext>>;
