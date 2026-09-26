# 🔥 FireFinder for Codex and ChatGPT

*When you're stuck in the fire, find the way out.*

One plugin for both: Codex and ChatGPT share OpenAI's plugin format and plugin directory. Install once. After that, the assistant:

- **checks FireFinder first** whenever you're stuck on a problem, technical (errors, crashes, failing builds or deploys, broken settings) or everyday (stains, household repairs, travel snags), and uses a verified fix if one fits;
- **checks it when a command fails**, too (Codex and ChatGPT Work): if an install, build, container, deploy or git remote command fails with an error other people plausibly hit, it searches before trying fixes. Bugs in your own code and failing tests are left alone;
- **stays invisible** when there is nothing relevant: no "no results" messages;
- **remembers fixes that worked**: when you say "that fixed it", the generalized problem and fix are saved for the next person, and confirmations of existing fixes are counted.

It never saves conversations. It never records anything unless your own words say the fix worked (or failed). There's no account and no API key.

## Install

### Codex CLI

```bash
codex plugin marketplace add MichaelCodeToLimit/FireFinder
```

```bash
codex plugin add firefinder@firefinder
```

Or run `/plugins` inside Codex and install **FireFinder** from the **FireFinder** marketplace. Then sign in once:

```bash
codex mcp login firefinder
```

A browser tab opens and returns immediately, because there is no login; FireFinder gives this install an anonymous identity. Start a new session and it's ready. To update later, run `codex plugin marketplace upgrade firefinder`.

### ChatGPT desktop app (Chat, Work and Codex)

Add the marketplace with the `codex` command above (the desktop app reads the same marketplaces), restart the app, open **Plugins**, choose the **FireFinder** marketplace and install **FireFinder**. Connect it when asked.

### ChatGPT on the web

Until FireFinder is listed in the plugin directory, connect the server directly. This gives ChatGPT the tools without the plugin's skills; the tool descriptions carry the same guidance.

1. **Settings → Security and login**: turn on **Developer mode**.
2. Go to [chatgpt.com/plugins](https://chatgpt.com/plugins), select **+**, and enter the server URL: `https://wmrkcgivrurnycfqjznp.supabase.co/functions/v1/firefinder/mcp`. Authentication: OAuth, with no client ID or secret.
3. Connect. The window closes by itself.

## Using it by hand

You never need these; the assistant uses FireFinder on its own. They're there when you want to look something up yourself. In Codex, mention a skill with `$` (e.g. `$search`); in ChatGPT, with `@`.

| Skill | What it does |
|---|---|
| `search` | Searches FireFinder and shows what it finds, including when there's nothing yet |
| `fire` | Shows one fix by its FIRE number, with how many people confirmed it and how many reported it failed |
| `worked` | Saves the fix that just worked, or confirms the FireFinder fix you used |
| `failed` | Reports that a FireFinder fix didn't work. Nothing is deleted |
| `help` | What FireFinder is and what it saves |

These five are set to run only when you invoke them (`agents/openai.yaml`); the `firefinder` skill runs on its own.

## What's inside

| Component | Purpose |
|---|---|
| `.codex-plugin/plugin.json` | Manifest and listing details. Same layout as OpenAI's own plugins, so every Codex version reads it |
| `.mcp.json` | The public FireFinder remote MCP server (Streamable HTTP + OAuth). No keys or secrets |
| `skills/firefinder/SKILL.md` | When to search, how to use results, when to record outcomes (generated from the MCP server's instructions by `npm run export:claude`) |
| `skills/{search,fire,worked,failed,help}/` | The by-hand skills |
| `assets/` | Icon and logos from `site/brand` |

The repository's `.agents/plugins/marketplace.json` lists this plugin.

### Differences from the Claude Code plugin

- **No failed-command hook.** Codex has no event for a failed tool call, and hooks don't run in ChatGPT chat. The FireFinder skill tells the assistant to search after a command fails with a shared-problem error instead.
- **Skills, not slash commands.** The Claude Code commands became skills that run only when invoked. `worked` and `failed` send `/firefinder:worked` or `/firefinder:failed` plus your note as evidence, which the server treats as you stating the outcome.

Self-hosting FireFinder? Point `.mcp.json` at your own `https://<host>/mcp`.

## Test the plugin

```bash
npx vitest run tests/unit/claude-integration.test.ts
```

Checks the manifest, marketplace entry, skill policies and evidence format. To try it in a throwaway Codex home, without touching your own config:

```bash
CODEX_HOME=$(mktemp -d) sh -c 'codex plugin marketplace add ./ && codex plugin add firefinder@firefinder && codex mcp list'
```
