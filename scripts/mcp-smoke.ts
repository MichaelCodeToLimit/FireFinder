/**
 * End-to-end check of a deployed remote MCP endpoint, connecting exactly like
 * claude.ai: discovery -> dynamic client registration -> OAuth (PKCE) -> MCP.
 * Two anonymous users then run the FireFinder chain reaction on a clearly
 * labelled test record, which is disabled afterwards.
 *
 * Against a deployed server the write path only runs with FIREFINDER_ADMIN_KEY
 * (so the test record never stays in a shared database); without it the check
 * is read-only: OAuth, tool list and a search that must miss.
 *
 *   FIREFINDER_MCP_URL=https://<ref>.supabase.co/functions/v1/firefinder/mcp npm run smoke:mcp
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

const mcpUrl =
  process.env.FIREFINDER_MCP_URL || (process.env.FIREFINDER_API_URL ? `${process.env.FIREFINDER_API_URL.replace(/\/+$/, '')}/mcp` : '');
if (!mcpUrl) {
  console.error('Set FIREFINDER_MCP_URL (e.g. https://<ref>.supabase.co/functions/v1/firefinder/mcp).');
  process.exit(1);
}
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

class ClaudeLikeProvider implements OAuthClientProvider {
  authorizationUrl?: URL;
  #client?: OAuthClientInformationMixed;
  #tokens?: OAuthTokens;
  #verifier = '';
  get redirectUrl() {
    return CALLBACK;
  }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: 'FireFinder smoke test', redirect_uris: [CALLBACK], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  }
  clientInformation() {
    return this.#client;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.#client = info;
  }
  tokens() {
    return this.#tokens;
  }
  saveTokens(tokens: OAuthTokens) {
    this.#tokens = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.#verifier = verifier;
  }
  codeVerifier() {
    return this.#verifier;
  }
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await fn();
  console.log(`✓ ${label} (${Math.round(performance.now() - started)} ms)`);
  return result;
}

async function connectClaude(name: string) {
  const provider = new ClaudeLikeProvider();
  const client = new Client({ name, version: '1.0.0' });
  // The same transport must see the 401 challenge and finish the authorization:
  // it remembers where the server's metadata lives.
  const first = new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: provider });
  await timed(`${name}: discovery + registration`, async () => {
    try {
      await client.connect(first);
      throw new Error('expected an authorization challenge');
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
    }
  });
  const code = await timed(`${name}: authorize (no account, no consent screen)`, async () => {
    const response = await fetch(provider.authorizationUrl!, { redirect: 'manual' });
    const location = new URL(response.headers.get('location') ?? 'about:blank');
    const value = location.searchParams.get('code');
    if (!value) throw new Error(`authorization failed: ${response.status} ${location.search}`);
    return value;
  });
  await timed(`${name}: token exchange`, () => first.finishAuth(code));
  await timed(`${name}: MCP initialize`, () => client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: provider })));
  const call = async (tool: string, args: Record<string, unknown>) => {
    const result = await timed(`${name}: ${tool}`, () => client.callTool({ name: tool, arguments: args }));
    const text = (result.content as Array<{ text: string }>).map((c) => c.text).join('\n');
    if (result.isError) throw new Error(`${tool} failed: ${text}`);
    return text;
  };
  return { client, call };
}

const run = Date.now().toString(36).toUpperCase();
const errorCode = `FFSMOKE_${run}`;
const adminKey = process.env.FIREFINDER_ADMIN_KEY;
const writes = Boolean(adminKey) || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(mcpUrl);
const userA = await connectClaude('user A');
const userB = writes ? await connectClaude('user B') : undefined;
let fireId: string | undefined;

try {
  const { tools } = await userA.client.listTools();
  console.log(`  tools: ${tools.map((t) => t.name).join(', ')}`);

  const nothing = await userA.call('search_firefinder', {
    problem: `Smoke-test app ${run} fails to start with error ${errorCode}`,
    error_message: errorCode,
  });
  if (!nothing.includes('do not mention FireFinder')) throw new Error(`expected an invisible miss, got: ${nothing}`);
  console.log('  user A: no match -> FireFinder stays invisible');

  if (userB) {
    const saved = await userA.call('submit_solution', {
      problem: `[smoke test ${run}] Smoke-test app fails to start with error ${errorCode}`,
      solution: 'Delete the smoke-test cache folder and start the app again. (Test record; it is disabled automatically.)',
      error_message: errorCode,
      user_evidence: 'That fixed it!',
    });
    fireId = saved.match(/id: ([0-9a-f-]{36})/)?.[1];
    console.log(`  user A: "That fixed it!" -> ${saved.split('\n')[0]}`);

    const found = await userB.call('search_firefinder', {
      problem: `My smoke-test app keeps failing at startup with ${errorCode}`,
      error_message: errorCode,
    });
    if (!fireId || !found.includes(fireId)) throw new Error(`user B did not receive user A's fix:\n${found}`);
    console.log(`  user B: ${found.split('\n')[0]}`);

    const confirmed = await userB.call('confirm_solution', { id: fireId, user_evidence: "It's working now" });
    if (!confirmed.includes('confirmed by 2')) throw new Error(`expected 2 confirmations: ${confirmed}`);
    console.log(`  user B: "It's working now" -> ${confirmed.split('. Now: ')[1]?.split('. No need')[0]}`);
  }
} finally {
  await userA.client.close();
  await userB?.client.close();
  if (fireId) {
    const base = mcpUrl.replace(/\/mcp$/, '');
    if (adminKey) {
      const res = await fetch(`${base}/admin/solutions/${fireId}/status`, {
        method: 'POST',
        headers: { 'x-api-key': adminKey, 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'disabled' }),
      });
      console.log(res.ok ? '✓ test record disabled' : `! could not disable test record (HTTP ${res.status})`);
      if (!res.ok) process.exitCode = 1;
    } else {
      console.log(`  (set FIREFINDER_ADMIN_KEY to disable the test record automatically; id ${fireId})`);
    }
  }
}

console.log(
  userB
    ? '\n🔥 Remote MCP chain reaction verified: Claude -> remote MCP -> FireFinder -> semantic search -> verified solution.'
    : '\n🔥 Remote MCP verified read-only (OAuth, tools, invisible miss). Set FIREFINDER_ADMIN_KEY to also run the write path; its test record is disabled afterwards.',
);
