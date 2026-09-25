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
  pluginToolsList: 'plugins/firefinder/evals/mocks/firefinder/_tools.json',
} as const;

const rendered = await renderClaudeExports();
for (const [key, path] of Object.entries(EXPORT_PATHS)) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rendered[key as keyof typeof EXPORT_PATHS]);
  console.log(`wrote ${path}`);
}
