import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../helpers/context.ts';

let ctx: TestContext;
const ids: Record<string, string> = {};

async function seed(name: string, body: Record<string, unknown>, confirmations?: number, failures = 0) {
  const res = await ctx.request('POST', '/solutions', { body: { worked: true, ...body }, clientId: `seed-${name}` });
  expect(res.status).toBe(201);
  ids[name] = res.body.solution.id;
  if (confirmations !== undefined) {
    await ctx.db.sql.query(
      `update firefinder.solutions set confirmation_count = $2, failure_count = $3, last_confirmed_at = now() where id = $1`,
      [ids[name], confirmations, failures],
    );
  }
}

const search = (body: Record<string, unknown>) => ctx.request('POST', '/search', { key: ctx.keys.read, body });

beforeAll(async () => {
  ctx = await createTestContext();
  await seed(
    'bluetoothWin11',
    {
      problem: 'Bluetooth toggle disappeared from Windows settings after an update',
      solution: 'Open services.msc, start "Bluetooth Support Service" and set it to Automatic. If the adapter is still missing, uninstall it in Device Manager and reboot.',
      operating_system: 'Windows 11',
    },
    3,
  );
  await seed(
    'bluetoothWin10',
    {
      problem: 'Bluetooth option missing from Windows Action Center',
      solution: 'Run the Bluetooth troubleshooter from Settings > Update & Security > Troubleshoot, then reinstall the Intel Wireless Bluetooth driver.',
      operating_system: 'Windows 10',
    },
    1000,
  );
  await seed('vercel', {
    problem: 'Vercel deployment fails during build step with exit code 1',
    solution: 'Set the Build Command to `npm run build` and the Output Directory to `dist` in Project Settings, then redeploy.',
    software: 'Vercel',
  });
  await seed('gatekeeper', {
    problem: "My Mac app won't open because Apple cannot check it for malicious software",
    solution: 'Open System Settings > Privacy & Security, scroll down and click "Open Anyway" next to the blocked app.',
    operating_system: 'macOS 14',
  });
  await seed('blender', {
    problem: 'Blender crashes when rendering with Cycles on the GPU',
    solution: 'Update the NVIDIA driver, then switch Cycles Render Devices from OptiX to CUDA in Preferences > System.',
    software: 'Blender',
    operating_system: 'Windows 11',
  });
  await seed('openssl', {
    problem: 'npm start fails after upgrading Node.js',
    solution: 'Set NODE_OPTIONS=--openssl-legacy-provider or upgrade react-scripts/webpack to a version that supports OpenSSL 3.',
    software: 'Node.js',
    software_version: '18.17.0',
    error_message: 'Error: error:0308010C:digital envelope routines::unsupported ERR_OSSL_EVP_UNSUPPORTED',
  });
});
afterAll(() => ctx.close());

describe('semantic similarity', () => {
  it.each([
    'My Windows Bluetooth disappeared.',
    'Bluetooth is gone from my Windows laptop.',
    "Windows doesn't show Bluetooth anymore.",
  ])('recognizes "%s" as a known Bluetooth problem', async (problem) => {
    const res = await search({ problem });
    expect(res.status).toBe(200);
    expect([ids.bluetoothWin11, ids.bluetoothWin10]).toContain(res.body.results[0].id);
    expect(res.body.results[0].similarity).toBeGreaterThan(0.85);
  });

  it('finds the macOS fix from a differently worded question', async () => {
    const res = await search({ problem: 'macOS says the app is damaged or from an unidentified developer and refuses to launch' });
    expect(res.body.results[0].id).toBe(ids.gatekeeper);
  });

  it('returns nothing for questions that are not known problems', async () => {
    const res = await search({ problem: 'What is the capital of France?' });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it('returns the documented result shape', async () => {
    const res = await search({ problem: 'Blender crashes when I render with my GPU' });
    const [top] = res.body.results;
    expect(top).toMatchObject({
      id: ids.blender,
      problem: expect.any(String),
      solution: expect.any(String),
      similarity: expect.any(Number),
      score: expect.any(Number),
      confirmation_count: 1,
      failure_count: 0,
      verification_status: 'verified',
      environment_match: { software: 'unknown', operating_system: 'unknown', software_version: 'unknown' },
    });
    expect(typeof res.body.took_ms).toBe('number');
  });
});

describe('metadata-aware ranking', () => {
  it('ranks the Windows 11 fix first for a Windows 11 user despite far fewer confirmations', async () => {
    const res = await search({ problem: 'Bluetooth is gone from my Windows laptop', operating_system: 'Windows 11' });
    expect(res.body.results[0].id).toBe(ids.bluetoothWin11);
    expect(res.body.results[0].environment_match.operating_system).toBe('match');
    const win10 = res.body.results.find((r: { id: string }) => r.id === ids.bluetoothWin10);
    expect(win10.environment_match.operating_system).toBe('different_version');
  });

  it('ranks the Windows 10 fix first for a Windows 10 user', async () => {
    const res = await search({ problem: 'Bluetooth is gone from my Windows laptop', operating_system: 'Windows 10' });
    expect(res.body.results[0].id).toBe(ids.bluetoothWin10);
  });

  it('does not let popularity override a clearly closer match when no environment is given', async () => {
    // The Windows 11 record is the closer problem match (~0.93 vs ~0.89);
    // 1000 confirmations on the other record must not flip that.
    const res = await search({ problem: 'Bluetooth is gone from my Windows laptop' });
    const [first, second] = res.body.results;
    expect(first.id).toBe(ids.bluetoothWin11);
    expect(first.similarity).toBeGreaterThan(second.similarity);
    expect(second.id).toBe(ids.bluetoothWin10);
    expect(second.confirmation_count).toBe(1000);
  });

  it('filters out solutions for different software', async () => {
    const res = await search({ problem: 'App crashes as soon as I start rendering on the GPU', software: 'Photoshop' });
    expect(res.body.results.map((r: { id: string }) => r.id)).not.toContain(ids.blender);
  });

  it('matches exact error codes even when the description is vague', async () => {
    const res = await search({
      problem: 'my dev server will not start',
      error_message: 'ERR_OSSL_EVP_UNSUPPORTED',
    });
    expect(res.body.results[0].id).toBe(ids.openssl);
  });

  it('demotes solutions that keep failing', async () => {
    const before = await search({ problem: 'Mac app will not open, blocked by Gatekeeper' });
    await ctx.db.sql.query(`update firefinder.solutions set confirmation_count = 1, failure_count = 30 where id = $1`, [ids.gatekeeper]);
    const after = await search({ problem: 'Mac app will not open, blocked by Gatekeeper' });
    expect(after.body.results[0].score).toBeLessThan(before.body.results[0].score);
    await ctx.db.sql.query(`update firefinder.solutions set confirmation_count = 1, failure_count = 0 where id = $1`, [ids.gatekeeper]);
  });

  it('respects the limit and min_similarity parameters', async () => {
    const limited = await search({ problem: 'Bluetooth is gone from my Windows laptop', limit: 1 });
    expect(limited.body.results).toHaveLength(1);
    const strict = await search({ problem: 'Bluetooth is gone from my Windows laptop', min_similarity: 0.999 });
    expect(strict.body.results).toEqual([]);
  });
});

describe('search is read-only', () => {
  it('stores nothing about the query', async () => {
    const count = async () =>
      (await ctx.db.sql.query<{ n: number }>(
        `select (select count(*) from firefinder.solutions) + (select count(*) from firefinder.solution_confirmations) as n`,
      ))[0]!.n;
    const before = Number(await count());
    await search({ problem: 'My printer at jane@example.com prints blank pages', software: 'HP Smart' });
    expect(Number(await count())).toBe(before);
  });
});
