// docs/style.evidence.jsonl — what the author decided about arc's prose.
//
// The generation ledger (ledger.ts) answers "what did arc write". This answers
// "what did the author do about it", and the two together are the only honest
// input to a rule about their voice.
//
// IT IS RECORD, NOT WORKING STATE. The ledger lives under .arc/, which this
// codebase promises twice over is safe to delete. An authorial judgment is not
// safe to delete: it is the evidence a style rule rests on, and the author
// ratifies rules from it. So the log is tracked and rides along in the commit
// the accept already makes. A refusal commits nothing — that is the whole
// point of refusing — so its entry waits, visible in `git status`, until the
// next accept carries it.
//
// NOTHING HERE MAY FAIL AN ACCEPT. Losing a style proposal is a smaller harm
// than failing an accept that already committed; every write is wrapped and
// every read returns a default. Same contract as the capture pass.
import fs from 'node:fs'
import path from 'node:path'
import type { AlignedSentence } from 'arc-canon-graph'
import { STORY } from './config'

export const EVIDENCE_REL = 'docs/style.evidence.jsonl'
const evidencePath = (): string => path.join(STORY, EVIDENCE_REL)

/** Working state, and deliberately separate from the record above: which
 *  commit a file's pending work started from, and how far mining has got.
 *  Bookkeeping is disposable; the judgments are not. */
const BASELINES = (): string => path.join(STORY, '.arc', 'baselines.json')

// The mining watermark lives beside it, under .arc/, and deliberately NOT as a
// flag on the entries: those are record, and rewriting a tracked file to say
// "arc has read this" would put bookkeeping in the author's history.
const WATERMARK = (): string => path.join(STORY, '.arc', 'mined.json')

/** How far the learning pass has read. Entries stamped after this are new. */
export function readWatermark(): string {
  try {
    return (JSON.parse(fs.readFileSync(WATERMARK(), 'utf8')) as { at?: string }).at ?? ''
  } catch {
    return ''
  }
}

export function setWatermark(at: string): void {
  try {
    fs.mkdirSync(path.dirname(WATERMARK()), { recursive: true })
    fs.writeFileSync(WATERMARK(), JSON.stringify({ at }, null, 2))
  } catch { /* bookkeeping only — a lost watermark re-argues a rule the id collapses */ }
}

/** How the author answered one piece of arc's prose.
 *
 *  `approved` is not `accepted` with equal sides. A paragraph taken verbatim
 *  says something real — arc got this one right — but it is not an edit, and
 *  filing it as a pair whose two halves match would put a rule's evidence
 *  table in the position of arguing from a non-difference. */
export type Verdict = 'accepted' | 'rejected' | 'approved' | 'discarded'
export type Granularity = 'scene' | 'paragraph' | 'sentence'

export interface Judgment {
  at: string
  file: string
  scene: string | null
  granularity: Granularity
  /** Where in the scene, so the learning pass can tell two passes at one
   *  paragraph from two independent examples. Null for a whole-scene verdict. */
  paragraph: number | null
  verdict: Verdict
  /** What arc put in front of the author. Empty when arc wrote nothing here. */
  arcWrote: string
  /** What stands after the author decided. Empty when the text was cut. */
  authorKept: string
  /** Read from the generation ledger, never guessed from context. */
  origin: string
  /** The commit this file's pending work started from. */
  baseline: string | null
}

/** Append one judgment. Never throws. */
export function recordJudgment(j: Omit<Judgment, 'at'> & { at?: string }): void {
  try {
    const entry: Judgment = { at: j.at ?? new Date().toISOString(), ...j } as Judgment
    fs.mkdirSync(path.dirname(evidencePath()), { recursive: true })
    fs.appendFileSync(evidencePath(), JSON.stringify(entry) + '\n')
  } catch (e) {
    console.error('[warn] evidence log write failed (the decision itself stands):', e)
  }
}

export function readJudgments(): Judgment[] {
  try {
    return fs.readFileSync(evidencePath(), 'utf8').split('\n').filter(Boolean)
      .map(l => JSON.parse(l) as Judgment)
  } catch {
    return []
  }
}

// ---- the pinned baseline ------------------------------------------------
//
// learn-style used to reach for HEAD^, on the stated assumption that an accept
// makes exactly one commit. Judging by paragraph and by sentence makes that
// false — HEAD^ is one sentence ago — so the boundary is pinned when a file's
// pending work is first judged, and read back instead of walked to.

function baselines(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(BASELINES(), 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

/** Pin this file's baseline if it has none, and return whatever it now has. */
export function pinBaseline(file: string, head: string | null): string | null {
  if (!head) return baselines()[file] ?? null
  try {
    const all = baselines()
    if (!all[file]) {
      all[file] = head
      fs.mkdirSync(path.dirname(BASELINES()), { recursive: true })
      fs.writeFileSync(BASELINES(), JSON.stringify(all, null, 2))
    }
    return all[file]
  } catch {
    return null
  }
}

/** Forget a file's baseline — its pending work has been fully judged, so the
 *  next draft starts from wherever the book now stands. */
export function clearBaseline(file: string): void {
  try {
    const all = baselines()
    if (!(file in all)) return
    delete all[file]
    fs.writeFileSync(BASELINES(), JSON.stringify(all, null, 2))
  } catch { /* bookkeeping only */ }
}

// ---- putting a rewritten sentence back together -------------------------

/** The other half of a rewritten sentence, or null when there is no other half.
 *
 *  alignSentences has no `replace`: a rewrite surfaces as a `del` on main's
 *  side immediately followed by an `ins` on the draft's, and the author judges
 *  those through two separate calls that know nothing of each other. So the
 *  before/after pair has to be put back together from the alignment, here,
 *  where it can be tested — a hook that recorded only the sentence it was
 *  handed would throw away the very thing that makes it a pair.
 *
 *  Adjacency is the whole rule. A `del` with an `ins` after it is a rewrite; a
 *  `del` followed by anything else is a cut, and a lone `ins` is an addition. */
export function counterpartOf(
  aligned: AlignedSentence[],
  side: 'main' | 'draft',
  index: number,
): AlignedSentence | null {
  const at = aligned.findIndex(s => s.side === side && s.index === index && s.kind !== 'same')
  if (at < 0) return null
  if (aligned[at].kind === 'del') {
    const after = aligned[at + 1]
    return after?.kind === 'ins' ? after : null
  }
  const before = aligned[at - 1]
  return before?.kind === 'del' ? before : null
}
