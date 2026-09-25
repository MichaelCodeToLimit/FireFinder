/**
 * API key management.
 *
 *   npm run keys:create -- --name claude-desktop [--scopes read,write]
 *   npm run keys:create -- --list
 *   npm run keys:create -- --revoke ff_AbCdEfGh
 *
 * Only a SHA-256 hash of each key is stored; the key is printed once.
 * With a PGlite database, stop the dev server first (PGlite is single-process).
 */
import { parseArgs } from 'node:util';
import { API_SCOPES, generateApiKey, hashApiKey, PostgresStore, type ApiScope } from '@firefinder/core';
import { migrate, openDatabase } from '../apps/api/src/db.ts';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    scopes: { type: 'string', default: 'read,write' },
    list: { type: 'boolean', default: false },
    revoke: { type: 'string' },
  },
});

const url = process.env.DATABASE_URL ?? 'pglite://.data/firefinder';
const db = await openDatabase(url, { poolMax: 1 });

try {
  if (db.kind === 'pglite') await migrate(db);

  if (values.list) {
    const rows = await db.sql.query<Record<string, unknown>>(
      `select key_prefix, name, scopes, created_at, last_used_at, revoked_at from firefinder.api_keys order by created_at`,
    );
    console.table(rows);
  } else if (values.revoke) {
    const rows = await db.sql.query(
      `update firefinder.api_keys set revoked_at = now() where key_prefix = $1 and revoked_at is null returning key_prefix`,
      [values.revoke],
    );
    console.log(rows.length ? `Revoked ${values.revoke}. Running servers stop accepting it within a minute.` : `No active key with prefix ${values.revoke}.`);
  } else {
    if (!values.name) throw new Error('--name is required, e.g. --name claude-desktop');
    const scopes = values.scopes.split(',').map((s) => s.trim()) as ApiScope[];
    const invalid = scopes.filter((s) => !API_SCOPES.includes(s));
    if (invalid.length) throw new Error(`Unknown scope(s): ${invalid.join(', ')}. Valid: ${API_SCOPES.join(', ')}`);

    const { key, prefix } = generateApiKey();
    await new PostgresStore(db.sql).createApiKey({ name: values.name, keyPrefix: prefix, keyHash: await hashApiKey(key), scopes });
    console.log(`\nCreated API key "${values.name}" (${scopes.join(', ')}):\n\n  ${key}\n\nStore it now; it cannot be shown again.\n`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.close();
}
