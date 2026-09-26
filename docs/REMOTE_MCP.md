# Remote MCP: FireFinder in claude.ai, Claude Desktop and mobile, Claude Code, Codex and ChatGPT

The remote MCP endpoint lets anyone connect FireFinder to Claude **once**, with no account and no API key. After that, FireFinder works automatically: Claude checks it before solving problems people get stuck on (technical or everyday), stays invisible when it has nothing, and records outcomes from the user's own words.

```text
Claude (claude.ai · mobile · Desktop · Claude Code)
   │  Streamable HTTP + OAuth 2.1
   ▼
https://<ref>.supabase.co/functions/v1/firefinder/mcp     (Supabase Edge Function)
   │  in-process: same validation, privacy filter, ranking, voting as the REST API
   ▼
Supabase PostgreSQL + pgvector
```

The endpoint is part of the existing `firefinder` Edge Function; there is no second service. The Node server (`npm start`) serves the same endpoint at `<FIREFINDER_PUBLIC_URL>/mcp` for self-hosting.

---

## The zero-touch loop

Connected Claude receives FireFinder's guidance through the MCP `instructions` field, the tool descriptions, and in Claude Code also the plugin skill. It then acts on its own:

1. **Decide:** is the user stuck on a practical problem someone else plausibly solved before? That covers technical problems and everyday ones (stains, household repairs, travel snags). If not ("What's the capital of France?"), or if it's about health, legal, financial or relationship matters, Claude doesn't touch FireFinder.
2. **Search first:** Claude calls `search_firefinder` before answering. The tool returns only *strong, verified* matches: similarity ≥ 0.85, at least one real confirmation, at most 3 results.
3. **Use it critically:** if a match fits, Claude offers it as the first thing to try, optionally saying naturally that it's a previously verified fix.
4. **Stay invisible:** with no strong match, the tool answers "continue normally and do not mention FireFinder", and Claude simply solves the problem.
5. **Record outcomes automatically, only from the user's own words, however casual:**
   - "this worked" / "amazing, that worked!" on a FireFinder fix → `confirm_solution`
   - "still broken" / "the stain is still there" → `report_solution`
   - "that did it" on any other fix, whether Claude suggested it or the user describes using it → `submit_solution`, with a generalized problem and the fix that worked

Claude passes the user's words as `user_evidence`. **The server checks them** (`packages/core/src/evidence.ts`) and records nothing unless they clearly state the outcome. "Thanks", "I'll try that", praise alone ("perfect!"), partial improvements ("a bit lighter"), questions, mixed signals and Claude's own confidence never count.

The guidance is repeated in the tool descriptions, because some clients show Claude only those, and claude.ai may load connector tools on demand by matching what the user says against them.

This behavior is tested with real Claude sessions: `claude plugin eval plugins/firefinder`. See [Testing](#testing).

## Tools

| Tool | Access | What it does |
|---|---|---|
| `search_firefinder` | read-only | Strong verified matches for a problem, or an "invisible" miss |
| `get_fire` | read-only | One fire by FIRE number or id |
| `submit_solution` | write | Save a problem + fix; requires `user_evidence` that says it worked |
| `confirm_solution` | write | +1 confirmation (once per user); requires `user_evidence` that says it worked |
| `report_solution` | write | +1 failure report (never deletes); requires `user_evidence` that says it failed |

Every input schema is strict (`additionalProperties: false`). Unexpected arguments such as `confirmation_count` or `status` are rejected. These five operations are the only things the endpoint can do: there is no moderation, no deletion, and no raw database access.

---

## Authentication

claude.ai, Claude mobile and Claude Desktop require OAuth for remote connectors. FireFinder implements the [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) as its own small OAuth 2.1 authorization server, inside the same function.

1. Claude calls `/mcp` without a token. It gets `401` with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource", scope="firefinder:read firefinder:write"`.
2. Claude reads the protected-resource metadata, then the authorization-server metadata. On Supabase that metadata is found at `…/firefinder/.well-known/openid-configuration`, the path-appended OpenID discovery form, because Supabase can't serve `/.well-known` at the domain root.
3. Claude registers itself (`POST /oauth/register`, RFC 7591). Registration is **stateless**: the `client_id` is a signed token listing the redirect URIs, so registration spam costs no storage. Only Claude's callback (`https://claude.ai/api/mcp/auth_callback`), ChatGPT's callbacks (`https://chatgpt.com/connector_platform_oauth_redirect`, and `https://chatgpt.com/connector/oauth/<id>` as a fallback) and loopback addresses (Claude Code, Codex CLI, MCP Inspector) are accepted as redirect URIs. ChatGPT and Codex pick the stable callback because the authorize step returns `iss` ([RFC 9207](https://www.rfc-editor.org/rfc/rfc9207)).
4. The browser opens `GET /oauth/authorize` with PKCE (S256 only) and the `resource` parameter. **There is no login and no consent screen.** FireFinder mints a new *anonymous identity* and redirects straight back to Claude with a single-use code (valid 5 minutes, stored hashed).
5. Claude exchanges the code (`POST /oauth/token`) and receives:
   - an **access token** valid for 1 hour, HMAC-signed, bound to the audience `…/mcp`;
   - a **refresh token** valid for 90 days, stored hashed and rotated on every use. A reused refresh token is rejected.

**Why no login?** Authorizing grants access to a brand-new anonymous identity, not to anyone's existing data, so there's nothing a consent screen would protect. The identity exists so that votes count once per user and rate limits apply per user. All Claude traffic arrives from Anthropic's IP range, so IP addresses can't tell users apart.

### Abuse protection

| Threat | Protection |
|---|---|
| Vote stuffing through many identities | Minting identities is limited per user IP (the browser request): 10/hour and 30/day by default. One vote per identity per solution |
| Tool spam | 60 reads and 20 writes per identity per minute (database-backed limiter) |
| Recording without real evidence | Server-side evidence check on every write tool |
| Forged or foreign tokens | HMAC verification (constant-time), audience check, expiry. REST API keys don't work on `/mcp`, and MCP tokens don't work on the REST API (no token passthrough) |
| Open redirect / phishing via DCR | Redirect URIs are allowlisted at registration and re-checked at authorization; unknown clients get a `400`, never a redirect |
| Code interception | PKCE S256 is required; codes are single-use and bound to the client, redirect URI and verifier |
| Arbitrary database manipulation | Only the five operations exist; inputs are validated and parameterized; the tables have RLS enabled and are invisible to Supabase's Data API; no database or service-role credentials ever leave the server |
| Malicious content | The same privacy filter as the REST API redacts secrets and personal data before storage |

Operators can cut off an identity with `update firefinder.oauth_grants set revoked_at = now() where id = '<sub>'`. It takes effect at the next token refresh, within an hour.

---

## Deploy

The hosted instance runs on the Supabase project from [DEPLOYMENT.md](DEPLOYMENT.md). To add the remote endpoint to an existing deployment:

1. **Apply the OAuth migration** (`supabase/migrations/20260926000000_remote_mcp_oauth.sql`):
   ```bash
   supabase db push
   ```
2. **Pin database work to the database region** (recommended; e.g. `ap-southeast-1`):
   ```bash
   supabase secrets set FIREFINDER_DB_REGION=<database-region>
   ```
3. **Deploy:**
   ```bash
   npm run deploy:edge
   ```
4. **Verify from your machine**, the same way claude.ai connects. With the admin key it runs the full chain reaction and disables its test record afterwards; without it, against a deployed server, the check is read-only:
   ```bash
   FIREFINDER_MCP_URL=https://<ref>.supabase.co/functions/v1/firefinder/mcp FIREFINDER_ADMIN_KEY=ff_… npm run smoke:mcp
   ```

### Environment variables

| Variable | Where | Required | Purpose |
|---|---|---|---|
| `FIREFINDER_VOTER_SECRET` | Edge secret / Node env | yes | Voter hashes; also the default OAuth signing secret |
| `FIREFINDER_OAUTH_SECRET` | Edge secret / Node env | no | Separate secret for OAuth tokens and client ids (16+ chars). Rotating it signs everyone out |
| `FIREFINDER_DB_REGION` | Edge secret | no | Database region; database-bound requests are forwarded there (see below) |
| `FIREFINDER_PUBLIC_URL` | Edge secret / Node env | Node: yes in production | Public base URL (OAuth issuer). Edge default: `$SUPABASE_URL/functions/v1/firefinder`; Node default: `http://localhost:$PORT` |
| `MCP_READ_PER_MINUTE`, `MCP_WRITE_PER_MINUTE` | both | no | Per-identity tool limits (60 / 20) |
| `MCP_IDENTITIES_PER_IP_PER_HOUR` | both | no | New identities per IP per hour (10) |
| `SUPABASE_URL`, `SUPABASE_DB_URL`, `SB_REGION` | provided by Supabase | | Issuer URL, database connection, current region |

No database credentials, service-role keys or other secrets are ever sent to Claude or to users. Claude only ever holds its own short-lived access token.

### Speed: region forwarding

Supabase runs an Edge Function near the *caller*, and for claude.ai the caller is Anthropic's servers. Each database round trip from there to your database region crosses continents. The function therefore answers the MCP handshake (`initialize`, `tools/list`), metadata and registration locally, and forwards only database-bound requests to the function in `FIREFINDER_DB_REGION`: tool calls, token exchange, authorization and REST calls. The caller's IP travels in a signed header, so per-IP limits keep working. If the forwarded hop fails at the platform level, the request is handled locally instead.

Measured from Europe against the Singapore database:

| Request | Handled in | Server time | Round trip |
|---|---|---|---|
| `initialize`, `tools/list` | caller's region | ~13 ms | ~150–200 ms |
| `tools/call search_firefinder` | database region | ~310–400 ms (connection + embedding + 8 ms vector search) | ~0.8–0.9 s |

The `x-firefinder-region` response header shows which region handled a request.

---

## Connect FireFinder to Claude

### claude.ai, Claude Desktop, Claude mobile (one connector for all)

1. Open **Customize → Connectors**, click **+**, then **Add custom connector**. On Team and Enterprise plans, an owner first adds it under **Organization settings → Connectors → Add → Custom → Web**.
2. Name: `FireFinder`. URL: `https://<ref>.supabase.co/functions/v1/firefinder/mcp` (the public instance: `https://wmrkcgivrurnycfqjznp.supabase.co/functions/v1/firefinder/mcp`). Leave the OAuth fields under **Advanced settings** empty.
3. Click **Add**, then **Connect**. A window opens and closes almost immediately (there is no login).
4. If Claude asks for permission the first time it uses a FireFinder tool, allow it always, so it can keep working without asking.

The connector syncs to Claude Desktop and the mobile apps. It's enabled for new chats; you can toggle it under **+ → Connectors** in a chat. Free plans allow one custom connector.

### Claude Code

Install the plugin, which bundles the remote server, the FireFinder skill, a hook that has Claude check FireFinder when an install, build or deploy command it runs fails, and the `/firefinder:search` and `/firefinder:fire` commands:

```text
/plugin marketplace add https://github.com/MichaelCodeToLimit/FireFinder.git
```

```text
/plugin install firefinder@firefinder
```

Then run `/mcp`, choose **firefinder → Authenticate** once. If you've also added FireFinder as a claude.ai connector, Claude Code keeps one of the two, since they share a URL. The plugin works with either. The plugin's `.mcp.json` points at the public instance; for your own deployment, change its URL in a fork or use `claude mcp add` below.

Or, without the plugin:

```bash
claude mcp add --transport http firefinder https://<ref>.supabase.co/functions/v1/firefinder/mcp
```

### Codex and ChatGPT

One plugin, [plugins/firefinder-codex](../plugins/firefinder-codex), serves both. It bundles the remote server, the zero-touch skill and five skills the user can invoke (`search`, `fire`, `worked`, `failed`, `help`). Codex has no failed-tool hook event and hooks don't run in ChatGPT chat, so the skill carries the failed-command guidance instead.

```bash
codex plugin marketplace add MichaelCodeToLimit/FireFinder
```

```bash
codex plugin add firefinder@firefinder
```

Then `codex mcp login firefinder` once. The ChatGPT desktop app reads the same marketplaces: install **FireFinder** from **Plugins**. On ChatGPT on the web, turn on **Developer mode** and add the `/mcp` URL at [chatgpt.com/plugins](https://chatgpt.com/plugins) with OAuth and no client credentials.

To publish in OpenAI's plugin directory, submit the `/mcp` URL through the [plugin submission portal](https://platform.openai.com/plugins) with the plugin's skills. The portal needs a domain challenge served at `/.well-known/openai-apps-challenge` on the MCP host, which Supabase can't serve at the domain root, so a directory listing needs a custom domain.

---

## Testing

| What | How |
|---|---|
| OAuth and every tool, through the official MCP SDK client, served under Supabase's path layout | `npx vitest run tests/integration/remote-mcp.test.ts` (23 tests) |
| Region forwarding, the forwarded-IP signature, platform-failure fallback | `npx vitest run tests/unit/region-routing.test.ts` |
| Evidence classification ("that worked" / "still broken" / "thanks") | `npx vitest run tests/unit/evidence.test.ts` |
| The live deployment, end to end, connecting like claude.ai | `npm run smoke:mcp` |
| Claude's actual decisions with the plugin (real Claude, mocked FireFinder) | `claude plugin eval plugins/firefinder --ablation none --no-publish --max-cost-usd 3` |
| The plugin's failed-command hook, with real failing commands (macOS, Linux or WSL2) | `claude plugin eval plugins/firefinder --eval-dir evals-shell --allow-tools Bash --scaffold --ablation none --no-publish` |
| Manual poking | [MCP Inspector](https://github.com/modelcontextprotocol/inspector): `npx @modelcontextprotocol/inspector`, transport "Streamable HTTP", the `/mcp` URL (loopback redirects are allowed) |

## Limitations

- **Identities are per connection.** Reconnecting creates a new identity, which could vote again on a solution. That rate is bounded by the per-IP minting limits.
- **Revocation isn't immediate.** Revoking an identity takes effect at its next refresh, so an access token can remain valid for up to an hour.
- **Evidence classification is pattern-based.** It errs toward recording nothing when the user's words are unusual.
- **Dynamic registration is used, not CIMD.** Registration is stateless, so it creates no records.
