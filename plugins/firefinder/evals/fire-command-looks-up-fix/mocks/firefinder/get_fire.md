---
expect:
  id: [3, "3"]
---

🔥 FIRE #3 — ✓ verified · confirmed by 27 · ✕ 1 failed · last confirmed 2 days ago
id: 01a0d96c-cdcb-7e55-bd1e-a9d72c78c979
Problem: Application crashes on startup with ERR_DLOPEN_FAILED after upgrading Node.js
Error: ERR_DLOPEN_FAILED
Environment: Node.js
Solution:
   Native modules were compiled for the previous Node version. Run `npm rebuild` (or `npx electron-rebuild` for Electron apps), then start the app again.

When the user reports back, call confirm_solution (it worked) or report_solution (it did not) with this id.
