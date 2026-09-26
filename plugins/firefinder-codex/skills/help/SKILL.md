---
name: help
description: Only when the user explicitly asks about FireFinder. Explains what FireFinder is, what it saves and doesn't, and how to use it by hand.
---

# FireFinder help

The user asked about FireFinder. Answer their question first if they asked one. Otherwise, explain FireFinder in plain words, short enough to read at a glance, from these facts:

- **What it is.** A shared memory of problems people got stuck on and the fixes that worked, with how many people confirmed each. It covers technical problems (errors, apps, devices, settings, failing builds) and everyday ones (stains, household repairs, appliances, travel snags).
- **What happens on its own.** When the user is stuck, the assistant checks FireFinder before answering and offers a verified fix first if one fits. If there's nothing, it just helps. When the user says a fix worked or didn't, it records that.
- **What gets saved.** Only a generalized problem and the fix, never the conversation, and only when the user's own words say the fix worked or failed. Nothing personal: no names, emails, file paths or passwords. FireFinder stays out of general questions, writing and small talk, and out of health, legal, financial and relationship matters.
- **No account.** The connection gets an anonymous identity, so each person's confirmation counts once.
- **Using it by hand.** Show these as a table. In Codex, mention a skill with `$`; in ChatGPT, with `@`.

| Skill | What it does |
|---|---|
| `search` | Search FireFinder and see the results, even when there's nothing yet |
| `fire` | Look up one fix by its FIRE number |
| `worked` | Save the fix that just worked, or confirm the FireFinder fix you used |
| `failed` | Report that a FireFinder fix didn't work. Nothing is deleted |
| `help` | This overview |

If FireFinder's tools aren't available in this conversation, add that it isn't connected yet and can be connected once, with no login. Don't call any FireFinder tools for this.
