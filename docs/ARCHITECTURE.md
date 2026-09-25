# Architecture

## Goals, in order

1. **The core loop works reliably:** search → present → confirm/report → remember.
2. **Fast:** one local embedding plus one SQL round trip per search. No AI API calls.
3. **Private by default:** only generalized problem/solution text is stored.
4. **Portable:** Supabase for the hosted instance, but nothing depends on it.

## Components

```text
┌───────────────────────── integrations ──────────────────────────┐
│ packages/mcp      MCP server for Claude Desktop / Claude Code   │
│                   (tools + usage instructions + result format)  │
│ integrations/     Messages API tool definitions + system prompt │
│   claude          (generated from packages/mcp)                 │
│ packages/client   typed HTTP client; the only way integrations  │
│                   talk to FireFinder                            │
└───────────────────────────────┬─────────────────────────────────┘
                                │ HTTPS, X-API-Key, X-FireFinder-Client
┌───────────────────────────────▼─────────────────────────────────┐
│ packages/core (runtime-agnostic, Web APIs only)                 │
│   http.ts         Hono app: routes, auth, rate limits, errors   │
│   service.ts      search / submit / confirm / report / moderate │
│   schemas.ts      zod request validation + response types       │
│   privacy.ts      sanitize + redact                             │
│   normalize.ts    OS / software / version / error signatures    │
│   ranking.ts      scoring (pure)                                │
│   dedupe.ts       duplicate detection (pure)                    │
│   auth.ts         API keys (hashed), scopes, cache              │
│   rate-limit.ts   RateLimiter: memory | Postgres | noop         │
│   store.ts        SolutionStore interface                       │
│   postgres-store  SolutionStore over a one-method SqlClient     │
│   embedding.ts    Embedder interface + LRU cache                │
├────────────────────────────┬────────────────────────────────────┤
│ apps/api (Node)            │ apps/edge (Supabase Edge Function) │
│  postgres.js or PGlite     │  postgres.js (npm:) via            │
│  transformers.js gte-small │  SUPABASE_DB_URL                   │
│  MemoryRateLimiter         │  Supabase.ai gte-small             │
│  developer console         │  StoreRateLimiter (Postgres)       │
└────────────────────────────┴───────────────┬────────────────────┘
                                             │ SQL
┌────────────────────────────────────────────▼────────────────────┐
│ PostgreSQL + pgvector (supabase/migrations)                     │
│   firefinder.solutions            HNSW(embedding), GIN(errors)  │
│   firefinder.solution_confirmations  one vote per voter_hash    │
│   firefinder.api_keys             SHA-256 hashes, scopes        │
│   firefinder.rate_limit_buckets   unlogged, HMAC keys           │
│   search_candidates() record_feedback() rate_limit_hit()        │
└─────────────────────────────────────────────────────────────────┘
```

## Request flows

### Search: `POST /search`

1. Authenticate: SHA-256 the key and check the cache (60 s TTL); the database is consulted only on a miss.
2. Rate-limit per client and per IP.
3. Validate (zod), sanitize, redact. The query is never stored.
4. Normalize the environment (software key, OS family/version, version major) and extract error signatures.
5. Embed `software + problem + error` with gte-small: ~2–5 ms on CPU, cached by an LRU.
6. Run **one** SQL call, `firefinder.search_candidates`, for HNSW neighbours ∪ error-code matches.
7. Filter and rank in memory, then return the top N.

Measured locally (PGlite): about 7 ms server time and 22 ms round trip.

### Submit: `POST /solutions`

1. Steps 1–4 above, plus `worked` must be stated explicitly.
2. Embed the problem and the solution (one batched call).
3. Fetch candidates, including solution similarity, with one SQL call.
4. `findDuplicate()`:
   - A match plus `worked` → `record_feedback('worked')` on the existing record (**merged**).
   - A match without `worked` → return the existing record unchanged (**duplicate**).
   - No match → insert the solution and its initial vote in **one statement** (CTE); **created**.

### Confirm / report

`firefinder.record_feedback()` runs as one plpgsql function:

1. Lock the solution row.
2. Apply the one-vote-per-voter logic (new, changed or duplicate).
3. Update counters and `last_confirmed_at` / `last_failed_at`.
4. Apply the moderation hook (`under_review` after repeated failures).

Everything happens atomically and is consistent under concurrency.

## Key decisions

| Decision | Why |
|---|---|
| Direct Postgres, not PostgREST | One round trip, full SQL (pgvector, CTEs), works with any Postgres |
| Dedicated `firefinder` schema + RLS without policies | Invisible to Supabase's Data API; defense in depth |
| gte-small, in-process | No external AI calls or keys; identical model on Node and on Supabase Edge |
| Two-stage search (SQL candidates → TS ranking) | SQL stays simple and indexed; ranking can evolve without migrations |
| Wilson lower bound for verification | Rewards evidence without letting popularity dominate |
| Generated `verification_status` | `candidate` / `verified` can never drift from `confirmation_count` |
| UUIDv7 IDs plus `fire_number` | Globally unique across instances/mirrors; friendly "FIRE #123" for humans |
| Idempotent migrations | Work with both `supabase db push` and `npm run db:migrate` |
| TypeScript without a build step | Node 22.18+ strips types natively; esbuild only for deployable bundles |
| PGlite for dev and tests | Real Postgres + pgvector with no Docker; tests run the real migration |

## Extending

- **Another assistant (ChatGPT, Gemini, open models):** call the same HTTP API with `packages/client`. The ranking, verification and privacy guarantees live in the API, so every integration gets them.
- **Another database or host:** implement `SqlClient` (one method) for another driver, or `SolutionStore` for a different backend.
- **Another embedding model:** implement `Embedder`, recalibrate `minSimilarity` and the relevance floor ([RANKING.md](RANKING.md)), and re-embed existing rows. `embedding_model` records which model produced each vector.
- **Mirrors and federation:** UUIDv7 IDs, a portable schema and `embedding_model` make record exchange possible. No sync protocol exists yet.

## Remote MCP and zero-touch

The same deployment also serves `/mcp` (Streamable HTTP, stateless) and a small OAuth 2.1 authorization server (`/oauth/*`, `/.well-known/*`), both in `packages/mcp/src/remote/`. Tool calls run **in-process** on the same `FireFinderService` as the REST API (`ServiceOperations`); there is no extra network hop. Each Claude connection gets an anonymous identity, which is the voter and the rate-limit subject.

- **Behavior.** Claude's zero-touch behavior comes from the MCP `instructions` and tool descriptions (`packages/mcp/src/instructions.ts`, `server.ts`). It's enforced by server-side checks: strong verified matches only, and writes only with the user's own words (`packages/core/src/evidence.ts`).
- **Regions.** On Supabase, `apps/edge/src/handler.ts#routeByRegion` answers the MCP handshake locally and forwards database-bound requests to the database region.

Details: [REMOTE_MCP.md](REMOTE_MCP.md).
