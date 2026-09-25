/**
 * Conversational evidence of an outcome.
 *
 * FireFinder records "it worked" / "it didn't work" automatically, but only
 * when the user's own words say so. The integration passes those words; this
 * classifier decides whether they are clear enough. Anything ambiguous
 * ("thanks", "I'll try that", mixed signals, a question) is `unclear` and
 * nothing is recorded: silence, politeness and the assistant's own
 * confidence are never confirmation.
 */
export type EvidenceVerdict = 'worked' | 'failed' | 'unclear';

const FAILED: RegExp[] = [
  /\b(?:did|does|do|is|was|has|have|will|can)\s+not\s+(?:really\s+)?(?:work|fix|help|solve|change|resolve|do anything)\w*/,
  /\bnot\s+(?:working|fixed|solved|resolved|helping|better)\b/,
  /\bstill\s+(?:broken|failing|fails|crash\w*|getting|get|seeing|see|happening|happens|the same|not|there|erroring|throwing|stuck|down|hangs?|freez\w*|showing|shows|missing|have|has)\b/,
  /\b(?:error|problem|issue|crash|it)\s+(?:is\s+)?still\s+(?:there|happening|here)\b/,
  /\bsame\s+(?:error|problem|issue|result|thing|crash|message)\b/,
  /\b(?:no|zero)\s+(?:luck|change|difference|dice)\b/,
  /\bnope\b/,
  /\b(?:made it|it's|it is|now it's)\s+worse\b/,
  /\bnothing\s+(?:changed|happened|works?|helped)\b/,
];

const UNCERTAIN: RegExp[] = [
  /\b(?:i'll|i will|let me|going to|gonna|i'm going to|will)\s+(?:try|test|check|see|give it a (?:try|go|shot))\b/,
  /\b(?:if|whether)\s+(?:it|that|this)\s+(?:works|worked|fixes|fixed|helps)\b/,
  /\b(?:should|might|may|could|would)\s+(?:work|fix|help)\b/,
  /\?\s*$/,
];

const WORKED: RegExp[] = [
  /\b(?:worked|works|working)\b/,
  /\b(?:fixed|solved|resolved|sorted)\b/,
  /\bdid the trick\b/,
  /\bthat(?:'s| is| was)\s+(?:it|the (?:problem|issue|fix|cause|culprit|one))\b/,
  /\ball good\b/,
  /\bgood now\b/,
  /\bback to normal\b/,
  /\bup and running\b/,
  /\b(?:is|are|it's)\s+back\b/,
  /\bno more (?:errors?|crash(?:es)?|problems?|issues?|warnings?)\b/,
  /\b(?:error|problem|issue|crash|warning)s?\s+(?:is|are)\s+gone\b/,
  /\bgone now\b/,
  /\bnailed it\b/,
  /\b(?:builds|runs|starts|loads|opens|connects|compiles|deploys|installs|boots|launches|syncs|prints)\s+(?:now|fine|again|correctly|properly|perfectly)\b/,
];

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\bwon't\b/g, 'will not')
    .replace(/\bcan't\b/g, 'can not')
    .replace(/n't\b/g, ' not')
    .replace(/\s+/g, ' ')
    .trim();
}

export function classifyUserEvidence(text: string): EvidenceVerdict {
  let remaining = normalize(text);
  if (!remaining) return 'unclear';
  if (UNCERTAIN.some((pattern) => pattern.test(remaining))) return 'unclear';

  let failed = false;
  for (const pattern of FAILED) {
    const global = new RegExp(pattern.source, 'g');
    if (global.test(remaining)) {
      failed = true;
      // Remove failure phrases so "not working" can't also count as "working".
      remaining = remaining.replace(global, ' ');
    }
  }
  const worked = WORKED.some((pattern) => pattern.test(remaining));

  if (failed && worked) return 'unclear';
  if (failed) return 'failed';
  if (worked) return 'worked';
  return 'unclear';
}
