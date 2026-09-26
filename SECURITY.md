# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately through **GitHub → Security → "Report a vulnerability"** (private security advisory) on this repository. If that option isn't available, open an issue that only asks for a private contact, without any details. Include:

- what you found and where (file, endpoint, commit),
- how to reproduce it,
- the impact you expect.

We aim to acknowledge reports within 72 hours and to ship a fix or mitigation for confirmed issues as fast as their severity requires. We will credit you in the release notes unless you prefer otherwise.

Especially valuable:

- ways to make FireFinder **store personal data or secrets** despite the privacy filter
- ways to **read data or call functions** through Supabase's Data API
- authentication or scope bypasses
- ways to inflate confirmation counts beyond the documented limitations below

## Supported versions

FireFinder is pre-1.0. Security fixes land on `main` and in the latest release.

## Security model

| Area | Measure |
|---|---|
| Authentication | API keys (`ff_` + 40 random base62 chars) sent via `X-API-Key` or `Authorization: Bearer`. Only SHA-256 hashes are stored. Keys can be revoked (`npm run keys:create -- --revoke <prefix>`). Lookups are cached for 60 s, so a revocation takes effect within a minute. |
| Authorization | Scopes: `read` (search, get, list), `write` (submit, confirm, report), `admin` (moderation, and seeing disabled records). |
| Rate limiting | Per client (key + install ID) and per IP (5× the client limit). Node uses an in-memory limiter; Edge Functions use a Postgres-backed limiter whose bucket keys are HMACs (no IPs are stored in readable form). If the limiter backend itself fails, requests are allowed (fail open). |
| Input handling | zod validation with strict objects (unknown fields are rejected). Text is sanitized (control, zero-width and bidi characters are removed) before length checks. Bodies are capped at 64 KB. IDs are validated. JSON errors never include stack traces. |
| Privacy filter | Secrets and personal data are redacted before storage (see [docs/PRIVACY.md](docs/PRIVACY.md)). |
| SQL | Parameterized statements only. Arrays are passed as JSON and unpacked in SQL. |
| Database | FireFinder has its own schema (`firefinder`), which Supabase's auto-generated REST API doesn't expose. RLS is enabled on every table with **no policies**. `anon` and `authenticated` get no privileges on the schema, tables or functions, and `EXECUTE` is revoked from `PUBLIC`. Every function has `search_path = ''`. CHECK constraints mirror API validation. |
| Secrets | Only environment variables / Supabase secrets are used; nothing is hard-coded. `.env`, `.data/` (local database and dev key) and build output are gitignored, and `.env.example` contains names only. The Supabase service-role key is **not used** by FireFinder. Never put it in an MCP config or a client. The Claude Code plugin contains only the public server URL. |
| HTTP | Hono `secureHeaders` on every response. CORS is off unless `CORS_ORIGINS` is set. The developer console uses a strict CSP (`script-src 'self'`, no inline scripts) and renders all data with `textContent`. |
| Logging | Structured logs with method, path and error only. Request bodies and search queries are never logged. |

## Remote MCP endpoint (claude.ai, Claude mobile, Claude Code)

The `/mcp` endpoint is public, so it's protected differently from the API-key REST API. Full details are in [docs/REMOTE_MCP.md](docs/REMOTE_MCP.md#abuse-protection).

- **OAuth 2.1.** It follows the MCP authorization spec:
  - PKCE S256 is required.
  - Authorization codes are single-use and expire after 5 minutes.
  - Access tokens are HMAC-signed, bound to the `/mcp` audience, and valid for 1 hour.
  - Refresh tokens rotate and are stored only as hashes.
- **Anonymous identities.** Authorizing mints an identity rather than logging anyone in, so there's no personal data to leak. Minting is rate-limited per end-user IP (10/hour, 30/day).
- **Redirect URIs are allowlisted** (Claude's callback and loopback). Unknown clients never get a redirect.
- **Only five operations exist:** search, get, submit, confirm, report. Inputs are strict, and writes require the user's own words, checked on the server. There are no moderation or delete operations and no raw database access. No database or service-role credentials are ever exposed.
- **No token passthrough.** MCP tokens are rejected by the REST API, and REST API keys are rejected by `/mcp`.
- **Per-identity limits:** 60 reads and 20 writes per minute, database-backed.
- **Signed forwarding.** Requests forwarded between regions carry the caller's IP in an HMAC-signed, 60-second header. Unsigned or stale claims are ignored.

## Known limitations (MVP)

- **Remote MCP identities are per connection.** Reconnecting yields a new identity that can vote again; the per-IP minting limits bound this. Revoking an identity (`oauth_grants.revoked_at`) takes effect at its next token refresh, within an hour.
- **Vote integrity with shared keys.** One vote per install relies on the random install ID the client sends. A malicious client holding a valid key can rotate install IDs to vote repeatedly; per-IP rate limits slow this down but don't prevent it. Mitigations are planned: per-user keys, and signed or anonymous attestations.
- **Redaction is best-effort.** Pattern-based filtering catches common secrets and personal data. It cannot recognize every name or proprietary detail in free text, so the Claude integration is also instructed to generalize and strip personal details before submitting.
- **In-memory rate limits are per process.** Behind a load balancer with several Node instances, use a shared limiter (the Postgres-backed `StoreRateLimiter`, or a Redis implementation of `RateLimiter`).
- **The local dev key has all scopes** and is written to `.data/dev-api-key`. It is for local PGlite databases only; the server never creates one for a shared database.
