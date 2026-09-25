import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { FireFinderService, PostgresStore } from '@firefinder/core';
import type { Hono } from 'hono';
import { createEdgeApp } from '../../apps/edge/src/handler.ts';
import type { Database } from '../../apps/api/src/db.ts';
import { createTestDatabase, realEmbedder, silentLogger } from './context.ts';

/** Where Supabase serves the function; the test server uses the same path. */
export const FUNCTION_PATH = '/functions/v1/firefinder';
export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
export const VOTER_SECRET = 'remote-test-voter-secret-0123456789';

/** An OAuth client provider that behaves like claude.ai's connector. */
export class ClaudeLikeProvider implements OAuthClientProvider {
  authorizationUrl: URL | undefined;
  #client: OAuthClientInformationMixed | undefined;
  #tokens: OAuthTokens | undefined;
  #verifier = '';
  readonly scope: string | undefined;
  constructor(scope?: string) {
    this.scope = scope;
  }
  get redirectUrl() {
    return CLAUDE_CALLBACK;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Claude',
      redirect_uris: [CLAUDE_CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.scope ? { scope: this.scope } : {}),
    };
  }
  state() {
    return 'state-123';
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

export interface RemoteServer {
  db: Database;
  store: PostgresStore;
  service: FireFinderService;
  /** e.g. http://127.0.0.1:1234/functions/v1/firefinder */
  baseUrl: string;
  mcpUrl: string;
  /** Every URL the MCP client fetched (discovery assertions). */
  fetched: string[];
  /** Connects a new "Claude" (a new anonymous identity) through the full OAuth flow. */
  connectClaude(options?: { ip?: string; scope?: string }): Promise<ConnectedClaude>;
  close(): Promise<void>;
}

export interface ConnectedClaude {
  client: Client;
  provider: ClaudeLikeProvider;
  accessToken: string;
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

export async function startRemoteServer(env: Record<string, string> = {}): Promise<RemoteServer> {
  const db = await createTestDatabase();
  let app: Hono | undefined;
  const http = serve({ fetch: (request) => app!.fetch(request), port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => http.once('listening', () => resolve()));
  const port = (http.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}${FUNCTION_PATH}`;

  const values: Record<string, string> = {
    SUPABASE_DB_URL: 'postgres://unused',
    FIREFINDER_VOTER_SECRET: VOTER_SECRET,
    FIREFINDER_PUBLIC_URL: baseUrl,
    ...env,
  };
  app = createEdgeApp({
    env: { get: (name) => values[name] },
    embedder: realEmbedder(),
    connect: () => db.sql,
    basePath: FUNCTION_PATH,
    logger: silentLogger,
  });

  const store = new PostgresStore(db.sql);
  const service = new FireFinderService({ store, embedder: realEmbedder(), config: { voterSecret: VOTER_SECRET } });
  const fetched: string[] = [];
  const recordingFetch: typeof fetch = (input, init) => {
    fetched.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return fetch(input, init);
  };
  const mcpUrl = `${baseUrl}/mcp`;

  async function connectClaude(options: { ip?: string; scope?: string } = {}): Promise<ConnectedClaude> {
    const provider = new ClaudeLikeProvider(options.scope);
    const client = new Client({ name: 'claude-ai-test', version: '1.0.0' });
    const first = new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: provider, fetch: recordingFetch });
    // 1st attempt: 401 -> discovery -> dynamic registration -> "open the browser".
    await client.connect(first).then(
      () => {
        throw new Error('expected the first connection to require authorization');
      },
      (error) => {
        if (!(error instanceof UnauthorizedError)) throw error;
      },
    );
    // The browser visits the authorization URL; FireFinder redirects back to Claude with a code.
    const response = await fetch(provider.authorizationUrl!, {
      redirect: 'manual',
      headers: { 'x-forwarded-for': options.ip ?? '198.51.100.20' },
    });
    const location = new URL(response.headers.get('location')!);
    const code = location.searchParams.get('code');
    if (!code) throw new Error(`authorization failed: ${location.search}`);
    await first.finishAuth(code);
    // Connect again, now with tokens.
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: provider, fetch: recordingFetch });
    await client.connect(transport);
    return {
      client,
      provider,
      accessToken: (await provider.tokens())!.access_token,
      call: async (name, args) => {
        const result = await client.callTool({ name, arguments: args });
        const text = (result.content as Array<{ text: string }>).map((c) => c.text).join('\n');
        return { text, isError: result.isError === true };
      },
    };
  }

  return {
    db,
    store,
    service,
    baseUrl,
    mcpUrl,
    fetched,
    connectClaude,
    close: async () => {
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await db.close();
    },
  };
}
