---
name: help
description: Explain what FireFinder is, what it saves and doesn't, and the /firefinder commands.
argument-hint: "[question, optional]"
disable-model-invocation: true
---

# FireFinder help

The user asked about FireFinder. Their question, if any: $ARGUMENTS

Answer their question first if they asked one. Otherwise, explain FireFinder in plain words, short enough to read at a glance, from these facts:

- **What it is.** A shared memory of problems people got stuck on and the fixes that worked, with how many people confirmed each. It covers technical problems (errors, apps, devices, settings) and everyday ones (stains, household repairs, appliances, travel snags).
- **What happens on its own.** When the user is stuck, Claude checks FireFinder before answering and offers a verified fix first if one fits. If there's nothing, Claude just helps. When the user says a fix worked or didn't, Claude records it.
- **What gets saved.** Only a generalized problem and the fix, never the conversation, and only when the user's own words say the fix worked or failed. Nothing personal: no names, emails, file paths or passwords. FireFinder stays out of general questions, writing and small talk, and out of health, legal, financial and relationship matters.
- **No account.** The connection gets an anonymous identity, so each person's confirmation counts once.
- **The commands.** Show them as a table:

| Command | What it does |
|---|---|
| `/firefinder:search [problem]` | Search FireFinder and see the results, even when there's nothing yet |
| `/firefinder:fire <number>` | Look up one fix by its FIRE number |
| `/firefinder:worked [note]` | Save the fix that just worked, or confirm the FireFinder fix you used |
| `/firefinder:failed [number, note]` | Report that a FireFinder fix didn't work. Nothing is deleted |
| `/firefinder:help` | This overview |

If FireFinder's tools aren't available in this conversation, add that it isn't connected yet and can be connected once in the app's connector settings, with no login. Don't call any FireFinder tools for this.
