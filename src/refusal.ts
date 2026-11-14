// WHAT THE AUTHOR READS WHEN SOMETHING WOULD NOT GO IN (A72-11).
//
// A69-12's walk on the novel found a refusal reading *the answer did not
// validate (FAIL — 1 finding(s): against the story validates)*. The
// parenthesis is the validator talking. Rule 9 says the author's surface
// speaks the author's language, and a sentence that hands a writer another
// trade's summary line tells them something is wrong without telling them
// what, or what to do.
//
// SO THE TRANSLATION LIVES HERE, in one place, pure: the tool's output in,
// one product sentence out. The tool's own words are not thrown away — they
// go on the receipt's gate record, where the author opens them on purpose.
// Two registers, two homes, and nothing scanned or censored on the way out:
// there is no runtime filter in arc, and `arc-core/graph/author-language.ts`
// is the TEST that holds this boundary, never a blacklist the code applies.
import path from 'node:path'
import { STORY } from './config'

/** One finding of the story's own validator, with the machinery stripped. */
export interface StoryFinding {
  /** the scene it is about, when the finding names one */
  scene: string | null
  /** what the validator said, less the path and the summary line */
  said: string
}

const STRIP_PATH = (s: string): string => {
  // the story's own absolute path, and any other absolute path, go — a
  // writer does not have a filesystem, they have scenes
  const rel = s.split(`${STORY}${path.sep}`).join('')
  return rel.replace(/(^|\s)\/[\w./-]+\/([\w.-]+\.(?:md|yaml|yml))/g, '$1$2')
}

/** READ THE STORY VALIDATOR'S ANSWER. `FAIL — n finding(s):` then one line
 *  per finding, each `<path>: <what>`. Returns what it said, in pieces. */
export function readValidatorOutput(output: string): StoryFinding[] {
  const out: StoryFinding[] = []
  for (const raw of output.split('\n')) {
    const line = STRIP_PATH(raw.trim())
    if (!line || /^(FAIL|OK|PASS)\b/.test(line)) continue
    const said = line.replace(/^[\w./-]+\.(?:md|yaml|yml):\s*/, '').trim()
    if (!said) continue
    const scene = /\bscene ([\w.-]+):/.exec(said)?.[1]
      ?? /^([\w.-]+\.md)\b/.exec(line)?.[1]
      ?? null
    out.push({ scene, said: said.replace(/^scene [\w.-]+:\s*/, '') })
  }
  return out
}

/** ONE FINDING, IN THE AUTHOR'S WORDS. The shapes `validate.py` can produce
 *  about a scene a pass just wrote; anything else is reported as the story's
 *  own check refusing, which is true and says nothing it cannot support. */
export function findingSentence(f: StoryFinding): string {
  const s = f.said
  let m: RegExpExecArray | null
  if ((m = /^unresolved binding id:\s*(\S+)/.exec(s))) {
    return `it names ${m[1]}, which your record does not hold`
  }
  if ((m = /^satisfies names unknown material:\s*(\S+)/.exec(s))) {
    return `it says it answers ${m[1]}, which your record does not hold`
  }
  if ((m = /^unresolved wikilink:\s*\[\[(.+?)\]\]/.exec(s))) {
    return `it links to ${m[1]}, which your record does not hold`
  }
  if ((m = /^frontmatter canon id unresolved:\s*(\S+)/.exec(s))) {
    return `its heading names ${m[1]}, which your record does not hold`
  }
  if (/^scene frontmatter:/.test(s) || /^frontmatter/.test(s)) {
    return 'its heading is not the shape a scene\'s heading has'
  }
  if (/^duplicate scene id/.test(s)) {
    return 'it uses a scene name your book already has'
  }
  if (/^line \d+: a scene holds the prose/.test(s)) {
    return 'it put something in the file that is not the scene'
  }
  if (/^unresolved ID reference:\s*(\S+)/.test(s)) {
    return `it refers to ${/^unresolved ID reference:\s*(\S+)/.exec(s)![1]}, which your record does not hold`
  }
  return 'your story\'s own check would not take it'
}

/** THE SENTENCE A REFUSED DRAFT GETS. Names what the check found, in the
 *  author's terms, and ends in the next thing they can do. Several findings
 *  are said as a count plus the first, because a sentence that lists five
 *  faults is read as none. */
export function validatorSentence(output: string): string {
  const findings = readValidatorOutput(output)
  if (!findings.length) return 'your story\'s own check would not take that draft. Nothing was written; ask again.'
  const first = findingSentence(findings[0])
  const rest = findings.length > 1
    ? ` (and ${findings.length - 1} other thing${findings.length === 2 ? '' : 's'} the check named)`
    : ''
  return `that draft does not fit your record — ${first}${rest}. Nothing was written; ask again.`
}

/** WHAT THE RECEIPT KEEPS: the check's own words, the machinery stripped but
 *  the trade's language intact. The author opens this on purpose. */
export const validatorDetail = (output: string): string => {
  const findings = readValidatorOutput(output)
  return findings.length ? findings.map(f => f.said).join('; ') : STRIP_PATH(output.trim().split('\n')[0] ?? '')
}

/** THE SENTENCE A HAND EDIT GETS. The author typed this themselves, so
 *  "that draft" and "ask again" name a pass they never ran: what they can do
 *  is change the edit. */
export function editRefusal(output: string): string {
  const findings = readValidatorOutput(output)
  const said = findings.length ? findingSentence(findings[0]) : null
  return said && said !== 'your story\'s own check would not take it'
    ? `that edit does not fit your record — ${said}. Nothing was changed.`
    : 'that edit does not fit your record — your story\'s own check would not take it. Nothing was changed.'
}

/** THE SENTENCE A LANDING'S REFUSAL GETS. A pass that could not put its
 *  words in usually failed the story's own check, so the fault is read the
 *  same way the gate reads it; anything else says what arc can support. */
export function landingSentence(what: string, output: string): string {
  const findings = readValidatorOutput(output)
  if (findings.length && findingSentence(findings[0]) !== 'your story\'s own check would not take it') {
    return `arc could not write ${what} into your story — ${findingSentence(findings[0])}. Nothing was written.`
  }
  // not the validator talking: the landing's own sentence, which is already
  // the author's (`movedSentence`, the provenance refusal), or a plain stop
  const plain = output.trim().split('\n')[0]
  return /^arc /.test(plain) ? plain : `arc could not write ${what} into your story, and nothing was written. Ask again.`
}

/** THE CLAIM THAT HAS TO BE TRUE. "Nothing was written" is a statement about
 *  the disk, and arc may only make it where a rollback actually held. A
 *  decision that landed and then failed at its bookkeeping says THAT — the
 *  words are in, and what did not finish is arc's own record-keeping. */
export const landedThenFailed = (what: string): string =>
  `your words are in the book. What arc could not finish is its own record of it — ${what}. Nothing of yours is lost, and arc's check will say this is outstanding.`
