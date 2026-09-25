import { describe, expect, it } from 'vitest';
import {
  extractErrorSignature,
  hasConflictingDetails,
  normalizeEnvironment,
  normalizeSoftware,
  parseOperatingSystem,
  parseVersion,
} from '@firefinder/core';

describe('parseOperatingSystem', () => {
  it.each([
    ['Windows 11', { family: 'windows', version: '11' }],
    ['win10', { family: 'windows', version: '10' }],
    ['Windows 11 Pro 23H2', { family: 'windows', version: '11' }],
    ['Windows Server 2022', { family: 'windows', version: 'server 2022' }],
    ['Windows', { family: 'windows', version: null }],
    ['macOS Sonoma 14.2', { family: 'macos', version: '14' }],
    ['macOS Ventura', { family: 'macos', version: '13' }],
    ['Mac OS X 10.15.7', { family: 'macos', version: '10.15' }],
    ['MacBook Pro', { family: 'macos', version: null }],
    ['Ubuntu 22.04', { family: 'linux', version: 'ubuntu 22.04' }],
    ['Debian 12 bookworm', { family: 'linux', version: 'debian 12' }],
    ['Linux', { family: 'linux', version: null }],
    ['WSL2 on Windows 11', { family: 'linux', version: 'wsl 2' }],
    ['iOS 17', { family: 'ios', version: '17' }],
    ['Android 14', { family: 'android', version: '14' }],
  ])('%s', (input, expected) => {
    expect(parseOperatingSystem(input)).toEqual(expected);
  });

  it('does not mistake ordinary words for an OS', () => {
    expect(parseOperatingSystem('browser window')).toBeNull();
    expect(parseOperatingSystem('research machine')).toBeNull();
    expect(parseOperatingSystem('')).toBeNull();
  });
});

describe('normalizeSoftware', () => {
  it.each([
    ['Blender', 'blender', null],
    ['Blender 4.1', 'blender', '4.1'],
    ['VSCode', 'vs code', null],
    ['Visual Studio Code', 'vs code', null],
    ['NodeJS v20.11', 'node.js', '20.11'],
    ['Adobe Photoshop 2024', 'photoshop', '2024'],
    ['Windows 11', null, null],
    ['macOS', null, null],
  ])('%s -> %s', (input, key, version) => {
    expect(normalizeSoftware(input)).toEqual({ key, inferredVersion: version });
  });
});

describe('parseVersion', () => {
  it.each([
    ['4.1.0', { full: '4.1', major: '4' }],
    ['v18.17.0', { full: '18.17', major: '18' }],
    ['4.x', { full: '4', major: '4' }],
    ['2024', { full: '2024', major: '2024' }],
  ])('%s', (input, expected) => {
    expect(parseVersion(input)).toEqual(expected);
  });

  it('returns null without digits', () => {
    expect(parseVersion('latest')).toBeNull();
  });
});

describe('normalizeEnvironment', () => {
  it('uses the OS typed into the software field when no OS was given', () => {
    const env = normalizeEnvironment({ software: 'Windows 11' });
    expect(env).toEqual({ software_key: null, os: { family: 'windows', version: '11' }, version: null });
  });

  it('prefers an explicit software_version over one inferred from the name', () => {
    const env = normalizeEnvironment({ software: 'Blender 4.1', software_version: '4.2.1' });
    expect(env.version).toEqual({ full: '4.2.1', major: '4' });
  });
});

describe('extractErrorSignature', () => {
  it('extracts distinctive error identifiers', () => {
    const signature = extractErrorSignature(
      'Error: error:0308010C:digital envelope routines::unsupported ERR_OSSL_EVP_UNSUPPORTED',
      'TypeError: Cannot read properties of undefined; also saw ENOENT and 0x80070005, TS2345, SIGSEGV, HTTP 502, error code 43',
    );
    expect(signature).toEqual(
      expect.arrayContaining(['err_ossl_evp_unsupported', 'typeerror', 'enoent', '0x80070005', 'ts2345', 'sigsegv', 'http:502', 'code:43']),
    );
  });

  it('ignores ordinary capitalised words', () => {
    expect(extractErrorSignature('ERROR: EVERY Error happened on EXIT')).toEqual([]);
  });
});

describe('hasConflictingDetails', () => {
  it('detects opposite actions', () => {
    expect(hasConflictingDetails('Enable hardware acceleration', 'Disable hardware acceleration')).toBe(true);
    expect(hasConflictingDetails('Uninstalling the driver fixed it', 'Install the driver')).toBe(true);
  });

  it('detects different versions', () => {
    expect(hasConflictingDetails('Downgrade Node to 16.20', 'Downgrade Node to 18.19')).toBe(true);
  });

  it('accepts rewordings of the same fix', () => {
    expect(hasConflictingDetails('Restart the Bluetooth service.', 'Restart the Bluetooth Support Service.')).toBe(false);
    expect(hasConflictingDetails('Use Node 18.19', 'Switch to Node 18.19 with nvm')).toBe(false);
  });
});
