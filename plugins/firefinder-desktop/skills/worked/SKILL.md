---
name: worked
description: Tell FireFinder that a fix worked, so the next person stuck on the same problem gets it first. Saves a new fix, or confirms the FireFinder fix the user used.
argument-hint: "[what worked, optional]"
disable-model-invocation: true
allowed-tools: mcp__plugin_firefinder_firefinder__submit_solution mcp__plugin_firefinder_firefinder__confirm_solution
---

# Record a fix that worked

The user typed `/firefinder:worked`, followed by this note (it may be empty): $ARGUMENTS

Typing the command is the user saying, in their own words, that the fix worked. Record it now, without asking whether they're sure.

1. **Find the problem and the fix.** Use the note and this conversation: the problem the user was stuck on and the fix they tried last. A note that describes both is enough on its own. If you still can't tell what was fixed and how, ask one short question and stop.
2. **Record it once.** If you already confirmed or submitted this same fix earlier in the conversation, don't record it again. Tell the user it's already saved, with its FIRE number.
3. **Record it.**
   - **The fix came from FireFinder** (you have its id or FIRE number, or the note names one): call `confirm_solution` with that id.
   - **Any other fix** (one you suggested, or one the user found): call `submit_solution` with a generalized `problem` another person would recognize and the exact `solution` steps that worked. Add `software`, `operating_system`, `software_version` and `error_message` when known.
   - **`user_evidence`** is exactly what the user typed, starting with `/firefinder:worked` and including their note, cut to 300 characters if it's longer.
   - **Keep it reusable and private.** Leave out names, emails, usernames, paths containing usernames, hostnames, IPs, addresses, keys, passwords and anything confidential. The fix is for strangers with the same problem.
4. **Tell the user in one line.** They asked for this, so say it's saved (with its FIRE number) or confirmed. Automatic recording stays silent; this doesn't.

If FireFinder says it recorded nothing, tell the user and pass on why. If FireFinder errors or its tools aren't available, say it isn't connected yet and that they can connect it once in the app's connector settings (it needs no account).
