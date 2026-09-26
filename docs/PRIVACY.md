# Privacy model

FireFinder's rule: **store the reusable fix, never the person or the conversation.**

## What is stored

| Table | Columns | Content |
|---|---|---|
| `solutions` | `problem`, `solution`, `error_message` | Generalized text, **after** the privacy filter |
| | `software`, `operating_system`, `software_version` | Non-personal environment |
| | `software_key`, `os_family`, `os_version`, `version_major`, `error_signature` | Normalized metadata derived from the above |
| | `embedding`, `solution_embedding` | Vectors derived from the filtered text |
| | counts, status, timestamps, `source` | `source` names the integration (e.g. `claude-mcp`), never a person |
| `solution_confirmations` | `result`, `voter_hash` | `worked` / `failed`, plus an HMAC of an anonymous install ID |
| | `operating_system`, `software_version`, `note` | Optional voter environment and short reason (redacted) |
| `api_keys` | `name`, `key_prefix`, `key_hash`, `scopes` | Key label chosen by the operator; only a SHA-256 hash of the key |
| `rate_limit_buckets` | `bucket_key`, `window_start`, `hits` | HMACs of `client`/`IP` bucket names, deleted within about an hour |
| `oauth_codes` | `code_hash`, `client_id`, `redirect_uri`, `code_challenge`, `resource`, `scopes` | Remote MCP sign-in in progress: a hashed single-use code, deleted when redeemed and useless after 5 minutes |
| `oauth_grants` | `id`, `client_id_hash`, `client_name`, `scopes`, `refresh_token_hash`, timestamps | One anonymous identity per connection (e.g. client name "Claude"). No account, name, email or IP |

## What is never stored

- Conversations, chat transcripts or prompts. The API rejects unknown fields, and no column could hold them.
- Names, emails, usernames or account identifiers.
- Search queries. Searches are read-only and are not logged.
- IP addresses or raw install IDs. Rate limiting and vote counting use keyed HMACs only.
- Passwords, API keys, tokens or private keys. They are redacted before storage, as described below.

## Automatic recording (zero-touch)

Claude records outcomes on its own, but only from the user's own words: "that worked", "still broken". The words are checked on the server to decide whether anything is recorded, and are then discarded; they're never stored. Recording something requires clear evidence. Conversations, Claude's reasoning, and anything from general questions are never sent to FireFinder.

## The privacy filter (`packages/core/src/privacy.ts`)

Every free-text field in submissions and feedback passes through two steps.

### 1. Sanitize

Unicode NFKC normalization. Control, zero-width and bidi-override characters are stripped. Whitespace is normalized, but line breaks and indentation are kept in problem and solution bodies.

### 2. Redact

| Kind | Examples → replacement |
|---|---|
| `private_key` | `-----BEGIN … PRIVATE KEY----- … -----END …` → `[REDACTED_PRIVATE_KEY]` |
| `url_credentials` | `postgres://admin:pw@host` → `postgres://[REDACTED]@host` |
| `token` | JWTs, `Bearer …`, `Basic …` → `[REDACTED_TOKEN]` / `Bearer [REDACTED]` |
| `api_key` | Anthropic, OpenAI, GitHub, GitLab, Slack, AWS, Google, Stripe, Supabase, npm, Hugging Face, SendGrid, FireFinder keys → `[REDACTED_API_KEY]` |
| `secret` | `PASSWORD=…`, `"client_secret": "…"`, `--password …`, long high-entropy strings → `[REDACTED]` / `[REDACTED_SECRET]` |
| `email` | `jane@example.com` → `[REDACTED_EMAIL]` (`git@github.com:` remotes are kept) |
| `card_number` | Luhn-valid card numbers → `[REDACTED_CARD]` |
| `ssn` | `123-45-6789` → `[REDACTED_SSN]` |
| `phone` | `(555) 123-4567`, `+44 20 7946 0958` → `[REDACTED_PHONE]` |
| `ip_address` | public IPv4 → `[REDACTED_IP]` (private ranges and version strings are kept) |
| `username_in_path` | `C:\Users\jsmith\…`, `/Users/jane/…`, `/home/bob/…` → `<user>` |

The filter deliberately **keeps** detail that helps match problems: error codes (`0x80070005`, `ERR_…`), versions, GUIDs, private IPs, `localhost` URLs and config variable names (`NODE_OPTIONS=…`). Each redaction kind is covered by tests in both directions: what gets redacted, and what is left alone.

Submission responses include `redactions: [...]`, so the integration can tell the user what was removed.

## Anonymous voting

Each install (e.g. the MCP server on one machine) generates a random ID, stored in `~/.firefinder/client-id`. The server stores only:

```text
voter_hash = HMAC-SHA256(FIREFINDER_VOTER_SECRET, "voter:" + api_key_id + ":" + install_id)
```

This lets FireFinder count one vote per install, and lets a voter change their vote, without knowing who anyone is. Rotating `FIREFINDER_VOTER_SECRET` breaks the link to existing votes.

## Defense in depth

Pattern matching cannot find every personal detail in free text. The Claude integration is therefore instructed, both in its MCP instructions and in its tool descriptions, to:

- rewrite problems and fixes in generic, reusable terms,
- leave out names, emails, usernames, hostnames, IPs, keys, passwords and private code,
- ask the user before submitting anything that came from confidential material,
- tell the user, in one line, what it shared.

## Deletion

- Moderators can hide a record immediately: `POST /admin/solutions/:id/status {"status":"disabled"}`.
- Operators can hard-delete it: `delete from firefinder.solutions where id = '…'` (its votes cascade).
- Rate-limit buckets expire on their own.
