---
name: failed
description: Tell FireFinder that one of its fixes didn't work, so its failure count goes up and the next person sees it. Never deletes anything.
argument-hint: "[FIRE number, what happened (optional)]"
disable-model-invocation: true
allowed-tools: mcp__plugin_firefinder_firefinder__report_solution
---

# Report a FireFinder fix that didn't work

The user typed `/firefinder:failed`, followed by this note (it may be empty): $ARGUMENTS

Typing the command is the user saying, in their own words, that the fix didn't work. Report it now, without asking whether they're sure.

1. **Find the FireFinder fix.** Use a FIRE number or id in the note. Otherwise, use the FireFinder fix the user tried most recently in this conversation. Only FireFinder fixes can be reported: if the fix that failed didn't come from FireFinder, say there's nothing to report and keep helping. If you can't tell which fix they mean, ask one short question and stop.
2. **Report it once.** If you already reported this fix earlier in the conversation, don't report it again.
3. **Report it.** Call `report_solution` with:
   - `id`: the fix's FIRE number or id.
   - `user_evidence`: exactly what the user typed, starting with `/firefinder:failed` and including their note, cut to 300 characters if it's longer.
   - `reason`: when the note or conversation says what happened, a short generalized description, such as "Wi-Fi still drops every few minutes". No personal details.
   - `operating_system` and `software_version` when known. A fix can fail in one setup and work in another, so these make the report useful.
4. **Tell the user in one line** that it's reported, then keep helping: offer the next thing to try.

If FireFinder says it recorded nothing, tell the user and pass on why. If FireFinder errors or its tools aren't available, say it isn't connected yet and that they can connect it once in the app's connector settings (it needs no account).
