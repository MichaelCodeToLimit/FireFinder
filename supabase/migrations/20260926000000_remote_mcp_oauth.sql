-- =============================================================================
-- Remote MCP: OAuth 2.1 storage for claude.ai / Claude mobile connections.
--
-- FireFinder is its own small authorization server. Each connection gets an
-- anonymous identity (a grant): no accounts, no personal data. The identity is
-- what one-vote-per-voter and per-user rate limits are keyed on.
--
-- Stored:  hashes of single-use authorization codes (minutes) and of the
--          current refresh token per grant (rotated on every use).
-- Never stored: access tokens (short-lived, signed), IP addresses, names.
-- =============================================================================

create table if not exists firefinder.oauth_codes (
  code_hash text primary key,
  client_id text not null,
  redirect_uri text not null,
  code_challenge text not null,
  resource text not null,
  scopes text[] not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),

  constraint oauth_codes_hash_format check (code_hash ~ '^[0-9a-f]{64}$'),
  constraint oauth_codes_client_id_length check (char_length(client_id) <= 2048),
  constraint oauth_codes_redirect_uri_length check (char_length(redirect_uri) <= 2048),
  constraint oauth_codes_challenge_format check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  constraint oauth_codes_resource_length check (char_length(resource) <= 2048)
);

-- Cleanup of expired, never-redeemed codes.
create index if not exists oauth_codes_expires_idx on firefinder.oauth_codes (expires_at);

create table if not exists firefinder.oauth_grants (
  -- The anonymous identity ("sub" of access tokens).
  id uuid primary key,
  -- SHA-256 of the OAuth client_id the grant was issued to; refresh must match.
  client_id_hash text not null,
  -- Display name the client registered with (e.g. "Claude"); for operators.
  client_name text,
  scopes text[] not null,
  resource text not null,
  refresh_token_hash text not null unique,
  refresh_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_refreshed_at timestamptz,
  -- Set by an operator to cut off an abusive identity (effective at next refresh).
  revoked_at timestamptz,

  constraint oauth_grants_client_hash_format check (client_id_hash ~ '^[0-9a-f]{64}$'),
  constraint oauth_grants_refresh_hash_format check (refresh_token_hash ~ '^[0-9a-f]{64}$'),
  constraint oauth_grants_client_name_length check (char_length(client_name) <= 100),
  constraint oauth_grants_resource_length check (char_length(resource) <= 2048),
  constraint oauth_grants_scopes_check check (
    cardinality(scopes) > 0 and scopes <@ array['firefinder:read', 'firefinder:write']
  )
);

-- Same lock-down as every other FireFinder table.
alter table firefinder.oauth_codes enable row level security;
alter table firefinder.oauth_grants enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on firefinder.oauth_codes, firefinder.oauth_grants from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on firefinder.oauth_codes, firefinder.oauth_grants from authenticated';
  end if;
end;
$$;
