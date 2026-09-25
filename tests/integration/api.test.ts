import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryRateLimiter, StoreRateLimiter } from '@firefinder/core';
import { createTestContext, type TestContext } from '../helpers/context.ts';

const blenderFix = {
  problem: 'Blender crashes when rendering with Cycles on the GPU',
  solution: 'Update the NVIDIA driver, then in Preferences > System switch Cycles Render Devices from OptiX to CUDA.',
  software: 'Blender',
  operating_system: 'Windows 11',
  software_version: '4.1',
  error_message: 'EXCEPTION_ACCESS_VIOLATION',
  worked: true,
};

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

describe('GET /health', () => {
  it('reports status without authentication', async () => {
    const res = await ctx.request('GET', '/health', { key: null });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'firefinder', embedding_model: 'gte-small' });
  });
});

describe('authentication', () => {
  it('rejects requests without a key', async () => {
    const res = await ctx.request('POST', '/search', { key: null, body: { problem: 'anything at all' } });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('rejects unknown and malformed keys', async () => {
    for (const key of ['ff_doesnotexist0000000000000000000000000', 'not-a-key']) {
      const res = await ctx.request('POST', '/search', { key, body: { problem: 'anything at all' } });
      expect(res.status).toBe(401);
    }
  });

  it('accepts the X-API-Key header', async () => {
    const res = await ctx.request('POST', '/search', {
      key: null,
      headers: { 'x-api-key': ctx.keys.read },
      body: { problem: 'anything at all' },
    });
    expect(res.status).toBe(200);
  });

  it('enforces scopes: a read-only key cannot write', async () => {
    const res = await ctx.request('POST', '/solutions', { key: ctx.keys.read, body: blenderFix });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  it('rejects revoked keys', async () => {
    const key = await ctx.createKey(['read'], 'to-revoke');
    await ctx.db.sql.query(`update firefinder.api_keys set revoked_at = now() where name = 'to-revoke'`);
    const res = await ctx.request('POST', '/search', { key, body: { problem: 'anything at all' } });
    expect(res.status).toBe(401);
  });

  it('caches key lookups but drops revoked keys once the cache expires', async () => {
    const { ApiKeyAuthenticator } = await import('@firefinder/core');
    let now = 0;
    const authenticator = new ApiKeyAuthenticator(ctx.store, { cacheTtlMs: 1000 }, () => now);
    const key = await ctx.createKey(['read'], 'cached-then-revoked');
    expect(await authenticator.authenticate(key)).not.toBeNull();

    await ctx.db.sql.query(`update firefinder.api_keys set revoked_at = now() where name = 'cached-then-revoked'`);
    expect(await authenticator.authenticate(key)).not.toBeNull(); // still cached
    now = 1001;
    expect(await authenticator.authenticate(key)).toBeNull();
  });
});

describe('invalid requests', () => {
  it.each([
    ['missing problem', { solution: 'Do the thing properly', worked: true }],
    ['problem too short', { ...blenderFix, problem: 'crash' }],
    ['solution too long', { ...blenderFix, solution: 'x'.repeat(5001) }],
    ['worked missing', { problem: blenderFix.problem, solution: blenderFix.solution }],
    ['worked not boolean', { ...blenderFix, worked: 'yes' }],
    ['unknown field', { ...blenderFix, conversation: 'full chat transcript' }],
    ['bad source', { ...blenderFix, source: 'Claude Desktop!' }],
  ])('rejects %s', async (_name, body) => {
    const res = await ctx.request('POST', '/solutions', { body });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
    expect(res.body.error.details.length).toBeGreaterThan(0);
  });

  it('rejects malformed JSON', async () => {
    const res = await ctx.request('POST', '/search', { rawBody: '{"problem": ' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_json');
  });

  it('rejects oversized bodies', async () => {
    const res = await ctx.request('POST', '/search', { rawBody: JSON.stringify({ problem: 'x'.repeat(70_000) }) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('payload_too_large');
  });

  it('rejects malformed ids and client ids', async () => {
    expect((await ctx.request('GET', '/solutions/not-an-id')).status).toBe(400);
    expect((await ctx.request('POST', '/search', { clientId: 'bad id!', body: { problem: 'anything at all' } })).status).toBe(400);
  });

  it('returns JSON 404 for unknown routes and solutions', async () => {
    expect((await ctx.request('GET', '/nope')).body.error.code).toBe('not_found');
    const res = await ctx.request('GET', '/solutions/018f0000-0000-7000-8000-000000000000');
    expect(res.status).toBe(404);
  });
});

describe('solutions lifecycle', () => {
  let id: string;
  let fireNumber: number;

  it('creates a verified solution when the user confirmed it worked', async () => {
    const res = await ctx.request('POST', '/solutions', { body: { ...blenderFix, source: 'claude-mcp' }, clientId: 'install-A-123' });
    expect(res.status).toBe(201);
    expect(res.body.outcome).toBe('created');
    expect(res.body.solution).toMatchObject({
      problem: blenderFix.problem,
      software: 'Blender',
      operating_system: 'Windows 11',
      confirmation_count: 1,
      failure_count: 0,
      status: 'active',
      verification_status: 'verified',
    });
    expect(res.body.solution.last_confirmed_at).not.toBeNull();
    expect(res.body.solution).not.toHaveProperty('embedding');
    id = res.body.solution.id;
    fireNumber = res.body.solution.fire_number;
  });

  it('stores an unconfirmed submission as a candidate', async () => {
    const res = await ctx.request('POST', '/solutions', {
      body: {
        problem: 'Docker Desktop is stuck on "Starting the Docker Engine" forever',
        solution: 'Run `wsl --update`, then `wsl --shutdown`, then restart Docker Desktop.',
        software: 'Docker Desktop',
        operating_system: 'Windows 11',
        worked: false,
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.solution).toMatchObject({ confirmation_count: 0, verification_status: 'candidate', last_confirmed_at: null });
  });

  it('retrieves a solution by id and by FIRE number', async () => {
    const byId = await ctx.request('GET', `/solutions/${id}`, { key: ctx.keys.read });
    const byNumber = await ctx.request('GET', `/solutions/${fireNumber}`, { key: ctx.keys.read });
    expect(byId.status).toBe(200);
    expect(byId.body.solution.id).toBe(id);
    expect(byNumber.body.solution.id).toBe(id);
  });

  it('confirms: increments confirmation_count once per voter', async () => {
    const first = await ctx.request('POST', `/solutions/${id}/confirm`, { clientId: 'install-B-456' });
    expect(first.status).toBe(200);
    expect(first.body.outcome).toBe('recorded');
    expect(first.body.solution.confirmation_count).toBe(2);

    const again = await ctx.request('POST', `/solutions/${id}/confirm`, { clientId: 'install-B-456' });
    expect(again.body.outcome).toBe('duplicate');
    expect(again.body.solution.confirmation_count).toBe(2);
  });

  it('reports failures: increments failure_count and records last_failed_at, without deleting', async () => {
    const res = await ctx.request('POST', `/solutions/${fireNumber}/report`, {
      clientId: 'install-C-789',
      body: { operating_system: 'Windows 10', note: 'Did not help on my older GPU' },
    });
    expect(res.status).toBe(200);
    expect(res.body.solution).toMatchObject({ confirmation_count: 2, failure_count: 1, status: 'active' });
    expect(res.body.solution.last_failed_at).not.toBeNull();

    const rows = await ctx.db.sql.query<{ result: string; operating_system: string; note: string }>(
      `select result, operating_system, note from firefinder.solution_confirmations where solution_id = $1 and result = 'failed'`,
      [id],
    );
    expect(rows).toEqual([{ result: 'failed', operating_system: 'Windows 10', note: 'Did not help on my older GPU' }]);
  });

  it('lets a voter change their mind', async () => {
    const res = await ctx.request('POST', `/solutions/${id}/confirm`, { clientId: 'install-C-789' });
    expect(res.body.outcome).toBe('changed');
    expect(res.body.solution).toMatchObject({ confirmation_count: 3, failure_count: 0 });
  });

  it('lists recent solutions', async () => {
    const res = await ctx.request('GET', '/solutions?limit=10', { key: ctx.keys.read });
    expect(res.status).toBe(200);
    expect(res.body.solutions.length).toBeGreaterThanOrEqual(2);
    expect(res.body.solutions[0].fire_number).toBeGreaterThan(res.body.solutions[1].fire_number);
  });
});

describe('moderation', () => {
  it('flags a solution for review after repeated failures instead of deleting it', async () => {
    const created = await ctx.request('POST', '/solutions', {
      body: {
        problem: 'Outlook search returns no results for recent emails',
        solution: 'Rebuild the search index from Control Panel > Indexing Options > Advanced > Rebuild.',
        software: 'Outlook',
        operating_system: 'Windows 11',
        worked: false,
      },
    });
    const id = created.body.solution.id;
    let last;
    for (let i = 0; i < 5; i++) {
      last = await ctx.request('POST', `/solutions/${id}/report`, { clientId: `failing-voter-${i}` });
    }
    expect(last!.body.solution).toMatchObject({ failure_count: 5, status: 'under_review' });
    expect((await ctx.request('GET', `/solutions/${id}`)).status).toBe(200);
  });

  it('lets admins disable a solution, which hides it from everyone else', async () => {
    const created = await ctx.request('POST', '/solutions', {
      body: {
        problem: 'Spam submission that moderators should remove from results',
        solution: 'Visit my totally legitimate website for the fix.',
        worked: false,
      },
    });
    const id = created.body.solution.id;

    expect((await ctx.request('POST', `/admin/solutions/${id}/status`, { body: { status: 'disabled' } })).status).toBe(403);
    const res = await ctx.request('POST', `/admin/solutions/${id}/status`, { key: ctx.keys.admin, body: { status: 'disabled' } });
    expect(res.status).toBe(200);
    expect(res.body.solution.status).toBe('disabled');

    expect((await ctx.request('GET', `/solutions/${id}`)).status).toBe(404);
    expect((await ctx.request('POST', `/solutions/${id}/confirm`)).status).toBe(404);
    expect((await ctx.request('GET', `/solutions/${id}`, { key: ctx.keys.admin })).status).toBe(200);
  });
});

describe('rate limiting', () => {
  it('returns 429 with Retry-After once a client exceeds its limit', async () => {
    const limited = await createTestContext({
      rateLimiter: new MemoryRateLimiter(),
      rateLimits: { read: { limit: 2, windowSeconds: 60 } },
    });
    try {
      const search = () => limited.request('POST', '/search', { key: limited.keys.read, clientId: 'client-one', body: { problem: 'anything at all' } });
      const first = await search();
      expect(first.status).toBe(200);
      expect(first.headers.get('ratelimit-limit')).toBe('2');
      expect(first.headers.get('ratelimit-remaining')).toBe('1');
      expect((await search()).status).toBe(200);

      const blocked = await search();
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('rate_limited');
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);

      // Other clients have their own budget.
      const other = await limited.request('POST', '/search', { key: limited.keys.read, clientId: 'client-two', body: { problem: 'anything at all' } });
      expect(other.status).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it('supports a database-backed limiter for serverless deployments', async () => {
    const shared = new StoreRateLimiter(ctx.store, 'rate-limit-secret-0123456789');
    const checks = [{ key: 'read:ip:203.0.113.9', limit: 2 }, { key: 'read:client:k:c', limit: 10 }];
    const rounds = [];
    for (let i = 0; i < 3; i++) rounds.push(await shared.hit(checks, 60));
    // Both buckets are counted in one statement, results in input order.
    expect(rounds.map(([ip]) => ip!.allowed)).toEqual([true, true, false]);
    expect(rounds.map(([, client]) => client!.remaining)).toEqual([9, 8, 7]);
    const keys = await ctx.db.sql.query<{ bucket_key: string }>('select bucket_key from firefinder.rate_limit_buckets');
    expect(keys.some((k) => k.bucket_key.includes('203.0.113.9'))).toBe(false);
  });
});
