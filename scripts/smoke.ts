/**
 * Smoke test for a running FireFinder API (local or deployed).
 *
 *   FIREFINDER_API_URL=... FIREFINDER_API_KEY=... npm run smoke
 *   npm run smoke -- --write     also submit, confirm and report a clearly
 *                                labelled test record (disabled afterwards
 *                                when FIREFINDER_ADMIN_KEY is set)
 */
import { parseArgs } from 'node:util';
import { FireFinderClient } from '@firefinder/client';

const { values } = parseArgs({ options: { write: { type: 'boolean', default: false } } });
const baseUrl = process.env.FIREFINDER_API_URL ?? 'http://localhost:8787';
const apiKey = process.env.FIREFINDER_API_KEY;
if (!apiKey) {
  console.error('Set FIREFINDER_API_KEY (and FIREFINDER_API_URL for a deployed API).');
  process.exit(1);
}

const run = `smoke-${Date.now().toString(36)}`;
const region = process.env.FIREFINDER_API_REGION || undefined;
const client = (id: string) => new FireFinderClient({ baseUrl, apiKey, clientId: `${run}-${id}`, region });

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await fn();
  console.log(`✓ ${label} (${Math.round(performance.now() - started)} ms)`);
  return result;
}

const health = await timed('health', () => client('a').health());
console.log(`  version ${health.version}, embeddings ${health.embedding_model}`);

// The first search on a cold instance loads the model; the second shows steady-state latency.
await timed('search (cold)', () => client('a').search({ problem: 'My Windows Bluetooth disappeared' }));
const found = await timed('search (warm)', () => client('a').search({ problem: 'Bluetooth is gone from my Windows laptop' }));
console.log(`  ${found.results.length} result(s), server time ${found.took_ms} ms`);

if (values.write) {
  const created = await timed('submit', () =>
    client('a').submit({
      problem: `[smoke test ${run}] FireFinder smoke test record, safe to delete`,
      solution: 'This record verifies the FireFinder write path. It is not a real solution.',
      worked: false,
      source: 'smoke-test',
    }),
  );
  const id = created.solution.id;
  await timed('confirm', () => client('b').confirm(id));
  const reported = await timed('report', () => client('c').report(id, { note: 'smoke test' }));
  const { confirmation_count, failure_count } = reported.solution;
  if (confirmation_count !== 1 || failure_count !== 1) throw new Error(`unexpected counts ${confirmation_count}/${failure_count}`);
  console.log(`  FIRE #${created.solution.fire_number}: ✓ ${confirmation_count} ✕ ${failure_count}`);

  const adminKey = process.env.FIREFINDER_ADMIN_KEY;
  if (adminKey) {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/admin/solutions/${id}/status`, {
      method: 'POST',
      headers: { 'x-api-key': adminKey, 'content-type': 'application/json', ...(region ? { 'x-region': region } : {}) },
      body: JSON.stringify({ status: 'disabled' }),
    });
    console.log(res.ok ? '✓ test record disabled' : `! could not disable test record (HTTP ${res.status})`);
  } else {
    console.log(`  (set FIREFINDER_ADMIN_KEY to disable test records automatically; id ${id})`);
  }
}

console.log('\n🔥 FireFinder smoke test passed.');
