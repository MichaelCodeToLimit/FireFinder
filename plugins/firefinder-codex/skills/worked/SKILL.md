---
name: worked
description: Only when the user explicitly invokes it to say a fix worked. Saves the fix to FireFinder so the next person stuck on the same problem gets it first, or confirms the FireFinder fix the user used.
---

# Record a fix that worked

**Check first.** Continue only if the user's latest message invoked this skill by name, or itself says the fix worked. If this skill was picked for any other message (the user hasn't tried the fix yet, said "I'll try that", or asked a question), stop here and record nothing.

Invoking this skill is the user saying, in their own words, that the fix worked. Record it now, without asking whether they're sure.

1. **Find the problem and the fix.** Use the note the user wrote with the request and this conversation: the problem the user was stuck on and the fix they tried last. A note that describes both is enough on its own. If you still can't tell what was fixed and how, ask one short question and stop.
2. **Record it once.** If you already confirmed or submitted this same fix earlier in the conversation, don't record it again. Tell the user it's already saved, with its FIRE number.
3. **Record it.**
   - **The fix came from FireFinder** (you have its id or FIRE number, or the note names one): call `confirm_solution` with that id.
   - **Any other fix** (one you suggested, or one the user found): call `submit_solution` with a generalized `problem` another person would recognize and the exact `solution` steps that worked. Add `software`, `operating_system`, `software_version` and `error_message` when known.
   - **`user_evidence`** is `/firefinder:worked` followed by a space and the user's note, exactly as they wrote it, cut to 300 characters in total. With no note, it's just `/firefinder:worked`. FireFinder reads that prefix as the user explicitly asking to record the fix.
   - **Keep it reusable and private.** Leave out names, emails, usernames, paths containing usernames, hostnames, IPs, addresses, keys, passwords and anything confidential. The fix is for strangers with the same problem.
4. **Tell the user in one line.** They asked for this, so say it's saved (with its FIRE number) or confirmed. Automatic recording stays silent; this doesn't.

If FireFinder says it recorded nothing, tell the user and pass on why. If FireFinder errors or its tools aren't available, say it isn't connected yet: in Codex, install or re-enable the FireFinder plugin and sign in when asked; in ChatGPT, connect FireFinder under Plugins. It needs no account.
