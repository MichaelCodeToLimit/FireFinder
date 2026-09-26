import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyUserEvidence } from '@firefinder/core';
import { formatSearchResults, timeAgo, trustLine } from '@firefinder/mcp';
import type { SearchResult } from '@firefinder/client';
import { renderClaudeExports } from '../../packages/mcp/src/exports.ts';

const root = resolve(import.meta.dirname, '../..');

describe('Claude Messages API exports', () => {
  it('every generated Claude file matches the MCP server definitions', async () => {
    const rendered = await renderClaudeExports();
    const files = {
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
    for (const [key, path] of Object.entries(files)) {
      expect(readFileSync(resolve(root, path), 'utf8'), `${path} is stale: run npm run export:claude`).toBe(
        rendered[key as keyof typeof files],
      );
    }
  });

  it('the Claude Code plugin connects to the remote MCP endpoint and loads the FireFinder skill', () => {
    const mcp = JSON.parse(readFileSync(resolve(root, 'plugins/firefinder/.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.firefinder).toMatchObject({ type: 'http', url: expect.stringMatching(/^https:\/\/.+\/mcp$/) });
    const skill = readFileSync(resolve(root, 'plugins/firefinder/skills/firefinder/SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: firefinder\n/);
    expect(skill).toContain('SEARCH FIRST');
  });

  // Claude Code loads the MCP tools on demand, so the skill's trigger text is what brings
  // FireFinder into a conversation there. It must cover everyday problems and casual confirmations.
  it('the skill triggers on everyday problems and casual confirmations, within the skill description limit', () => {
    const skill = readFileSync(resolve(root, 'plugins/firefinder/skills/firefinder/SKILL.md'), 'utf8');
    const description = skill.match(/^description: >-\n((?: {2}.*\n)+)/m)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
    for (const phrase of ['everyday', 'stain', 'a command you run fails', 'amazing, that worked!', 'health']) {
      expect(description).toContain(phrase);
    }
  });

  // The hook only prints a file, so it runs in bash, zsh and Windows PowerShell with no runtime.
  it('the failed-command hook prints the hint after a failing toolchain command, for Bash and PowerShell', async () => {
    const { SHARED_PROBLEM_COMMANDS, FAILED_COMMAND_HINT_PATH } = await import('../../packages/mcp/src/claude-code-plugin.ts');
    const config = JSON.parse(readFileSync(resolve(root, 'plugins/firefinder/hooks/hooks.json'), 'utf8'));
    expect(Object.keys(config.hooks)).toEqual(['PostToolUseFailure']);
    const groups = config.hooks.PostToolUseFailure as Array<{ matcher: string; hooks: Array<Record<string, unknown>> }>;
    expect(groups.map((g) => g.matcher)).toEqual(['Bash', 'PowerShell']);
    for (const group of groups) {
      expect(group.hooks.map((h) => h.if)).toEqual(SHARED_PROBLEM_COMMANDS.map((c) => `${group.matcher}(${c} *)`));
      for (const handler of group.hooks) {
        expect(handler).toMatchObject({ type: 'command', command: `cat "\${CLAUDE_PLUGIN_ROOT}/${FAILED_COMMAND_HINT_PATH}"` });
      }
    }
    const bashRules = groups[0]?.hooks.map((h) => h.if);
    for (const covered of ['Bash(npm *)', 'Bash(pip *)', 'Bash(docker *)', 'Bash(git push *)', 'Bash(sudo *)']) {
      expect(bashRules).toContain(covered);
    }

    const raw = readFileSync(resolve(root, 'plugins/firefinder/hooks', 'failed-command.json'), 'utf8');
    expect(raw).toMatch(/^[\x00-\x7f]*$/);
    const { hookSpecificOutput } = JSON.parse(raw);
    expect(hookSpecificOutput.hookEventName).toBe('PostToolUseFailure');
    expect(hookSpecificOutput.additionalContext).toContain('search_firefinder');
    expect(hookSpecificOutput.additionalContext).toContain('failing test');
  });

  // The slash commands only read. A claude.ai connector can stand in for the plugin's own
  // server, so each command pre-approves its tool under both names and nothing else.
  it('the /firefinder:search and /firefinder:fire commands are user-only and pre-approve one read-only tool', async () => {
    const { TOOL_NAME_PREFIXES } = await import('../../packages/mcp/src/claude-code-plugin.ts');
    for (const [skill, tool] of [['search', 'search_firefinder'], ['fire', 'get_fire']]) {
      const text = readFileSync(resolve(root, `plugins/firefinder/skills/${skill}/SKILL.md`), 'utf8');
      expect(text).toMatch(new RegExp(`^---\\nname: ${skill}\\n`));
      expect(text).toContain('\ndisable-model-invocation: true\n');
      expect(text).toContain('$ARGUMENTS');
      const allowed = text.match(/^allowed-tools: (.+)$/m)?.[1]?.split(' ');
      expect(allowed).toEqual(TOOL_NAME_PREFIXES.map((prefix) => `${prefix}${tool}`));
    }
  });

  // The Claude desktop app plugin: the same server and guidance, plus five user-only commands.
  it('the desktop plugin bundles the same server and skill guidance, and user-only commands with the right tools', async () => {
    const desktop = (path: string) => readFileSync(resolve(root, 'plugins/firefinder-desktop', path), 'utf8');
    expect(JSON.parse(desktop('.mcp.json'))).toEqual(
      JSON.parse(readFileSync(resolve(root, 'plugins/firefinder/.mcp.json'), 'utf8')),
    );
    expect(JSON.parse(desktop('.claude-plugin/plugin.json')).name).toBe('firefinder');
    expect(desktop('skills/firefinder/SKILL.md')).toContain('SEARCH FIRST');
    expect(desktop('skills/firefinder/SKILL.md')).not.toContain('Claude Code');

    const commands = { search: ['search_firefinder'], fire: ['get_fire'], worked: ['submit_solution', 'confirm_solution'], failed: ['report_solution'], help: [] };
    for (const [skill, tools] of Object.entries(commands)) {
      const text = desktop(`skills/${skill}/SKILL.md`);
      expect(text).toMatch(new RegExp(`^---\\nname: ${skill}\\n`));
      expect(text).toContain('\ndisable-model-invocation: true\n');
      expect(text).toContain('$ARGUMENTS');
      const allowed = text.match(/^allowed-tools: (.+)$/m)?.[1]?.split(' ') ?? [];
      expect(allowed).toEqual(tools.map((tool) => `mcp__plugin_firefinder_firefinder__${tool}`));
    }
  });

  // /firefinder:worked and /firefinder:failed quote what the user typed as user_evidence;
  // the server has to accept exactly that, with or without a note.
  it('what /firefinder:worked and /firefinder:failed send as evidence passes the server check', () => {
    for (const [skill, verdict] of [['worked', 'worked'], ['failed', 'failed']] as const) {
      const text = readFileSync(resolve(root, `plugins/firefinder-desktop/skills/${skill}/SKILL.md`), 'utf8');
      expect(text).toContain(`exactly what the user typed, starting with \`/firefinder:${skill}\``);
      expect(classifyUserEvidence(`/firefinder:${skill}`)).toBe(verdict);
    }
  });

  // Claude Code truncates server instructions and tool descriptions at 2048 characters, and
  // claude.ai shows Claude only the tool descriptions, so each must fit and stand on its own.
  it('instructions and every tool description fit Claude Code\'s 2048-character limit', async () => {
    const { FIREFINDER_INSTRUCTIONS, INSTRUCTIONS_MAX_LENGTH } = await import('../../packages/mcp/src/instructions.ts');
    expect(FIREFINDER_INSTRUCTIONS.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_LENGTH);
    const tools = JSON.parse((await renderClaudeExports()).tools) as Array<{ name: string; description: string }>;
    for (const tool of tools) expect(tool.description.length, tool.name).toBeLessThanOrEqual(1900);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.description]));
    expect(byName.search_firefinder).toContain('everyday');
    expect(byName.search_firefinder).toContain('BEFORE answering');
    expect(byName.submit_solution).toContain('"amazing, that worked!"');
    expect(byName.confirm_solution).toContain('"this worked"');
  });

  it('uses the Messages API tool shape', async () => {
    const tools = JSON.parse((await renderClaudeExports()).tools);
    expect(tools.map((t: { name: string }) => t.name).sort()).toEqual([
      'confirm_solution',
      'get_fire',
      'report_solution',
      'search_firefinder',
      'submit_solution',
    ]);
    for (const tool of tools) {
      expect(Object.keys(tool).sort()).toEqual(['description', 'input_schema', 'name']);
      expect(tool.input_schema.type).toBe('object');
    }
    const submit = tools.find((t: { name: string }) => t.name === 'submit_solution');
    expect(submit.input_schema.required).toEqual(expect.arrayContaining(['problem', 'solution', 'user_evidence']));
    expect(submit.input_schema.additionalProperties).toBe(false);
  });
});

describe('result formatting for Claude', () => {
  const now = new Date('2026-09-25T12:00:00Z');
  const result: SearchResult = {
    id: '01a0d96c-cdcb-7e55-bd1e-a9d72c78c979',
    fire_number: 18492,
    problem: 'Vercel deployment fails during build',
    solution: 'Change the build command to `npm run build`.\nThen redeploy.',
    software: 'Vercel',
    operating_system: null,
    software_version: null,
    error_message: null,
    confirmation_count: 127,
    failure_count: 4,
    status: 'active',
    verification_status: 'verified',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-09-25T09:00:00Z',
    last_confirmed_at: '2026-09-25T09:00:00Z',
    last_failed_at: null,
    similarity: 0.94,
    score: 0.81,
    environment_match: { software: 'match', operating_system: 'unknown', software_version: 'unknown' },
  };

  it('renders the FIRE card with trust signals', () => {
    const text = formatSearchResults({ results: [result], took_ms: 7 }, now);
    expect(text).toContain('🔥 FIRE #18492 — ✓ verified · confirmed by 127 · ✕ 4 failed · last confirmed 3 hours ago');
    expect(text).toContain(`id: ${result.id}`);
    expect(text).toContain('   Change the build command to `npm run build`.\n   Then redeploy.');
    expect(text).toContain('Environment: Vercel (software: match)');
    expect(text).toContain('confirm_solution');
  });

  it('tells Claude to stay invisible when nothing matches, and to record a fix that later works', () => {
    const text = formatSearchResults({ results: [], took_ms: 3 });
    expect(text).toMatch(/^No verified FireFinder solution matches this problem\. Continue normally and do not mention FireFinder to the user\./);
    expect(text).toContain('call submit_solution');
    expect(text).toContain('"amazing, that worked!"');
  });

  it('marks unverified candidates and solutions under review', () => {
    expect(trustLine({ ...result, verification_status: 'candidate', confirmation_count: 0, last_confirmed_at: null }, now)).toContain('○ unverified candidate');
    expect(trustLine({ ...result, status: 'under_review' }, now)).toContain('under review');
  });

  it('formats relative times', () => {
    expect(timeAgo('2026-09-25T11:59:30Z', now)).toBe('just now');
    expect(timeAgo('2026-09-24T12:00:00Z', now)).toBe('1 day ago');
    expect(timeAgo(null, now)).toBe('never');
  });
});

// One package serves Codex and ChatGPT. It uses the .codex-plugin layout that OpenAI's own plugins ship.
describe('Codex and ChatGPT plugin', () => {
  const plugin = resolve(root, 'plugins/firefinder-codex');
  const read = (path: string) => readFileSync(resolve(plugin, path), 'utf8');
  const commandSkills = ['search', 'fire', 'worked', 'failed', 'help'];

  it('declares its skills, the same remote server as the Claude plugin, and assets that exist', () => {
    const manifest = JSON.parse(read('.codex-plugin/plugin.json'));
    expect(manifest).toMatchObject({ name: 'firefinder', skills: './skills/', mcpServers: './.mcp.json' });
    expect(manifest.description.length).toBeGreaterThan(0);
    for (const asset of [manifest.interface.composerIcon, manifest.interface.logo, manifest.interface.logoDark]) {
      expect(asset).toMatch(/^\.\/assets\//);
      expect(() => read(asset)).not.toThrow();
    }
    const claude = JSON.parse(readFileSync(resolve(root, 'plugins/firefinder/.mcp.json'), 'utf8'));
    expect(JSON.parse(read('.mcp.json')).mcpServers.firefinder).toEqual(claude.mcpServers.firefinder);
  });

  it('is listed in the repo marketplace that `codex plugin marketplace add` reads', () => {
    const marketplace = JSON.parse(readFileSync(resolve(root, '.agents/plugins/marketplace.json'), 'utf8'));
    expect(marketplace.plugins).toEqual([
      expect.objectContaining({
        name: 'firefinder',
        source: { source: 'local', path: './plugins/firefinder-codex' },
        policy: expect.objectContaining({ installation: 'AVAILABLE' }),
        category: expect.any(String),
      }),
    ]);
  });

  it('runs the FireFinder skill automatically and the other skills only when the user invokes them', () => {
    const skill = read('skills/firefinder/SKILL.md');
    expect(skill).toMatch(/^---\nname: firefinder\n/);
    expect(skill).toContain('SEARCH FIRST');
    expect(skill).toContain('Failed commands count too');
    for (const name of commandSkills) {
      expect(read(`skills/${name}/SKILL.md`)).toMatch(new RegExp(`^---\nname: ${name}\ndescription: Only when the user explicitly`));
      expect(read(`skills/${name}/agents/openai.yaml`)).toMatch(/^policy:\n {2}allow_implicit_invocation: false$/m);
    }
  });

  it('uses no Claude-only syntax or wording', () => {
    for (const name of ['firefinder', ...commandSkills]) {
      const skill = read(`skills/${name}/SKILL.md`).replace(/<!--.*?-->/gs, '');
      for (const claudeOnly of ['$ARGUMENTS', 'allowed-tools', 'disable-model-invocation', 'argument-hint', 'Claude', '/mcp']) {
        expect(skill, `${name} contains ${claudeOnly}`).not.toContain(claudeOnly);
      }
    }
  });

  it('what the worked and failed skills send as evidence passes the server check', () => {
    expect(read('skills/worked/SKILL.md')).toContain('`/firefinder:worked` followed by a space and the user\'s note');
    expect(read('skills/failed/SKILL.md')).toContain('`/firefinder:failed` followed by a space and the user\'s note');
    expect(classifyUserEvidence('/firefinder:worked')).toBe('worked');
    expect(classifyUserEvidence('/firefinder:worked cleared the npm cache')).toBe('worked');
    expect(classifyUserEvidence('/firefinder:failed still crashes on launch')).toBe('failed');
  });
});
