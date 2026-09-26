# FireFinder for Claude

Connect FireFinder once. After that, Claude uses it by itself:

- **Searches first.** Whenever you describe a concrete technical problem (an error, crash, failing build/install/deploy, broken setting or device), Claude calls `search_firefinder` before answering. It gets back only strong, verified matches.
- **Uses a fix critically.** If a verified fix fits your situation, Claude offers it first, e.g. "This is a known fix, confirmed by 12 people".
- **Stays invisible.** If nothing fits, Claude doesn't mention FireFinder and solves the problem normally.
- **Records outcomes from your own words:**
  - "that worked" → `confirm_solution`
  - "still broken" → `report_solution`
  - "that fixed it" on Claude's own fix → `submit_solution`

  The write tools require `user_evidence` (your words), and the server checks them. "Thanks", "I'll try that" or Claude's confidence never count.
- **Never shares anything personal.** Nothing is saved from general questions, writing, math or small talk. What does get saved is generalized problem/fix text, without personal details.

The guidance Claude receives is in [system-prompt.md](system-prompt.md), which is generated from the MCP server.

## claude.ai, Claude Desktop, Claude mobile (recommended)

One remote connector works on all three and needs no API key.

1. **Customize → Connectors → + → Add custom connector.** On Team or Enterprise plans, an owner first adds it under **Organization settings → Connectors → Add → Custom → Web**.
2. URL: `https://wmrkcgivrurnycfqjznp.supabase.co/functions/v1/firefinder/mcp` (or your deployment's `/mcp`). Leave the OAuth fields under **Advanced settings** empty.
3. **Add**, then **Connect.** A window opens and closes by itself: FireFinder gives this connection an anonymous identity, with no login.
4. If Claude asks for permission the first time it calls a FireFinder tool, allow it always.

The connector then also appears in Claude Desktop and the Claude mobile apps on the same account. Free plans allow one custom connector.

How it works, and how it's protected: [docs/REMOTE_MCP.md](../../docs/REMOTE_MCP.md).

## Claude Code

Use the plugin: it bundles the remote server plus a skill with the same guidance.

```text
/plugin marketplace add https://github.com/MichaelCodeToLimit/FireFinder.git
```

```text
/plugin install firefinder@firefinder
```

Then `/mcp` → **firefinder → Authenticate** (once). Details: [plugins/firefinder](../../plugins/firefinder).

Or connect the remote server directly:

```bash
claude mcp add --transport http firefinder https://wmrkcgivrurnycfqjznp.supabase.co/functions/v1/firefinder/mcp
```

## Local stdio server (self-hosting, API keys)

`packages/mcp/dist/firefinder-mcp.js` (build it with `npm run build:mcp`) is a stdio MCP server with the same tools. It talks to the REST API with an API key, which suits self-hosted or local-only setups.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `FIREFINDER_API_KEY` | yes | | API key (`read,write`) |
| `FIREFINDER_API_URL` | | `http://localhost:8787` | API base URL |
| `FIREFINDER_API_REGION` | hosted only | | Supabase region of the database, so the API runs next to it |
| `FIREFINDER_CLIENT_ID` | | random, in `~/.firefinder/client-id` | Anonymous install ID used for one-vote-per-install |

Claude Desktop: see [claude_desktop_config.example.json](claude_desktop_config.example.json). Claude Code:

```bash
claude mcp add firefinder -e FIREFINDER_API_URL=http://localhost:8787 -e FIREFINDER_API_KEY=ff_your_key -- node /absolute/path/to/FireFinder/packages/mcp/dist/firefinder-mcp.js
```

## Claude API (Messages API)

- **Remote server:** use the MCP connector, with `mcp_servers: [{ type: "url", url: ".../mcp", name: "firefinder", authorization_token }]` plus a `mcp_toolset` tool entry. The token comes from FireFinder's OAuth flow.
- **Your own tool loop:** use [`tools.json`](tools.json) (Messages API format) and [`system-prompt.md`](system-prompt.md). Execute each call against the REST API:

| Tool | API call | Notes |
|---|---|---|
| `search_firefinder` | `POST /search` | Add `verified_only: true, min_similarity: 0.85`; `formatSearchResults()` from `packages/mcp` renders the text Claude expects |
| `get_fire` | `GET /solutions/:id` | `id` is a UUID or a FIRE number |
| `submit_solution` | `POST /solutions` | Only if `classifyUserEvidence(user_evidence) === 'worked'`; send `worked: true` |
| `confirm_solution` | `POST /solutions/:id/confirm` | Only if the evidence is `'worked'` |
| `report_solution` | `POST /solutions/:id/report` | Only if the evidence is `'failed'`; map `reason` → `note` |

## Try it without Claude

```bash
npm run smoke:mcp
```

This connects to the remote endpoint exactly like claude.ai (OAuth included). With `FIREFINDER_ADMIN_KEY` set, it also plays the chain reaction with two anonymous users and disables its test record afterwards. Without the key, against a deployed server, the check is read-only. `npm run demo` plays the chain reaction through the local stdio server against `npm run dev`.
