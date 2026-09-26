/**
 * Writes every Claude-facing file generated from the MCP server definitions.
 * A test fails if any of them is out of date.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { renderClaudeExports } from '../packages/mcp/src/exports.ts';

export const EXPORT_PATHS = {
  tools: 'integrations/claude/tools.json',
  systemPrompt: 'integrations/claude/system-prompt.md',
  pluginSkill: 'plugins/firefinder/skills/firefinder/SKILL.md',
  pluginHooks: 'plugins/firefinder/hooks/hooks.json',
  pluginHookHint: 'plugins/firefinder/hooks/failed-command.json',
  pluginToolsList: 'plugins/firefinder/evals/mocks/firefinder/_tools.json',
  pluginShellEvalToolsList: 'plugins/firefinder/evals-shell/mocks/firefinder/_tools.json',
  desktopPluginSkill: 'plugins/firefinder-desktop/skills/firefinder/SKILL.md',
  desktopPluginToolsList: 'plugins/firefinder-desktop/evals/mocks/firefinder/_tools.json',
  codexPluginSkill: 'plugins/firefinder-codex/skills/firefinder/SKILL.md',
} as const;

const rendered = await renderClaudeExports();
for (const [key, path] of Object.entries(EXPORT_PATHS)) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rendered[key as keyof typeof EXPORT_PATHS]);
  console.log(`wrote ${path}`);
}
