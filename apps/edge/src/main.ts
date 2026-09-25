/**
 * Supabase Edge Function entry point (Deno).
 * `npm run build:edge` bundles this into supabase/functions/firefinder/index.js.
 *
 * Secrets (supabase secrets set ...):
 *   FIREFINDER_VOTER_SECRET   required, 16+ random characters
 *   FIREFINDER_DB_REGION      optional, the database's region (e.g. ap-southeast-1):
 *                             database-bound requests are forwarded there
 *   FIREFINDER_OAUTH_SECRET   optional, signs remote-MCP OAuth tokens
 *                             (defaults to FIREFINDER_VOTER_SECRET)
 * Provided by the platform:
 *   SUPABASE_DB_URL           Postgres connection string
 *   SUPABASE_URL              public project URL (remote MCP issuer)
 *   SB_REGION                 region this instance runs in
 */
import postgres from 'postgres';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, type Embedder } from '@firefinder/core';
import { TokenSigner } from '@firefinder/mcp/remote';
import { createEdgeApp, edgePublicUrl, routeByRegion } from './handler.ts';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Response | Promise<Response>): unknown;
};

declare const Supabase: {
  ai: {
    Session: new (model: string) => {
      run(input: string, options: { mean_pool: boolean; normalize: boolean }): Promise<ArrayLike<number>>;
    };
  };
};

// Built into the Edge Runtime: gte-small inference without any external API call.
const session = new Supabase.ai.Session('gte-small');

const embedder: Embedder = {
  model: EMBEDDING_MODEL,
  dimensions: EMBEDDING_DIMENSIONS,
  embed: (texts) =>
    Promise.all(texts.map(async (text) => Array.from(await session.run(text, { mean_pool: true, normalize: true })))),
};

const app = createEdgeApp({
  env: Deno.env,
  embedder,
  connect: (databaseUrl) => {
    // Transaction-mode pooling: prepared statements must be disabled.
    // Workers are short-lived, so connection setup dominates: use exactly one
    // connection per worker (queries run sequentially anyway) and skip
    // postgres.js's type-lookup query on connect.
    const sql = postgres(databaseUrl, { prepare: false, fetch_types: false, max: 1, idle_timeout: 20, connect_timeout: 10 });
    return {
      query: async <T>(text: string, params: unknown[] = []) => [...(await sql.unsafe(text, params as never[]))] as T[],
    };
  },
});

const env = Deno.env;
const publicUrl = edgePublicUrl(env);
const signingSecret = env.get('FIREFINDER_OAUTH_SECRET') ?? env.get('FIREFINDER_VOTER_SECRET');
const signer = signingSecret && signingSecret.length >= 16 ? new TokenSigner(signingSecret) : null;

Deno.serve(async (request) => {
  if (!publicUrl || !signer) return app.fetch(request);
  const routed = await routeByRegion(request, {
    databaseRegion: env.get('FIREFINDER_DB_REGION'),
    currentRegion: env.get('SB_REGION'),
    publicUrl,
    basePath: '/firefinder',
    signer,
    fetch,
  });
  return routed instanceof Response ? routed : app.fetch(routed);
});
