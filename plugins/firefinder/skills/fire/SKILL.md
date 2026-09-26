---
name: fire
description: Show one FireFinder fix by its FIRE number or id, with its current confirmations and failure reports.
argument-hint: "[FIRE number or id]"
disable-model-invocation: true
allowed-tools: mcp__plugin_firefinder_firefinder__get_fire mcp__claude_ai_FireFinder__get_fire
---

# Look up a FireFinder fix

The user asked for this FireFinder fix: $ARGUMENTS

1. **Pick the fix.** Use the text above. If it's empty, use the FIRE number or id mentioned most recently in this conversation. If there's none, ask for one and stop.
2. **Look it up.** Call `get_fire` with `id` set to the FIRE number as a number (`FIRE #18492` becomes `18492`) or the full id as given.
3. **Show it.** The problem, the fix, and its trust signals: how many people confirmed it, how many reported it failed, when it was last confirmed, and whether it's under review. If it doesn't exist, say so.
4. **Record the outcome later.** If the user tries the fix and then says it worked or failed, record it from their own words, as the `firefinder` skill describes.

If FireFinder errors or isn't connected, say it's unavailable (the user can connect it with `/mcp`, **firefinder**, **Authenticate**).
