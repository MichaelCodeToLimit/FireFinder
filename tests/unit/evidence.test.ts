import { describe, expect, it } from 'vitest';
import { classifyUserEvidence } from '@firefinder/core';

describe('classifyUserEvidence', () => {
  it.each([
    'That worked.',
    'Fixed it.',
    "Yep, that's the problem.",
    'That solved it.',
    "It's working now.",
    'That did the trick, thanks!',
    'Awesome, all good now',
    'Bluetooth is back!',
    'It builds now',
    'No more errors 🎉',
    'Perfect, it works',
    'Yes that was it',
    'Error is gone',
  ])('"%s" is confirmation', (text) => {
    expect(classifyUserEvidence(text)).toBe('worked');
  });

  it.each([
    "That didn't work.",
    'Still broken.',
    "No, I'm still getting the error.",
    "That didn't fix it.",
    'Same error as before',
    "It's still crashing",
    'Not working',
    "Doesn't help",
    'Nope',
    'No luck',
    'Now it is worse',
    'Nothing changed',
  ])('"%s" is failure', (text) => {
    expect(classifyUserEvidence(text)).toBe('failed');
  });

  it.each([
    'Thanks',
    "I'll try that",
    'Let me test it and see if it works',
    'That should work',
    'Did that fix it?',
    'It worked but now I am still getting a different error',
    'ok',
    '',
    'I restarted the computer',
  ])('"%s" is not evidence either way', (text) => {
    expect(classifyUserEvidence(text)).toBe('unclear');
  });
});
