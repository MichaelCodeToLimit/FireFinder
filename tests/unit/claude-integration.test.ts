import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
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
      pluginToolsList: 'plugins/firefinder/evals/mocks/firefinder/_tools.json',
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

  it('tells Claude to stay invisible when nothing matches', () => {
    expect(formatSearchResults({ results: [], took_ms: 3 })).toBe(
      'No verified FireFinder solution matches this problem. Continue normally and do not mention FireFinder to the user.',
    );
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
