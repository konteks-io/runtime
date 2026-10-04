/**
 * Reading the person's answers. People answer in words, and an agent that
 * relays them faithfully passes the words on: "Yes.", "Yes, please.", "yes,
 * try it again". An answer counts when it starts with a yes or a no, ignoring
 * punctuation.
 */

const AFFIRMATIVE = new Set(["y", "yes", "yeah", "yep", "yup", "ok", "okay", "sure", "do it", "please", "go ahead", "go for it", "absolutely", "of course", "sounds good"]);
const NEGATIVE = new Set(["n", "no", "nope", "not now", "skip", "later", "cancel", "stop"]);
/** Words that turn an otherwise agreeable answer into a refusal ("please don't"). */
const NEGATION = /\b(no|not|don'?t|do not|never|cancel|stop|wait)\b/;
/** "use a different email", "wrong address", "change the email". */
export const ASKS_OTHER_EMAIL = /\b(different|another|other|wrong|change( the)?) (e-?mail|address)\b/i;
/** "send a new code", "resend", "I didn't get it", "another code please". */
export const ASKS_NEW_CODE = /\b(new code|another code|resend|send (it |a code )?again|didn'?t (get|receive|arrive)|did not (get|receive|arrive)|no (code|email) (came|arrived))\b/i;

function normalizeAnswer(answer: string): string {
  return answer.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();
}

function leadsWith(words: Set<string>, answer: string): boolean {
  if (words.has(answer)) return true;
  for (const word of words) if (answer.startsWith(`${word} `)) return true;
  return false;
}

/** The answer's last sentence ("It already is my System, I think. Yes." ends in "yes"). */
function lastSentence(answer: string): string {
  const sentences = answer.split(/[.!?\n]+/).map(normalizeAnswer).filter(Boolean);
  return sentences.at(-1) ?? "";
}

function yesIn(said: string): boolean {
  if (!leadsWith(AFFIRMATIVE, said)) return false;
  // "yes, but not now" and "please don't" are not a yes.
  return !NEGATION.test(said.replace(/^\S+\s?/, ""));
}

export function isYes(answer: string): boolean {
  const said = normalizeAnswer(answer);
  if (yesIn(said)) return true;
  // A person who explains first and answers last still answered.
  return !leadsWith(NEGATIVE, said) && yesIn(lastSentence(answer));
}

export function isNo(answer: string): boolean {
  if (leadsWith(NEGATIVE, normalizeAnswer(answer))) return true;
  return !yesIn(normalizeAnswer(answer)) && leadsWith(NEGATIVE, lastSentence(answer));
}
