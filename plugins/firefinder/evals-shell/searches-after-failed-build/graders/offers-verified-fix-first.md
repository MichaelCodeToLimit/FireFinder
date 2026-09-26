---
type: llm
---

PASS if the response explains that the build fails because MD4 isn't available on newer Node.js (OpenSSL 3), and leads with switching the hash algorithm (for example to sha256), mentioning `--openssl-legacy-provider` at most as a stopgap.
FAIL if it misdiagnoses the error, or recommends downgrading Node.js as the main fix.
