# 🔥 FireFinder

**When you're stuck in the fire, find the way out.**
*Someone already solved it.*

FireFinder is a shared memory of **verified** solutions that Claude uses on its own. **Connect it once; after that it's invisible.** Whenever you describe a technical problem, Claude quietly checks FireFinder first. If someone already solved it, Claude offers that verified fix first. If not, FireFinder stays out of the way. When you say "that fixed it", FireFinder remembers the fix for the next person. It keeps only the generalized problem and fix, never the conversation.

> Solve a problem once → remember the solution → help everyone who hits it later.

```text
ONE PERSON SOLVES IT  →  FIREFINDER REMEMBERS  →  NEXT PERSON ASKS
        ↑                                              ↓
  REPEAT  ←  FIREFINDER GETS STRONGER  ←  ANOTHER PERSON CONFIRMS IT  ←  CLAUDE USES IT

User message ─→ Claude: a reusable technical problem? ── no ──→ answer normally
                        │ yes
                        ▼
                search_firefinder (strong, verified matches only)
                 ├─ match    → "🔥 Previously solved" → Claude offers it first
                 └─ no match → silent; Claude solves it normally
                        ▼
User: "That fixed it" → recorded automatically (submit or confirm)
User: "Still broken"  → failure recorded automatically (report)
"Thanks" / "I'll try it" / silence → nothing recorded
```

Nobody operates FireFinder by hand: there are no buttons, no accounts and no API keys. The only step is connecting it once, as [a Claude connector](#connect-claude) or [a Claude Code plugin](plugins/firefinder).

What Claude shows the next person:

```text
🔥 FIRE #18492 — ✓ verified · confirmed by 127 · ✕ 4 failed · last confirmed 3 hours ago
   Problem: Vercel deployment fails during build
   Solution:
   Change the build command to `npm run build` and the output directory to `dist`, then redeploy.
```

---

## Contents

- [Quick start](#quick-start-no-accounts-needed)
- [Connect Claude](#connect-claude)
- [Architecture](#architecture)
- [API](#api)
- [Search and ranking](#search-and-ranking)
- [Verified, not just generated](#verified-not-just-generated)
- [Privacy](#privacy)
- [Security](#security)
- [Supabase setup (hosted)](#supabase-setup-hosted)
- [Self-hosting](#self-hosting)
- [Development and testing](#development-and-testing)
- [Roadmap](#roadmap)
- [Contributing and license](#contributing-and-license)

---

## Quick start (no accounts needed)

Requirements: **Node.js 22.18+** (24 recommended). No Docker, no database install, no cloud account.

```bash
npm install
```

```bash
npm run dev
```

This starts the API at **http://localhost:8787** with:

- an embedded PostgreSQL + pgvector database ([PGlite](https://pglite.dev)) in `.data/`, migrated automatically,
- the gte-small embedding model, downloaded once (~34 MB) into `.cache/models`,
- a local API key, printed once and saved to `.data/dev-api-key`,
- a developer console at http://localhost:8787 for searching, submitting and confirming solutions.

In a second terminal, watch the whole loop run through the real Claude integration:

```bash
npm run build:mcp
```

```bash
npm run demo
```

User A's question finds nothing, so Claude submits the confirmed fix. User B asks the same thing in different words, gets User A's fix first, and confirms it: `✓ confirmed by 2`.

---

## Connect Claude

### Once, and it works everywhere: claude.ai, Claude Desktop, Claude mobile

1. In Claude, open **Customize → Connectors → + → Add custom connector**.
2. Enter the URL `https://wmrkcgivrurnycfqjznp.supabase.co/functions/v1/firefinder/mcp` (or your own deployment's `/mcp`), then click **Connect**. A window opens and closes by itself: there's no login and no API key.
3. The first time Claude uses FireFinder, choose **Allow always**.

### Claude Code

Install the plugin from the marketplace in this repository (`/plugin marketplace add <repo>`, then `/plugin install firefinder@firefinder`). Run `/mcp` → **firefinder → Authenticate** once. See [plugins/firefinder](plugins/firefinder).

### What Claude gets

| Tool | Claude uses it… |
|---|---|
| `search_firefinder` | on its own, **before** answering a concrete technical problem; it returns only strong verified matches, or nothing |
| `get_fire` | to look up a specific fix ("FIRE #123") |
| `submit_solution` | automatically, when the user's own words confirm a fix Claude suggested worked |
| `confirm_solution` | automatically, when the user says a FireFinder fix worked |
| `report_solution` | automatically, when the user says a FireFinder fix didn't work |

The write tools require `user_evidence`, the user's own words, and **the server checks them**. "That fixed it" is recorded; "thanks", "I'll try that" and Claude's own confidence are not. With real Claude sessions, this behavior passed 14 of 14 eval runs. How the remote endpoint, its anonymous OAuth and its abuse protection work: [docs/REMOTE_MCP.md](docs/REMOTE_MCP.md).

### Local and API-key options

For self-hosters and development, a stdio MCP server that talks to the REST API with an API key is also included.

**Claude Desktop (local stdio server):** add this to `claude_desktop_config.json` and restart Claude:

```json
{
  "mcpServers": {
    "firefinder": {
      "command": "node",
      "args": ["/absolute/path/to/Firefinder/packages/mcp/dist/firefinder-mcp.js"],
      "env": {
        "FIREFINDER_API_URL": "http://localhost:8787",
        "FIREFINDER_API_KEY": "ff_your_key"
      }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add firefinder -e FIREFINDER_API_URL=http://localhost:8787 -e FIREFINDER_API_KEY=ff_your_key -- node /absolute/path/to/Firefinder/packages/mcp/dist/firefinder-mcp.js
```

**Claude API (Messages API):** use [`integrations/claude/tools.json`](integrations/claude/tools.json) and [`system-prompt.md`](integrations/claude/system-prompt.md). Both are generated from the MCP server, so they never drift.

Full guide: [integrations/claude/README.md](integrations/claude/README.md).

---

## Architecture

```text
 claude.ai · Claude mobile · Claude Desktop · Claude Code (plugin)      Claude API apps
            │ remote MCP: Streamable HTTP + OAuth 2.1 (anonymous)          │ tool use
            ▼                                                               ▼
 ┌──────── FireFinder (one Supabase Edge Function or Node server) ───────────────┐
 │ /mcp + /oauth/*   packages/mcp: 5 tools, evidence checks, per-user limits     │
 │ /search, /solutions/*  REST API with API keys (packages/core, Hono)           │
 │ shared core: validate → privacy filter → normalize → embed → search → rank    │
 └───────────────────────────────────────┬───────────────────────────────────────┘
                                         ▼ one SQL round trip (in the database region)
                  PostgreSQL + pgvector (supabase/migrations)
                  Supabase · any Postgres 15+ · PGlite for dev/tests

 (local stdio MCP server for self-hosters: packages/mcp → packages/client → REST API)
```

- **One core, two runtimes.** `packages/core` is runtime-agnostic TypeScript (Web APIs only). The Node server and the Supabase Edge Function are thin wrappers around it.
- **No external AI calls.** Embeddings come from **gte-small** (384 dimensions), running in-process. Node uses transformers.js; Supabase Edge Functions use the built-in `Supabase.ai` session with the same model. Nothing is sent to an AI provider.
- **Fast by construction.** A search is one local embedding (~2–5 ms) plus one SQL call: HNSW vector search and exact error-code matching, combined in a single function. Ranking happens in memory.
  - Node server: **~7 ms server time, ~22 ms round trip** (measured locally).
  - Supabase Edge Function: **~160–300 ms server time**, most of it per-request connection setup and embedding. The vector search itself takes ~8 ms.
  - Every search reports a per-stage breakdown in `Server-Timing`.
- **Portable.** Storage sits behind a `SolutionStore` interface, and SQL behind a one-method `SqlClient`. IDs are UUIDv7, so records stay unique across instances. Nothing requires Supabase: any Postgres with pgvector works.

| Path | What it is |
|---|---|
| `packages/core` | Domain logic: validation (zod), privacy filter, normalization, ranking, duplicate detection, auth, rate limiting, Postgres store, HTTP app |
| `packages/client` | Typed HTTP client shared by every integration |
| `packages/mcp` | Claude integration: MCP server, tool guidance, result formatting |
| `apps/api` | Node server: config, database adapters (postgres.js / PGlite), local embedder, developer console |
| `apps/edge` | Supabase Edge Function entry (bundled to `supabase/functions/firefinder/index.js`) |
| `supabase/migrations` | The schema: tables, indexes, constraints, RLS, SQL functions |
| `integrations/claude` | Setup guide, Messages API tool definitions, system prompt |
| `scripts` | build, migrate, API keys, smoke test, demo |
| `tests` | Unit and integration tests (real Postgres + pgvector via PGlite, real embedding model) |
| `docs` | [Architecture](docs/ARCHITECTURE.md) · [API](docs/API.md) · [Ranking](docs/RANKING.md) · [Privacy](docs/PRIVACY.md) · [Deployment](docs/DEPLOYMENT.md) |

---

## API

All endpoints take and return JSON. Authenticate with `X-API-Key: ff_…` (or `Authorization: Bearer ff_…`).

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `POST` | `/search` | read | Ranked solutions for a problem |
| `POST` | `/solutions` | write | Submit a solution (`worked: true` = user confirmed) |
| `GET` | `/solutions/:id` | read | One solution, by UUID or FIRE number |
| `POST` | `/solutions/:id/confirm` | write | "It worked" |
| `POST` | `/solutions/:id/report` | write | "It didn't work" |
| `GET` | `/solutions` | read | Recent solutions (keyset pagination) |
| `POST` | `/admin/solutions/:id/status` | admin | Moderation: `active` / `under_review` / `disabled` |
| `GET` | `/health` | none | Liveness and embedding model |

```bash
curl -s http://localhost:8787/search -H "X-API-Key: $FIREFINDER_API_KEY" -H "Content-Type: application/json" -d '{"problem":"Bluetooth is gone from my Windows laptop","operating_system":"Windows 11"}'
```

```json
{
  "results": [
    {
      "id": "01a0d962-f041-7357-b4aa-922d1ba63c5f",
      "fire_number": 12,
      "problem": "Bluetooth toggle disappeared from Windows settings after an update",
      "solution": "Open services.msc, start \"Bluetooth Support Service\" and set it to Automatic…",
      "operating_system": "Windows 11",
      "similarity": 0.93,
      "score": 0.64,
      "confirmation_count": 3,
      "failure_count": 0,
      "verification_status": "verified",
      "last_confirmed_at": "2026-09-25T17:26:13.000Z",
      "environment_match": { "software": "unknown", "operating_system": "match", "software_version": "unknown" }
    }
  ],
  "took_ms": 7
}
```

Full reference with every field, error and header: [docs/API.md](docs/API.md).

---

## Search and ranking

Search recognizes the same problem in different words: "My Windows Bluetooth disappeared", "Bluetooth is gone from my Windows laptop" and "Windows doesn't show Bluetooth anymore" score 0.96–0.97 against each other, while unrelated technical problems score 0.72–0.81. Candidates come from **semantic similarity** (pgvector HNSW) and from **exact error-code matches** (`ERR_OSSL_EVP_UNSUPPORTED`, `0x80070005`, `ENOENT`, `TS2345`…). They are then ranked on:

```text
score = 0.55·relevance + 0.15·verification + 0.20·environment + 0.05·recency − 0.20·failure rate
```

- **Relevance:** similarity, plus exact error-code overlap.
- **Verification:** the *Wilson lower bound* of the confirmation rate. It rewards evidence but saturates, so 1,000 confirmations can't bury a clearly better match.
- **Environment:** software, OS and version matching, scored only on what the user told us. A Windows 11 user gets the relevant Windows 11 fix above a hugely popular Windows 10 one; that exact case is a test.
- **Recency:** a light tie-breaker with a 180-day half-life.
- **Failure rate:** smoothed, so one failure on a new fix isn't a verdict.

A fix for different software is filtered out unless the exact error code matches. The ranking lives in one pure module (`packages/core/src/ranking.ts`) so it can evolve without migrations. Details and calibration data: [docs/RANKING.md](docs/RANKING.md).

---

## Verified, not just generated

FireFinder is not a dump of AI answers.

- A submission is a **candidate** until someone confirms it worked; then it is **verified** (a generated column: `confirmation_count > 0`).
- Claude only submits after the user explicitly confirms the fix worked. "I'll try that" is not confirmation.
- Every record tracks `confirmation_count`, `failure_count`, `last_confirmed_at`, `last_failed_at`, `created_at` and `updated_at`.
- **One vote per install.** Votes are keyed by an HMAC of an anonymous install ID. The same person confirming twice counts once, and people can change their vote.
- **Failures don't delete.** A fix may only fail in some environments. Reports lower the ranking and record where it failed. After 5+ reports with a failure rate of 75% or more, the fix is flagged `under_review` for moderators. Moderators can also `disable` it, which hides it everywhere.
- **Duplicates merge.** "Restart the Bluetooth service" and "Restart the Bluetooth Support Service" for the same problem become one record with two confirmations. They stay separate when the difference matters: a Windows 10 fix vs a Windows 11 fix, *enable* vs *disable*, Node 16 vs Node 18.

---

## Privacy

FireFinder **never stores conversations**. The schema has no column that could hold one, or a name, email or user ID.

| Stored | Never stored |
|---|---|
| Generalized problem, solution, optional error text | Conversations or chat history |
| Software, OS and version (non-personal environment) | Names, emails, usernames, user IDs |
| Confirmation and failure counts and timestamps | Passwords, API keys, tokens, private keys |
| An HMAC of an anonymous install ID, per vote | IP addresses, raw install IDs, search queries |

Every text field passes through a privacy filter before storage:

- Removes control, invisible and bidi characters.
- Redacts emails, API keys (Anthropic, OpenAI, GitHub, AWS, Google, Stripe, Supabase, Slack, npm, Hugging Face, FireFinder…), JWTs and bearer tokens, `password=` / `"secret": …` assignments, credentials in connection strings, private keys, card numbers (Luhn-checked), SSNs, phone numbers, public IP addresses, usernames in paths (`C:\Users\<user>\…`), and long high-entropy strings.

Useful technical detail is kept on purpose: error codes, versions, GUIDs and private IPs. The API tells the client what was redacted. Search queries are never stored or logged. Full model: [docs/PRIVACY.md](docs/PRIVACY.md).

---

## Security

- **API keys** (`ff_` + 40 random base62 characters) are stored only as SHA-256 hashes. They carry scopes (`read`, `write`, `admin`), can be revoked, and lookups are cached for 60 s.
- **Rate limiting** applies per client and per IP, returns `RateLimit-*` and `Retry-After` headers, and is pluggable: in-memory for the Node server, Postgres-backed for Edge Functions.
- **Strict validation:** unknown fields are rejected, lengths are checked after sanitization, bodies are capped at 64 KB, IDs are validated, and errors are JSON without internals.
- **Database:**
  - FireFinder lives in its own `firefinder` schema, which Supabase's auto-generated REST API doesn't expose.
  - RLS is enabled on every table with no policies, so no role except the owner sees anything.
  - The `anon` / `authenticated` roles are explicitly revoked, and every function pins `search_path`.
  - CHECK constraints mirror API validation.
- **Secrets come only from environment variables.** The Supabase service-role key is not needed and never used.
- **Security headers** on every response, and a strict CSP on the console.

Reporting and known limitations: [SECURITY.md](SECURITY.md).

---

## Supabase setup (hosted)

The hosted version runs on Supabase's free tier: Postgres with pgvector, plus the API as an Edge Function with built-in gte-small embeddings. You need the [Supabase CLI](https://supabase.com/docs/guides/cli), logged in with `supabase login`. Docker isn't required.

1. **Create a project** at [database.new](https://database.new) and note its project ref.
2. **Link it:**
   ```bash
   supabase link --project-ref <project-ref>
   ```
3. **Create the schema** (both migrations: solutions, and OAuth for remote MCP):
   ```bash
   supabase db push
   ```
4. **Set the secrets:** the voter secret (any 32+ random characters, e.g. `openssl rand -hex 32`) and your database's region, so database work runs next to it:
   ```bash
   supabase secrets set FIREFINDER_VOTER_SECRET=<random-hex> FIREFINDER_DB_REGION=<database-region>
   ```
5. **Deploy.** This builds the bundle, then runs `supabase functions deploy firefinder --use-api`:
   ```bash
   npm run deploy:edge
   ```
6. **Connect Claude.** Add the custom connector `https://<project-ref>.supabase.co/functions/v1/firefinder/mcp` ([details](#connect-claude)).
7. **Verify** the whole chain the way claude.ai connects. An admin key (step 8) lets the smoke test clean up its test record:
   ```bash
   FIREFINDER_MCP_URL=https://<project-ref>.supabase.co/functions/v1/firefinder/mcp npm run smoke:mcp
   ```
8. *(Optional)* **API keys for the REST API or the local stdio server.** Use the *Session pooler* connection string from Dashboard → Connect:
   ```bash
   DATABASE_URL="postgresql://postgres.<ref>:<db-password>@aws-0-<region>.pooler.supabase.com:5432/postgres" npm run keys:create -- --name claude-desktop
   ```

Step-by-step with troubleshooting: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

---

## Self-hosting

FireFinder isn't tied to Supabase. Any PostgreSQL 15+ with the `vector` extension works:

```bash
DATABASE_URL=postgres://user:pass@host:5432/firefinder npm run db:migrate
```

```bash
DATABASE_URL=postgres://user:pass@host:5432/firefinder FIREFINDER_VOTER_SECRET=<random-hex> npm start
```

All options are in [`.env.example`](.env.example). The Node server runs anywhere Node 22.18+ runs (VM, Render, Fly.io, Railway, a Raspberry Pi). The schema, IDs (UUIDv7) and `embedding_model` column are designed so self-hosted instances and future community mirrors stay compatible.

---

## Development and testing

| Command | What it does |
|---|---|
| `npm run dev` | API + console on :8787 with local PGlite, restarts on change |
| `npm test` | All tests (unit + integration) |
| `npm run typecheck` | TypeScript, strict |
| `npm run demo` | The core loop through the real MCP server (needs `npm run dev` + `npm run build:mcp`) |
| `npm run smoke` | Health, search latency and optionally the write path (`-- --write`) against any deployment |
| `npm run db:migrate` | Apply migrations to `DATABASE_URL` |
| `npm run keys:create -- --name <n> [--scopes read,write]` | Create an API key (`--list`, `--revoke <prefix>`) |
| `npm run build:mcp` / `build:edge` | Bundle the MCP server / Edge Function |
| `npm run smoke:mcp` | The remote MCP endpoint end to end, connecting like claude.ai (OAuth + the chain reaction) |
| `npm run export:claude` | Regenerate the files derived from the MCP server: Claude API tools, system prompt, plugin skill, eval mocks |
| `claude plugin eval plugins/firefinder --ablation none --no-publish` | Claude's zero-touch decisions, tested with real Claude sessions and mocked FireFinder |

The test suite runs against **real PostgreSQL + pgvector** (PGlite, in-process) with the **real migration** and the **real gte-small model**. There are no database or embedding mocks. It covers:

- creating solutions
- semantic search (the Bluetooth paraphrases)
- metadata filtering and environment-aware ranking
- confirmations, votes and failure reports
- duplicate detection
- invalid requests
- authentication and scopes
- rate limiting
- privacy filtering
- database security: RLS, grants, `search_path`
- the Edge Function wiring and region forwarding
- the production database driver (postgres.js over the wire protocol)
- the remote MCP endpoint, through the official MCP SDK client: OAuth discovery, registration, PKCE, rotation, every tool, strict inputs, abuse limits
- evidence classification ("that worked" / "still broken" / "thanks")

The most important test is the **chain reaction**: User A searches, finds nothing, and "That fixed it" saves the fix. User B asks in different words, gets the fix first, and "That worked" confirms it (`✓ 2`). User C's "didn't fix it" records a failure. It runs through the Claude tools, over HTTP and the remote MCP endpoint ([tests/integration/remote-mcp.test.ts](tests/integration/remote-mcp.test.ts), [tests/integration/core-loop.test.ts](tests/integration/core-loop.test.ts)). It also runs live against the deployment with `npm run smoke:mcp`.

---

## Roadmap

Not built yet on purpose; the architecture is ready for each:

- **ChatGPT and other assistants.** They use the same HTTP API or the remote MCP endpoint, so a fix found through Claude helps ChatGPT users too.
- **Publishing the Claude Code plugin** in a public marketplace, and submitting the connector to Claude's directory.
- **Browser extension** on top of `packages/client`.
- **Community mirrors and self-hosted federation.** UUIDv7 IDs and a portable schema make this possible; no sync protocol exists yet.
- **Per-user keys and anonymous attestations** for stronger vote integrity.

---

## Contributing and license

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md), and [SECURITY.md](SECURITY.md) for reporting vulnerabilities. FireFinder is released under the [MIT License](LICENSE).
