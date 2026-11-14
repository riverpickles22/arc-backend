// WHERE A PASS'S ANSWER LANDS (A72-4).
//
// Invariant 1 names the write path, and this is the door it names. A pass runs
// for a minute or two; the author is not idle while it does. Every writing row
// landed with a plain `fs.writeFileSync` over whatever was there, and the
// failure paths were worse — a cancelled or refused pass put back the bytes it
// had read AT LAUNCH, which is the author's own paragraph gone without a word.
//
// So a pass takes a SNAPSHOT of its destination when it launches, including
// the absence of a file it is about to create, and hands it back here at the
// landing. Inside the lane, immediately before the write:
//
//   · the destination is compared against the snapshot;
//   · a mismatch does not write. The candidate is kept beside the book, in
//     `.arc/candidates/`, where the author can read it and ask again — it is
//     NOT made the live draft, because the live draft is their words now;
//   · a match writes once, through the validator, with the locks re-checked.
//
// And the restoration after a failure asks the same question: arc puts back
// only what it can still see it wrote. Anything else on disk is somebody's,
// and is left alone.
import fs from 'node:fs'
import path from 'node:path'
import { STORY } from './config'
import { validateStory } from './canon'
import { resolveWithin } from './safe-path'
import { inLane } from './lane'
import { sha16 } from './records'

/** The destination as it stood when a pass launched. `bytes: null` is the
 *  state of a file that is not there — which is a thing a new scene's target
 *  can stop being while the pass runs, and the case a plain write would take
 *  silently. */
export interface Destination {
  file: string
  bytes: string | null
  at: string
}

export function destinationAt(file: string): Destination {
  let bytes: string | null = null
  try { bytes = fs.readFileSync(path.join(STORY, file), 'utf8') } catch { bytes = null }
  return { file, bytes, at: new Date().toISOString() }
}

const onDisk = (file: string): string | null => {
  try { return fs.readFileSync(path.join(STORY, file), 'utf8') } catch { return null }
}

/** Has the destination moved since the pass launched? */
export const moved = (d: Destination): boolean => onDisk(d.file) !== d.bytes

/** Where a candidate that could not land waits. Working state under `.arc/`,
 *  gitignored like the rest of it, and readable by id — the run's. */
export const candidatePath = (run: string): string =>
  path.join(STORY, '.arc', 'candidates', `${run}.md`)

/** Keep an answer that could not land, beside the book rather than in it.
 *  Never throws: losing the candidate is a smaller harm than failing to
 *  report why nothing landed. */
export function keepCandidate(run: string, file: string, content: string): string | null {
  try {
    const abs = candidatePath(run)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
    fs.appendFileSync(path.join(STORY, '.arc', 'candidates', 'index.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), run, file, sha: sha16(content) }) + '\n')
    return abs
  } catch (e) {
    console.error('[warn] could not keep the candidate beside the book:', e)
    return null
  }
}

/** What a landing answered. `kept` names the candidate's file when the
 *  destination moved — there is always something to look at. */
export type Landing =
  | { ok: true }
  | { ok: false; why: 'moved'; kept: string | null }
  | { ok: false; why: 'refused'; output: string }

/** LAND IT, OR DON'T. `write` is the row's own validated write — it does the
 *  trial, the validator and the restore — and it is called only once the
 *  destination has been proven not to have moved, inside the lane, so nothing
 *  of arc's can interleave between the compare and the write.
 *
 *  `record` writes the draft's PROVENANCE — what pass made it, what it read —
 *  and runs inside the same transaction, because a draft on disk with no
 *  provenance reads as the author's own hand to anything that looks between
 *  the two. A provenance that cannot be written is a landing that does not
 *  happen: the prose is taken back off and the run says it could not run.
 *
 *  `run` names where a candidate goes when it cannot land. */
export function landOrKeep(
  d: Destination,
  run: string,
  content: string,
  write: () => { ok: boolean; output: string },
  record?: () => void,
): Landing {
  return inLane(`landing ${path.basename(d.file)}`, () => {
    if (moved(d)) {
      const kept = keepCandidate(run, d.file, content)
      return { ok: false, why: 'moved', kept } as Landing
    }
    const check = write()
    if (!check.ok) return { ok: false, why: 'refused', output: check.output } as Landing
    if (record) {
      try {
        record()
      } catch (e) {
        // Exposed prose with no provenance is the one outcome worse than no
        // prose: put it back and say so.
        try {
          if (d.bytes === null) fs.rmSync(path.join(STORY, d.file), { force: true })
          else fs.writeFileSync(path.join(STORY, d.file), d.bytes)
        } catch { /* the message below is what the author reads either way */ }
        // the message goes to the log; the author reads the sentence (A72-11)
        console.error('[warn] the provenance of a landing could not be recorded:', e)
        return { ok: false, why: 'refused', output: 'arc could not record where those words came from, so it did not leave them in your story.' } as Landing
      }
    }
    return { ok: true } as Landing
  })
}

/** A TRIAL WRITE THAT CANNOT COST A PARAGRAPH (A72-4).
 *
 *  The story's validator reads files, so a candidate has to be on disk to be
 *  judged. Both revision rows did that by writing the candidate to the LIVE
 *  destination and then restoring the bytes they had read at launch — minutes
 *  earlier, past the model call, and spanning a python process. An author
 *  save inside that window was silently overwritten.
 *
 *  The whole trial now happens inside the lane, against the destination as it
 *  stands at that moment: what is there is captured, the candidate goes down,
 *  the verdict comes back, and the capture goes up again — and only if the
 *  file still holds the candidate, because anything else on disk arrived from
 *  outside arc and is not arc's to roll back. A destination that moved since
 *  the pass launched is not trialled at all; its answer cannot land anyway. */
export function trialValidate(
  file: string,
  candidate: string,
  check: (text: string) => { ok: boolean; output: string },
): { ok: boolean; output: string } {
  return inLane(`trying ${path.basename(file)}`, () => {
    const abs = path.join(STORY, file)
    const before = onDisk(file)
    const out = check(candidate)
    // `check` puts the file back itself when the validator refuses; when it
    // passes, the candidate is on disk and this is what takes it off again.
    if (out.ok) {
      const now = onDisk(file)
      if (now !== candidate) {
        console.error(`[landing] ${file} changed during a trial — left as it is`)
        return out
      }
      try {
        if (before === null) fs.rmSync(abs, { force: true })
        else fs.writeFileSync(abs, before)
      } catch (e) { console.error(`[landing] could not take the trial back off ${file}:`, e) }
    }
    return out
  })
}

/** PUT BACK ONLY WHAT ARC CAN SEE IT WROTE. A pass that failed after writing
 *  restores the author's text — but if the file no longer holds what the pass
 *  put there, somebody else has written since, and their words are not arc's
 *  to roll back. The old code restored the launch-time bytes unconditionally,
 *  which is how a cancelled pass could cost the author a paragraph. */
export function restoreIfOurs(d: Destination, wrote: string): boolean {
  const now = onDisk(d.file)
  if (now !== wrote) {
    if (now !== d.bytes) {
      console.error(`[landing] ${d.file} changed outside arc while a pass was failing — left as it is`)
    }
    return false
  }
  try {
    if (d.bytes === null) fs.rmSync(path.join(STORY, d.file), { force: true })
    else fs.writeFileSync(path.join(STORY, d.file), d.bytes)
    return true
  } catch (e) {
    console.error(`[landing] could not put ${d.file} back:`, e)
    return false
  }
}

/** What arc wrote and could not put in: one entry per candidate still on
 *  disk, newest first. Working state, so it is read fresh and never cached. */
export interface Candidate { run: string; file: string; at: string }

export function candidates(): Candidate[] {
  try {
    const index = fs.readFileSync(path.join(STORY, '.arc', 'candidates', 'index.jsonl'), 'utf8')
    const seen = new Map<string, Candidate>()
    for (const line of index.split('\n').filter(Boolean)) {
      const e = JSON.parse(line) as Candidate
      // Only what is still there: a candidate the author has read and taken,
      // or cleaned up, is not something to go on offering them.
      if (!fs.existsSync(candidatePath(e.run))) continue
      seen.set(e.run, { run: e.run, file: e.file, at: e.at })
    }
    return [...seen.values()].sort((a, b) => b.at.localeCompare(a.at))
  } catch {
    return []
  }
}

/** The words of one candidate, for the author to read. */
export function candidateText(run: string): string | null {
  try { return fs.readFileSync(candidatePath(run), 'utf8') } catch { return null }
}

/** The author has read it and is done with it. */
export function dropCandidate(run: string): boolean {
  try { fs.rmSync(candidatePath(run), { force: true }); return true } catch { return false }
}

/** The author's sentence when a pass finished and could not land. No id, no
 *  path, no git word — what happened and what they can do next. */
export const movedSentence = (where: string): string =>
  `You changed ${where} while that was being written, so arc did not put its words over yours. What it wrote is kept beside the scene — ask again from where the scene stands now.`

/** THE VALIDATED WRITE: the file on disk, the story's validator run over it,
 *  and the previous bytes put back — or the file removed — when it refuses.
 *  Shared by every writing row (A80-1, from draft.ts). */
export function writeValidated(rel: string, content: string): { ok: boolean; output: string } {
  const abs = resolveWithin(STORY, rel)
  const existed = fs.existsSync(abs)
  const prev = existed ? fs.readFileSync(abs, 'utf8') : null
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  const check = validateStory()
  if (!check.ok) {
    if (prev !== null) fs.writeFileSync(abs, prev)
    else fs.unlinkSync(abs)
  }
  return check
}

/** WHAT THE AUTHOR IS TOLD AT THE LANDING about the age of what the pass
 *  was given — proven from the manifest, never argued (A69-6). A season-old
 *  snapshot belongs where they are already reading, not in a receipt they
 *  have to open. Nothing stale, nothing said: a sentence that fires on every
 *  draft teaches the author to skip it.
 *
 *  Pure, so both halves of the claim can be held by a test. */
export function leansOnSentence(aged: { id: string; as_of: string }[] | undefined): string {
  if (!aged?.length) return ''
  return ` It leans on ${aged.map(l => `${l.id} as of ${l.as_of}`).join(', ')} — the record has not looked since.`
}
