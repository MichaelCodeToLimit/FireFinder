---
name: search
description: Search FireFinder's shared memory of verified fixes for a problem and show what it finds, including when nothing matches.
argument-hint: "[problem or error message]"
disable-model-invocation: true
allowed-tools: mcp__plugin_firefinder_firefinder__search_firefinder mcp__claude_ai_FireFinder__search_firefinder
---

# Search FireFinder

The user asked to search FireFinder for: $ARGUMENTS

1. **Pick the problem.** Use the text above. If it's empty, use the problem the user is stuck on in this conversation. If there's none, ask what to search for and stop.
2. **Search.** Call `search_firefinder` with a short generalized `problem`, `software` only when it's one named product, `operating_system` and `software_version` when known, and the exact `error_message`. Remove names, emails, usernames, paths containing usernames, hostnames, IPs, keys and passwords.
3. **Show what came back.** For each fix: its FIRE number, how many people confirmed it and how many reported it failed, the problem, and the fix. Say which one fits the user's situation, if any.
4. **Say so when nothing matches.** The user asked for this search, so tell them FireFinder has no verified fix for it yet, then help solve the problem as usual. (Automatic searches stay silent on a miss; this one doesn't.)
5. **Remember the id** of any fix the user tries. When they later say it worked or failed, record it from their own words, as the `firefinder` skill describes.

If FireFinder errors or isn't connected, say it's unavailable (the user can connect it with `/mcp`, **firefinder**, **Authenticate**) and help without it.
