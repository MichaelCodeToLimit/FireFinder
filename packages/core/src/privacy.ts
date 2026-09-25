/**
 * Privacy filtering.
 *
 * FireFinder stores generalized problem/solution text only. Integrations are
 * instructed to strip personal details, but this module is the safety net:
 * every text field is sanitized and scanned for secrets and personal data
 * before it is stored, and matches are replaced with placeholders such as
 * `[REDACTED_EMAIL]`.
 */

export interface SanitizeOptions {
  /** Keep line breaks and indentation (problem/solution bodies). */
  multiline: boolean;
}

// Zero-width characters, word joiner, BOM, soft hyphen.
const INVISIBLE = /[​-‍⁠﻿­]/g;
// Bidirectional overrides/isolates ("Trojan Source").
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;
// C0/C1 control characters except tab (\t) and newline (\n).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

export function sanitizeText(input: string, options: SanitizeOptions): string {
  const text = input
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE, '')
    .replace(BIDI_CONTROLS, '')
    .replace(CONTROL, '');

  if (!options.multiline) return text.replace(/\s+/g, ' ').trim();

  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type RedactionKind =
  | 'private_key'
  | 'url_credentials'
  | 'token'
  | 'api_key'
  | 'secret'
  | 'email'
  | 'card_number'
  | 'ssn'
  | 'phone'
  | 'ip_address'
  | 'username_in_path';

export interface RedactionResult {
  text: string;
  /** Unique kinds of data that were removed, in detection order. */
  redactions: RedactionKind[];
}

type Replacer = (match: string, ...args: any[]) => string | null;

interface Rule {
  kind: RedactionKind;
  pattern: RegExp;
  /** Returns the replacement, or null to leave the match untouched. */
  replace: Replacer;
}

const constant =
  (value: string): Replacer =>
  () =>
    value;

const API_KEY_PATTERN = new RegExp(
  [
    String.raw`\bsk-ant-[A-Za-z0-9_-]{20,}`,
    String.raw`\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}`,
    String.raw`\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}`,
    String.raw`\bgithub_pat_[A-Za-z0-9_]{30,}`,
    String.raw`\bglpat-[A-Za-z0-9_-]{20,}`,
    String.raw`\bxox[abposr]-[A-Za-z0-9-]{10,}`,
    String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`,
    String.raw`\bAIza[0-9A-Za-z_-]{35}`,
    String.raw`\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}`,
    String.raw`\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{16,}`,
    String.raw`\bnpm_[A-Za-z0-9]{36}\b`,
    String.raw`\bhf_[A-Za-z0-9]{30,}`,
    String.raw`\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}`,
    String.raw`\bff_[A-Za-z0-9]{20,}`,
  ].join('|'),
  'g',
);

const SECRET_WORDS = String.raw`(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|credentials?)`;

const PATH_PLACEHOLDERS = new Set([
  '<user>',
  'user',
  'username',
  'your_user',
  'yourusername',
  'yourname',
  '%username%',
  '$user',
  '{user}',
  '{username}',
  'public',
  'default',
  'shared',
  'all users',
]);

const redactUsername: Replacer = (_match, prefix: string, name: string) =>
  PATH_PLACEHOLDERS.has(name.toLowerCase()) ? null : `${prefix}<user>`;

const RULES: Rule[] = [
  {
    kind: 'private_key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    replace: constant('[REDACTED_PRIVATE_KEY]'),
  },
  {
    kind: 'url_credentials',
    pattern: /\b([a-z][a-z0-9+.-]{1,20}:\/\/)([^\s:@/]+):([^\s@/]+)@/gi,
    replace: (_m, scheme: string) => `${scheme}[REDACTED]@`,
  },
  {
    kind: 'token',
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
    replace: constant('[REDACTED_TOKEN]'),
  },
  { kind: 'api_key', pattern: API_KEY_PATTERN, replace: constant('[REDACTED_API_KEY]') },
  {
    kind: 'token',
    pattern: /\b(Bearer|Basic|Token)\s+(?!\[REDACTED)[A-Za-z0-9._~+/=-]{12,}/g,
    replace: (_m, scheme: string) => `${scheme} [REDACTED]`,
  },
  {
    // PASSWORD=hunter2, "api_key": "abc123", client-secret: xyz
    kind: 'secret',
    pattern: new RegExp(
      String.raw`\b([A-Za-z0-9_-]*?${SECRET_WORDS})(["']?\s*[:=]\s*)(["']?)(?!\[REDACTED)([^\s"'\`,;]{3,})`,
      'gi',
    ),
    replace: (_m, key: string, separator: string, quote: string) => `${key}${separator}${quote}[REDACTED]`,
  },
  {
    // --password hunter2, -token=abc
    kind: 'secret',
    pattern: /(--?(?:password|passwd|token|secret|api-key|apikey)[=\s]+)(?!\[REDACTED)([^\s"']+)/gi,
    replace: (_m, flag: string) => `${flag}[REDACTED]`,
  },
  {
    kind: 'email',
    pattern: /\b([A-Za-z0-9._%+-]+)@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    // git@github.com:org/repo is an SSH remote, not a person.
    replace: (_m, local: string) => (local.toLowerCase() === 'git' ? null : '[REDACTED_EMAIL]'),
  },
  {
    kind: 'card_number',
    // Not part of a longer dashed identifier such as a GUID.
    pattern: /(?<![\w-])\d(?:[ -]?\d){12,18}(?![\w-])/g,
    replace: (match) => (looksLikeCardNumber(match) ? '[REDACTED_CARD]' : null),
  },
  { kind: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replace: constant('[REDACTED_SSN]') },
  {
    kind: 'phone',
    pattern: /(?<![\w.])(?:\+\d{1,3}(?:[\s-]\d{2,5}){2,4}|(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})(?![\w.])/g,
    replace: constant('[REDACTED_PHONE]'),
  },
  {
    kind: 'ip_address',
    pattern: /(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w.])/g,
    replace: (match, a: string, b: string, c: string, d: string, offset: number, whole: string) => {
      const octets = [a, b, c, d].map(Number);
      if (octets.some((octet) => octet > 255)) return null;
      // "Version=1.0.0.0" / "v2.0.1.5" are versions, not addresses.
      if (/(?:version\s*[=:]?\s*|\bv)$/i.test(whole.slice(Math.max(0, offset - 10), offset))) return null;
      return isPrivateIPv4(octets) ? null : '[REDACTED_IP]';
    },
  },
  {
    kind: 'username_in_path',
    pattern: /([A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+)([^\\/\s"':*?<>|]+)/gi,
    replace: redactUsername,
  },
  { kind: 'username_in_path', pattern: /(\/Users\/)([^/\s"']+)/g, replace: redactUsername },
  { kind: 'username_in_path', pattern: /(\/home\/)([^/\s"']+)/g, replace: redactUsername },
  {
    // Long high-entropy strings that no specific rule caught.
    kind: 'secret',
    pattern: /(?<![A-Za-z0-9_+=-])[A-Za-z0-9_+=-]{32,}(?![A-Za-z0-9_+=-])/g,
    replace: (match) => (looksLikeSecret(match) ? '[REDACTED_SECRET]' : null),
  },
];

export function redactSensitive(input: string): RedactionResult {
  const found = new Set<RedactionKind>();
  let text = input;
  for (const rule of RULES) {
    text = text.replace(rule.pattern, (...args) => {
      const match = args[0] as string;
      const replacement = rule.replace(...(args as [string, ...unknown[]]));
      if (replacement === null || replacement === match) return match;
      found.add(rule.kind);
      return replacement;
    });
  }
  return { text, redactions: [...found] };
}

function looksLikeCardNumber(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '');
  // Card numbers never start with 0; runs like 0000... are ids or padding.
  if (digits.startsWith('0') || /^(\d)\1+$/.test(digits)) return false;
  const hasSeparators = digits.length !== candidate.length;
  if (!hasSeparators && (digits.length < 15 || digits.length > 16)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

function isPrivateIPv4([a = 0, b = 0]: number[]): boolean {
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeSecret(candidate: string): boolean {
  if (UUID.test(candidate)) return false;
  if (!/\d/.test(candidate) || !/[A-Za-z]/.test(candidate)) return false;
  return shannonEntropy(candidate) >= 3.5;
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
