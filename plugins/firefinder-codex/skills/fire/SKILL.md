---
name: fire
description: Only when the user explicitly asks for a FireFinder fix by number. Shows one FireFinder fix by its FIRE number or id, with its current confirmations and failure reports.
---

# Look up a FireFinder fix

The user explicitly asked to see a FireFinder fix.

1. **Pick the fix.** Use the FIRE number or id the user gave with the request. If they gave none, use the one mentioned most recently in this conversation. If there's none, ask for one and stop.
2. **Look it up.** Call `get_fire` with `id` set to the FIRE number as a number (`FIRE #18492` becomes `18492`) or the full id as given.
3. **Show it.** The problem, the fix, and its trust signals: how many people confirmed it, how many reported it failed, when it was last confirmed, and whether it's under review. If it doesn't exist, say so.
4. **Remember the id.** If the user tries the fix, a later "that worked" or "it failed" records the outcome against it.

If FireFinder errors or its tools aren't available, say it isn't connected yet: in Codex, install or re-enable the FireFinder plugin and sign in when asked; in ChatGPT, connect FireFinder under Plugins. It needs no account.
