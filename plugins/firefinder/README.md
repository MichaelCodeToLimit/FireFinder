# 🔥 FireFinder for Claude Code

*When you're stuck in the fire, find the way out.*

Install once. After that, Claude:

- **checks FireFinder first** whenever you describe a technical problem (errors, crashes, failing builds or deploys, broken settings), and uses a verified fix if one fits;
- **stays invisible** when there is nothing relevant: no "no results" messages;
- **remembers fixes that worked**: when you say "that fixed it", the generalized problem and fix are saved for the next person, and confirmations of existing fixes are counted.

It never saves conversations. It never records anything unless your own words say the fix worked (or failed). There's no account and no API key.

## Install

In Claude Code:

```text
/plugin marketplace add https://github.com/MichaelCodeToLimit/FireFinder.git
```

```text
/plugin install firefinder@firefinder
```

Or from a terminal:

```bash
claude plugin marketplace add https://github.com/MichaelCodeToLimit/FireFinder.git
```

```bash
claude plugin install firefinder@firefinder
```

Then connect it once. Run `/mcp`, select **firefinder**, and choose **Authenticate**. A browser tab opens and returns immediately, because there is no login; FireFinder gives this install an anonymous identity. That's it.

To update later, run `/plugin marketplace update firefinder`. Working on FireFinder itself? Add your local checkout instead: `/plugin marketplace add ./path/to/FireFinder`.

## What's inside

| Component | Purpose |
|---|---|
| `.mcp.json` | The public FireFinder remote MCP server (Streamable HTTP + OAuth), hosted on Supabase. No keys or secrets |
| `skills/firefinder/SKILL.md` | When to search, how to use results, when to record outcomes (generated from the MCP server's instructions) |
| `evals/` | Behavior tests for `claude plugin eval`, with the FireFinder server mocked |

Self-hosting FireFinder? Point `.mcp.json` at your own `https://<host>/mcp`.

## Test the plugin

```bash
claude plugin validate plugins/firefinder
```

```bash
claude plugin eval plugins/firefinder --ablation none --no-publish --max-cost-usd 3
```

The evals run real Claude sessions against mocked FireFinder tools and check the behavior. Claude should:

- search before answering a technical problem,
- stay out of general questions,
- stay silent on a miss,
- record a fix only after the user confirms it,
- record nothing after "I'll try that",
- confirm or report FireFinder fixes from the user's own words.
