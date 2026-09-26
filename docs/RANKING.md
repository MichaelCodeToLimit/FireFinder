# Search and ranking

Search happens in two stages. Stage 1 is **candidate retrieval** in Postgres; it's fast and generous. Stage 2 is **ranking** in the API; it's precise, cheap and easy to change. Stage 2 lives in `packages/core/src/ranking.ts` as pure functions, so changing it never needs a migration.

## 1. Candidate retrieval (`firefinder.search_candidates`)

One SQL call returns the union of:

- **Semantic neighbours:** the top 30 by cosine distance on the problem embedding, using the HNSW index (`vector_cosine_ops`). The function sets `hnsw.ef_search = 100` so HNSW can return the full candidate list.
- **Exact error-code matches:** solutions whose `error_signature` array overlaps the query's (GIN index). This catches the case where the wording is vague but the error code is identical.

Disabled solutions are excluded here. Each candidate comes back with `similarity`, `error_overlap` and, for duplicate checks, `solution_similarity`.

### What gets embedded

`software + problem + error_message`, embedded with **gte-small** (384 dimensions, mean pooling, normalized). Stored records and queries use the same shape.

### Error signatures

`extractErrorSignature()` pulls out distinctive identifiers, lowercased, at most 12:

| Pattern | Examples |
|---|---|
| hex codes | `0x80070005`, `0xc000007b` |
| SCREAMING_SNAKE identifiers | `ERR_OSSL_EVP_UNSUPPORTED`, `DRIVER_IRQL_NOT_LESS_OR_EQUAL` |
| POSIX/npm error names | `ENOENT`, `EADDRINUSE`, `ERESOLVE` |
| exception classes | `TypeError`, `ModuleNotFoundError`, `NullPointerException` |
| product/compiler codes | `TS2345`, `CS0246`, `LNK2019`, `ORA-00942`, `KB5034441` |
| signals | `SIGSEGV` |
| numbered errors | `error code 43` → `code:43`, `HTTP 502` → `http:502` |

## 2. Ranking

### Filters

- Keep a candidate if `similarity ≥ min_similarity` (default **0.83**), or if it shares an exact error code and `similarity ≥ min_similarity − 0.08`.
- Drop candidates for **different software** (for example, a Blender fix for a Photoshop question) unless the exact error code matches.

### Score

```text
score = 0.55 · relevance
      + 0.15 · verification
      + 0.20 · environment
      + 0.05 · recency
      − 0.20 · failureRate
(× 0.6 when status = under_review)
```

| Signal | Definition | Range |
|---|---|---|
| relevance | `(similarity − 0.80) / 0.20`, clamped. If the query has error codes, the result is `0.75·that + 0.25·(error overlap ÷ query codes)` | 0…1 |
| verification | Wilson lower bound (95%) of `confirmations / (confirmations + failures)` | 0…1 |
| environment | Weighted mean over the dimensions **the query specified**: software 0.45, OS 0.35, version 0.20 | −1…1 |
| recency | `0.5 ^ (days since last confirmation, or creation / 180)` | 0…1 |
| failureRate | `failures / (confirmations + failures + 2)` (Laplace-smoothed) | 0…1 |

Environment levels map to scores as follows:

| Level | Score | Examples |
|---|---|---|
| `match` | +1 | Windows 11 ↔ Windows 11; Blender ↔ Blender |
| `partial` | +0.5 | Windows ↔ Windows 11 (one version unknown); 4.1 ↔ 4.2 (same major) |
| `unknown` | 0 | Either side didn't say |
| `different_version` | −0.4 | Windows 10 ↔ Windows 11; Node 16 ↔ Node 18 |
| `mismatch` | −1 | macOS ↔ Windows; Blender ↔ Photoshop |

### Why these choices

- **Popularity can't dominate.** Wilson's lower bound grows with evidence but never exceeds 1. So 1,000 confirmations beat 2 when everything else is equal (unit-tested), but not when the other fix matches the user's environment or is clearly more relevant. That is the Windows 10 vs Windows 11 requirement, tested in `tests/unit/ranking.test.ts` and `tests/integration/search.test.ts`.
- **Environment only counts what the user told us.** Someone who gives only their OS gets OS-aware ranking; someone who gives nothing isn't penalized.
- **Failures inform but don't erase.** Smoothing means one failure on a new fix barely moves it. A pattern of failures sinks it, and moderation can step in.
- **Recency is a tie-breaker.** It's worth at most 0.05; old but proven fixes stay on top.

## Calibration (gte-small, q8)

Measured with this repository's embedder:

| Pair | Cosine similarity |
|---|---|
| "My Windows Bluetooth disappeared." ↔ "Bluetooth is gone from my Windows laptop." | 0.968 |
| … ↔ "Windows doesn't show Bluetooth anymore." | 0.962 |
| Bluetooth ↔ "Vercel deployment fails during build" | 0.736 |
| Bluetooth ↔ "Blender crashes when rendering with Cycles on GPU" | 0.721 |
| Bluetooth ↔ "What is the capital of France?" | 0.666 |
| "Restart the Bluetooth service." ↔ "Restart the Bluetooth Support Service." | 0.988 |
| "Restart the Bluetooth service." ↔ "Update the graphics driver." | 0.783 |

gte-small places unrelated technical sentences around 0.70–0.81 and paraphrases above 0.90. That's why the relevance floor is 0.80 and the default `min_similarity` is 0.83. If you change the embedding model, recalibrate these numbers; the `embedding_model` column records which model produced each vector.

Everyday problems behave the same for paraphrases, but related-but-different problems score higher than unrelated technical ones:

| Stored: "Pomegranate juice stain on a wooden table mat / wood surface" | Similarity |
|---|---|
| "pomegranate stain on my wood table" (same, production) | 0.969 |
| "How do I get pomegranate juice out of a wooden table?" (same, production) | 0.931 |
| "Pomegranate juice stain on a white cotton shirt" (different material) | 0.924 |
| "Coffee stain on a wooden table" (different stain) | 0.907 |
| "How to peel a pomegranate without making a mess" (different problem) | 0.865 |

Similarity alone can't separate these, so Claude's automatic search keeps `min_similarity` at 0.85, and Claude judges whether a returned fix fits (the result shows the stored problem). Raising the threshold would drop real paraphrases.

The software mismatch filter can't be relaxed by similarity either. The same symptom on different software scores 0.89–0.95 ("Printer prints blank pages" for HP Smart vs Canon PRINT: 0.949). The filter therefore only fires when both sides name a product, and Claude is told to set `software` only to one specific named product, never to a category like "cleaning" or "car rental".

## Duplicate detection (`packages/core/src/dedupe.ts`)

A submission is merged into an existing record only when **all** of these hold:

1. The problem similarity is ≥ 0.90.
2. The solution similarity is ≥ 0.93, **or** the solutions share ≥ 85% of their words (Jaccard, stemmed, stopwords removed).
3. The environments don't conflict: different software, OS family, OS version or major version all keep records apart.
4. The fixes don't differ in an important detail: no opposite actions (enable/disable, install/uninstall, upgrade/downgrade, add/remove, start/stop, …) and no different version numbers.

A merge adds the submitter's confirmation to the existing record, counted once per voter.

## Tuning

All weights and thresholds are constructor options (`ServiceConfig.ranking`, `ServiceConfig.duplicates`, `minSimilarity`). Change them with tests: the unit tests in `tests/unit/ranking.test.ts` describe the intended behavior in plain language.
