# Contributing to FireFinder

Thanks for helping people get out of the fire. This project values a **small, reliable core loop** over features: search → present → confirm → remember. Please keep changes focused.

## Setup

```bash
npm install
```

```bash
npm test
```

```bash
npm run dev
```

Node.js 22.18+ is required (TypeScript runs natively through Node's type stripping, so there's no build step for development). No Docker or external database is needed: tests and `npm run dev` use PGlite (real PostgreSQL + pgvector compiled to WASM).

The first test run downloads the gte-small model (~34 MB) into `.cache/models`.

## Project conventions

- **TypeScript that Node can run directly.** Use erasable syntax only (no `enum`, `namespace` or constructor parameter properties). Import relative files with their `.ts` extension, and use `import type` for types. `npm run typecheck` enforces this.
- **`packages/core` must stay runtime-agnostic.** Use Web APIs only (`crypto.subtle`, `fetch`, `TextEncoder`), with no `node:` imports, so the same code runs on Node and in Supabase Edge Functions (Deno).
- **Technical names in code, fire names in UI.** Code and the API say `problem`, `solution`, `confirmation` and `report`; "🔥 FIRE #123" is presentation only.
- **Match the surrounding code:** naming, comment density, error handling.

## Where things go

| Change | Location | Also update |
|---|---|---|
| Ranking weights or signals | `packages/core/src/ranking.ts` | `tests/unit/ranking.test.ts`, `docs/RANKING.md` |
| Duplicate rules | `packages/core/src/dedupe.ts`, `normalize.ts` | `tests/unit/dedupe-and-limits.test.ts`, `tests/integration/duplicates.test.ts` |
| Privacy filter | `packages/core/src/privacy.ts` | `tests/unit/privacy.test.ts` (both "redacts" and "leaves alone" cases), `docs/PRIVACY.md` |
| API endpoints / fields | `packages/core/src/http.ts`, `schemas.ts` | `packages/client`, `docs/API.md`, tests |
| Claude tool wording | `packages/mcp/src/server.ts`, `instructions.ts` | run `npm run export:claude` (a test fails if you forget) |
| Schema | new file in `supabase/migrations/` | see below |

## Database migrations

- Add a **new** file: `supabase/migrations/<YYYYMMDDHHMMSS>_<description>.sql`. Never edit a migration that has shipped.
- Keep it **idempotent** (`if not exists`, `create or replace`, guarded `DO` blocks). It must work with both `supabase db push` and `npm run db:migrate`.
- Every new table needs RLS enabled and must stay invisible to `anon` / `authenticated`. Every new function needs `set search_path = ''` and no `EXECUTE` for `PUBLIC`. `tests/integration/privacy-and-schema.test.ts` checks this.
- Keep it portable: plain PostgreSQL 15+ with pgvector, and nothing that requires Supabase.

## Privacy rules (non-negotiable)

- Never add columns or logs that could hold a conversation, a person's identity, an IP address or a raw client identifier.
- Never log request bodies or search queries.
- New free-text fields must go through `redactFields` in `service.ts`.

## Tests

`npm test` must pass, and so must `npm run typecheck`. Please add tests with every behavior change: unit tests for pure logic, and integration tests (see `tests/helpers/context.ts`) for anything touching the API or database. The core-loop test (`tests/integration/core-loop.test.ts`) is the product's definition of done; keep it green.

## Pull requests

1. Describe the problem and the approach in a few sentences.
2. Keep PRs small and focused; separate refactors from behavior changes.
3. Note any change to ranking, privacy or the schema explicitly in the description.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
