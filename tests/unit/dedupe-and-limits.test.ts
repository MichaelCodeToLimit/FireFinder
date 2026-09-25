import { describe, expect, it } from 'vitest';
import {
  environmentsCompatible,
  extractApiKey,
  findDuplicate,
  generateApiKey,
  MemoryRateLimiter,
  normalizeEnvironment,
  uuidv7,
  type DuplicateCandidate,
} from '@firefinder/core';

function candidate(overrides: Partial<DuplicateCandidate> = {}): DuplicateCandidate {
  return {
    id: 'existing',
    solution: 'Restart the Bluetooth service.',
    similarity: 0.95,
    solution_similarity: 0.98,
    error_overlap: 0,
    confirmation_count: 3,
    failure_count: 0,
    status: 'active',
    created_at: '2026-09-01T00:00:00Z',
    last_confirmed_at: null,
    software_key: null,
    os_family: 'windows',
    os_version: '11',
    software_version: null,
    version_major: null,
    ...overrides,
  };
}

const win11 = normalizeEnvironment({ operating_system: 'Windows 11' });

describe('findDuplicate', () => {
  it('matches the same fix for the same problem and environment', () => {
    const match = findDuplicate({ solution: 'Restart the Bluetooth Support Service.', environment: win11 }, [candidate()]);
    expect(match?.id).toBe('existing');
  });

  it('keeps fixes for different OS versions separate', () => {
    const win10 = normalizeEnvironment({ operating_system: 'Windows 10' });
    expect(findDuplicate({ solution: 'Restart the Bluetooth service.', environment: win10 }, [candidate()])).toBeNull();
  });

  it('keeps different fixes for the same problem separate', () => {
    const different = candidate({ solution_similarity: 0.78 });
    expect(findDuplicate({ solution: 'Update the graphics driver.', environment: win11 }, [different])).toBeNull();
  });

  it('keeps opposite fixes separate even when they read alike', () => {
    const enable = candidate({ solution: 'Enable Fast Startup in Power Options.', solution_similarity: 0.97 });
    expect(findDuplicate({ solution: 'Disable Fast Startup in Power Options.', environment: win11 }, [enable])).toBeNull();
  });

  it('requires the problems themselves to be near-identical', () => {
    expect(findDuplicate({ solution: 'Restart the Bluetooth service.', environment: win11 }, [candidate({ similarity: 0.86 })])).toBeNull();
  });

  it('treats an unspecified environment as compatible', () => {
    expect(environmentsCompatible(normalizeEnvironment({}), win11)).toBe(true);
  });
});

describe('MemoryRateLimiter', () => {
  const one = async (limiter: MemoryRateLimiter, key: string, limit: number) => (await limiter.hit([{ key, limit }], 60))[0]!;

  it('allows up to the limit per window, then blocks until the window resets', async () => {
    let now = 60_000 * 1000;
    const limiter = new MemoryRateLimiter({ now: () => now });
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await one(limiter, 'client', 3));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results[3]!.remaining).toBe(0);
    expect(results[0]!.resetSeconds).toBe(60);

    now += 60_000;
    expect((await one(limiter, 'client', 3)).allowed).toBe(true);
  });

  it('tracks keys independently', async () => {
    const limiter = new MemoryRateLimiter();
    await one(limiter, 'a', 1);
    expect((await one(limiter, 'a', 1)).allowed).toBe(false);
    expect((await one(limiter, 'b', 1)).allowed).toBe(true);
  });

  it('checks several keys in one call, each with its own limit', async () => {
    const limiter = new MemoryRateLimiter();
    const checks = [{ key: 'client', limit: 1 }, { key: 'ip', limit: 5 }];
    await limiter.hit(checks, 60);
    const [client, ip] = await limiter.hit(checks, 60);
    expect(client).toMatchObject({ allowed: false, remaining: 0 });
    expect(ip).toMatchObject({ allowed: true, remaining: 3 });
  });

  it('bounds memory use', async () => {
    const limiter = new MemoryRateLimiter({ maxKeys: 10 });
    for (let i = 0; i < 100; i++) await one(limiter, `k${i}`, 5);
    expect((await one(limiter, 'fresh', 1)).allowed).toBe(true);
  });
});

describe('API keys and ids', () => {
  it('generates ff_ keys with a displayable prefix', () => {
    const { key, prefix } = generateApiKey();
    expect(key).toMatch(/^ff_[A-Za-z0-9]{40}$/);
    expect(key.startsWith(prefix)).toBe(true);
    expect(generateApiKey().key).not.toBe(key);
  });

  it('reads keys from Authorization or X-API-Key', () => {
    expect(extractApiKey({ authorization: 'Bearer ff_abc' })).toBe('ff_abc');
    expect(extractApiKey({ apiKey: ' ff_xyz ' })).toBe('ff_xyz');
    expect(extractApiKey({ authorization: 'Basic abc' })).toBeNull();
    expect(extractApiKey({})).toBeNull();
  });

  it('generates time-ordered UUIDv7 ids', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});

describe('parseTextArray', () => {
  it('parses Postgres text[] literals, including quoted and escaped elements', async () => {
    const { parseTextArray } = await import('@firefinder/core');
    expect(parseTextArray('{}')).toEqual([]);
    expect(parseTextArray('{read,write}')).toEqual(['read', 'write']);
    expect(parseTextArray('{err_ossl,code:43,http:502}')).toEqual(['err_ossl', 'code:43', 'http:502']);
    expect(parseTextArray('{"a b","c,d","e\\"f",g}')).toEqual(['a b', 'c,d', 'e"f', 'g']);
    expect(parseTextArray('not an array')).toEqual([]);
  });
});
