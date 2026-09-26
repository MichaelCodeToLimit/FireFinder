import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../apps/api/src/db.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

describe('privacy filtering on submission', () => {
  it('stores redacted text and reports what was removed', async () => {
    const res = await ctx.request('POST', '/solutions', {
      clientId: 'privacy-client-1',
      body: {
        problem: 'App at C:\\Users\\jsmith\\AppData\\Local\\MyApp fails to log in; support said email jane.doe@example.com',
        solution: 'Regenerate the token and set API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz123456 in the .env file, then restart.',
        error_message: 'POST https://admin:hunter2@api.example.com/login -> 401',
        software: 'MyApp',
        worked: true,
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.redactions).toEqual(expect.arrayContaining(['username_in_path', 'email', 'api_key', 'url_credentials']));
    expect(res.body.solution.problem).toContain('C:\\Users\\<user>\\AppData');
    expect(res.body.solution.problem).toContain('[REDACTED_EMAIL]');

    // Nothing sensitive reaches the database, in any column.
    const [row] = await ctx.db.sql.query<Record<string, string>>(
      `select problem, solution, error_message from firefinder.solutions where id = $1`,
      [res.body.solution.id],
    );
    const stored = JSON.stringify(row);
    for (const secret of ['jsmith', 'jane.doe@example.com', 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz123456', 'hunter2']) {
      expect(stored).not.toContain(secret);
    }
  });

  it('stores votes with an anonymous hash, never the raw client identifier', async () => {
    const rows = await ctx.db.sql.query<{ voter_hash: string }>(`select voter_hash from firefinder.solution_confirmations`);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.voter_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.voter_hash).not.toContain('privacy-client-1');
    }
  });

  it('redacts feedback notes too', async () => {
    const created = await ctx.request('POST', '/solutions', {
      body: { problem: 'Printer prints blank pages over Wi-Fi', solution: 'Reinstall the printer driver and clear the spooler.', worked: false },
    });
    await ctx.request('POST', `/solutions/${created.body.solution.id}/report`, {
      clientId: 'privacy-client-2',
      body: { note: 'Still broken, email me at bob@example.org' },
    });
    const [row] = await ctx.db.sql.query<{ note: string }>(
      `select note from firefinder.solution_confirmations where solution_id = $1`,
      [created.body.solution.id],
    );
    expect(row!.note).toBe('Still broken, email me at [REDACTED_EMAIL]');
  });

  it('has no column that could hold a conversation or a person', async () => {
    const columns = await ctx.db.sql.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_schema = 'firefinder'`,
    );
    const names = columns.map((c) => c.column_name);
    for (const forbidden of ['conversation', 'transcript', 'messages', 'email', 'user_id', 'ip_address', 'name_of_user']) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe('database security and portability', () => {
  it('enables row level security on every FireFinder table', async () => {
    const rows = await ctx.db.sql.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relnamespace = 'firefinder'::regnamespace and relkind = 'r'`,
    );
    // solutions, confirmations, api keys, rate limits, migrations, oauth codes, oauth grants
    expect(rows.length).toBe(7);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
  });

  it('gives Supabase Data API roles no access to tables or functions', async () => {
    const rows = await ctx.db.sql.query<{ role: string; schema_usage: boolean; can_select: boolean; can_execute: boolean }>(
      `select r.rolname as role,
              has_schema_privilege(r.rolname, 'firefinder', 'USAGE') as schema_usage,
              has_table_privilege(r.rolname, 'firefinder.solutions', 'SELECT') as can_select,
              has_function_privilege(r.rolname, 'firefinder.rate_limit_hit(text, integer)', 'EXECUTE') as can_execute
       from pg_roles r where r.rolname in ('anon', 'authenticated')`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ schema_usage: false, can_select: false, can_execute: false });
  });

  it('pins search_path on every function', async () => {
    const rows = await ctx.db.sql.query<{ proname: string; proconfig: string[] | null }>(
      `select proname, proconfig from pg_proc where pronamespace = 'firefinder'::regnamespace`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) expect(row.proconfig).toEqual(expect.arrayContaining(['search_path=""']));
  });

  it('enforces constraints at the database level too', async () => {
    await expect(
      ctx.db.sql.query(`update firefinder.solutions set status = 'deleted' where fire_number = 1`),
    ).rejects.toThrow(/solutions_status_check/);
    await expect(
      ctx.db.sql.query(`update firefinder.solutions set confirmation_count = -1 where fire_number = 1`),
    ).rejects.toThrow(/solutions_counts_nonnegative/);
  });

  it('uses an HNSW index for vector search', async () => {
    const rows = await ctx.db.sql.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname = 'firefinder' and indexname = 'solutions_embedding_hnsw_idx'`,
    );
    expect(rows[0]!.indexdef).toMatch(/USING hnsw \(embedding extensions\.vector_cosine_ops\)/);
  });

  it('migrations are idempotent', async () => {
    expect(await migrate(ctx.db)).toEqual([]);
  });
});
