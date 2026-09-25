import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const VALID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * A random identifier for this install, stored in ~/.firefinder/client-id.
 * It carries no personal information; the server only ever stores an HMAC of
 * it, which is enough to count one vote per install.
 */
export function loadOrCreateClientId(path = join(homedir(), '.firefinder', 'client-id')): string {
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (VALID.test(existing)) return existing;
  } catch {
    // not created yet
  }
  const id = randomBytes(18).toString('base64url');
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${id}\n`, { mode: 0o600 });
  } catch {
    // Read-only home directory: fall back to a per-process id.
  }
  return id;
}
