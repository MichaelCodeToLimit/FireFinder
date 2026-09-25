/**
 * Metadata normalization: turns free-form software / OS / version / error text
 * into comparable keys used for ranking and duplicate detection.
 */

// ---------------------------------------------------------------------------
// Operating systems
// ---------------------------------------------------------------------------

export interface OperatingSystemInfo {
  /** windows | macos | linux | ios | android | chromeos | bsd */
  family: string;
  /** Normalized version ("11", "14", "10.15", "ubuntu 22.04", "server 2022"), or null if unspecified. */
  version: string | null;
}

const MAC_CODENAMES: Record<string, string> = {
  tahoe: '26',
  sequoia: '15',
  sonoma: '14',
  ventura: '13',
  monterey: '12',
  'big sur': '11',
  catalina: '10.15',
  mojave: '10.14',
  'high sierra': '10.13',
};

const LINUX_DISTROS = [
  'ubuntu',
  'debian',
  'fedora',
  'arch',
  'manjaro',
  'mint',
  'centos',
  'rhel',
  'red hat',
  'rocky',
  'alma',
  'opensuse',
  'suse',
  'pop!_os',
  'pop os',
  'alpine',
  'kali',
  'nixos',
  'gentoo',
  'raspbian',
  'elementary',
  'zorin',
  'wsl',
] as const;

export function parseOperatingSystem(value?: string | null): OperatingSystemInfo | null {
  if (!value) return null;
  const text = value.toLowerCase();

  const windows = text.match(/\b(?:microsoft\s+)?(?:windows|win)[\s-]*(server[\s-]*)?(11|10|8\.1|8|7|xp|vista|20\d\d)?(?![a-z0-9])/);
  if (windows && !/\bwsl\d?\b/.test(text)) {
    const version = windows[2] ? (windows[1] ? `server ${windows[2]}` : windows[2]) : windows[1] ? 'server' : null;
    return { family: 'windows', version };
  }

  const codename = Object.keys(MAC_CODENAMES).find((name) => text.includes(name));
  const mac = text.match(/\b(?:macos|mac\s*os(?:\s*x)?|osx|os\s*x|macbook|mac)\b[\s-]*(\d{1,2}(?:\.\d{1,2})?)?/);
  if (mac || (codename && /\bmac|\bos\s*x|\bmacos/.test(text))) {
    const version = mac?.[1] ? normalizeMacVersion(mac[1]) : codename ? (MAC_CODENAMES[codename] ?? null) : null;
    return { family: 'macos', version };
  }

  const ios = text.match(/\b(?:ipados|ios|iphone|ipad)\b[\s-]*(\d{1,2})?/);
  if (ios) return { family: 'ios', version: ios[1] ?? null };

  const android = text.match(/\bandroid\b[\s-]*(\d{1,2})?/);
  if (android) return { family: 'android', version: android[1] ?? null };

  if (/\bchrome\s*os\b|\bchromeos\b|\bchromebook\b/.test(text)) return { family: 'chromeos', version: null };
  if (/\bfreebsd\b|\bopenbsd\b/.test(text)) return { family: 'bsd', version: null };

  const distro = LINUX_DISTROS.find((name) => new RegExp(`(^|[^a-z])${escapeRegExp(name)}([^a-z]|$)`).test(text));
  if (distro) {
    const number = text.match(new RegExp(`${escapeRegExp(distro)}[\\s-]*(\\d{1,2}(?:\\.\\d{1,2})?)\\b`))?.[1];
    const name = distro === 'red hat' ? 'rhel' : distro === 'pop os' ? 'pop!_os' : distro;
    return { family: 'linux', version: number ? `${name} ${number}` : name };
  }
  if (/\blinux\b/.test(text)) return { family: 'linux', version: null };

  return null;
}

function normalizeMacVersion(version: string): string {
  const [major, minor] = version.split('.');
  return major === '10' && minor ? `10.${minor}` : major!;
}

// ---------------------------------------------------------------------------
// Software
// ---------------------------------------------------------------------------

const SOFTWARE_ALIASES: Record<string, string> = {
  vscode: 'vs code',
  'visual studio code': 'vs code',
  'microsoft visual studio code': 'vs code',
  node: 'node.js',
  nodejs: 'node.js',
  nextjs: 'next.js',
  reactjs: 'react',
  'react.js': 'react',
  vuejs: 'vue',
  'vue.js': 'vue',
  postgres: 'postgresql',
  psql: 'postgresql',
  'google chrome': 'chrome',
  'mozilla firefox': 'firefox',
  'microsoft edge': 'edge',
  'microsoft word': 'word',
  'ms word': 'word',
  'microsoft excel': 'excel',
  'ms excel': 'excel',
  'microsoft outlook': 'outlook',
  'microsoft teams': 'teams',
  'ms teams': 'teams',
  'adobe photoshop': 'photoshop',
  'adobe premiere pro': 'premiere pro',
  'adobe illustrator': 'illustrator',
  python3: 'python',
  golang: 'go',
  k8s: 'kubernetes',
  'docker desktop': 'docker',
  'apple music': 'apple music',
};

/** Names that describe an operating system rather than an application. */
const OS_AS_SOFTWARE = /^(?:windows|win(?:dows)?\s*\d+|macos|mac\s*os(?:\s*x)?|osx|linux|ubuntu|debian|fedora|ios|ipados|android|chromeos)$/;

export interface SoftwareInfo {
  /** Normalized comparable name, or null when the value is empty or names an OS. */
  key: string | null;
  /** Version found inside the software string ("Blender 4.1" -> "4.1"). */
  inferredVersion: string | null;
}

export function normalizeSoftware(value?: string | null): SoftwareInfo {
  if (!value) return { key: null, inferredVersion: null };
  let text = value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').trim();
  let inferredVersion: string | null = null;

  const trailingVersion = text.match(/^(.*?)[\s-]+v?(\d+(?:\.(?:\d+|x))*)$/);
  if (trailingVersion?.[1] && /[a-z]/.test(trailingVersion[1])) {
    text = trailingVersion[1];
    inferredVersion = trailingVersion[2]!;
  }
  text = text.replace(/\s+/g, ' ').replace(/[\s,;:]+$/, '');
  if (!text || OS_AS_SOFTWARE.test(text)) return { key: null, inferredVersion: null };
  return { key: SOFTWARE_ALIASES[text] ?? text, inferredVersion };
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export interface VersionInfo {
  /** Normalized full version without trailing ".0" parts ("4.1.0" -> "4.1"). */
  full: string;
  major: string;
}

export function parseVersion(value?: string | null): VersionInfo | null {
  if (!value) return null;
  const match = value.match(/\d+(?:\.\d+)*/);
  if (!match) return null;
  const parts = match[0].split('.');
  while (parts.length > 1 && /^0+$/.test(parts[parts.length - 1]!)) parts.pop();
  return { full: parts.join('.'), major: String(Number(parts[0])) };
}

// ---------------------------------------------------------------------------
// Environment bundle
// ---------------------------------------------------------------------------

export interface NormalizedEnvironment {
  software_key: string | null;
  os: OperatingSystemInfo | null;
  version: VersionInfo | null;
}

export function normalizeEnvironment(fields: {
  software?: string | null;
  operating_system?: string | null;
  software_version?: string | null;
}): NormalizedEnvironment {
  const software = normalizeSoftware(fields.software);
  return {
    software_key: software.key,
    // "Windows 11" typed into the software field still tells us the OS.
    os: parseOperatingSystem(fields.operating_system) ?? (software.key ? null : parseOperatingSystem(fields.software)),
    version: parseVersion(fields.software_version ?? software.inferredVersion),
  };
}

// ---------------------------------------------------------------------------
// Error signatures
// ---------------------------------------------------------------------------

const ERRNO_NAMES = new Set(
  'ENOENT EACCES EPERM EEXIST ENOTDIR EISDIR EINVAL EMFILE ENFILE ENOSPC EROFS EPIPE EAGAIN EBUSY ECONNREFUSED ECONNRESET ECONNABORTED ETIMEDOUT EADDRINUSE EADDRNOTAVAIL EHOSTUNREACH ENETUNREACH ENOTFOUND ENOTEMPTY ELOOP ENAMETOOLONG ENOMEM ENOTSUP ESRCH EINTR EIO EXDEV ENOTCONN ECANCELED EPROTO ERANGE EDQUOT ENOEXEC EFBIG ESPIPE E2BIG EINTEGRITY ELIFECYCLE ERESOLVE'.split(
    ' ',
  ),
);

const SIGNATURE_PATTERNS: Array<{ pattern: RegExp; token: (match: RegExpExecArray) => string | null }> = [
  // Hex error codes: 0x80070005, 0xc000007b
  { pattern: /\b0x[0-9a-f]{4,16}\b/gi, token: (m) => m[0] },
  // SCREAMING_SNAKE identifiers: ERR_OSSL_EVP_UNSUPPORTED, DRIVER_IRQL_NOT_LESS_OR_EQUAL
  { pattern: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, token: (m) => (m[0].length >= 6 ? m[0] : null) },
  // POSIX / npm error names: ENOENT, EADDRINUSE, ERESOLVE
  { pattern: /\bE[A-Z0-9]{2,12}\b/g, token: (m) => (ERRNO_NAMES.has(m[0]) ? m[0] : null) },
  // Exception class names: TypeError, ModuleNotFoundError, NullPointerException
  { pattern: /\b[A-Z][A-Za-z0-9]*(?:Error|Exception|Fault|Panic)\b/g, token: (m) => m[0] },
  // Compiler / product codes: TS2345, CS0246, LNK2019, ORA-00942, KB5034441
  { pattern: /\b[A-Z]{1,4}-?\d{3,6}\b/g, token: (m) => m[0] },
  // Signals: SIGSEGV, SIGKILL
  { pattern: /\bSIG[A-Z]{3,6}\b/g, token: (m) => m[0] },
  // "error code 43", "Error: -1073741819"
  { pattern: /\berror\s*(?:code)?\s*[:#]?\s*(-?\d{2,10})\b/gi, token: (m) => `code:${m[1]}` },
  // "HTTP 502", "status code 404"
  { pattern: /\b(?:http|status(?:\s*code)?)\s*[:#]?\s*([45]\d\d)\b/gi, token: (m) => `http:${m[1]}` },
];

const MAX_SIGNATURE_TOKENS = 12;

/** Extracts distinctive error identifiers used for exact matching. */
export function extractErrorSignature(...texts: Array<string | null | undefined>): string[] {
  const tokens = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const { pattern, token } of SIGNATURE_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const value = token(match)?.toLowerCase();
        if (value && /^[a-z0-9_.:-]{2,64}$/.test(value)) tokens.add(value);
        if (tokens.size >= MAX_SIGNATURE_TOKENS) return [...tokens];
      }
    }
  }
  return [...tokens];
}

// ---------------------------------------------------------------------------
// Text comparison helpers (duplicate detection)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  'a an and are as at be by for from if in into is it its my of on or so that the then this to try your you'.split(' '),
);

/** Lowercase, accent-free, punctuation-free text for comparisons. */
export function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
    .split(' ')
    .filter((word) => word && !STOPWORDS.has(word))
    .join(' ');
}

export function stem(word: string): string {
  return word.length > 4 ? word.replace(/(?:ing|ed|es|e|s)$/, '') : word;
}

export function wordSet(text: string): Set<string> {
  return new Set(normalizeForComparison(text).split(' ').filter(Boolean).map(stem));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

const OPPOSITES: Array<[string, string]> = [
  ['enable', 'disable'],
  ['install', 'uninstall'],
  ['upgrade', 'downgrade'],
  ['add', 'remove'],
  ['increase', 'decrease'],
  ['allow', 'block'],
  ['allow', 'deny'],
  ['show', 'hide'],
  ['mount', 'unmount'],
  ['on', 'off'],
  ['start', 'stop'],
  ['connect', 'disconnect'],
].map(([a, b]) => [stem(a!), stem(b!)] as [string, string]);

/**
 * True when two otherwise-similar solutions differ in a way that matters:
 * opposite actions ("enable" vs "disable") or different version numbers
 * ("downgrade to 16" vs "upgrade to 18").
 */
export function hasConflictingDetails(a: string, b: string): boolean {
  const wordsA = wordSet(a);
  const wordsB = wordSet(b);
  for (const [x, y] of OPPOSITES) {
    const aOnlyX = wordsA.has(x) && !wordsA.has(y);
    const aOnlyY = wordsA.has(y) && !wordsA.has(x);
    const bOnlyX = wordsB.has(x) && !wordsB.has(y);
    const bOnlyY = wordsB.has(y) && !wordsB.has(x);
    if ((aOnlyX && bOnlyY) || (aOnlyY && bOnlyX)) return true;
  }
  const numbersA = versionNumbers(a);
  const numbersB = versionNumbers(b);
  if (numbersA.size > 0 && numbersB.size > 0) {
    if (numbersA.size !== numbersB.size) return true;
    for (const n of numbersA) if (!numbersB.has(n)) return true;
  }
  return false;
}

function versionNumbers(text: string): Set<string> {
  return new Set(text.match(/\b\d+(?:\.\d+)+\b|\b\d{2,}\b/g) ?? []);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
