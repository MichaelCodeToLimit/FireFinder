import { describe, expect, it } from 'vitest';
import { redactSensitive, sanitizeText } from '@firefinder/core';

describe('sanitizeText', () => {
  it('removes control, zero-width and bidi-override characters', () => {
    const input = 'Blender\u0000 crash\u200B on\u202E start\u0007';
    expect(sanitizeText(input, { multiline: false })).toBe('Blender crash on start');
  });

  it('collapses whitespace for single-line fields', () => {
    expect(sanitizeText('  Windows\t 11 \n Pro  ', { multiline: false })).toBe('Windows 11 Pro');
  });

  it('keeps line breaks and indentation for multi-line fields', () => {
    const input = 'Steps:\r\n1. Open settings\n\n\n\n```yaml\nbuild:\n  command: npm run build   \n```';
    expect(sanitizeText(input, { multiline: true })).toBe(
      'Steps:\n1. Open settings\n\n```yaml\nbuild:\n  command: npm run build\n```',
    );
  });
});

describe('redactSensitive', () => {
  const cases: Array<[string, string, string]> = [
    ['email', 'Contact jane.doe@example.com for access', '[REDACTED_EMAIL]'],
    ['anthropic key', 'ANTHROPIC key sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345', '[REDACTED_API_KEY]'],
    ['openai key', 'using sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz123456', '[REDACTED_API_KEY]'],
    ['github token', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB', '[REDACTED_API_KEY]'],
    ['aws key', 'AKIAIOSFODNN7EXAMPLE was rejected', '[REDACTED_API_KEY]'],
    ['firefinder key', 'my key ff_Abc123Def456Ghi789Jkl012Mno345', '[REDACTED_API_KEY]'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', '[REDACTED_TOKEN]'],
    ['bearer', 'Authorization: Bearer abcdef1234567890ghijkl', 'Bearer [REDACTED]'],
    ['env password', 'DB_PASSWORD=hunter2 in .env', 'DB_PASSWORD=[REDACTED]'],
    ['json secret', '{"client_secret": "s3cr3t-value"}', '"client_secret": "[REDACTED]'],
    ['cli flag', 'mysql -u root --password SuperSecret1', '--password [REDACTED]'],
    ['connection string', 'postgres://admin:pa55word@db.example.com:5432/app', 'postgres://[REDACTED]@db.example.com'],
    ['card', 'charged card 4111 1111 1111 1111 twice', '[REDACTED_CARD]'],
    ['ssn', 'SSN 123-45-6789 in the form', '[REDACTED_SSN]'],
    ['phone', 'call me at (555) 123-4567', '[REDACTED_PHONE]'],
    ['public ip', 'cannot reach 203.0.113.42 from home', '[REDACTED_IP]'],
    ['windows user path', 'File C:\\Users\\michael\\AppData\\Roaming\\app.log', 'C:\\Users\\<user>\\AppData'],
    ['mac user path', 'at /Users/jane/Library/Logs/app.log', '/Users/<user>/Library'],
    ['linux user path', 'see /home/bob/.config/app.toml', '/home/<user>/.config'],
    ['generic secret', 'webhook secret whsec9f8A7b6C5d4E3f2A1b0C9d8E7f6A5b4C3d', '[REDACTED_SECRET]'],
  ];

  it.each(cases)('redacts %s', (_name, input, expected) => {
    const result = redactSensitive(input);
    expect(result.text).toContain(expected);
    expect(result.redactions.length).toBeGreaterThan(0);
  });

  it('removes the private key body entirely', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\nabcd\n-----END RSA PRIVATE KEY-----';
    const result = redactSensitive(`Using key:\n${key}\nand it fails`);
    expect(result.text).toBe('Using key:\n[REDACTED_PRIVATE_KEY]\nand it fails');
    expect(result.redactions).toEqual(['private_key']);
  });

  it('reports each kind once', () => {
    const result = redactSensitive('a@example.com and b@example.org');
    expect(result.redactions).toEqual(['email']);
  });

  const untouched = [
    'npm install fails with ERR_OSSL_EVP_UNSUPPORTED on Node 18.17.0',
    'Windows Update error 0x80070005 after KB5034441',
    'Set NODE_OPTIONS=--openssl-legacy-provider and rebuild',
    'Component {00000000-0000-0000-C000-000000000046} failed',
    'git clone git@github.com:org/repo.git fails with Permission denied (publickey)',
    'Router at 192.168.1.1 and 10.0.0.5 unreachable, localhost:3000 works',
    'Assembly Version=1.0.0.0 could not be loaded',
    'The password field is empty and the token expired',
    'Change the build command to `npm run build` in vercel.json',
    'C:\\Users\\Public\\Documents is read-only',
  ];

  it.each(untouched)('leaves useful technical detail alone: %s', (input) => {
    expect(redactSensitive(input)).toEqual({ text: input, redactions: [] });
  });
});
