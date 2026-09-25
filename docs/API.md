# FireFinder API reference

Base URL:

- Local: `http://localhost:8787`
- Supabase: `https://<project-ref>.supabase.co/functions/v1/firefinder`

All requests and responses are JSON (`Content-Type: application/json`).

## Authentication

Send an API key with every request except `GET /health`:

```text
X-API-Key: ff_…
```

`Authorization: Bearer ff_…` also works. Prefer `X-API-Key` when calling the Supabase-hosted API, so the key never collides with Supabase's own `Authorization` usage.

| Scope | Allows |
|---|---|
| `read` | `POST /search`, `GET /solutions`, `GET /solutions/:id` |
| `write` | `POST /solutions`, `POST /solutions/:id/confirm`, `POST /solutions/:id/report` |
| `admin` | everything, plus `POST /admin/solutions/:id/status` and seeing disabled records |

### Anonymous install ID (optional, recommended)

```text
X-FireFinder-Client: <8-64 chars of A-Z a-z 0-9 _ ->
```

This is a random identifier per install; the MCP server stores one in `~/.firefinder/client-id`. The server keeps only an HMAC of it, which is how it counts **one vote per install** and applies per-client rate limits. It must not contain anything personal.

## Endpoints

### `POST /search`

Find previously solved problems similar to this one, best first.

| Field | Type | Required | Notes |
|---|---|---|---|
| `problem` | string (3–1000) | yes | Generalized description |
| `software` | string (≤100) | | e.g. `"Blender"`, `"Node.js"` |
| `operating_system` | string (≤100) | | e.g. `"Windows 11"`, `"macOS 14"` |
| `software_version` | string (≤50) | | e.g. `"4.1"` |
| `error_message` | string (≤1000) | | Exact error text; error codes are matched exactly |
| `limit` | integer 1–20 | | Default 5 |
| `min_similarity` | number 0–1 | | Default 0.83 (calibrated for gte-small) |

```bash
curl -s "$FIREFINDER_API_URL/search" -H "X-API-Key: $FIREFINDER_API_KEY" -H "Content-Type: application/json" -d '{"problem":"npm start fails after upgrading Node","error_message":"ERR_OSSL_EVP_UNSUPPORTED"}'
```

**200:**

```json
{
  "results": [
    {
      "id": "01a0d962-f0b9-7b62-a030-d2d4c9d51e50",
      "fire_number": 6,
      "problem": "npm start fails after upgrading Node.js",
      "solution": "Set NODE_OPTIONS=--openssl-legacy-provider or upgrade react-scripts/webpack…",
      "software": "Node.js",
      "operating_system": null,
      "software_version": "18.17.0",
      "error_message": "Error: error:0308010C:digital envelope routines::unsupported ERR_OSSL_EVP_UNSUPPORTED",
      "confirmation_count": 184,
      "failure_count": 3,
      "status": "active",
      "verification_status": "verified",
      "created_at": "2026-09-01T10:00:00.000Z",
      "updated_at": "2026-09-25T09:00:00.000Z",
      "last_confirmed_at": "2026-09-25T09:00:00.000Z",
      "last_failed_at": "2026-09-20T14:00:00.000Z",
      "similarity": 0.94,
      "score": 0.83,
      "environment_match": { "software": "unknown", "operating_system": "unknown", "software_version": "unknown" }
    }
  ],
  "took_ms": 7
}
```

- `similarity`: cosine similarity between the query and the stored problem.
- `score`: the final ranking score ([RANKING.md](RANKING.md)).
- `environment_match`: per dimension, one of `match`, `partial`, `different_version`, `mismatch` or `unknown`.

An empty `results` array means nothing relevant is known yet. Searches are never stored.

### `POST /solutions`

Submit a problem and the fix that solved it.

| Field | Type | Required | Notes |
|---|---|---|---|
| `problem` | string (10–1000) | yes | Generalized, reusable problem statement |
| `solution` | string (10–5000) | yes | The fix; newlines and indentation are kept |
| `worked` | boolean | yes | `true` only if the user explicitly confirmed it worked. `true` stores it as **verified** with one confirmation; `false` stores an unverified **candidate**. |
| `software`, `operating_system`, `software_version`, `error_message` | string | | Same limits as search |
| `source` | string | | Short lowercase identifier of the integration, e.g. `"claude-mcp"` |

**Responses:**

- `201`: `outcome: "created"`, a new record.
- `200`: `outcome: "merged"`, meaning an equivalent solution already existed and this submission was added to it as a confirmation.
- `200`: `outcome: "duplicate"`, meaning the solution is already known and nothing changed (an unconfirmed submission, or the same voter again).

```json
{
  "outcome": "created",
  "solution": { "id": "…", "fire_number": 42, "confirmation_count": 1, "verification_status": "verified", "…": "…" },
  "redactions": ["email", "api_key"]
}
```

`redactions` lists the kinds of sensitive data removed before storage ([PRIVACY.md](PRIVACY.md)).

### `GET /solutions/:id`

`:id` is a UUID or a FIRE number (`/solutions/18492`).

- `200`: `{ "solution": { … } }`
- `404`: the solution doesn't exist, or it's disabled (non-admin keys).

### `POST /solutions/:id/confirm`

Records "it worked". The body is optional:

```json
{ "operating_system": "Windows 11", "software_version": "4.1" }
```

**200:** `{ "outcome": "recorded" | "changed" | "duplicate", "solution": { … } }`

- `recorded`: a new vote.
- `changed`: this voter previously reported a failure.
- `duplicate`: this voter had already confirmed it (counted once).

The confirmation also updates `last_confirmed_at`.

### `POST /solutions/:id/report`

Records "it didn't work". The body is optional:

```json
{ "operating_system": "Windows 10", "software_version": "5.0", "note": "Setting does not exist in 5.0" }
```

`note` is redacted and at most 500 characters. A report increments `failure_count` and sets `last_failed_at`; it **never deletes**. After at least 5 reports with a failure share of 75% or more, the solution moves to `under_review`. It stays searchable but is ranked lower until a moderator decides.

### `GET /solutions?limit=25&before=<fire_number>&status=<status>`

Recent solutions, newest first. Use `before` with the last `fire_number` you received to get the next page. Non-admin keys never see disabled records.

- `200`: `{ "solutions": [ … ] }`

### `POST /admin/solutions/:id/status` (admin)

```json
{ "status": "active" | "under_review" | "disabled" }
```

`disabled` hides a solution from search, get and feedback for everyone except admins.

### `GET /health`

`200`: `{ "status": "ok", "service": "firefinder", "version": "0.1.0", "embedding_model": "gte-small" }`

## Errors

Every error uses the same shape:

```json
{ "error": { "code": "invalid_request", "message": "Request validation failed.", "details": [{ "path": "problem", "message": "Too small: expected string to have >=10 characters" }] } }
```

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_request` | Validation failed (including unknown fields and bad IDs); `details` lists the fields |
| 400 | `invalid_json` | The body isn't valid JSON |
| 401 | `unauthorized` | The key is missing, unknown or revoked |
| 403 | `forbidden` | The key lacks the required scope |
| 404 | `not_found` | Unknown route, or the solution doesn't exist or is disabled |
| 413 | `payload_too_large` | The body is larger than 64 KB |
| 429 | `rate_limited` | Too many requests; see `Retry-After` |
| 500 | `internal_error` | Unexpected server error (details are logged server-side, never returned) |
| 503 | `internal_error` | Edge Function is missing required secrets |

## Rate limits

The defaults are 60 read and 20 write requests per minute per client (key + install ID), and 5× that per IP. Every limited response carries:

```text
RateLimit-Limit: 60
RateLimit-Remaining: 59
RateLimit-Reset: 42
Retry-After: 42        (only on 429)
```

## Other headers

- `Server-Timing`: server-side time per stage, in milliseconds. `/search` reports `auth`, `ratelimit`, `embed`, `db`, `rank` and the total `app`, e.g. `auth;dur=0.1, ratelimit;dur=0.1, embed;dur=2.4, db;dur=3.9, rank;dur=0.1` followed by `app;dur=6.8`.
