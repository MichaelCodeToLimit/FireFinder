/**
 * The remote MCP endpoint as claude.ai and Claude mobile use it:
 * OAuth 2.1 (discovery, dynamic registration, PKCE, rotation) + Streamable HTTP,
 * served under the same path layout as a Supabase Edge Function, driven by the
 * official MCP SDK client.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey, type Actor } from '@firefinder/core';
import { TokenSigner } from '@firefinder/mcp/remote';
import { CLAUDE_CALLBACK, startRemoteServer, VOTER_SECRET, type ConnectedClaude, type RemoteServer } from '../helpers/remote.ts';

const seedActor: Actor = { keyId: 'seed', clientId: 'seed-install-0001' };

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
});
const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

let server: RemoteServer;
let claude: ConnectedClaude;
let bluetoothFire: { id: string; fire_number: number };
let candidateFire: { id: string; fire_number: number };

beforeAll(async () => {
  server = await startRemoteServer();
  const verified = await server.service.submit(
    {
      problem: 'Bluetooth toggle disappeared from Windows settings after an update',
      solution: 'Open services.msc, start "Bluetooth Support Service" and set it to Automatic, then reboot.',
      operating_system: 'Windows 11',
      worked: true,
    },
    seedActor,
  );
  bluetoothFire = verified.solution;
  const candidate = await server.service.submit(
    {
      problem: 'Bluetooth adapter is missing from Windows Device Manager',
      solution: 'Reinstall the chipset drivers from the laptop vendor website.',
      operating_system: 'Windows 11',
      worked: false,
    },
    seedActor,
  );
  candidateFire = candidate.solution;
  claude = await server.connectClaude();
});

afterAll(async () => {
  await claude?.client.close();
  await server?.close();
});

const solutionRow = async (id: string) =>
  (
    await server.db.sql.query<{ confirmation_count: number; failure_count: number; status: string }>(
      `select confirmation_count, failure_count, status from firefinder.solutions where id = $1`,
      [id],
    )
  )[0]!;

describe('OAuth 2.1 for claude.ai', () => {
  it('answers unauthenticated MCP requests with a 401 that points at the metadata', async () => {
    const res = await fetch(server.mcpUrl, { method: 'POST', headers: MCP_HEADERS, body: INITIALIZE });
    expect(res.status).toBe(401);
    const challenge = res.headers.get('www-authenticate')!;
    expect(challenge).toContain(`resource_metadata="${server.baseUrl}/.well-known/oauth-protected-resource"`);
    expect(challenge).toContain('scope="firefinder:read firefinder:write"');
  });

  it('publishes protected-resource and authorization-server metadata', async () => {
    const prm = await (await fetch(`${server.baseUrl}/.well-known/oauth-protected-resource`)).json();
    expect(prm).toMatchObject({ resource: server.mcpUrl, authorization_servers: [server.baseUrl] });

    const as = await (await fetch(`${server.baseUrl}/.well-known/openid-configuration`)).json();
    expect(as).toMatchObject({
      issuer: server.baseUrl,
      authorization_endpoint: `${server.baseUrl}/oauth/authorize`,
      token_endpoint: `${server.baseUrl}/oauth/token`,
      registration_endpoint: `${server.baseUrl}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });

  it('connects the way Claude does: discovery, dynamic registration, PKCE, token exchange', async () => {
    // Supabase cannot serve /.well-known at the domain root; the client must find
    // the path-appended OpenID discovery document, exactly as it does here.
    expect(server.fetched).toContain(`${server.baseUrl}/.well-known/oauth-protected-resource`);
    expect(server.fetched).toContain(`${server.baseUrl}/.well-known/openid-configuration`);
    expect(server.fetched).toContain(`${server.baseUrl}/oauth/register`);
    const tokens = (await claude.provider.tokens())!;
    expect(tokens.access_token).toMatch(/^ffa_/);
    expect(tokens.refresh_token).toMatch(/^ffr_/);
    expect(tokens.scope).toBe('firefinder:read firefinder:write');
  });

  it('only registers Claude and loopback redirect URIs', async () => {
    const register = (redirect: string) =>
      fetch(`${server.baseUrl}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [redirect], client_name: 'test' }),
      });
    expect((await register(CLAUDE_CALLBACK)).status).toBe(201);
    expect((await register('http://localhost:53682/callback')).status).toBe(201);
    const evil = await register('https://evil.example/steal');
    expect(evil.status).toBe(400);
    expect((await evil.json()).error).toBe('invalid_redirect_uri');
  });

  async function registeredClient(): Promise<string> {
    const res = await fetch(`${server.baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK], client_name: 'Claude' }),
    });
    return (await res.json()).client_id;
  }

  const authorizeUrl = (params: Record<string, string>) => `${server.baseUrl}/oauth/authorize?${new URLSearchParams(params)}`;
  const PKCE = { verifier: 'v'.repeat(43), challenge: '' };
  beforeAll(async () => {
    const { pkceS256 } = await import('@firefinder/mcp/remote');
    PKCE.challenge = await pkceS256(PKCE.verifier);
  });

  it('never redirects for unknown clients or unregistered redirect URIs', async () => {
    const unknown = await fetch(authorizeUrl({ client_id: 'ffc_forged.sig', redirect_uri: CLAUDE_CALLBACK, response_type: 'code' }), {
      redirect: 'manual',
    });
    expect(unknown.status).toBe(400);
    const clientId = await registeredClient();
    const wrongRedirect = await fetch(
      authorizeUrl({ client_id: clientId, redirect_uri: 'https://evil.example/cb', response_type: 'code' }),
      { redirect: 'manual' },
    );
    expect(wrongRedirect.status).toBe(400);
  });

  it('requires PKCE S256 and the right resource', async () => {
    const clientId = await registeredClient();
    const noPkce = await fetch(authorizeUrl({ client_id: clientId, redirect_uri: CLAUDE_CALLBACK, response_type: 'code', state: 's' }), {
      redirect: 'manual',
    });
    expect(new URL(noPkce.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');

    const wrongResource = await fetch(
      authorizeUrl({
        client_id: clientId,
        redirect_uri: CLAUDE_CALLBACK,
        response_type: 'code',
        code_challenge: PKCE.challenge,
        code_challenge_method: 'S256',
        resource: 'https://other.example/mcp',
      }),
      { redirect: 'manual' },
    );
    expect(new URL(wrongResource.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');
  });

  it('issues single-use codes bound to the PKCE verifier, and rotates refresh tokens', async () => {
    const clientId = await registeredClient();
    const authorized = await fetch(
      authorizeUrl({
        client_id: clientId,
        redirect_uri: CLAUDE_CALLBACK,
        response_type: 'code',
        code_challenge: PKCE.challenge,
        code_challenge_method: 'S256',
        resource: server.mcpUrl,
        state: 'xyz',
      }),
      { redirect: 'manual', headers: { 'x-forwarded-for': '198.51.100.44' } },
    );
    const location = new URL(authorized.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(CLAUDE_CALLBACK);
    expect(location.searchParams.get('state')).toBe('xyz');
    expect(location.searchParams.get('iss')).toBe(server.baseUrl);
    const code = location.searchParams.get('code')!;

    const token = (params: Record<string, string>) =>
      fetch(`${server.baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params),
      });
    const exchange = { grant_type: 'authorization_code', code, redirect_uri: CLAUDE_CALLBACK, client_id: clientId };

    const badVerifier = await token({ ...exchange, code_verifier: 'x'.repeat(43) });
    expect((await badVerifier.json()).error).toBe('invalid_grant');
    // A failed attempt consumed the code: codes are single-use.
    const reused = await token({ ...exchange, code_verifier: PKCE.verifier });
    expect((await reused.json()).error).toBe('invalid_grant');

    // A fresh code with the right verifier works.
    const fresh = new URL(
      (
        await fetch(authorizeUrl({ client_id: clientId, redirect_uri: CLAUDE_CALLBACK, response_type: 'code', code_challenge: PKCE.challenge, code_challenge_method: 'S256' }), {
          redirect: 'manual',
          headers: { 'x-forwarded-for': '198.51.100.44' },
        })
      ).headers.get('location')!,
    ).searchParams.get('code')!;
    const issued = await (await token({ ...exchange, code: fresh, code_verifier: PKCE.verifier })).json();
    expect(issued).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });

    const rotated = await (await token({ grant_type: 'refresh_token', refresh_token: issued.refresh_token, client_id: clientId })).json();
    expect(rotated.refresh_token).not.toBe(issued.refresh_token);
    const replay = await token({ grant_type: 'refresh_token', refresh_token: issued.refresh_token, client_id: clientId });
    expect((await replay.json()).error).toBe('invalid_grant');
  });

  it('rejects tampered, expired and foreign-audience tokens, and API keys, on /mcp', async () => {
    const send = (bearer: string) =>
      fetch(server.mcpUrl, { method: 'POST', headers: { ...MCP_HEADERS, authorization: `Bearer ${bearer}` }, body: INITIALIZE });

    const tampered = claude.accessToken.slice(0, -2) + (claude.accessToken.endsWith('A') ? 'BB' : 'AA');
    const res = await send(tampered);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');

    const signer = new TokenSigner(VOTER_SECRET);
    const now = Math.floor(Date.now() / 1000);
    const sub = '01a0d962-f041-7357-b4aa-922d1ba63c5f';
    const scope = ['firefinder:read', 'firefinder:write'];
    const expired = await signer.sign('ffa_', 'access', { v: 1, sub, scope, aud: server.mcpUrl, iat: now - 7200, exp: now - 3600 });
    expect((await send(expired)).status).toBe(401);
    const foreign = await signer.sign('ffa_', 'access', { v: 1, sub, scope, aud: 'https://other.example/mcp', iat: now, exp: now + 3600 });
    expect((await send(foreign)).status).toBe(401);

    const { key, prefix } = generateApiKey();
    await server.store.createApiKey({ name: 'rest', keyPrefix: prefix, keyHash: await hashApiKey(key), scopes: ['admin'] });
    expect((await send(key)).status).toBe(401);
  });

  it('does not accept MCP access tokens on the REST API (no token passthrough)', async () => {
    const res = await fetch(`${server.baseUrl}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${claude.accessToken}` },
      body: JSON.stringify({ problem: 'Bluetooth is gone from my Windows laptop' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('remote MCP tools', () => {
  it('exposes exactly the five FireFinder tools, with strict input schemas', async () => {
    const { tools } = await claude.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['confirm_solution', 'get_fire', 'report_solution', 'search_firefinder', 'submit_solution']);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.search_firefinder!.annotations?.readOnlyHint).toBe(true);
    expect(byName.get_fire!.annotations?.readOnlyHint).toBe(true);
    for (const name of ['submit_solution', 'confirm_solution', 'report_solution']) {
      expect(byName[name]!.annotations?.readOnlyHint).toBe(false);
      expect(byName[name]!.inputSchema.required).toContain('user_evidence');
    }
    for (const tool of tools) expect(tool.inputSchema.additionalProperties).toBe(false);
  });

  it('search_firefinder returns only strong verified matches', async () => {
    const found = await claude.call('search_firefinder', { problem: 'Bluetooth is gone from my Windows laptop', operating_system: 'Windows 11' });
    expect(found.isError).toBe(false);
    expect(found.text).toContain('🔥 Previously solved');
    expect(found.text).toContain(`🔥 FIRE #${bluetoothFire.fire_number} — ✓ verified`);
    expect(found.text).toContain('Bluetooth Support Service');
    // The similar but unverified candidate is never pushed into the conversation.
    expect(found.text).not.toContain(candidateFire.id);
  });

  it('search_firefinder stays invisible when nothing strong matches', async () => {
    for (const problem of ['What is the capital of France?', 'Vercel deployment fails during build']) {
      const result = await claude.call('search_firefinder', { problem });
      expect(result.text).toMatch(/^No verified FireFinder solution matches this problem\. Continue normally and do not mention FireFinder to the user\./);
    }
  });

  it('get_fire looks up a fire by FIRE number or id', async () => {
    const byNumber = await claude.call('get_fire', { id: bluetoothFire.fire_number });
    expect(byNumber.text).toContain(`🔥 FIRE #${bluetoothFire.fire_number}`);
    expect(byNumber.text).toContain(`id: ${bluetoothFire.id}`);
    const byId = await claude.call('get_fire', { id: candidateFire.id });
    expect(byId.text).toContain('Nobody has confirmed this fix yet');
    const missing = await claude.call('get_fire', { id: 999999 });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('Solution not found');
  });

  it('submit_solution saves a fix only with the user\'s own confirming words', async () => {
    const countSolutions = async () => Number((await server.db.sql.query<{ n: number }>('select count(*) as n from firefinder.solutions'))[0]!.n);
    const before = await countSolutions();
    const fix = {
      problem: 'Docker Desktop is stuck on "Starting the Docker Engine" on Windows 11',
      solution: 'Run `wsl --update`, then `wsl --shutdown`, then restart Docker Desktop.',
      software: 'Docker Desktop',
      operating_system: 'Windows 11',
    };

    for (const evidence of ['Thanks!', "I'll try that later", "It didn't work"]) {
      const refused = await claude.call('submit_solution', { ...fix, user_evidence: evidence });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('Not recorded');
    }
    expect(await countSolutions()).toBe(before);

    const saved = await claude.call('submit_solution', { ...fix, user_evidence: "Yes! It's working now" });
    expect(saved.isError).toBe(false);
    expect(saved.text).toMatch(/Saved as FIRE #\d+ \(✓ verified · confirmed by 1/);
    expect(await countSolutions()).toBe(before + 1);
  });

  it('submit_solution cannot set counts, status or other fields, and stores text literally', async () => {
    const forged = await claude.call('submit_solution', {
      problem: 'Printer prints blank pages after a driver update',
      solution: 'Roll back the printer driver in Device Manager.',
      user_evidence: 'That fixed it',
      confirmation_count: 9999,
      status: 'active',
    });
    expect(forged.isError).toBe(true);
    expect(await Number((await server.db.sql.query<{ n: number }>(`select count(*) as n from firefinder.solutions where confirmation_count > 100`))[0]!.n)).toBe(0);

    const injection = "Error: '); drop table firefinder.solutions; -- happens on save";
    const saved = await claude.call('submit_solution', {
      problem: 'Notes app crashes on save with a SQL-looking error message',
      solution: 'Clear the app cache from Settings > Apps > Notes > Storage, then reopen the app.',
      error_message: injection,
      user_evidence: 'That solved it',
    });
    expect(saved.isError).toBe(false);
    const [row] = await server.db.sql.query<{ error_message: string }>(
      `select error_message from firefinder.solutions where problem like 'Notes app crashes%'`,
    );
    expect(row!.error_message).toBe(injection);
  });

  it('confirm_solution counts once per user, and only on clear confirmation', async () => {
    const before = await solutionRow(bluetoothFire.id);
    const unclear = await claude.call('confirm_solution', { id: bluetoothFire.id, user_evidence: 'Thanks, I will try it tonight' });
    expect(unclear.isError).toBe(true);
    const failure = await claude.call('confirm_solution', { id: bluetoothFire.id, user_evidence: 'Still broken' });
    expect(failure.isError).toBe(true);
    expect((await solutionRow(bluetoothFire.id)).confirmation_count).toBe(before.confirmation_count);

    const confirmed = await claude.call('confirm_solution', { id: bluetoothFire.fire_number, user_evidence: 'That worked!' });
    expect(confirmed.text).toContain('Confirmation recorded');
    const again = await claude.call('confirm_solution', { id: bluetoothFire.fire_number, user_evidence: 'Yep, fixed it' });
    expect(again.text).toContain('counted once');
    expect((await solutionRow(bluetoothFire.id)).confirmation_count).toBe(before.confirmation_count + 1);
  });

  it('report_solution records failures only on clear failure, and never deletes', async () => {
    const other = await server.connectClaude({ ip: '198.51.100.77' });
    try {
      const wrongWay = await other.call('report_solution', { id: bluetoothFire.id, user_evidence: 'That fixed it' });
      expect(wrongWay.isError).toBe(true);
      const reported = await other.call('report_solution', {
        id: bluetoothFire.id,
        user_evidence: "No, I'm still getting the error",
        operating_system: 'Windows 10',
      });
      expect(reported.text).toContain('Failure report recorded');
      const row = await solutionRow(bluetoothFire.id);
      expect(row.failure_count).toBe(1);
      expect(row.status).toBe('active');
    } finally {
      await other.client.close();
    }
  });

  it('disabled solutions are invisible and immutable through MCP', async () => {
    await server.db.sql.query(`update firefinder.solutions set status = 'disabled' where id = $1`, [candidateFire.id]);
    expect((await claude.call('get_fire', { id: candidateFire.id })).isError).toBe(true);
    expect((await claude.call('confirm_solution', { id: candidateFire.id, user_evidence: 'That worked' })).isError).toBe(true);
    expect((await solutionRow(candidateFire.id)).confirmation_count).toBe(0);
  });

  it('a read-only grant can search but cannot write', async () => {
    const { pkceS256 } = await import('@firefinder/mcp/remote');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

    // A client that explicitly asks only for firefinder:read.
    const registration = await (
      await fetch(`${server.baseUrl}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK] }),
      })
    ).json();
    const verifier = 'r'.repeat(43);
    const params = new URLSearchParams({
      client_id: registration.client_id,
      redirect_uri: CLAUDE_CALLBACK,
      response_type: 'code',
      code_challenge: await pkceS256(verifier),
      code_challenge_method: 'S256',
      scope: 'firefinder:read',
    });
    const redirect = await fetch(`${server.baseUrl}/oauth/authorize?${params}`, {
      redirect: 'manual',
      headers: { 'x-forwarded-for': '198.51.100.88' },
    });
    const code = new URL(redirect.headers.get('location')!).searchParams.get('code')!;
    const tokens = await (
      await fetch(`${server.baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: CLAUDE_CALLBACK,
          code_verifier: verifier,
          client_id: registration.client_id,
        }),
      })
    ).json();
    expect(tokens.scope).toBe('firefinder:read');

    const reader = new Client({ name: 'read-only', version: '1.0.0' });
    await reader.connect(
      new StreamableHTTPClientTransport(new URL(server.mcpUrl), {
        requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
      }),
    );
    try {
      const search = await reader.callTool({ name: 'search_firefinder', arguments: { problem: 'Bluetooth is gone from my Windows laptop' } });
      expect(search.isError).not.toBe(true);
      const write = await reader.callTool({ name: 'confirm_solution', arguments: { id: bluetoothFire.id, user_evidence: 'That worked' } });
      expect(write.isError).toBe(true);
      expect((write.content as Array<{ text: string }>)[0]!.text).toContain('firefinder:write');
    } finally {
      await reader.close();
    }
  });

  it('rejects unknown tools', async () => {
    await expect(claude.client.callTool({ name: 'set_status', arguments: { id: bluetoothFire.id, status: 'disabled' } })).resolves.toMatchObject({
      isError: true,
    });
  });
});

describe('abuse protection', () => {
  let limited: RemoteServer;
  beforeAll(async () => {
    limited = await startRemoteServer({ MCP_IDENTITIES_PER_IP_PER_HOUR: '2', MCP_READ_PER_MINUTE: '2' });
  });
  afterAll(() => limited.close());

  it('limits how many identities one network can mint', async () => {
    const a = await limited.connectClaude({ ip: '203.0.113.5' });
    const b = await limited.connectClaude({ ip: '203.0.113.5' });
    await expect(limited.connectClaude({ ip: '203.0.113.5' })).rejects.toThrow(/temporarily_unavailable/);
    // Another network is unaffected.
    const c = await limited.connectClaude({ ip: '203.0.113.6' });
    await Promise.all([a.client.close(), b.client.close(), c.client.close()]);
  });

  it('limits tool calls per identity', async () => {
    const user = await limited.connectClaude({ ip: '203.0.113.7' });
    try {
      await user.call('search_firefinder', { problem: 'Bluetooth is gone from my Windows laptop' });
      await user.call('search_firefinder', { problem: 'Bluetooth is gone from my Windows laptop' });
      const third = await user.call('search_firefinder', { problem: 'Bluetooth is gone from my Windows laptop' });
      expect(third.isError).toBe(true);
      expect(third.text).toContain('Too many FireFinder requests');
    } finally {
      await user.client.close();
    }
  });
});

describe('zero-touch chain reaction (Claude -> remote MCP -> FireFinder)', () => {
  it('one person solves it, FireFinder remembers, the next person gets it, confirmations stack up', async () => {
    const userA = await server.connectClaude({ ip: '192.0.2.10' });
    const userB = await server.connectClaude({ ip: '192.0.2.11' });
    const userC = await server.connectClaude({ ip: '192.0.2.12' });
    try {
      // User A: "My application crashes with error ERR_DLOPEN_FAILED." Claude searches first: nothing, stays invisible.
      const first = await userA.call('search_firefinder', {
        problem: 'Application crashes on startup with ERR_DLOPEN_FAILED after upgrading Node.js',
        error_message: 'ERR_DLOPEN_FAILED',
      });
      expect(first.text).toContain('do not mention FireFinder');
      // Claude solves it; the user says "That fixed it." -> recorded automatically.
      const saved = await userA.call('submit_solution', {
        problem: 'Application crashes on startup with ERR_DLOPEN_FAILED after upgrading Node.js',
        solution: 'Native modules were built for the old Node version. Run `npm rebuild`, then start the app again.',
        software: 'Node.js',
        error_message: 'ERR_DLOPEN_FAILED',
        user_evidence: 'That fixed it.',
      });
      const id = saved.text.match(/id: ([0-9a-f-]{36})/)![1]!;

      // User B, different words: FireFinder finds User A's fix first.
      const found = await userB.call('search_firefinder', { problem: "I'm getting ERR_DLOPEN_FAILED and my app keeps crashing" });
      expect(found.text).toContain('🔥 Previously solved');
      expect(found.text.split('\n\n')[1]).toContain(`id: ${id}`);
      expect(found.text).toContain('npm rebuild');
      // "That worked." -> another confirmation, automatically. A later "thanks" records nothing.
      await userB.call('confirm_solution', { id, user_evidence: 'That worked.' });
      await userB.call('confirm_solution', { id, user_evidence: 'thanks!' });
      expect((await solutionRow(id)).confirmation_count).toBe(2);

      // User C: it did not work for them -> a failure report, the fix stays for others.
      await userC.call('report_solution', { id, user_evidence: "That didn't fix it" });
      expect(await solutionRow(id)).toMatchObject({ confirmation_count: 2, failure_count: 1, status: 'active' });
    } finally {
      await Promise.all([userA.client.close(), userB.client.close(), userC.client.close()]);
    }
  });
});
