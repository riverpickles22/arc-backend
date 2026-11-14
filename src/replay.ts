// ASK AGAIN, FOR A PENDING DRAFT (A72-13).
//
// A69-13 gave ROUTES a re-issue: the same question, asked again, from where
// the record stands now. A pending draft had nothing of the kind. The author's
// only way back was to discard what arc wrote and rebuild the request by hand
// — which is the request they already made, typed a second time, and a gesture
// that destroys work before it knows whether the replacement is any good.
//
// What makes a replay honest:
//
//   · IT ASKS THE SAME QUESTION. The row that answered it, the target it
//     answered about, the scope inside that target, the author's own words and
//     the notes it was handed — all recorded at the landing (`ledger.ts`), and
//     all re-resolved against the record as it stands now. Never the rendered
//     brief: that is one ANSWER to a question, against a record that has moved.
//   · IT KEEPS THE OLD WORDS UNTIL THE NEW ONES ARE IN. The replacement runs
//     through the same guarded landing as any pass (`landing.ts`), whose
//     destination snapshot is the pending draft itself. A failure, a
//     cancellation or a refusal leaves exactly what was there.
//   · IT NEVER ERASES THE AUTHOR'S OWN WORK BY ACCIDENT. A pending draft the
//     author has edited is no longer the proposal arc made, and a bare retry
//     would throw their edit away under a label that says *stale*. That
//     replacement has to be asked for in as many words.
//   · IT RECORDS NO VERDICT. The record moving is not the author deciding.
//     The new entry links to the old one; the old one stays where it is.
import fs from 'node:fs'
import path from 'node:path'
import { STORY } from './config'
import { HttpError } from './http'
import { assertBase } from './base'
import { generatedFor } from './ledger'
import { standingJudgments } from './put-back'
import { annotations } from './annotations'
import { noteVersion } from './reads'
import { proseScenes } from './story'
import { sha16 } from './records'

/** What a replay would do, before it does anything. */
export interface ReplayPlan {
  file: string
  scene?: string
  row: string
  /** The author's own words, as the first request carried them. */
  guidance?: string
  /** The scope, when the first request had one. */
  paragraphs?: [number, number]
  /** WHAT WOULD BE REPLACED. `yours` is true when the author has been in this
   *  draft — they edited it, or they already decided about part of it — and
   *  then the replacement must be asked for explicitly.
   *
   *  `decided` names the paragraphs and sentences they have already taken out
   *  of this draft into the book. A byte compare cannot see those: accepting
   *  one paragraph commits it and then puts the pending draft back EXACTLY,
   *  so the file reads as untouched while a decision has been made about it.
   *  Replacing that silently discards work the author did. */
  replacing: { yours: boolean; words: string; edited: boolean; decided: string[] }
  /** What has moved under the proposal since, in the record's own ids. */
  moved: string[]
}

/** The pending proposal at a file, and the request that made it. Refuses in
 *  the author's words when there is nothing to ask again. */
export function replayable(file: string): { entry: NonNullable<ReturnType<typeof generatedFor>>['entry']; content: string } {
  const gen = generatedFor(file)
  if (!gen) {
    throw new HttpError(409,
      'these words were not written by arc, so there is no question to ask again. Edit them, or ask for something new.')
  }
  if (!gen.entry.replay) {
    throw new HttpError(409,
      'arc kept no record of what it was asked for these words, so it cannot ask it again. Ask for something new from where the scene stands now.')
  }
  return gen
}

/** The notes that apply NOW to the scene a replay is about, and which of the
 *  ones the first pass was handed have moved since. Named rather than
 *  counted: the author reads which note changed, not how many. */
export function notesMoved(entry: { replay?: { notes?: { id: string; version: string }[] } }): string[] {
  const was = entry.replay?.notes ?? []
  if (!was.length) return []
  const now = new Map(annotations().map(n => [n.id, noteVersion(n)]))
  return was.filter(n => now.get(n.id) !== n.version).map(n => n.id)
}

/** Has the author EDITED this draft since arc wrote it? Whitespace-
 *  insensitive at the edges, because a trailing newline is not an edit. */
export const theirsNow = (file: string, wrote: string): boolean => {
  let onDisk = ''
  try { onDisk = fs.readFileSync(path.join(STORY, file), 'utf8') } catch { return false }
  return onDisk.trimEnd() !== wrote.trimEnd()
}

/** HAS THE AUTHOR ALREADY DECIDED ABOUT PART OF IT? A paragraph or sentence
 *  accept commits one change and then restores the pending draft's exact bytes
 *  (`restoreWorking`), so the file reads as untouched while a decision has been
 *  made about it — and a byte compare says the draft is still wholly arc's.
 *
 *  The evidence log is what knows: a verdict on this file at paragraph or
 *  sentence grain, recorded since this proposal was made. Named, not counted:
 *  the author reads which paragraph they already took. */
export function decidedPartly(file: string, since: string): string[] {
  try {
    // standing only: an accept the author put back is not a decision the
    // replay has to ask about replacing (A72-8)
    return standingJudgments()
      .filter(j => j.file === file && j.at > since
        && (j.granularity === 'paragraph' || j.granularity === 'sentence')
        && (j.verdict === 'accepted' || j.verdict === 'approved' || j.verdict === 'rejected'))
      .map(j => `${j.granularity} ${(j.paragraph ?? 0) + 1}`)
  } catch {
    return []
  }
}

/** WHAT ASKING AGAIN WOULD DO, said before anything is asked. The author
 *  reads this and decides; nothing here writes, launches or spends. */
export function planReplay(file: string): ReplayPlan {
  const { entry, content } = replayable(file)
  const r = entry.replay!
  let words = ''
  try { words = fs.readFileSync(path.join(STORY, file), 'utf8') } catch { words = content }
  const edited = theirsNow(file, content)
  const decided = decidedPartly(file, entry.at)
  return {
    file,
    ...(r.scene ? { scene: r.scene } : {}),
    row: r.row,
    ...(r.guidance ? { guidance: r.guidance } : {}),
    ...(r.paragraphs ? { paragraphs: r.paragraphs } : {}),
    replacing: { yours: edited || decided.length > 0, words, edited, decided },
    moved: notesMoved(entry),
  }
}

/** THE SCOPE A PASSAGE REBUILD WAS ABOUT, re-resolved against the scene as it
 *  stands — BY ITS WORDS, not by its index.
 *
 *  An index is not an anchor. One paragraph inserted above leaves `[2,3]`
 *  perfectly in bounds and pointing at somebody else's prose, and rebuilding
 *  that under the author's original label is exactly the fault conventions §14
 *  built annotation anchors to prevent. So the recorded span's own first and
 *  last paragraphs are what a replay looks for: found where they were, the
 *  range stands; found somewhere else, it moves to where they are now; gone,
 *  the replay refuses rather than rebuilding whatever took their place.
 *
 *  A proposal recorded before the span was kept has indices alone. It is not
 *  comparable, so it is refused for that reason and said so. */
export function resolveRange(scene: string, range: [number, number], span?: [string, string]): [number, number] | null {
  const s = proseScenes().find(x => x.scene === scene)
  if (!s) return null
  const paras = s.body.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
  const [from, to] = range
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) return null
  if (!span) return null              // indices alone cannot be re-resolved
  const [firstWas, lastWas] = span
  const first = paras.indexOf(firstWas)
  const last = paras.indexOf(lastWas)
  if (first < 0 || last < 0 || last < first) return null
  return [first, last]
}

/** Everything a replay checks before it is allowed to run. Throws in the
 *  author's words; returns what the row needs when it may go ahead.
 *
 *  `base` is A72-3's review token for the destination: a replay is a decision
 *  about the words on screen, and one made from a view that has not seen the
 *  current ones replaces something the author never read.
 *
 *  `replaceMine` is the explicit gesture. Without it, a draft the author has
 *  edited is left alone and the refusal says what would have gone. */
export function admitReplay(file: string, base: unknown, replaceMine: boolean): {
  entry: NonNullable<ReturnType<typeof generatedFor>>['entry']
  plan: ReplayPlan
  /** The recorded scope, re-resolved to where those words are NOW. */
  paragraphs?: [number, number]
  replaces: { sha: string; run?: string }
} {
  const { entry, content } = replayable(file)
  assertBase(file, base, 'ask again about that')
  const plan = planReplay(file)

  if (plan.replacing.yours && !replaceMine) {
    const why = plan.replacing.edited
      ? 'you have written in this draft since arc did'
      : `you have already taken ${plan.replacing.decided.join(', ')} of this into the book`
    throw new HttpError(409,
      `${why}, and asking again would replace what you did. `
      + 'Say so and arc will ask again; otherwise keep what is there and the question stays unasked.',
      { replacing: plan.replacing.words, scope: plan.file, decided: plan.replacing.decided })
  }

  const r = entry.replay!
  if (!r.scene) {
    throw new HttpError(409,
      'arc did not record which scene these words were written for, so it cannot ask the same question again. '
      + 'Ask for something new from where the scene stands now.')
  }
  let paragraphs: [number, number] | undefined
  if (r.paragraphs && r.scene) {
    const found = resolveRange(r.scene, r.paragraphs, r.span)
    if (!found) {
      throw new HttpError(409,
        'those paragraphs are not where they were when arc rebuilt them, so asking the same question again '
        + 'would be asking about different words. Pick the passage again from where the scene stands now.')
    }
    paragraphs = found
  }

  return {
    entry, plan,
    ...(paragraphs ? { paragraphs } : {}),
    replaces: { sha: sha16(content), ...(entry.run ? { run: entry.run } : {}) },
  }
}

// ---- one replacement at a time, per destination --------------------------
//
// Two replays of the same pending draft would each take the destination
// snapshot, both pass it, and race two replacements into one file — the second
// landing over the first's words with no decision made about either. The lane
// cannot see it: each landing is a transaction of its own, and the window is
// between them, across the model call. So a destination carries a claim for
// as long as a replay of it is in flight.

const inFlight = new Map<string, string>()

export function claimReplay(file: string, run: string): void {
  const held = inFlight.get(file)
  if (held) {
    throw new HttpError(409,
      'arc is already asking that question again. Wait for the words it is writing, then decide about them.')
  }
  inFlight.set(file, run)
}

export const releaseReplay = (file: string): void => { inFlight.delete(file) }

/** For a test that needs to prove the claim is released. */
export const replayInFlight = (file: string): string | undefined => inFlight.get(file)
