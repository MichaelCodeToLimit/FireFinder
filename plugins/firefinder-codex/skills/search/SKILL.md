---
name: search
description: Only when the user explicitly asks to search FireFinder. Searches FireFinder's shared memory of verified fixes for a problem and shows what it finds, including when nothing matches.
---

# Search FireFinder

The user explicitly asked to search FireFinder.

1. **Pick the problem.** Use what the user wrote with the request. If it names no problem, use the problem the user is stuck on in this conversation. If there's none, ask what to search for and stop.
2. **Search.** Call `search_firefinder` with a short generalized `problem`, `software` only when it's one named product, `operating_system` and `software_version` when known, and the exact `error_message`. Remove names, emails, usernames, paths containing usernames, hostnames, IPs, keys and passwords.
3. **Show what came back.** For each fix: its FIRE number, how many people confirmed it and how many reported it failed, the problem, and the fix. Say which one fits the user's situation, if any.
4. **Say so when nothing matches.** The user asked for this search, so tell them FireFinder has no verified fix for it yet, then help solve the problem as usual. (Automatic searches stay silent on a miss; this one doesn't.)
5. **Remember the id** of any fix the user tries, so a later "that worked" or "it failed" records the outcome against it.

If FireFinder errors or its tools aren't available, say it isn't connected yet: in Codex, install or re-enable the FireFinder plugin and sign in when asked; in ChatGPT, connect FireFinder under Plugins. It needs no account. Then help without it.
