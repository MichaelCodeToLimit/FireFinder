/**
 * Remote MCP endpoint for claude.ai, Claude mobile, ChatGPT, Codex and any MCP
 * client that speaks Streamable HTTP + OAuth 2.1 (MCP authorization spec 2025-11-25).
 *
 *   /mcp                                    MCP (Streamable HTTP, stateless, JSON responses)
 *   /.well-known/oauth-protected-resource   RFC 9728 metadata (linked from every 401)
 *   /.well-known/oauth-authorization-server RFC 8414 metadata
 *   /.well-known/openid-configuration       same, OIDC-discovery form (path-appended issuers)
 *   /oauth/register                         RFC 7591 dynamic client registration (stateless)
 *   /oauth/authorize                        authorization code + PKCE (S256 only)
 *   /oauth/token                            code exchange and refresh-token rotation
 *
 * FireFinder is its own authorization server. Authorizing mints an anonymous
 * identity (no account, no personal data); that identity is the voter and the
 * rate-limit subject. There is nothing pre-existing to protect behind a login,
 * so the authorize step completes without a consent screen; abuse is bounded
 * by redirect-URI allowlisting and per-IP limits on minting identities.
 */
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  consoleLogger,
  randomBase62,
  sha256Hex,
  uuidv7,
  type FireFinderService,
  type Logger,
  type RateLimiter,
} from '@firefinder/core';
import { createFireFinderMcpServer } from '../server.ts';
import type { OAuthStore } from './oauth-store.ts';
import { SCOPES, ServiceOperations, type McpIdentity } from './operations.ts';
import { pkceS256, TokenSigner } from './tokens.ts';

export interface RemoteMcpConfig {
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  codeTtlSeconds: number;
  /** Exact redirect URIs accepted at client registration (besides loopback). */
  allowedRedirectUris: string[];
  /** Redirect URIs accepted by pattern, for callbacks that carry a per-connection id. */
  allowedRedirectPatterns: RegExp[];
  /** Accept http://localhost, 127.0.0.1 and [::1] redirects on any port (Claude Code, MCP Inspector). */
  allowLoopbackRedirects: boolean;
  /** New identities per IP address (the user's browser) per hour and per day. */
  identitiesPerIpPerHour: number;
  identitiesPerIpPerDay: number;
  /** Tool calls per identity per minute. */
  readPerMinute: number;
  writePerMinute: number;
}

export const DEFAULT_REMOTE_MCP_CONFIG: RemoteMcpConfig = {
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 90 * 24 * 3600,
  codeTtlSeconds: 300,
  allowedRedirectUris: [
    'https://claude.ai/api/mcp/auth_callback',
    // ChatGPT and Codex use this stable callback because /oauth/authorize returns `iss` (RFC 9207).
    'https://chatgpt.com/connector_platform_oauth_redirect',
  ],
  // ChatGPT's per-connection callback, which it uses with servers that don't return `iss`.
  allowedRedirectPatterns: [/^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/],
  allowLoopbackRedirects: true,
  identitiesPerIpPerHour: 10,
  identitiesPerIpPerDay: 30,
  readPerMinute: 60,
  writePerMinute: 20,
};

export interface RemoteMcpOptions {
  service: FireFinderService;
  oauthStore: OAuthStore;
  rateLimiter: RateLimiter;
  /**
   * Public base URL where these routes are reachable, without trailing slash,
   * e.g. https://<ref>.supabase.co/functions/v1/firefinder. It is the OAuth
   * issuer; the MCP endpoint (and token audience) is `${publicUrl}/mcp`.
   */
  publicUrl: string;
  /** Master secret for signing access tokens and client ids (16+ chars). */
  secret: string;
  /** The end user's IP address, for limiting how fast identities can be minted. */
  clientIp?: (c: Context) => string | null | Promise<string | null>;
  config?: Partial<RemoteMcpConfig>;
  logger?: Logger;
  /** Clock in milliseconds (tests). */
  now?: () => number;
}

interface AccessTokenPayload {
  v: 1;
  sub: string;
  scope: string[];
  aud: string;
  iat: number;
  exp: number;
}

interface ClientPayload {
  v: 1;
  r: string[];
  n?: string;
}

const SUPPORTED_SCOPES = [SCOPES.read, SCOPES.write];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createRemoteMcpApp(options: RemoteMcpOptions): Hono {
  const config: RemoteMcpConfig = { ...DEFAULT_REMOTE_MCP_CONFIG, ...options.config };
  const logger = options.logger ?? consoleLogger;
  const now = options.now ?? Date.now;
  const signer = new TokenSigner(options.secret);

  const issuer = options.publicUrl.replace(/\/+$/, '');
  const resource = `${issuer}/mcp`;
  const resourceMetadataUrl = `${issuer}/.well-known/oauth-protected-resource`;

  const app = new Hono();
  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type', 'Mcp-Session-Id', 'Mcp-Protocol-Version', 'Last-Event-ID'],
      exposeHeaders: ['WWW-Authenticate', 'Mcp-Session-Id', 'Mcp-Protocol-Version'],
      maxAge: 600,
    }),
  );
  app.use('*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'invalid_request', error_description: 'Request body is too large.' }, 413) }));

  // ---------------------------------------------------------------------------
  // Discovery metadata
  // ---------------------------------------------------------------------------

  const protectedResourceMetadata = () => ({
    resource,
    authorization_servers: [issuer],
    scopes_supported: SUPPORTED_SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'FireFinder',
  });
  app.get('/.well-known/oauth-protected-resource', (c) => c.json(protectedResourceMetadata()));
  app.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(protectedResourceMetadata()));

  const authorizationServerMetadata = () => ({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    scopes_supported: [...SUPPORTED_SCOPES, 'offline_access'],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    // Required fields of an OpenID Connect discovery document. FireFinder
    // issues no ID tokens: the key set is empty and "openid" is not a scope.
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
  });
  app.get('/.well-known/oauth-authorization-server', (c) => c.json(authorizationServerMetadata()));
  app.get('/.well-known/openid-configuration', (c) => c.json(authorizationServerMetadata()));
  app.get('/.well-known/jwks.json', (c) => c.json({ keys: [] }));

  // ---------------------------------------------------------------------------
  // Dynamic client registration (stateless: the client id is signed)
  // ---------------------------------------------------------------------------

  const redirectAllowed = (uri: string): boolean => {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return false;
    }
    if (url.hash) return false;
    if (config.allowedRedirectUris.includes(uri)) return true;
    if (config.allowedRedirectPatterns.some((pattern) => pattern.test(uri))) return true;
    return config.allowLoopbackRedirects && url.protocol === 'http:' && isLoopback(url.hostname);
  };

  app.post('/oauth/register', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') return registrationError(c, 'invalid_client_metadata', 'Body must be a JSON object.');
    const redirectUris = (body as { redirect_uris?: unknown }).redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 10) {
      return registrationError(c, 'invalid_redirect_uri', 'redirect_uris must list 1-10 URIs.');
    }
    for (const uri of redirectUris) {
      if (typeof uri !== 'string' || uri.length > 2048 || !redirectAllowed(uri)) {
        return registrationError(
          c,
          'invalid_redirect_uri',
          `Redirect URI not allowed: ${String(uri).slice(0, 200)}. FireFinder accepts Claude's and ChatGPT's callbacks and loopback addresses.`,
        );
      }
    }
    const grantTypes = (body as { grant_types?: unknown }).grant_types;
    if (grantTypes !== undefined && (!Array.isArray(grantTypes) || !grantTypes.includes('authorization_code'))) {
      return registrationError(c, 'invalid_client_metadata', 'grant_types must include authorization_code.');
    }
    const rawName = (body as { client_name?: unknown }).client_name;
    const clientName = typeof rawName === 'string' ? rawName.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) : undefined;

    const payload: ClientPayload = { v: 1, r: redirectUris as string[], ...(clientName ? { n: clientName } : {}) };
    const clientId = await signer.sign('ffc_', 'client', payload);
    return c.json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(now() / 1000),
        ...(clientName ? { client_name: clientName } : {}),
        redirect_uris: redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      201,
    );
  });

  const decodeClient = async (clientId: string | undefined): Promise<ClientPayload | null> => {
    if (!clientId) return null;
    const payload = await signer.verify<ClientPayload>('ffc_', 'client', clientId);
    return payload?.v === 1 && Array.isArray(payload.r) ? payload : null;
  };

  // ---------------------------------------------------------------------------
  // Authorization endpoint
  // ---------------------------------------------------------------------------

  app.get('/oauth/authorize', async (c) => {
    c.header('Cache-Control', 'no-store');
    const q = c.req.query();
    const client = await decodeClient(q.client_id);
    if (!client) return c.json({ error: 'invalid_client', error_description: 'Unknown client_id. Register the client first.' }, 400);

    // Never redirect to a URI the client did not register (open-redirect protection).
    const redirectUri = q.redirect_uri ?? (client.r.length === 1 ? client.r[0] : undefined);
    if (!redirectUri || !client.r.some((registered) => redirectMatches(registered, redirectUri)) || !redirectAllowed(redirectUri)) {
      return c.json({ error: 'invalid_request', error_description: 'redirect_uri is not registered for this client.' }, 400);
    }
    const fail = (error: string, description: string) =>
      c.redirect(withParams(redirectUri, { error, error_description: description, state: q.state, iss: issuer }), 302);

    if (q.response_type !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported.');
    if (q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge ?? '')) {
      return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
    }
    if (q.resource && !sameResource(q.resource, resource)) {
      return fail('invalid_target', `Tokens can only be issued for ${resource}.`);
    }
    const scopes = requestedScopes(q.scope);
    if (!scopes) return fail('invalid_scope', `Supported scopes: ${SUPPORTED_SCOPES.join(' ')}.`);

    // Each authorization mints a new anonymous identity: limit how fast one network can do that.
    const ip = await options.clientIp?.(c);
    if (ip) {
      try {
        const decisions = await options.rateLimiter.hit(
          [
            { key: `oauth:identity:h:${ip}`, limit: config.identitiesPerIpPerHour },
            { key: `oauth:identity:d:${ip}`, limit: config.identitiesPerIpPerDay },
          ],
          3600,
        );
        if (decisions.some((d) => !d.allowed)) {
          return fail('temporarily_unavailable', 'Too many new FireFinder connections from this network. Try again later.');
        }
      } catch (error) {
        logger.warn('rate limiter unavailable', { error: String(error) });
      }
    }

    const code = `ffo_${randomBase62(43)}`;
    await options.oauthStore.saveCode(
      await sha256Hex(code),
      { clientId: q.client_id!, redirectUri, codeChallenge: q.code_challenge!, resource, scopes },
      config.codeTtlSeconds,
    );
    return c.redirect(withParams(redirectUri, { code, state: q.state, iss: issuer }), 302);
  });

  // ---------------------------------------------------------------------------
  // Token endpoint
  // ---------------------------------------------------------------------------

  const issueTokens = async (subject: string, scopes: string[], refreshToken: string) => {
    const iat = Math.floor(now() / 1000);
    const payload: AccessTokenPayload = { v: 1, sub: subject, scope: scopes, aud: resource, iat, exp: iat + config.accessTokenTtlSeconds };
    return {
      access_token: await signer.sign('ffa_', 'access', payload),
      token_type: 'Bearer',
      expires_in: config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  };

  app.post('/oauth/token', async (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    const params = await readParams(c);
    if (!params) return tokenError(c, 'invalid_request', 'Send parameters as application/x-www-form-urlencoded.');

    if (params.grant_type === 'authorization_code') {
      const { code, redirect_uri, code_verifier, client_id } = params;
      if (!code || !redirect_uri || !code_verifier || !client_id) {
        return tokenError(c, 'invalid_request', 'code, redirect_uri, code_verifier and client_id are required.');
      }
      const stored = await options.oauthStore.consumeCode(await sha256Hex(code));
      if (!stored || stored.expired) return tokenError(c, 'invalid_grant', 'The authorization code is invalid, expired or already used.');
      if (stored.clientId !== client_id || stored.redirectUri !== redirect_uri) {
        return tokenError(c, 'invalid_grant', 'The authorization code was issued to a different client or redirect_uri.');
      }
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(code_verifier) || (await pkceS256(code_verifier)) !== stored.codeChallenge) {
        return tokenError(c, 'invalid_grant', 'PKCE verification failed.');
      }
      if (params.resource && !sameResource(params.resource, stored.resource)) {
        return tokenError(c, 'invalid_target', `Tokens can only be issued for ${resource}.`);
      }
      const client = await decodeClient(client_id);
      const subject = uuidv7(now());
      const refreshToken = `ffr_${randomBase62(43)}`;
      await options.oauthStore.createGrant({
        id: subject,
        clientIdHash: await sha256Hex(client_id),
        clientName: client?.n ?? null,
        scopes: stored.scopes,
        resource: stored.resource,
        refreshTokenHash: await sha256Hex(refreshToken),
        refreshTtlSeconds: config.refreshTokenTtlSeconds,
      });
      return c.json(await issueTokens(subject, stored.scopes, refreshToken));
    }

    if (params.grant_type === 'refresh_token') {
      if (!params.refresh_token) return tokenError(c, 'invalid_request', 'refresh_token is required.');
      const next = `ffr_${randomBase62(43)}`;
      const grant = await options.oauthStore.rotateRefreshToken(
        await sha256Hex(params.refresh_token),
        await sha256Hex(next),
        config.refreshTokenTtlSeconds,
        params.client_id ? await sha256Hex(params.client_id) : null,
      );
      if (!grant) return tokenError(c, 'invalid_grant', 'The refresh token is invalid, expired, revoked or already used.');
      return c.json(await issueTokens(grant.id, grant.scopes, next));
    }

    return tokenError(c, 'unsupported_grant_type', 'Supported grant types: authorization_code, refresh_token.');
  });

  // ---------------------------------------------------------------------------
  // MCP endpoint
  // ---------------------------------------------------------------------------

  const unauthorized = (c: Context, description?: string) => {
    const parts = [`resource_metadata="${resourceMetadataUrl}"`, `scope="${SUPPORTED_SCOPES.join(' ')}"`];
    if (description) parts.push('error="invalid_token"', `error_description="${description}"`);
    c.header('WWW-Authenticate', `Bearer ${parts.join(', ')}`);
    return c.json({ error: description ? 'invalid_token' : 'unauthorized', error_description: description ?? 'Authorization required.' }, 401);
  };

  const authenticate = async (c: Context): Promise<{ identity: McpIdentity; authInfo: AuthInfo } | string | null> => {
    const token = c.req.header('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token) return null;
    const payload = await signer.verify<AccessTokenPayload>('ffa_', 'access', token);
    if (!payload || payload.v !== 1 || !UUID.test(payload.sub) || !Array.isArray(payload.scope)) return 'The access token is invalid.';
    if (!sameResource(payload.aud, resource)) return 'The access token was issued for a different resource.';
    if (payload.exp * 1000 <= now()) return 'The access token has expired.';
    const scopes = payload.scope.filter((scope) => SUPPORTED_SCOPES.includes(scope as (typeof SUPPORTED_SCOPES)[number]));
    return {
      identity: { subject: payload.sub, scopes },
      authInfo: { token, clientId: 'firefinder', scopes, expiresAt: payload.exp, resource: new URL(resource), extra: { subject: payload.sub } },
    };
  };

  app.all('/mcp', async (c) => {
    const auth = await authenticate(c);
    if (auth === null) return unauthorized(c);
    if (typeof auth === 'string') return unauthorized(c, auth);

    // Stateless server: no sessions and no server-initiated streams.
    if (c.req.method !== 'POST') {
      c.header('Allow', 'POST');
      return c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }, 405);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error.' }, id: null }, 400);
    }

    const operations = new ServiceOperations({
      service: options.service,
      identity: auth.identity,
      rateLimiter: options.rateLimiter,
      limits: {
        read: { limit: config.readPerMinute, windowSeconds: 60 },
        write: { limit: config.writePerMinute, windowSeconds: 60 },
      },
      logger,
    });
    const server = createFireFinderMcpServer(operations, {
      source: 'claude-remote-mcp',
      authHint: 'Reconnect FireFinder in your assistant\'s connector or plugin settings to renew its authorization.',
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw, { parsedBody: body, authInfo: auth.authInfo });
    } finally {
      await server.close();
    }
  });

  return app;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** Exact match, except loopback redirects ignore the port (RFC 8252 section 7.3). */
function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  try {
    const a = new URL(registered);
    const b = new URL(requested);
    return (
      a.protocol === 'http:' &&
      b.protocol === 'http:' &&
      isLoopback(a.hostname) &&
      a.hostname === b.hostname &&
      a.pathname === b.pathname &&
      a.search === b.search
    );
  } catch {
    return false;
  }
}

/** Resource indicators compare case-insensitively on scheme/host and ignore a trailing slash. */
function sameResource(a: string, b: string): boolean {
  const canonical = (value: string) => {
    try {
      const url = new URL(value);
      return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}${url.search}`.toLowerCase();
    } catch {
      return null;
    }
  };
  const left = canonical(a);
  return left !== null && left === canonical(b);
}

/** Granted scopes: the supported scopes requested, or all of them when none are named. Null if only unknown scopes were requested. */
function requestedScopes(scope: string | undefined): string[] | null {
  const requested = (scope ?? '').split(/\s+/).filter(Boolean);
  if (requested.length === 0) return [...SUPPORTED_SCOPES];
  const granted = SUPPORTED_SCOPES.filter((s) => requested.includes(s));
  if (granted.length > 0) return granted;
  // Only protocol scopes such as offline_access were requested: grant the defaults.
  return requested.every((s) => s === 'offline_access') ? [...SUPPORTED_SCOPES] : null;
}

function withParams(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  return url.toString();
}

async function readParams(c: Context): Promise<Record<string, string> | null> {
  const type = c.req.header('content-type') ?? '';
  try {
    if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
      const body = await c.req.parseBody();
      return Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    }
    if (type.includes('application/json')) {
      const body = await c.req.json();
      return Object.fromEntries(Object.entries(body ?? {}).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    }
  } catch {
    return null;
  }
  return null;
}

function tokenError(c: Context, error: string, description: string) {
  return c.json({ error, error_description: description }, 400);
}

function registrationError(c: Context, error: string, description: string) {
  return c.json({ error, error_description: description }, 400);
}
