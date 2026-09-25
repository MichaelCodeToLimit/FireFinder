/**
 * Compact signed tokens (Web Crypto only; runs on Node and Deno).
 *
 *   <prefix><base64url(JSON payload)>.<base64url(HMAC-SHA256)>
 *
 * Each purpose (client ids, access tokens, forwarded IPs) signs with its own
 * key derived from the master secret, so a value minted for one purpose can
 * never be accepted as another.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/** base64url(SHA-256(verifier)): the PKCE S256 transform. */
export async function pkceS256(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
}

export type TokenPurpose = 'client' | 'access' | 'forwarded-ip';

export class TokenSigner {
  readonly #secret: string;
  readonly #keys = new Map<TokenPurpose, Promise<CryptoKey>>();

  constructor(secret: string) {
    if (secret.length < 16) throw new Error('token signing secret must be at least 16 characters');
    this.#secret = secret;
  }

  async sign(prefix: string, purpose: TokenPurpose, payload: object): Promise<string> {
    const body = `${prefix}${base64url(encoder.encode(JSON.stringify(payload)))}`;
    const signature = await crypto.subtle.sign('HMAC', await this.#key(purpose), encoder.encode(body));
    return `${body}.${base64url(new Uint8Array(signature))}`;
  }

  /** Returns the payload if the signature is valid, otherwise null. Constant-time comparison. */
  async verify<T>(prefix: string, purpose: TokenPurpose, token: string): Promise<T | null> {
    if (!token.startsWith(prefix) || token.length > 4096) return null;
    const dot = token.lastIndexOf('.');
    if (dot <= prefix.length) return null;
    const body = token.slice(0, dot);
    const signature = fromBase64url(token.slice(dot + 1));
    const payload = fromBase64url(body.slice(prefix.length));
    if (!signature || !payload) return null;
    const valid = await crypto.subtle.verify('HMAC', await this.#key(purpose), signature, encoder.encode(body));
    if (!valid) return null;
    try {
      return JSON.parse(decoder.decode(payload)) as T;
    } catch {
      return null;
    }
  }

  #key(purpose: TokenPurpose): Promise<CryptoKey> {
    let key = this.#keys.get(purpose);
    if (!key) {
      key = (async () => {
        const master = await crypto.subtle.importKey(
          'raw',
          encoder.encode(this.#secret),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign'],
        );
        const derived = await crypto.subtle.sign('HMAC', master, encoder.encode(`firefinder-oauth:${purpose}`));
        return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
      })();
      this.#keys.set(purpose, key);
    }
    return key;
  }
}
