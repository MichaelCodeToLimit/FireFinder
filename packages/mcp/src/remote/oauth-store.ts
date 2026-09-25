import type { SqlClient } from '@firefinder/core';

export interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: string[];
}

export interface Grant {
  id: string;
  clientIdHash: string;
  scopes: string[];
  resource: string;
}

/** Persistence for the remote MCP authorization server. */
export interface OAuthStore {
  saveCode(codeHash: string, code: AuthorizationCode, ttlSeconds: number): Promise<void>;
  /** Deletes the code (single use) and returns it; `expired` is true if it was too old. */
  consumeCode(codeHash: string): Promise<(AuthorizationCode & { expired: boolean }) | null>;
  createGrant(grant: Grant & { clientName: string | null; refreshTokenHash: string; refreshTtlSeconds: number }): Promise<void>;
  /**
   * Atomically replaces a valid refresh token with a new one (rotation).
   * Returns null for unknown, rotated-out, expired or revoked tokens, or when
   * `clientIdHash` does not match the grant.
   */
  rotateRefreshToken(
    oldHash: string,
    newHash: string,
    ttlSeconds: number,
    clientIdHash: string | null,
  ): Promise<Grant | null>;
}

const TEXT_ARRAY = (param: string) => `array(select jsonb_array_elements_text(${param}::text::jsonb))`;

export class PostgresOAuthStore implements OAuthStore {
  readonly #sql: SqlClient;

  constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  async saveCode(codeHash: string, code: AuthorizationCode, ttlSeconds: number): Promise<void> {
    await this.#sql.query(
      `insert into firefinder.oauth_codes (code_hash, client_id, redirect_uri, code_challenge, resource, scopes, expires_at)
       values ($1, $2, $3, $4, $5, ${TEXT_ARRAY('$6')}, now() + make_interval(secs => $7::integer))`,
      [codeHash, code.clientId, code.redirectUri, code.codeChallenge, code.resource, JSON.stringify(code.scopes), ttlSeconds],
    );
    // Opportunistic cleanup of codes that were never redeemed.
    if (Math.random() < 0.05) {
      await this.#sql.query(`delete from firefinder.oauth_codes where expires_at < now()`);
    }
  }

  async consumeCode(codeHash: string): Promise<(AuthorizationCode & { expired: boolean }) | null> {
    const rows = await this.#sql.query<Record<string, unknown>>(
      `delete from firefinder.oauth_codes where code_hash = $1
       returning client_id, redirect_uri, code_challenge, resource, to_jsonb(scopes) as scopes, expires_at <= now() as expired`,
      [codeHash],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      clientId: String(row.client_id),
      redirectUri: String(row.redirect_uri),
      codeChallenge: String(row.code_challenge),
      resource: String(row.resource),
      scopes: jsonArray(row.scopes),
      expired: row.expired === true || row.expired === 't',
    };
  }

  async createGrant(
    grant: Grant & { clientName: string | null; refreshTokenHash: string; refreshTtlSeconds: number },
  ): Promise<void> {
    await this.#sql.query(
      `insert into firefinder.oauth_grants
         (id, client_id_hash, client_name, scopes, resource, refresh_token_hash, refresh_expires_at)
       values ($1::uuid, $2, $3, ${TEXT_ARRAY('$4')}, $5, $6, now() + make_interval(secs => $7::integer))`,
      [
        grant.id,
        grant.clientIdHash,
        grant.clientName,
        JSON.stringify(grant.scopes),
        grant.resource,
        grant.refreshTokenHash,
        grant.refreshTtlSeconds,
      ],
    );
  }

  async rotateRefreshToken(oldHash: string, newHash: string, ttlSeconds: number, clientIdHash: string | null): Promise<Grant | null> {
    const rows = await this.#sql.query<Record<string, unknown>>(
      `update firefinder.oauth_grants
       set refresh_token_hash = $2,
           refresh_expires_at = now() + make_interval(secs => $3::integer),
           last_refreshed_at = now()
       where refresh_token_hash = $1
         and revoked_at is null
         and refresh_expires_at > now()
         and ($4::text is null or client_id_hash = $4::text)
       returning id, client_id_hash, to_jsonb(scopes) as scopes, resource`,
      [oldHash, newHash, ttlSeconds, clientIdHash],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      clientIdHash: String(row.client_id_hash),
      scopes: jsonArray(row.scopes),
      resource: String(row.resource),
    };
  }
}

function jsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}
