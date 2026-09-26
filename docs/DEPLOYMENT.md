# Deployment

FireFinder runs in three ways:

- **Supabase (hosted):** the free tier is enough. Postgres + pgvector, with the API as an Edge Function.
- **Node server:** on any host, against Supabase Postgres or any other Postgres with pgvector.
- **Local:** `npm run dev` with an embedded PGlite database, for development and demos.

---

## Supabase (hosted)

Prerequisites:

- The Supabase CLI ≥ 1.215, logged in with `supabase login`.
- `npm install` has been run in this repository.

Docker is **not** required.

### 1. Create a project

Create a project at [database.new](https://database.new), or with the CLI:

```bash
supabase projects create firefinder --org-id <org-id> --region <region> --db-password <strong-password>
```

Note the project ref (the `abcdefghijklmnopqrst` part of `https://abcdefghijklmnopqrst.supabase.co`).

### 2. Link and create the schema

```bash
supabase link --project-ref <project-ref>
```

```bash
supabase db push
```

This applies `supabase/migrations/*` and enables pgvector in the `extensions` schema. Alternatively, run `DATABASE_URL=<session pooler URL> npm run db:migrate`. Both are safe because the migration is idempotent.

### 3. Set the secret

```bash
supabase secrets set FIREFINDER_VOTER_SECRET=<64 random hex characters>
```

Generate the value with `openssl rand -hex 32`, or with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Optional secrets: `RATE_LIMIT_READ_PER_MINUTE`, `RATE_LIMIT_WRITE_PER_MINUTE` and `CORS_ORIGINS`. `SUPABASE_DB_URL` is provided by the platform.

### 4. Deploy the API

```bash
npm run deploy:edge
```

This bundles `apps/edge/src/main.ts` into `supabase/functions/firefinder/index.js` (~470 KB, gitignored). It then runs `supabase functions deploy firefinder --use-api`, which bundles server-side, so no Docker is needed.

`supabase/config.toml` sets `verify_jwt = false` for this function because FireFinder authenticates callers itself. The REST API needs FireFinder API keys (except `/health`), and `/mcp` needs FireFinder's own OAuth tokens. OAuth metadata and registration are public, as the MCP spec requires.

### 5. Create API keys

Use the **Session pooler** connection string from Dashboard → Connect. The direct `db.<ref>.supabase.co` host is IPv6-only on the free tier.

```bash
DATABASE_URL="postgresql://postgres.<ref>:<db-password>@aws-0-<region>.pooler.supabase.com:5432/postgres" npm run keys:create -- --name claude-desktop
```

Use `--scopes read,write` (the default) for integrations and `--scopes admin` for moderators. List keys with `--list`; revoke one with `--revoke ff_XXXXXXXX`.

### 6. Verify

```bash
FIREFINDER_API_URL=https://<project-ref>.supabase.co/functions/v1/firefinder FIREFINDER_API_KEY=ff_… npm run smoke
```

Add `-- --write` to exercise submit, confirm and report as well. Against a deployed API this requires `FIREFINDER_ADMIN_KEY`, so the test record is disabled afterwards and never stays in the database.

Then connect Claude to the remote MCP endpoint (next section). Only the local stdio server uses the API URL and key directly: `FIREFINDER_API_URL=https://<project-ref>.supabase.co/functions/v1/firefinder` and `FIREFINDER_API_REGION=<your database region>`.

### Remote MCP (claude.ai, Claude mobile, Claude Code)

The same function serves the remote MCP endpoint at `https://<project-ref>.supabase.co/functions/v1/firefinder/mcp`. It needs the OAuth migration, which `supabase db push` applies, and optionally `FIREFINDER_DB_REGION`:

```bash
supabase secrets set FIREFINDER_DB_REGION=<database-region>
```

With it set, the function forwards database-bound requests to the database's region. That covers MCP tool calls, OAuth token exchange, and REST calls from clients that don't send `x-region`. See [REMOTE_MCP.md](REMOTE_MCP.md) for authentication, abuse protection and how to connect Claude. Verify with `npm run smoke:mcp`.

### Performance: pin the function to your database region

By default, Supabase runs an Edge Function in the region closest to the *caller*. FireFinder makes several database round trips per request, so a function running far from the database pays that distance on every one. With `FIREFINDER_API_REGION`, the client sends `x-region`, and the function runs next to the database.

Measured against a Singapore database from Europe:

| | Server time (search) | Round trip |
|---|---|---|
| Default (function runs in Zurich) | 2.3–4.3 s | 2.5–4.5 s |
| `x-region` = database region, after the query optimizations in this repo | ~160–300 ms | ~0.5–0.7 s |

The Edge Runtime starts a fresh worker for most requests. Every request therefore pays for one database connection (~120 ms) and the embedding (~150 ms); the vector search itself takes ~8 ms. For the lowest latency, create the project in the region closest to most of your users. The long-running Node server keeps connections, key lookups and embeddings warm, and answers searches in single-digit milliseconds on the server.

`Server-Timing` on every search response shows where time went, e.g. `auth;dur=126, ratelimit;dur=13, embed;dur=150, db;dur=8`.

### Troubleshooting

| Symptom | Fix |
|---|---|
| `503` "FireFinder is not configured" | Set `FIREFINDER_VOTER_SECRET` (step 3) |
| `401` on every call | Wrong key or wrong database: keys live in the project database you created them in |
| Every request takes seconds | Set `FIREFINDER_API_REGION` to the database region (see above) |
| First search is slow | Cold start: the Edge Runtime loads gte-small on the first request per instance |
| Timeouts connecting from your machine | Use the Session pooler URL, not the IPv6-only direct host |
| Paused project | Free-tier projects pause after inactivity; restore it in the dashboard |

Check logs in the Dashboard → Edge Functions → firefinder → Logs.

---

## Node server (any host)

```bash
DATABASE_URL=postgres://… npm run db:migrate
```

```bash
DATABASE_URL=postgres://… FIREFINDER_VOTER_SECRET=… HOST=0.0.0.0 PORT=8787 npm start
```

Configuration reference: [`.env.example`](../.env.example). Notes:

- **Supabase pooler:** port 5432 (session mode) supports prepared statements. Port 6543 (transaction mode) works too; FireFinder disables prepared statements for 6543 automatically (`DB_PREPARE=auto`).
- **Behind a reverse proxy:** set `TRUST_PROXY=true` so per-IP rate limits use `X-Forwarded-For`. Terminate TLS at the proxy.
- **Several instances:** the default rate limiter is in-memory per process; use a shared limiter for exact limits ([SECURITY.md](../SECURITY.md)).
- **Model cache:** the first start downloads gte-small (~34 MB) to `EMBEDDING_CACHE_DIR`. Persist that directory between deploys.
- **Console:** `DEV_CONSOLE=false` disables it in production if you don't want it exposed.

Any PostgreSQL 15+ with the `vector` extension works: Supabase, Neon, RDS, Cloud SQL, or a self-managed server.

---

## Local

```bash
npm run dev
```

On first start this creates `.data/firefinder` (PGlite), migrates it, writes a dev key to `.data/dev-api-key`, and serves the console at http://localhost:8787. Delete `.data/` to start over.

PGlite is single-process: stop the server before running `npm run keys:create` against the same `.data` directory.
