import { describe, expect, it } from 'vitest';
import {
  candidateEnvironment,
  DEFAULT_RANKING_OPTIONS,
  environmentMatch,
  normalizeEnvironment,
  scoreCandidate,
  wilsonLowerBound,
  type RankableCandidate,
  type RankingQuery,
} from '@firefinder/core';

const now = new Date('2026-09-25T12:00:00Z');
const options = { ...DEFAULT_RANKING_OPTIONS, now };

function candidate(overrides: Partial<RankableCandidate> = {}): RankableCandidate {
  return {
    similarity: 0.92,
    error_overlap: 0,
    confirmation_count: 0,
    failure_count: 0,
    status: 'active',
    created_at: '2026-09-01T00:00:00Z',
    last_confirmed_at: null,
    software_key: null,
    os_family: null,
    os_version: null,
    software_version: null,
    version_major: null,
    ...overrides,
  };
}

function query(fields: Parameters<typeof normalizeEnvironment>[0] = {}, errorSignature: string[] = []): RankingQuery {
  return { environment: normalizeEnvironment(fields), errorSignature };
}

const score = (q: RankingQuery, c: RankableCandidate) => scoreCandidate(q, c, candidateEnvironment(c), options).score;

describe('wilsonLowerBound', () => {
  it('is 0 without votes and grows with evidence', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(1, 1)).toBeLessThan(wilsonLowerBound(5, 5));
    expect(wilsonLowerBound(5, 5)).toBeLessThan(wilsonLowerBound(100, 100));
  });

  it('never exceeds 1, so popularity saturates', () => {
    expect(wilsonLowerBound(1_000_000, 1_000_000)).toBeLessThanOrEqual(1);
  });

  it('penalises failure-heavy solutions', () => {
    expect(wilsonLowerBound(127, 131)).toBeGreaterThan(wilsonLowerBound(5, 25));
  });
});

describe('scoreCandidate', () => {
  it('ranks more confirmations higher when everything else is equal', () => {
    const q = query();
    expect(score(q, candidate({ confirmation_count: 50 }))).toBeGreaterThan(score(q, candidate({ confirmation_count: 2 })));
    expect(score(q, candidate({ confirmation_count: 1 }))).toBeGreaterThan(score(q, candidate({ confirmation_count: 0 })));
  });

  it('puts a relevant Windows 11 fix above a hugely popular Windows 10 fix for a Windows 11 user', () => {
    const q = query({ operating_system: 'Windows 11' });
    const win11 = candidate({ os_family: 'windows', os_version: '11', confirmation_count: 2 });
    const win10 = candidate({ os_family: 'windows', os_version: '10', confirmation_count: 1000 });
    expect(score(q, win11)).toBeGreaterThan(score(q, win10));
  });

  it('prefers a clearly more relevant solution over a more popular one', () => {
    const q = query();
    const relevant = candidate({ similarity: 0.95, confirmation_count: 1 });
    const popular = candidate({ similarity: 0.85, confirmation_count: 1000 });
    expect(score(q, relevant)).toBeGreaterThan(score(q, popular));
  });

  it('lowers solutions that keep failing', () => {
    const q = query();
    const reliable = candidate({ confirmation_count: 3 });
    const failing = candidate({ confirmation_count: 5, failure_count: 20 });
    expect(score(q, reliable)).toBeGreaterThan(score(q, failing));
  });

  it('uses recency only as a light tie-breaker', () => {
    const q = query();
    const recent = candidate({ confirmation_count: 10, last_confirmed_at: '2026-09-24T00:00:00Z' });
    const stale = candidate({ confirmation_count: 10, last_confirmed_at: '2023-01-01T00:00:00Z' });
    expect(score(q, recent)).toBeGreaterThan(score(q, stale));
    expect(score(q, recent) - score(q, stale)).toBeLessThan(0.06);
  });

  it('demotes solutions under moderation review', () => {
    const q = query();
    expect(score(q, candidate({ confirmation_count: 5, status: 'active' }))).toBeGreaterThan(
      score(q, candidate({ confirmation_count: 5, status: 'under_review' })),
    );
  });

  it('rewards an exact error-code match', () => {
    const q = query({}, ['err_ossl_evp_unsupported']);
    expect(score(q, candidate({ error_overlap: 1 }))).toBeGreaterThan(score(q, candidate({ error_overlap: 0 })));
  });

  it('exposes the breakdown used to compute the score', () => {
    const q = query({ software: 'Blender', operating_system: 'Windows 11' });
    const breakdown = scoreCandidate(
      q,
      candidate({ software_key: 'blender', os_family: 'windows', os_version: '11', confirmation_count: 4 }),
      candidateEnvironment(candidate({ software_key: 'blender', os_family: 'windows', os_version: '11' })),
      options,
    );
    expect(breakdown.environmentMatch).toEqual({ software: 'match', operating_system: 'match', software_version: 'unknown' });
    expect(breakdown.environment).toBe(1);
    expect(breakdown.verification).toBeGreaterThan(0);
  });
});

describe('environmentMatch', () => {
  const env = (fields: Parameters<typeof normalizeEnvironment>[0]) => normalizeEnvironment(fields);

  it('is neutral when the query specifies nothing', () => {
    expect(environmentMatch(env({}), env({ software: 'Blender', operating_system: 'macOS 14' })).score).toBe(0);
  });

  it('only scores the dimensions the query specified', () => {
    const result = environmentMatch(env({ operating_system: 'Windows 11' }), env({ operating_system: 'Windows 11', software: 'Photoshop' }));
    expect(result.score).toBe(1);
  });

  it('grades OS matches from exact to different family', () => {
    const levels = (os: string) => environmentMatch(env({ operating_system: 'Windows 11' }), env({ operating_system: os })).levels.operating_system;
    expect(levels('Windows 11')).toBe('match');
    expect(levels('Windows')).toBe('partial');
    expect(levels('Windows 10')).toBe('different_version');
    expect(levels('macOS 14')).toBe('mismatch');
  });

  it('flags software mismatches', () => {
    const result = environmentMatch(env({ software: 'Blender' }), env({ software: 'Photoshop' }));
    expect(result.levels.software).toBe('mismatch');
    expect(result.score).toBe(-1);
  });
});
