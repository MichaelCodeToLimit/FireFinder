/**
 * Conversational evidence of an outcome.
 *
 * FireFinder records "it worked" / "it didn't work" automatically, but only
 * when the user's own words say so. The integration passes those words; this
 * classifier decides whether they are clear enough. People confirm casually
 * ("amazing, that worked!", "that did it", "the stain is gone"), so everyday
 * phrasings count. Anything ambiguous ("thanks", "I'll try that", "perfect!"
 * on its own, a partial result, mixed signals, a question) is `unclear` and
 * nothing is recorded: silence, politeness and the assistant's own confidence
 * are never confirmation.
 */
export type EvidenceVerdict = 'worked' | 'failed' | 'unclear';

/** Things whose disappearance means the problem is solved ("the stain is gone"). */
const SYMPTOM = String.raw`(?:error|warning|problem|issue|crash|bug|glitch|pop-?up|stain|mark|spot|smell|odou?r|noise|leak)s?`;

const FAILED: RegExp[] = [
  /\b(?:did|does|do|is|was|has|have|will|can)\s+not\s+(?:really\s+)?(?:work|fix|help|solve|change|resolve|do anything|come out|come off)\w*/,
  /\bnot\s+(?:working|fixed|solved|resolved|helping|better|gone)\b/,
  /\bstill\s+(?:broken|failing|fails|crash\w*|getting|get|seeing|see|happening|happens|the same|not|there|here|visible|erroring|throwing|stuck|down|hangs?|freez\w*|showing|shows|missing|have|has|closed)\b/,
  /\b(?:error|problem|issue|crash|it)\s+(?:is\s+)?still\s+(?:there|happening|here)\b/,
  /\bsame\s+(?:error|problem|issue|result|thing|crash|message)\b/,
  /\b(?:no|zero)\s+(?:luck|change|difference|dice|success)\b/,
  /\bunsuccessful\w*/,
  /\bnope\b/,
  /\b(?:made it|it's|it is|now it's)\s+worse\b/,
  /\bnothing\s+(?:changed|happened|works?|helped)\b/,
];

const UNCERTAIN: RegExp[] = [
  /\b(?:i'll|i will|let me|going to|gonna|i'm going to|will)\s+(?:try|test|check|see|give it a (?:try|go|shot))\b/,
  /\b(?:if|whether)\s+(?:it|that|this)\s+(?:works|worked|fixes|fixed|helps)\b/,
  /\b(?:should|might|may|could|would)\s+(?:work|fix|help)\b/,
  // A partial improvement is not a fix.
  /\b(?:a (?:bit|little)|slightly|somewhat|partly|partially|kind of|sort of)\s+(?:better|helped|improved|works?|working|fixed|faded|lighter)\b/,
  /\bhelped (?:a (?:bit|little)|somewhat|partially)\b/,
  /\?\s*$/,
];

const WORKED: RegExp[] = [
  /\b(?:worked|works|working)\b/,
  /\b(?:it|that|this|which)\s+(?:did|does)\s+(?:actually\s+|really\s+|indeed\s+)?work\b/,
  /\b(?:fixed|solved|resolved|sorted)\b/,
  /\bdid the trick\b/,
  // "that did it", but not "it did it again" (the problem came back).
  /\b(?:that|this|it)(?:'s| has| had)?\s+(?:did|done)\s+it\b(?!\s+again)/,
  /\b(?:that|this|it|which)\s+(?:really\s+|totally\s+|definitely\s+)?helped\b/,
  /\bthat(?:'s| is| was)\s+(?:it|the (?:problem|issue|fix|cause|culprit|one))\b/,
  /\ball (?:good|set)\b/,
  /\bgood to go\b/,
  /\b(?:we're|we are)\s+(?:all\s+)?good\b/,
  // "it's fine now", but not "ok now it crashes".
  /\b(?:it's|it is|is|are|all|everything's|everything is|looks|seems)\s+(?:good|fine|ok|okay|perfect|normal|great)\s+now\b/,
  /\bback to normal\b/,
  /\bup and running\b/,
  /\b(?:is|are|it's)\s+back\b/,
  /\bno more (?:errors?|crash(?:es)?|problems?|issues?|warnings?)\b/,
  /\bno (?:errors?|crash(?:es)?|problems?|issues?|warnings?)\s+(?:now|anymore|any more)\b/,
  new RegExp(String.raw`\b${SYMPTOM}\s+(?:is|are|has|have)\s+(?:been\s+)?(?:completely\s+|totally\s+|finally\s+|all\s+|now\s+)?gone\b`),
  /\bgone now\b/,
  /\b(?:stain|mark|spot)s?\s+(?:came|come|comes)\s+(?:right\s+|straight\s+|completely\s+)?(?:out|off)\b/,
  /\bcame right out\b/,
  /\bnailed it\b/,
  /\bsuccess(?:ful(?:ly)?)?\b/,
  /\bsucceed(?:ed|s)?\b/,
  /\b(?:builds|runs|starts|loads|opens|connects|compiles|deploys|installs|boots|launches|syncs|prints)\s+(?:now|fine|again|correctly|properly|perfectly)\b/,
  /\b(?:build|tests?|deploy(?:ment)?|install(?:ation)?|checks?|pipeline|ci)\s+(?:now\s+)?(?:pass(?:es|ed)?|went through|(?:is|are) green)\b/,
];

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\bwon'?t\b/g, 'will not')
    .replace(/\bcan'?t\b/g, 'can not')
    .replace(/n't\b/g, ' not')
    // Apostrophes people skip when typing fast.
    .replace(/\b(did|does|do|is|was|were|are|has|have|had|could|would|should)nt\b/g, '$1 not')
    .replace(/\bthats\b/g, "that's")
    .replace(/\bits\b/g, "it's")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The desktop plugin's /firefinder:worked and /firefinder:failed commands:
 * typing one is the user stating the outcome. A note after the command can
 * back it up, but a note that contradicts it makes the whole thing unclear.
 */
const COMMAND = /^\/firefinder:(worked|failed)\b/;

export function classifyUserEvidence(text: string): EvidenceVerdict {
  const normalized = normalize(text);
  const command = COMMAND.exec(normalized);
  if (!command) return classifyWords(normalized);
  const stated: EvidenceVerdict = command[1] === 'worked' ? 'worked' : 'failed';
  const note = classifyWords(normalized.slice(command[0].length).trim());
  return note === 'unclear' || note === stated ? stated : 'unclear';
}

function classifyWords(normalized: string): EvidenceVerdict {
  let remaining = normalized;
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
