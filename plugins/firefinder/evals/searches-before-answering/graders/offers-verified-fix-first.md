---
type: llm
---

PASS if the response offers rebuilding the native modules (`npm rebuild`, or electron-rebuild for Electron apps) as the first or main fix to try.
FAIL if it does not suggest rebuilding native modules, or buries it behind unrelated fixes.
