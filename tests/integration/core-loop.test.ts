/**
 * THE FireFinder loop, end to end:
 *
 *   question -> search -> no result -> solved -> "that fixed it" -> submit
 *   another user's question -> search -> previously solved -> "it worked" -> confirm
 *
 * Part 1 drives the HTTP API directly. Part 2 drives it exactly like Claude
 * does: through the FireFinder MCP tools, over real HTTP, against a running
 * Node server backed by PostgreSQL + pgvector.
 */
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FireFinderClient } from '@firefinder/client';
import { generateApiKey, hashApiKey } from '@firefinder/core';
import { createFireFinderMcpServer } from '@firefinder/mcp';
import { createServer, listen, type FireFinderServer } from '../../apps/api/src/app.ts';
import { loadConfig } from '../../apps/api/src/config.ts';
import { createTestContext, REPO_ROOT, silentLogger, type TestContext } from '../helpers/context.ts';

describe('core loop over the HTTP API', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());

  it('question -> search -> result -> confirmation -> updated solution', async () => {
    // User A: nothing known yet.
    const firstSearch = await ctx.request('POST', '/search', {
      clientId: 'user-a-install',
      body: { problem: 'My application keeps crashing with error ERR_DLOPEN_FAILED', software: 'Node.js' },
    });
    expect(firstSearch.body.results).toEqual([]);

    // User A solved it with Claude and said "that fixed it".
    const submitted = await ctx.request('POST', '/solutions', {
      clientId: 'user-a-install',
      body: {
        problem: 'Application crashes on startup with ERR_DLOPEN_FAILED after upgrading Node.js',
        solution: 'Native modules were compiled for the old Node version. Run `npm rebuild` (or `npx electron-rebuild` for Electron apps), then start the app again.',
        software: 'Node.js',
        software_version: '22.4.0',
        operating_system: 'Windows 11',
        error_message: 'Error: ERR_DLOPEN_FAILED: The specified module could not be found.',
        worked: true,
      },
    });
    expect(submitted.status).toBe(201);
    expect(submitted.body.solution).toMatchObject({ confirmation_count: 1, verification_status: 'verified' });

    // User B: same problem, different words.
    const secondSearch = await ctx.request('POST', '/search', {
      clientId: 'user-b-install',
      body: { problem: "I'm getting ERR_DLOPEN_FAILED and my app keeps crashing", operating_system: 'Windows 11' },
    });
    const [top] = secondSearch.body.results;
    expect(top.id).toBe(submitted.body.solution.id);
    expect(top.verification_status).toBe('verified');

    // User B: "it worked".
    const confirmed = await ctx.request('POST', `/solutions/${top.id}/confirm`, { clientId: 'user-b-install' });
    expect(confirmed.body.solution.confirmation_count).toBe(2);

    const fetched = await ctx.request('GET', `/solutions/${top.id}`);
    expect(fetched.body.solution).toMatchObject({ confirmation_count: 2, failure_count: 0, verification_status: 'verified' });
    expect(Date.parse(fetched.body.solution.last_confirmed_at)).toBeGreaterThanOrEqual(Date.parse(submitted.body.solution.last_confirmed_at));
  });
});

describe('core loop through the Claude (MCP) integration against a running server', () => {
  let server: FireFinderServer;
  let http: { url: string; stop(): Promise<void> };
  let apiKey: string;
  let userA: Client;
  let userB: Client;

  async function claudeFor(clientId: string): Promise<Client> {
    const api = new FireFinderClient({ baseUrl: http.url, apiKey, clientId });
    const mcpServer = createFireFinderMcpServer(api);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    const claude = new Client({ name: 'claude-under-test', version: '1.0.0' });
    await claude.connect(clientTransport);
    return claude;
  }

  async function call(claude: Client, name: string, args: Record<string, unknown>) {
    const result = await claude.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text: string }>).map((c) => c.text).join('\n');
    return { text, isError: result.isError === true };
  }

  beforeAll(async () => {
    const config = loadConfig({
      DATABASE_URL: 'pglite://memory',
      FIREFINDER_VOTER_SECRET: 'core-loop-voter-secret-000000',
      EMBEDDING_CACHE_DIR: resolve(REPO_ROOT, '.cache/models'),
    });
    server = await createServer(config, silentLogger);
    http = await listen(server, 0, '127.0.0.1');
    const { key, prefix } = generateApiKey();
    await server.store.createApiKey({ name: 'claude', keyPrefix: prefix, keyHash: await hashApiKey(key), scopes: ['read', 'write'] });
    apiKey = key;
    userA = await claudeFor('user-a-claude-desktop');
    userB = await claudeFor('user-b-claude-desktop');
  });

  afterAll(async () => {
    await userA?.close();
    await userB?.close();
    await http?.stop();
    await server?.close();
  });

  it('exposes the FireFinder tools and zero-touch guidance to Claude', async () => {
    const { tools } = await userA.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['confirm_solution', 'get_fire', 'report_solution', 'search_firefinder', 'submit_solution']);
    expect(tools.find((t) => t.name === 'search_firefinder')?.annotations?.readOnlyHint).toBe(true);
    const instructions = userA.getInstructions() ?? '';
    expect(instructions).toContain('SEARCH FIRST');
    expect(instructions).toContain('capital of France');
    expect(instructions).toContain("user's own words");
  });

  let fireId: string;

  it('User A: no result, solves it, confirms it worked, Claude submits it', async () => {
    const search = await call(userA, 'search_firefinder', {
      problem: 'My application keeps crashing with error ERR_DLOPEN_FAILED',
      software: 'Node.js',
    });
    expect(search.isError).toBe(false);
    expect(search.text).toContain('do not mention FireFinder');

    const submit = await call(userA, 'submit_solution', {
      problem: 'Application crashes on startup with ERR_DLOPEN_FAILED after upgrading Node.js',
      solution: 'Native modules were compiled for the old Node version. Run `npm rebuild` (or `npx electron-rebuild` for Electron apps), then start the app again.',
      software: 'Node.js',
      software_version: '22.4.0',
      operating_system: 'Windows 11',
      error_message: 'Error: ERR_DLOPEN_FAILED: The specified module could not be found.',
      user_evidence: 'That fixed it!',
    });
    expect(submit.isError).toBe(false);
    expect(submit.text).toMatch(/Saved as FIRE #\d+/);
    expect(submit.text).toContain('confirmed by 1');
    fireId = submit.text.match(/id: ([0-9a-f-]{36})/)![1]!;
  });

  it('User B: differently worded question gets User A\'s fix first, it works, Claude confirms it', async () => {
    const search = await call(userB, 'search_firefinder', {
      problem: "I'm getting ERR_DLOPEN_FAILED and my app keeps crashing",
      operating_system: 'Windows 11',
    });
    expect(search.text).toContain('🔥 Previously solved');
    const firstResult = search.text.split('\n\n')[1]!;
    expect(firstResult).toContain(`id: ${fireId}`);
    expect(firstResult).toContain('✓ verified · confirmed by 1');
    expect(firstResult).toContain('npm rebuild');

    const confirm = await call(userB, 'confirm_solution', { id: fireId, operating_system: 'Windows 11', user_evidence: 'It worked, thanks!' });
    expect(confirm.isError).toBe(false);
    expect(confirm.text).toContain('confirmed by 2');

    const stored = await server.service.get(fireId);
    expect(stored).toMatchObject({ confirmation_count: 2, failure_count: 0, verification_status: 'verified' });
  });

  it('a third user for whom it failed reports it, without removing it', async () => {
    const userC = await claudeFor('user-c-claude-code');
    try {
      const report = await call(userC, 'report_solution', {
        id: fireId,
        reason: 'Module still missing on ARM64 build',
        user_evidence: "No, I'm still getting the error",
      });
      expect(report.isError).toBe(false);
      expect(report.text).toContain('✕ 1 failed');
      expect(report.text).toContain('stays available');
    } finally {
      await userC.close();
    }
    const stored = await server.service.get(fireId);
    expect(stored).toMatchObject({ confirmation_count: 2, failure_count: 1, status: 'active' });
  });

  it('degrades gracefully when the API rejects the key', async () => {
    const api = new FireFinderClient({ baseUrl: http.url, apiKey: 'ff_invalidinvalidinvalidinvalid00' });
    const mcpServer = createFireFinderMcpServer(api);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    const claude = new Client({ name: 'bad-key', version: '1.0.0' });
    await claude.connect(clientTransport);
    const result = await call(claude, 'search_firefinder', { problem: 'Bluetooth is gone from my Windows laptop' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('FIREFINDER_API_KEY');
    await claude.close();
  });

  it('also serves the remote MCP endpoint with OAuth metadata at the root (self-hosted)', async () => {
    const challenge = await fetch(`${http.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{}',
    });
    expect(challenge.status).toBe(401);
    // A root-hosted server serves RFC 8414 / RFC 9728 metadata at the standard well-known paths.
    const metadata = await (await fetch(`${http.url}/.well-known/oauth-authorization-server`)).json();
    expect(metadata.token_endpoint).toMatch(/\/oauth\/token$/);
    const resource = await (await fetch(`${http.url}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(resource.resource).toMatch(/\/mcp$/);
  });

  it('serves the developer console with a strict CSP', async () => {
    const res = await fetch(`${http.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await res.text()).toContain("When you're stuck in the fire, find the way out.");
  });
});
