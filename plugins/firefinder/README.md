# 🔥 FireFinder for Claude Code

*When you're stuck in the fire, find the way out.*

Install once. After that, Claude:

- **checks FireFinder first** whenever you're stuck on a problem, technical (errors, crashes, failing builds or deploys, broken settings) or everyday (stains, household repairs, travel snags), and uses a verified fix if one fits;
- **checks it when a command fails**, too: if an install, build, container, deploy or git remote command Claude runs fails with an error other people plausibly hit, Claude searches before trying fixes. Bugs in your own code and failing tests are left alone;
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

Already added FireFinder as a claude.ai connector? Claude Code keeps only one server per URL, so it may use the connector's tools instead of the plugin's. Everything in the plugin works with either, but if FireFinder tools stop showing up, authenticate **firefinder** in `/mcp` as above.

To update later, run `/plugin marketplace update firefinder`. Working on FireFinder itself? Add your local checkout instead: `/plugin marketplace add ./path/to/FireFinder`.

## Commands

You never need these; Claude uses FireFinder on its own. They're there when you want to look something up yourself.

| Command | What it does |
|---|---|
| `/firefinder:search [problem]` | Searches FireFinder and shows what it finds, including when there's nothing yet. Without a problem, it searches the one you're working on |
| `/firefinder:fire <number>` | Shows one fix, e.g. `/firefinder:fire 18492`, with how many people confirmed it and how many reported it failed |

## What's inside

| Component | Purpose |
|---|---|
| `.mcp.json` | The public FireFinder remote MCP server (Streamable HTTP + OAuth), hosted on Supabase. No keys or secrets |
| `skills/firefinder/SKILL.md` | When to search, how to use results, when to record outcomes (generated from the MCP server's instructions) |
| `skills/search/`, `skills/fire/` | The two commands. Each can call only its one read-only tool |
| `hooks/hooks.json` | After a package manager, toolchain, container, deploy or git remote command fails, reminds Claude to check FireFinder (`hooks/failed-command.json`). It only prints that file, so it needs no runtime and works in bash, zsh and PowerShell |
| `evals/` | Behavior tests for `claude plugin eval`, with the FireFinder server mocked |
| `evals-shell/` | Behavior tests for the failed-command hook. They run real commands, so they need Bash and a sandbox |

Self-hosting FireFinder? Point `.mcp.json` at your own `https://<host>/mcp`.

## Test the plugin

```bash
claude plugin validate plugins/firefinder
```

```bash
claude plugin eval plugins/firefinder --ablation none --no-publish --max-cost-usd 3
```

The evals run real Claude sessions against mocked FireFinder tools and check the behavior. Claude should:

- search before answering a technical or everyday problem,
- stay out of general questions and health matters,
- stay silent on a miss,
- record a fix as soon as the user confirms it, however casually ("Amazing, that worked!"),
- record nothing after "I'll try that",
- confirm or report FireFinder fixes from the user's own words,
- answer `/firefinder:search` and `/firefinder:fire` visibly, even when nothing matches.

The failed-command hook has its own suite. Its cases run real commands in a sandbox, which native Windows doesn't have, so run it on macOS, Linux or WSL2:

```bash
claude plugin eval plugins/firefinder --eval-dir evals-shell --allow-tools Bash --scaffold --ablation none --no-publish --max-cost-usd 3
```

Claude should search FireFinder after a build fails with an error many people hit, and leave it alone when a test fails because of a bug in the project's own code.
