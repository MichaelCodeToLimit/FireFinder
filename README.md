# 🔥 FireFinder

**When you're stuck in the fire, find the way out.**

FireFinder is an open-source **shared solution memory for AI assistants**. It works with Claude today.

> Solve a problem once → remember the solution → help everyone who hits it later.

## The idea

- A **fire** is a problem someone is stuck with: an error message, a failing build or deploy, a broken setting, a device that stopped working, or an everyday snag like a stubborn stain or a rental car you can't return on a Sunday.
- **FireFinder** finds a solution someone already discovered for that fire, and verified.

In practice:

- **Claude searches FireFinder automatically** whenever you describe a problem where a known fix could help.
- **Strong, verified solutions are returned to Claude**, which offers them first ("known fix, confirmed by 12 people") and still checks that they fit your situation.
- **When no solution exists, FireFinder stays invisible.** There's no "no results found"; Claude just solves the problem normally.
- **When you naturally confirm that a fix worked** ("this worked", "amazing, that worked!", "that did it"), FireFinder records it automatically. Only the generalized problem and fix are kept, never the conversation.
- **Future users benefit.** The next person with the same fire gets the verified fix first, even if they describe it in completely different words.

```text
ONE PERSON SOLVES IT  →  FIREFINDER REMEMBERS  →  NEXT PERSON ASKS
        ↑                                              ↓
  REPEAT  ←  FIREFINDER GETS STRONGER  ←  ANOTHER PERSON CONFIRMS IT  ←  CLAUDE USES IT

User message ─→ Claude: stuck on a problem others hit too? ── no ──→ answer normally
                        │ yes
                        ▼
                search_firefinder (strong, verified matches only)
                 ├─ match    → "🔥 Previously solved" → Claude offers it first
                 └─ no match → silent; Claude solves it normally
                        ▼
User: "Amazing, that worked!" → recorded automatically (submit or confirm)
User: "Still broken"  → failure recorded automatically (report)
"Thanks" / "I'll try it" / silence → nothing recorded
```

What Claude sees when a fire has already been solved:

```text
🔥 FIRE #18492 — ✓ verified · confirmed by 127 · ✕ 4 failed · last confirmed 3 hours ago
   Problem: Vercel deployment fails during build
   Solution:
   Change the build command to `npm run build` and the output directory to `dist`, then redeploy.
```

## Zero-touch

You connect FireFinder **once**. After that, you never need to:

- manually search FireFinder,
- click "use solution",
- submit solutions,
- manually confirm solutions,
- manage a FireFinder account,
- enter an API key.

Claude decides when a problem is relevant (technical or everyday), searches, and records outcomes from your own words, however casually you say them. **The server checks those words:** "this worked", "that did it" and "the stain is gone" are recorded. "Thanks", "I'll try that", praise before you've tried it, a partial improvement, silence and Claude's own confidence are not. Nothing is sent to FireFinder from general questions, writing, math or small talk, and never anything about health, legal, financial or relationship matters. This behavior is tested with real Claude sessions in the [plugin evals](plugins/firefinder/evals).

---

## Contents

- [Install](#install): claude.ai · Claude Desktop and mobile · Claude Code · Codex · ChatGPT
- [What runs where](#what-runs-where)
- [Local development](#local-development)
- [Architecture](#architecture)
- [API](#api)
- [Search and ranking](#search-and-ranking)
- [Verified, not just generated](#verified-not-just-generated)
- [Privacy](#privacy)
- [Security](#security)
- [Run your own FireFinder](#run-your-own-firefinder)
- [Testing](#testing)
- [Roadmap](#roadmap)
- [Contributing and license](#contributing-and-license)

---

## Install

The public FireFinder server:

```text
https://wmrkcgivrurnycfqjznp.supabase.co/functions/v1/firefinder/mcp
```

Connecting needs no account, login or API key. Each connection gets an anonymous identity automatically: the authorization window opens and closes by itself.

### A. claude.ai

1. Open **Customize → Connectors**, click **+**, then **Add custom connector**.
2. Name: `FireFinder`. URL: the server URL above. Leave **Advanced settings** (OAuth client ID and secret) empty.
3. Click **Add**, then **Connect**. A window opens and closes by itself.
4. If Claude asks for permission the first time it uses a FireFinder tool, allow it always, so FireFinder stays zero-touch.

On **Team and Enterprise** plans, an owner first adds the connector under **Organization settings → Connectors → Add → Custom → Web**. Each member then clicks **Connect**. **Free** plans allow one custom connector.

### B. Claude Desktop and Claude mobile

Nothing extra to install. A connector added on claude.ai also appears in Claude Desktop and the Claude mobile apps signed in to the same account. On Desktop you can add it there instead, under **Customize → Connectors**, with the same steps.

You don't need a `claude_desktop_config.json` entry for the hosted server. That file is only for the [local stdio server](#local-stdio-server-self-hosting-with-api-keys) used by self-hosters.

### C. Claude Code

Install the plugin from this repository. It bundles the remote server, a skill with the zero-touch guidance, a hook that has Claude check FireFinder when an install, build or deploy command it runs fails, and two commands: `/firefinder:search` and `/firefinder:fire`.

```text
/plugin marketplace add https://github.com/MichaelCodeToLimit/FireFinder.git
```

```text
/plugin install firefinder@firefinder
```

Then run `/mcp`, select **firefinder**, and choose **Authenticate** (once). A browser tab opens and returns immediately.

The same works from a terminal with `claude plugin marketplace add …` and `claude plugin install firefinder@firefinder`. Without the plugin, you can add just the server: `claude mcp add --transport http firefinder <server URL>`. Details: [plugins/firefinder](plugins/firefinder).

### D. Codex

One plugin serves Codex and ChatGPT. It bundles the remote server, the same zero-touch skill, and `search`, `fire`, `worked`, `failed` and `help` skills you can invoke yourself.

```bash
codex plugin marketplace add MichaelCodeToLimit/FireFinder
```

```bash
codex plugin add firefinder@firefinder
```

Then sign in once with `codex mcp login firefinder`. The browser tab returns immediately. Details: [plugins/firefinder-codex](plugins/firefinder-codex).

### E. ChatGPT

- **Desktop app:** add the marketplace with the `codex plugin marketplace add` command above, restart the app, and install **FireFinder** from **Plugins**.
- **Web:** turn on **Developer mode** (Settings → Security and login), then at [chatgpt.com/plugins](https://chatgpt.com/plugins) select **+** and enter the server URL with OAuth, leaving the client ID and secret empty.

### What Claude gets

| Tool | Claude uses it… |
|---|---|
| `search_firefinder` | on its own, **before** answering a problem you're stuck on, technical or everyday; it returns only strong verified matches, or nothing |
| `get_fire` | to look up a specific fix ("FIRE #123") |
| `submit_solution` | automatically, when the user's own words confirm a fix Claude suggested worked |
| `confirm_solution` | automatically, when the user says a FireFinder fix worked |
| `report_solution` | automatically, when the user says a FireFinder fix didn't work |

The write tools require `user_evidence`, the user's own words, which the server checks. How the endpoint, its anonymous OAuth and its abuse protection work: [docs/REMOTE_MCP.md](docs/REMOTE_MCP.md).

---

## What runs where

| Piece | What it is | Who deals with it |
|---|---|---|
| **The deployed FireFinder MCP server** | The public endpoint above: remote MCP (`/mcp`, Streamable HTTP + OAuth 2.1) and the REST API. Source: `apps/edge` + `packages/*`. | Users connect to it once; operators deploy it |
| **Supabase** | Hosts the deployed server as an Edge Function, plus its database (PostgreSQL + pgvector, schema in `supabase/migrations`). All secrets live there as function secrets. | Operators only. Users never need a Supabase account |
| **The Claude Code plugin** | `plugins/firefinder` + `.claude-plugin/marketplace.json`: points Claude Code at the deployed server (`.mcp.json`) and adds the zero-touch skill, a failed-command hook and two slash commands. It contains no code and no secrets. | Claude Code users install it |
| **The Codex and ChatGPT plugin** | `plugins/firefinder-codex` + `.agents/plugins/marketplace.json`: the same server and zero-touch skill, plus five by-hand skills. No code and no secrets. | Codex and ChatGPT users install it |
| **Local development** | `npm run dev`: the same API and MCP server on `localhost`, with an embedded database in `.data/`. It never touches the deployed database. | Contributors |

The deployed server and a local server run the same code (`packages/core`, `packages/mcp`). Only the runtime wrapper differs: `apps/edge` for Supabase, `apps/api` for Node.

---

## Local development

Requirements: **Node.js 22.18+** (24 recommended). No Docker, no database install, no cloud account, no `.env` file.

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
- the remote MCP endpoint at http://localhost:8787/mcp,
- a developer console at http://localhost:8787 for searching, submitting and confirming solutions.

`.data/` and `.cache/` are gitignored. Delete `.data/` to start over. In a second terminal, watch the whole loop run through the real Claude integration:

```bash
npm run build:mcp
```

```bash
npm run demo
```

User A's question finds nothing, so Claude submits the confirmed fix. User B asks the same thing in different words, gets User A's fix first, and confirms it: `✓ confirmed by 2`.

Configuration for anything beyond local development is documented in [`.env.example`](.env.example). Copy it to `.env` (gitignored) and fill in only what you need.

### Local stdio server (self-hosting with API keys)

For self-hosters, a stdio MCP server that talks to the REST API with an API key is also included. Build it with `npm run build:mcp`.

**Claude Desktop:** add this to `claude_desktop_config.json` and restart Claude (see also [the example file](integrations/claude/claude_desktop_config.example.json)):

```json
{
  "mcpServers": {
    "firefinder": {
      "command": "node",
      "args": ["/absolute/path/to/FireFinder/packages/mcp/dist/firefinder-mcp.js"],
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
claude mcp add firefinder -e FIREFINDER_API_URL=http://localhost:8787 -e FIREFINDER_API_KEY=ff_your_key -- node /absolute/path/to/FireFinder/packages/mcp/dist/firefinder-mcp.js
```

**Claude API (Messages API):** use [`integrations/claude/tools.json`](integrations/claude/tools.json) and [`system-prompt.md`](integrations/claude/system-prompt.md). Both are generated from the MCP server, so they never drift. Full guide: [integrations/claude/README.md](integrations/claude/README.md).

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

```text
.
├── .claude-plugin/marketplace.json   Claude Code marketplace (lists plugins/firefinder)
├── plugins/firefinder/               Claude Code plugin: .mcp.json, skills, failed-command hook, behavior evals
├── .agents/plugins/marketplace.json  Codex and ChatGPT marketplace (lists plugins/firefinder-codex)
├── plugins/firefinder-codex/         Codex and ChatGPT plugin: .mcp.json, skills
├── packages/
│   ├── core/                         Domain logic: validation, privacy filter, ranking, dedupe, auth, rate limits, store, HTTP app
│   ├── client/                       Typed HTTP client shared by every integration
│   └── mcp/                          Claude integration: MCP tools, guidance, formatting, remote endpoint + OAuth
├── apps/
│   ├── api/                          Node server (postgres.js / PGlite, local embedder, dev console)
│   └── edge/                         Supabase Edge Function entry (bundled by `npm run build:edge`)
├── supabase/                         config.toml + migrations (tables, indexes, RLS, SQL functions)
├── integrations/claude/              Claude setup guide, Messages API tools, system prompt (generated)
├── scripts/                          build, migrate, API keys, smoke tests, demo, export
├── tests/                            unit + integration tests (real Postgres + pgvector, real model)
└── docs/                             architecture, API, ranking, privacy, deployment, remote MCP
```

Deeper dives: [Architecture](docs/ARCHITECTURE.md) · [API](docs/API.md) · [Ranking](docs/RANKING.md) · [Privacy](docs/PRIVACY.md) · [Deployment](docs/DEPLOYMENT.md) · [Remote MCP](docs/REMOTE_MCP.md).

---

## API

All endpoints take and return JSON. Authenticate with `X-API-Key: ff_…` (or `Authorization: Bearer ff_…`). Claude doesn't use API keys; it connects through the remote MCP endpoint.

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

A fix for different software is filtered out unless the exact error code matches. Claude's automatic search only returns **verified** matches with similarity ≥ 0.85, at most three. The ranking lives in one pure module (`packages/core/src/ranking.ts`) so it can evolve without migrations. Details and calibration data: [docs/RANKING.md](docs/RANKING.md).

---

## Verified, not just generated

FireFinder is not a dump of AI answers.

- A submission is a **candidate** until someone confirms it worked; then it is **verified** (a generated column: `confirmation_count > 0`).
- Claude only records a fix after the user's own words confirm it worked. "I'll try that" is not confirmation.
- Every record tracks `confirmation_count`, `failure_count`, `last_confirmed_at`, `last_failed_at`, `created_at` and `updated_at`.
- **One vote per person.** Votes are keyed by an HMAC of an anonymous identity. The same person confirming twice counts once, and people can change their vote.
- **Failures don't delete.** A fix may only fail in some environments. Reports lower the ranking and record where it failed. After 5+ reports with a failure rate of 75% or more, the fix is flagged `under_review` for moderators. Moderators can also `disable` it, which hides it everywhere.
- **Duplicates merge.** "Restart the Bluetooth service" and "Restart the Bluetooth Support Service" for the same problem become one record with two confirmations. They stay separate when the difference matters: a Windows 10 fix vs a Windows 11 fix, *enable* vs *disable*, Node 16 vs Node 18.

---

## Privacy

FireFinder **never stores conversations**. The schema has no column that could hold one, or a name, email or user ID.

| Stored | Never stored |
|---|---|
| Generalized problem, solution, optional error text | Conversations or chat history |
| Software, OS and version (non-personal environment) | Names, emails, usernames, user IDs, accounts |
| Confirmation and failure counts and timestamps | Passwords, API keys, tokens, private keys |
| An HMAC of an anonymous identity, per vote | IP addresses, raw identifiers, search queries, the user's words used as evidence |

Every text field passes through a privacy filter before storage:

- Removes control, invisible and bidi characters.
- Redacts emails, API keys (Anthropic, OpenAI, GitHub, AWS, Google, Stripe, Supabase, Slack, npm, Hugging Face, FireFinder…), JWTs and bearer tokens, `password=` / `"secret": …` assignments, credentials in connection strings, private keys, card numbers (Luhn-checked), SSNs, phone numbers, public IP addresses, usernames in paths (`C:\Users\<user>\…`), and long high-entropy strings.

Useful technical detail is kept on purpose: error codes, versions, GUIDs and private IPs. Claude is also instructed to generalize problems and fixes before recording them. Full model: [docs/PRIVACY.md](docs/PRIVACY.md).

---

## Security

- **No secrets in the repository.** All configuration comes from environment variables (`.env`, gitignored) or Supabase function secrets. [`.env.example`](.env.example) contains names only. The Supabase service-role key is not needed and never used.
- **Remote MCP:** OAuth 2.1 with PKCE, anonymous identities, allowlisted redirect URIs, short-lived signed access tokens, rotating refresh tokens, and per-identity and per-IP rate limits. There are only five operations, with strict inputs; there's no moderation, delete or raw database access.
- **REST API keys** (`ff_` + 40 random base62 characters) are stored only as SHA-256 hashes. They carry scopes (`read`, `write`, `admin`) and can be revoked.
- **Strict validation:** unknown fields are rejected, lengths are checked after sanitization, bodies are capped at 64 KB, and errors are JSON without internals.
- **Database:**
  - FireFinder lives in its own `firefinder` schema, which Supabase's auto-generated REST API doesn't expose.
  - RLS is enabled on every table with no policies, and the `anon` / `authenticated` roles are revoked.
  - Every function pins `search_path`, and CHECK constraints mirror API validation.
- **Security headers** on every response, and a strict CSP on the developer console.

Reporting vulnerabilities and known limitations: [SECURITY.md](SECURITY.md).

---

## Run your own FireFinder

Anyone can run their own instance: for a team, a company, or to develop against a real deployment. Point the connector or the plugin's `.mcp.json` at your own `…/mcp` URL.

### On Supabase (free tier works)

You need the [Supabase CLI](https://supabase.com/docs/guides/cli), logged in with `supabase login`. Docker isn't required.

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
6. **Connect Claude** with your URL: `https://<project-ref>.supabase.co/functions/v1/firefinder/mcp`.
7. **Verify** the endpoint the way claude.ai connects. Without an admin key the check is read-only; with one it also runs the full chain reaction and disables its test record afterwards:
   ```bash
   FIREFINDER_MCP_URL=https://<project-ref>.supabase.co/functions/v1/firefinder/mcp npm run smoke:mcp
   ```
8. *(Optional)* **API keys** for the REST API, moderation (`--scopes admin`) or the local stdio server. Use the *Session pooler* connection string from Dashboard → Connect:
   ```bash
   DATABASE_URL="postgresql://postgres.<ref>:<db-password>@aws-0-<region>.pooler.supabase.com:5432/postgres" npm run keys:create -- --name my-key
   ```

Step-by-step with troubleshooting: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

### On any Postgres + Node host

FireFinder isn't tied to Supabase. Any PostgreSQL 15+ with the `vector` extension works:

```bash
DATABASE_URL=postgres://user:pass@host:5432/firefinder npm run db:migrate
```

```bash
DATABASE_URL=postgres://user:pass@host:5432/firefinder FIREFINDER_VOTER_SECRET=<random-hex> FIREFINDER_PUBLIC_URL=https://firefinder.example.com npm start
```

All options are in [`.env.example`](.env.example). The Node server runs anywhere Node 22.18+ runs (VM, Render, Fly.io, Railway, a Raspberry Pi). The schema, IDs (UUIDv7) and `embedding_model` column are designed so self-hosted instances and future community mirrors stay compatible.

---

## Testing

| Command | What it does |
|---|---|
| `npm test` | All tests (unit + integration) |
| `npm run typecheck` | TypeScript, strict |
| `npm run dev` | API + MCP + console on :8787 with local PGlite, restarts on change |
| `npm run demo` | The core loop through the real MCP server (needs `npm run dev` + `npm run build:mcp`) |
| `npm run smoke` | Health, search latency and optionally the write path (`-- --write`) against any deployment |
| `npm run smoke:mcp` | A remote MCP endpoint end to end, connecting like claude.ai (OAuth, tools, the chain reaction) |
| `npm run db:migrate` | Apply migrations to `DATABASE_URL` |
| `npm run keys:create -- --name <n> [--scopes read,write]` | Create an API key (`--list`, `--revoke <prefix>`) |
| `npm run build:mcp` / `build:edge` | Bundle the stdio MCP server / Edge Function |
| `npm run export:claude` | Regenerate the files derived from the MCP server: Claude API tools, system prompt, plugin skills and hook, eval mocks |
| `claude plugin validate plugins/firefinder` | Validate the Claude Code plugin |
| `claude plugin eval plugins/firefinder --ablation none --no-publish` | Claude's zero-touch decisions, tested with real Claude sessions and mocked FireFinder |
| `claude plugin eval plugins/firefinder --eval-dir evals-shell --allow-tools Bash --scaffold --ablation none --no-publish` | The failed-command hook, with real failing commands (macOS, Linux or WSL2: it needs Claude Code's sandbox) |

The smoke tests never leave data behind in a shared database. Against a deployed server they only write when `FIREFINDER_ADMIN_KEY` is set, and they disable their test record afterwards.

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
- the Claude Code plugin and the generated Claude files staying in sync

The most important test is the **chain reaction**: User A searches, finds nothing, and "That fixed it" saves the fix. User B asks in different words, gets the fix first, and "That worked" confirms it (`✓ 2`). User C's "didn't fix it" records a failure. It runs through the Claude tools, over HTTP and the remote MCP endpoint ([tests/integration/remote-mcp.test.ts](tests/integration/remote-mcp.test.ts), [tests/integration/core-loop.test.ts](tests/integration/core-loop.test.ts)).

---

## Roadmap

Not built yet on purpose; the architecture is ready for each:

- **ChatGPT and other assistants.** They use the same HTTP API or the remote MCP endpoint, so a fix found through Claude helps ChatGPT users too.
- **Directory listings.** Submitting the connector to Claude's connector directory, the Claude Code plugin to a public plugin marketplace, and the Codex and ChatGPT plugin to OpenAI's plugin directory (which needs the domain challenge at `/.well-known/openai-apps-challenge`).
- **Browser extension** on top of `packages/client`.
- **Community mirrors and self-hosted federation.** UUIDv7 IDs and a portable schema make this possible; no sync protocol exists yet.
- **Per-user keys and anonymous attestations** for stronger vote integrity.

---

## Contributing and license

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md), and [SECURITY.md](SECURITY.md) for reporting vulnerabilities. FireFinder is released under the [MIT License](LICENSE).
