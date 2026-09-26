---
expect:
  problem: string
---

🔥 Previously solved: FireFinder has 1 verified fix for this problem (best match first). Offer one first only if it fits the user's situation:

1. 🔥 FIRE #12 — ✓ verified · confirmed by 41 · ✕ 2 failed · last confirmed 5 days ago
   id: 01a0d96c-cdcb-7e55-bd1e-a9d72c78c912 · similarity 0.93 · score 0.79
   Problem: Build fails with "error:0308010C:digital envelope routines::unsupported" after upgrading to Node.js 17 or later
   Error: ERR_OSSL_EVP_UNSUPPORTED
   Environment: Node.js
   Solution:
   The build hashes with MD4, which OpenSSL 3 (Node 17+) no longer enables by default. Switch the hash to a supported algorithm: in webpack 5 set `output.hashFunction: 'xxhash64'`, upgrade webpack 4 to 5, or change your own `createHash('md4')` to `sha256`. As a stopgap, run the build with `NODE_OPTIONS=--openssl-legacy-provider`.

When the user later says whether it worked, however casually ("this worked", "still broken"), call confirm_solution or report_solution with its id and their words.
