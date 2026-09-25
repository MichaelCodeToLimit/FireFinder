import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey, PostgresStore } from '@firefinder/core';
import { createEdgeApp } from '../../apps/edge/src/handler.ts';
import type { Database } from '../../apps/api/src/db.ts';
import { createTestDatabase, realEmbedder, silentLogger } from '../helpers/context.ts';

// The Supabase Edge Function wiring, exercised under Node with PGlite standing
// in for the project database and transformers.js for Supabase.ai gte-small.

let db: Database;
let key: string;

const env = (values: Record<string, string>) => ({ get: (name: string) => values[name] });

function edgeApp(values: Record<string, string> = { SUPABASE_DB_URL: 'postgres://unused', FIREFINDER_VOTER_SECRET: 'edge-voter-secret-0123456789' }) {
  return createEdgeApp({ env: env(values), embedder: realEmbedder(), connect: () => db.sql, logger: silentLogger });
}

beforeAll(async () => {
  db = await createTestDatabase();
  const generated = generateApiKey();
  await new PostgresStore(db.sql).createApiKey({
    name: 'edge',
    keyPrefix: generated.prefix,
    keyHash: await hashApiKey(generated.key),
    scopes: ['read', 'write'],
  });
  key = generated.key;
});
afterAll(() => db.close());

describe('Supabase Edge Function app', () => {
  it('serves the API under /firefinder', async () => {
    const res = await edgeApp().request('/firefinder/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', embedding_model: 'gte-small' });
  });

  it('keeps JSON errors and auth when mounted under a base path', async () => {
    const res = await edgeApp().request('/firefinder/search', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthorized');
    const missing = await edgeApp().request('/elsewhere');
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('not_found');
  });

  it('runs the submit and search flow with database-backed rate limiting', async () => {
    const app = edgeApp();
    const headers = { 'x-api-key': key, 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' };
    const created = await app.request('/firefinder/solutions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        problem: 'Mac app will not open because Apple cannot verify the developer',
        solution: 'Open System Settings > Privacy & Security and click "Open Anyway" for the blocked app.',
        operating_system: 'macOS 14',
        worked: true,
      }),
    });
    expect(created.status).toBe(201);

    const found = await app.request('/firefinder/search', {
      method: 'POST',
      headers,
      body: JSON.stringify({ problem: "macOS won't let me open an app from an unidentified developer" }),
    });
    expect(found.status).toBe(200);
    expect(found.headers.get('ratelimit-limit')).toBe('60');
    const body = await found.json();
    expect(body.results[0].confirmation_count).toBe(1);

    // Rate limit buckets exist, but never contain an IP or client id in readable form.
    const buckets = await db.sql.query<{ bucket_key: string }>('select bucket_key from firefinder.rate_limit_buckets');
    expect(buckets.length).toBeGreaterThan(0);
    for (const { bucket_key } of buckets) {
      expect(bucket_key).toMatch(/^[0-9a-f]{40}$/);
      expect(bucket_key).not.toContain('198.51.100.7');
    }
  });

  it('answers 503 with a clear message when secrets are missing', async () => {
    const res = await edgeApp({ SUPABASE_DB_URL: 'postgres://unused' }).request('/firefinder/health');
    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toContain('FIREFINDER_VOTER_SECRET');
  });
});
