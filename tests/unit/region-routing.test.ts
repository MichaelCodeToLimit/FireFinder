import { describe, expect, it } from 'vitest';
import { TokenSigner } from '@firefinder/mcp/remote';
import { FORWARDED_HEADER, needsDatabase, routeByRegion, verifiedForwardedIp } from '../../apps/edge/src/handler.ts';

const signer = new TokenSigner('region-test-secret-0123456789');
const PUBLIC = 'https://ref.supabase.co/functions/v1/firefinder';
const rpc = (method: string) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} });

function recordingFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response('forwarded', { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const options = (fetchFn: typeof fetch, currentRegion = 'us-east-1') => ({
  databaseRegion: 'ap-southeast-1',
  currentRegion,
  publicUrl: PUBLIC,
  basePath: '/firefinder',
  signer,
  fetch: fetchFn,
});

describe('needsDatabase', () => {
  it('keeps metadata, registration and MCP handshakes local', () => {
    expect(needsDatabase('GET', '/.well-known/openid-configuration', undefined)).toBe(false);
    expect(needsDatabase('GET', '/health', undefined)).toBe(false);
    expect(needsDatabase('POST', '/oauth/register', '{}')).toBe(false);
    expect(needsDatabase('POST', '/mcp', rpc('initialize'))).toBe(false);
    expect(needsDatabase('POST', '/mcp', rpc('tools/list'))).toBe(false);
    expect(needsDatabase('POST', '/mcp', 'not json')).toBe(false);
  });

  it('sends tool calls, token exchange, authorization and REST calls to the database region', () => {
    expect(needsDatabase('POST', '/mcp', rpc('tools/call'))).toBe(true);
    expect(needsDatabase('POST', '/mcp', `[${rpc('tools/list')},${rpc('tools/call')}]`)).toBe(true);
    expect(needsDatabase('POST', '/oauth/token', 'grant_type=refresh_token')).toBe(true);
    expect(needsDatabase('GET', '/oauth/authorize', undefined)).toBe(true);
    expect(needsDatabase('POST', '/search', '{}')).toBe(true);
  });
});

describe('routeByRegion', () => {
  it('handles requests locally when already in the database region', async () => {
    const { calls, fetchFn } = recordingFetch();
    const request = new Request('https://x/firefinder/mcp', { method: 'POST', body: rpc('tools/call') });
    expect(await routeByRegion(request, options(fetchFn, 'ap-southeast-1'))).toBe(request);
    expect(calls).toHaveLength(0);
  });

  it('forwards tool calls once, pinned to the database region, carrying a signed caller IP', async () => {
    const { calls, fetchFn } = recordingFetch();
    const request = new Request('https://x/firefinder/mcp?x=1', {
      method: 'POST',
      headers: { authorization: 'Bearer ffa_abc', 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
      body: rpc('tools/call'),
    });
    const routed = await routeByRegion(request, options(fetchFn));
    expect(routed).toBeInstanceOf(Response);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(`${PUBLIC}/mcp?x=1`);
    const headers = new Headers(init.headers);
    expect(headers.get('x-region')).toBe('ap-southeast-1');
    expect(headers.get('authorization')).toBe('Bearer ffa_abc');
    expect(init.body).toBe(rpc('tools/call'));
    expect(init.redirect).toBe('manual');
    expect(await verifiedForwardedIp(headers, signer)).toBe('203.0.113.9');
  });

  it('answers the MCP handshake locally and keeps the body readable', async () => {
    const { calls, fetchFn } = recordingFetch();
    const routed = await routeByRegion(new Request('https://x/firefinder/mcp', { method: 'POST', body: rpc('initialize') }), options(fetchFn));
    expect(routed).toBeInstanceOf(Request);
    expect(await (routed as Request).text()).toBe(rpc('initialize'));
    expect(calls).toHaveLength(0);
  });

  it('falls back to local handling when the forwarded hop fails at the platform level', async () => {
    for (const failure of [
      (async () => new Response('{"code":"BOOT_ERROR"}', { status: 503 })) as unknown as typeof fetch,
      (async () => new Response('limit', { status: 546 })) as unknown as typeof fetch,
      (async () => {
        throw new TypeError('network down');
      }) as unknown as typeof fetch,
    ]) {
      const routed = await routeByRegion(
        new Request('https://x/firefinder/oauth/token', { method: 'POST', body: 'grant_type=refresh_token' }),
        options(failure),
      );
      expect(routed).toBeInstanceOf(Request);
      expect(await (routed as Request).text()).toBe('grant_type=refresh_token');
    }
  });

  it('passes application errors from the database region straight through', async () => {
    const appError = (async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as unknown as typeof fetch;
    const routed = await routeByRegion(new Request('https://x/firefinder/oauth/token', { method: 'POST', body: 'x' }), options(appError));
    expect((routed as Response).status).toBe(400);
  });

  it('never forwards a forwarded request again', async () => {
    const { calls, fetchFn } = recordingFetch();
    const request = new Request('https://x/firefinder/search', {
      method: 'POST',
      headers: { [FORWARDED_HEADER]: 'fwd_anything.sig' },
      body: '{}',
    });
    expect(await routeByRegion(request, options(fetchFn))).toBe(request);
    expect(calls).toHaveLength(0);
  });

  it('only trusts correctly signed, fresh caller-IP claims', async () => {
    const other = new TokenSigner('a-different-secret-0123456789');
    const forged = new Headers({ [FORWARDED_HEADER]: await other.sign('fwd_', 'forwarded-ip', { ip: '1.2.3.4', t: Date.now() }) });
    expect(await verifiedForwardedIp(forged, signer)).toBeNull();
    const stale = new Headers({ [FORWARDED_HEADER]: await signer.sign('fwd_', 'forwarded-ip', { ip: '1.2.3.4', t: Date.now() - 120_000 }) });
    expect(await verifiedForwardedIp(stale, signer)).toBeNull();
    // An access token is not a forwarded-IP claim, even with the same secret.
    const accessToken = new Headers({ [FORWARDED_HEADER]: await signer.sign('ffa_', 'access', { ip: '1.2.3.4', t: Date.now() }) });
    expect(await verifiedForwardedIp(accessToken, signer)).toBeNull();
  });
});
