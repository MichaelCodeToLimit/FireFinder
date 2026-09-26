---
name: failed
description: Only when the user explicitly invokes it to say a FireFinder fix didn't work. Reports the failure so its failure count goes up and the next person sees it. Never deletes anything.
---

# Report a FireFinder fix that didn't work

**Check first.** Continue only if the user's latest message invoked this skill by name, or itself says the fix didn't work. Otherwise stop here and report nothing.

Invoking this skill is the user saying, in their own words, that the fix didn't work. Report it now, without asking whether they're sure.

1. **Find the FireFinder fix.** Use a FIRE number or id in the user's note. Otherwise, use the FireFinder fix the user tried most recently in this conversation. Only FireFinder fixes can be reported: if the fix that failed didn't come from FireFinder, say there's nothing to report and keep helping. If you can't tell which fix they mean, ask one short question and stop.
2. **Report it once.** If you already reported this fix earlier in the conversation, don't report it again.
3. **Report it.** Call `report_solution` with:
   - `id`: the fix's FIRE number or id.
   - `user_evidence`: `/firefinder:failed` followed by a space and the user's note, exactly as they wrote it, cut to 300 characters in total. With no note, it's just `/firefinder:failed`.
   - `reason`: when the note or conversation says what happened, a short generalized description, such as "Wi-Fi still drops every few minutes". No personal details.
   - `operating_system` and `software_version` when known. A fix can fail in one setup and work in another, so these make the report useful.
4. **Tell the user in one line** that it's reported, then keep helping: offer the next thing to try.

If FireFinder says it recorded nothing, tell the user and pass on why. If FireFinder errors or its tools aren't available, say it isn't connected yet: in Codex, install or re-enable the FireFinder plugin and sign in when asked; in ChatGPT, connect FireFinder under Plugins. It needs no account.
