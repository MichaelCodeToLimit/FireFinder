import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SqlClient } from '@firefinder/core';

export interface Database {
  readonly kind: 'postgres' | 'pglite';
  readonly sql: SqlClient;
  /** Runs a multi-statement script (migrations). */
  exec(script: string): Promise<void>;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  /** Max pooled connections (postgres only). */
  poolMax?: number;
  /**
   * Use prepared statements. Must be false behind a transaction-mode pooler
   * (Supabase port 6543). "auto" disables them for port 6543.
   */
  prepare?: boolean | 'auto';
}

/**
 * Opens the database named by `url`:
 *   postgres://... / postgresql://...   PostgreSQL (Supabase, self-hosted)
 *   pglite://memory                     in-memory PGlite (tests)
 *   pglite://<dir>                      on-disk PGlite (zero-setup local dev)
 */
export async function openDatabase(url: string, options: DatabaseOptions = {}): Promise<Database> {
  if (url.startsWith('pglite://')) return openPglite(url.slice('pglite://'.length));
  if (/^postgres(ql)?:\/\//.test(url)) return openPostgres(url, options);
  throw new Error('DATABASE_URL must start with postgres://, postgresql:// or pglite://');
}

async function openPostgres(url: string, options: DatabaseOptions): Promise<Database> {
  const { default: postgres } = await import('postgres');
  const parsed = new URL(url);
  const local = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  const prepare = options.prepare === 'auto' || options.prepare === undefined ? parsed.port !== '6543' : options.prepare;

  const sql = postgres(url, {
    max: options.poolMax ?? 10,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare,
    // The store parses arrays itself; skipping postgres.js's type lookup saves a query per new connection.
    fetch_types: false,
    ssl: parsed.searchParams.has('sslmode') || local ? undefined : 'require',
    onnotice: () => {},
    connection: { application_name: 'firefinder-api' },
  });

  return {
    kind: 'postgres',
    sql: {
      query: async <T>(text: string, params: unknown[] = []) =>
        [...(await sql.unsafe(text, params as never[]))] as T[],
    },
    exec: async (script) => {
      await sql.unsafe(script);
    },
    close: () => sql.end({ timeout: 5 }),
  };
}

async function openPglite(location: string): Promise<Database> {
  const [{ PGlite }, { vector }] = await Promise.all([
    import('@electric-sql/pglite'),
    import('@electric-sql/pglite-pgvector'),
  ]);
  const inMemory = location === '' || location === 'memory';
  if (!inMemory) mkdirSync(resolve(location), { recursive: true });
  const db = await PGlite.create(inMemory ? undefined : resolve(location), { extensions: { vector } });

  return {
    kind: 'pglite',
    sql: {
      query: async <T>(text: string, params: unknown[] = []) => (await db.query(text, params)).rows as T[],
    },
    exec: async (script) => {
      await db.exec(script);
    },
    close: () => db.close(),
  };
}

export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../supabase/migrations');

/**
 * Applies supabase/migrations/*.sql in order, recording each version.
 * Migrations are idempotent, so this is safe to combine with `supabase db push`.
 */
export async function migrate(db: Database, log: (message: string) => void = () => {}, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec(`
    create schema if not exists firefinder;
    create table if not exists firefinder.schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    );
    alter table firefinder.schema_migrations enable row level security;
  `);
  const applied = new Set(
    (await db.sql.query<{ version: string }>('select version from firefinder.schema_migrations')).map((row) => row.version),
  );
  const newlyApplied: string[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) {
    const version = file.split('_')[0]!;
    if (!/^\d+$/.test(version)) throw new Error(`Migration file names must start with a numeric version: ${file}`);
    if (applied.has(version)) continue;
    const script = readFileSync(join(dir, file), 'utf8');
    await db.exec(`begin;\n${script}\ninsert into firefinder.schema_migrations (version) values ('${version}');\ncommit;`);
    newlyApplied.push(file);
    log(`applied migration ${file}`);
  }
  return newlyApplied;
}
