import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((value) => value === 'true');

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(8787),
  HOST: z.string().default('127.0.0.1'),
  /** postgres://... (Supabase / self-hosted) or pglite://<dir> for zero-setup local development. */
  DATABASE_URL: z.string().default('pglite://.data/firefinder'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DB_PREPARE: z.enum(['auto', 'true', 'false']).default('auto'),
  AUTO_MIGRATE: bool.optional(),
  FIREFINDER_VOTER_SECRET: z.string().min(16, 'FIREFINDER_VOTER_SECRET must be at least 16 characters').optional(),
  EMBEDDING_DTYPE: z.enum(['q8', 'fp16', 'fp32']).default('q8'),
  EMBEDDING_CACHE_DIR: z.string().default('.cache/models'),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: bool.default(false),
  RATE_LIMIT_READ_PER_MINUTE: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_WRITE_PER_MINUTE: z.coerce.number().int().min(1).default(20),
  DEV_CONSOLE: bool.default(true),
  /** Public base URL of this server (OAuth issuer; the MCP endpoint is <url>/mcp). */
  FIREFINDER_PUBLIC_URL: z.url().optional(),
  /** Signs remote-MCP OAuth tokens; defaults to the voter secret (keys are domain-separated). */
  FIREFINDER_OAUTH_SECRET: z.string().min(16).optional(),
  MCP_READ_PER_MINUTE: z.coerce.number().int().min(1).default(60),
  MCP_WRITE_PER_MINUTE: z.coerce.number().int().min(1).default(20),
  MCP_IDENTITIES_PER_IP_PER_HOUR: z.coerce.number().int().min(1).default(10),
});

export interface ServerConfig {
  port: number;
  host: string;
  databaseUrl: string;
  dbPoolMax: number;
  dbPrepare: boolean | 'auto';
  autoMigrate: boolean;
  voterSecret: string;
  embeddingDtype: 'q8' | 'fp16' | 'fp32';
  embeddingCacheDir: string;
  corsOrigins: string[];
  trustProxy: boolean;
  rateLimits: { readPerMinute: number; writePerMinute: number };
  devConsole: boolean;
  publicUrl: string;
  oauthSecret: string;
  mcp: { readPerMinute: number; writePerMinute: number; identitiesPerIpPerHour: number };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  // `KEY=` in a .env file means "not set", not "empty string".
  const defined = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ''));
  const parsed = EnvSchema.safeParse(defined);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(`Invalid FireFinder configuration:\n${problems}`);
  }
  const e = parsed.data;
  const pglite = e.DATABASE_URL.startsWith('pglite://');
  const voterSecret = e.FIREFINDER_VOTER_SECRET ?? localVoterSecret(e.DATABASE_URL);

  return {
    port: e.PORT,
    host: e.HOST,
    databaseUrl: e.DATABASE_URL,
    dbPoolMax: e.DB_POOL_MAX,
    dbPrepare: e.DB_PREPARE === 'auto' ? 'auto' : e.DB_PREPARE === 'true',
    // Local PGlite databases migrate themselves; shared databases are migrated explicitly.
    autoMigrate: e.AUTO_MIGRATE ?? pglite,
    voterSecret,
    embeddingDtype: e.EMBEDDING_DTYPE,
    embeddingCacheDir: resolve(e.EMBEDDING_CACHE_DIR),
    corsOrigins: e.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
    trustProxy: e.TRUST_PROXY,
    rateLimits: { readPerMinute: e.RATE_LIMIT_READ_PER_MINUTE, writePerMinute: e.RATE_LIMIT_WRITE_PER_MINUTE },
    devConsole: e.DEV_CONSOLE,
    publicUrl: (e.FIREFINDER_PUBLIC_URL ?? `http://localhost:${e.PORT}`).replace(/\/+$/, ''),
    oauthSecret: e.FIREFINDER_OAUTH_SECRET ?? voterSecret,
    mcp: {
      readPerMinute: e.MCP_READ_PER_MINUTE,
      writePerMinute: e.MCP_WRITE_PER_MINUTE,
      identitiesPerIpPerHour: e.MCP_IDENTITIES_PER_IP_PER_HOUR,
    },
  };
}

/**
 * For local PGlite databases only: keep a generated voter secret next to the
 * data so one-vote-per-voter survives restarts. Shared databases must set
 * FIREFINDER_VOTER_SECRET explicitly.
 */
function localVoterSecret(databaseUrl: string): string {
  if (!databaseUrl.startsWith('pglite://')) {
    throw new Error('FIREFINDER_VOTER_SECRET is required when using a shared PostgreSQL database (generate one with: openssl rand -hex 32).');
  }
  const location = databaseUrl.slice('pglite://'.length);
  if (location === '' || location === 'memory') return randomBytes(32).toString('hex');
  const file = resolve(dirname(resolve(location)), 'voter-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dirname(file), { recursive: true });
  const secret = randomBytes(32).toString('hex');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
