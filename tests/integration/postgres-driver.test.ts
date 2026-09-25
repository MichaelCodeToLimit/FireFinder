/**
 * The production database path: the postgres.js driver (Node server and
 * Supabase Edge Function) over the PostgreSQL wire protocol. PGlite serves
 * the protocol here, so this runs without an external database.
 *
 * Drivers differ in how they encode parameters (postgres.js serializes by
 * inferred type); this suite catches differences the in-process PGlite
 * driver would hide.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import {
  ApiKeyAuthenticator,
  createApp,
  FireFinderService,
  generateApiKey,
  hashApiKey,
  PostgresStore,
  StoreRateLimiter,
} from '@firefinder/core';
import { migrate, openDatabase, type Database } from '../../apps/api/src/db.ts';
import { realEmbedder, silentLogger } from '../helpers/context.ts';

let pglite: PGlite;
let server: PGLiteSocketServer;
let db: Database;
let app: ReturnType<typeof createApp>;
let key: string;
let adminKey: string;

async function call(method: string, path: string, body?: unknown, apiKey = key, clientId = 'pgjs-client-1') {
  const res = await app.request(path, {
    method,
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json', 'x-firefinder-client': clientId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  pglite = await PGlite.create({ extensions: { vector } });
  server = new PGLiteSocketServer({ db: pglite, port: 0, host: '127.0.0.1' });
  await server.start();
  // Same adapter and options as production behind a transaction pooler.
  db = await openDatabase(`postgres://postgres@${server.getServerConn()}/postgres`, { prepare: false, poolMax: 1 });
  await migrate(db);

  const store = new PostgresStore(db.sql);
  const service = new FireFinderService({ store, embedder: realEmbedder(), config: { voterSecret: 'pgjs-voter-secret-0123456789' } });
  app = createApp({
    service,
    authenticator: new ApiKeyAuthenticator(store),
    rateLimiter: new StoreRateLimiter(store, 'pgjs-rate-secret-0123456789'),
    logger: silentLogger,
  });

  const created = async (scopes: Array<'read' | 'write' | 'admin'>) => {
    const generated = generateApiKey();
    await store.createApiKey({ name: 'pgjs', keyPrefix: generated.prefix, keyHash: await hashApiKey(generated.key), scopes });
    return generated.key;
  };
  key = await created(['read', 'write']);
  adminKey = await created(['admin']);
});

afterAll(async () => {
  await db?.close();
  await server?.stop();
  await pglite?.close();
});

describe('postgres.js driver', () => {
  let id: string;

  it('stores API key scopes as a real array', async () => {
    const rows = await db.sql.query<{ scopes: string[] }>(
      `select to_jsonb(scopes) as scopes from firefinder.api_keys where name = 'pgjs' order by created_at`,
    );
    expect(rows.map((r) => r.scopes)).toEqual([['read', 'write'], ['admin']]);
  });

  it('searches an empty database', async () => {
    const res = await call('POST', '/search', { problem: 'My application keeps crashing with ERR_DLOPEN_FAILED', error_message: 'ERR_DLOPEN_FAILED' });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it('submits with vectors and error signatures', async () => {
    const res = await call('POST', '/solutions', {
      problem: 'Application crashes on startup with ERR_DLOPEN_FAILED after upgrading Node.js',
      solution: 'Run `npm rebuild` so native modules match the new Node version.',
      software: 'Node.js',
      operating_system: 'Windows 11',
      error_message: 'ERR_DLOPEN_FAILED',
      worked: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.solution).toMatchObject({ confirmation_count: 1, verification_status: 'verified' });
    id = res.body.solution.id;
    const [row] = await db.sql.query<{ error_signature: string[] }>(
      `select to_jsonb(error_signature) as error_signature from firefinder.solutions where id = $1`,
      [id],
    );
    expect(row!.error_signature).toEqual(['err_dlopen_failed']);
  });

  it('finds it by meaning and by error code, and merges duplicates', async () => {
    const found = await call('POST', '/search', { problem: "I'm getting ERR_DLOPEN_FAILED and my app keeps crashing" }, key, 'pgjs-client-2');
    expect(found.body.results[0]).toMatchObject({ id, confirmation_count: 1 });
    expect(found.body.results[0].similarity).toBeGreaterThan(0.83);

    const merged = await call(
      'POST',
      '/solutions',
      {
        problem: 'App crashes at startup with ERR_DLOPEN_FAILED after a Node.js upgrade',
        solution: 'Run `npm rebuild` so native modules match the new Node version.',
        operating_system: 'Windows 11',
        worked: true,
      },
      key,
      'pgjs-client-2',
    );
    expect(merged.body).toMatchObject({ outcome: 'merged', solution: { id, confirmation_count: 2 } });
  });

  it('records confirmations and reports atomically', async () => {
    const confirmed = await call('POST', `/solutions/${id}/confirm`, {}, key, 'pgjs-client-3');
    expect(confirmed.body.solution.confirmation_count).toBe(3);
    const reported = await call('POST', `/solutions/${id}/report`, { note: 'fails on ARM64' }, key, 'pgjs-client-4');
    expect(reported.body.solution).toMatchObject({ confirmation_count: 3, failure_count: 1 });
  });

  it('reads by FIRE number, lists, and moderates', async () => {
    const byNumber = await call('GET', '/solutions/1');
    expect(byNumber.body.solution.id).toBe(id);
    const list = await call('GET', '/solutions?limit=5');
    expect(list.body.solutions).toHaveLength(1);
    const disabled = await call('POST', `/admin/solutions/${id}/status`, { status: 'disabled' }, adminKey);
    expect(disabled.body.solution.status).toBe('disabled');
    expect((await call('GET', `/solutions/${id}`)).status).toBe(404);
  });

  it('counts rate limits in the database', async () => {
    const [row] = await db.sql.query<{ n: number }>(`select count(*)::int as n from firefinder.rate_limit_buckets`);
    expect(Number(row!.n)).toBeGreaterThan(0);
  });
});
