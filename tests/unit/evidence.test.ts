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
    // Casual, everyday confirmations.
    'this worked',
    'amazing that worked',
    'Amazing, that worked!!',
    'yes that did it',
    'That did it!',
    "That's done it, thank you",
    'it did work',
    'wow it actually works',
    'that helped!',
    'ok its fine now',
    'thats it',
    "we're all good",
    'all set, thanks',
    'no errors now',
    'The stain is completely gone',
    'the stain came right out',
    'The smell is finally gone',
    'build passes now',
    'Installed successfully this time',
    'didnt think it would but it works',
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
    'didnt work',
    'the stain is still there',
    "It didn't come out",
    'No success',
    'Unsuccessful again',
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
    // Enthusiasm or thanks alone can come before trying the fix.
    'Amazing!',
    'perfect, thank you',
    'you are a lifesaver',
    // Partial results are not fixes.
    'That helped a bit',
    'The stain is a little lighter',
    'It works somewhat better',
    // Problem statements that look like success words.
    'It did it again this morning',
    'ok now it crashes on startup',
    'All my messages are gone',
    'Things were good before the update',
    'Did that do it?',
  ])('"%s" is not evidence either way', (text) => {
    expect(classifyUserEvidence(text)).toBe('unclear');
  });
});
