// The generation ledger: what arc wrote, before the author touched it.
//
// Git only ever sees the accepted version. arc drafts a scene into the
// working tree, the author edits it, then accepts — and the commit captures
// the edited text alone. "What arc wrote" is gone, and with it the only
// honest signal about the author's voice: the difference between what a
// machine produced and what a writer kept.
//
// So the drafting pass records its own output here, content-addressed, the
// moment it writes. Never committed (.arc/ is gitignored), never read by
// anything but arc, and safe to delete — it is working state, not record.
import fs from 'node:fs'
import path from 'node:path'
import { STORY } from './config'
import { sha16 } from './records'

const DIR = () => path.join(STORY, '.arc', 'generated')
const INDEX = () => path.join(STORY, '.arc', 'drafts.jsonl')

export interface LedgerEntry {
  at: string
  file: string
  sha: string
  engine?: string
  scene?: string
  /** Which pass produced this — 'draft', 'revise', 'redraft'. Recorded rather
   *  than inferred later: without it a revised paragraph and one the author
   *  typed themselves are the same bytes with no way to tell them apart, and
   *  a style rule argued from the wrong one is argued from nothing. */
  origin?: string
  /** The note ids the pass was handed when it wrote this — provenance the
   *  viewer shows as "answered in the draft" and the receipt names. Absent
   *  when the pass ran with no notes, or predates this field. */
  notes?: string[]
  /** The run that produced it (A67-4), so the accept that commits this file
   *  can stamp the commit onto the run's receipt. */
  run?: string
  /** The route this came from, when a route was adopted (A67-10), so the
   *  accept that clears the scene's field knows which one it already has a
   *  disposition for and does not record it superseded by its own adoption. */
  route?: string

  // ---- what the pass read (A72-4, invariant 1) --------------------------
  // A route has carried this since slice 1; a draft carried nothing, so a
  // draft written against a note the author has since answered looked exactly
  // like one written a second ago. Same fields, same comparison, same two
  // registers the author reads differently.

  /** Everything the pass was shown, with the version it was shown. */
  reads?: { id: string; version: string }[]
  /** WHICH ENUMERATION produced those versions. A draft minted under an older
   *  rule reads *written by an older arc* rather than pretending to compare. */
  v?: number
  /** The pass's own fingerprint at the time (`jobFingerprint`), so a draft
   *  made by a version of the row that no longer exists is labelled as such
   *  and not as the author's record having moved. */
  job?: string

  // ---- asking again (A72-13) --------------------------------------------
  // A69-13 gave ROUTES a re-issue: the same question, asked again, from where
  // the record stands now. A pending draft had nothing of the kind — the
  // author's only way back was to discard it and rebuild the request by hand,
  // which is the request they already made.
  //
  // What makes a replay honest is that arc asks the SAME QUESTION, not a
  // similar one: the row that answered it, the target it answered about, the
  // scope inside that target, and the author's own words. All of it recorded
  // at the landing, because a rendered prompt is not a question — it is one
  // answer to a question, against a record that has since moved.

  /** The request this draft answered, enough to ask it again. */
  replay?: {
    /** Which row answered it (`rowKey`), so a replay cannot become a
     *  different job than the one the author asked for. */
    row: string
    /** What it was about: the scene, or for a new scene the reserved file
     *  that draft was written into — a replay goes back to ITS target, never
     *  to the next free slot. */
    scene?: string
    file: string
    /** The scope inside the target: the paragraph range a passage rebuild was
     *  asked about, by index AT THE TIME — and the first and last paragraphs'
     *  own words beside it, because an index alone is not an anchor.
     *
     *  conventions §14: a mark is never silently reattached to whatever now
     *  occupies its old index. One paragraph inserted above leaves `[2,3]`
     *  perfectly in bounds and pointing at somebody else's prose, and a
     *  rebuild of that under the author's original label is the same fault
     *  the annotation anchors exist to prevent. A replay resolves the words
     *  and refuses when they have moved. */
    paragraphs?: [number, number]
    /** The first and last paragraph of that range, as they read when it was
     *  asked about. */
    span?: [string, string]
    /** The author's own words, and the craft plan they settled on. */
    guidance?: string
    plan?: { moves: { move: string; how: string }[] }
    /** The notes the pass was handed AND the version each was at, so a
     *  replay can say what changed about them rather than only that
     *  something did. */
    notes?: { id: string; version: string }[]
  }

  /** The proposal this one replaced, when it came from asking again. Links
   *  the two identities without a second store: the old entry stays exactly
   *  where it was, and nothing about it is recast as a decision. */
  supersedes?: { sha: string; run?: string }
}

/** Record what the drafting pass just wrote.
 *
 *  THIS IS SAFETY PROVENANCE NOW, not only a learning signal (A72-4). A draft
 *  on disk with no entry here reads as the author's own hand — and worse, as
 *  a draft that read nothing, so nothing about it can be called stale. It has
 *  to be durable BEFORE the draft is exposed, which is why every row writes
 *  it inside the same lane transaction as the prose and lets `strict` decide
 *  whether a failure to record is a failure to land.
 *
 *  `strict` throws when the entry cannot be written. The adopt path keeps the
 *  old contract — it is recording a decision the author already made, and a
 *  lost entry there costs provenance, not safety. */
export function recordGenerated(file: string, content: string, meta: Partial<Omit<LedgerEntry, 'at' | 'file' | 'sha'>> = {}, strict = false): void {
  try {
    const sha = sha16(content)
    fs.mkdirSync(DIR(), { recursive: true })
    fs.writeFileSync(path.join(DIR(), `${sha}.md`), content)
    const entry: LedgerEntry = { at: new Date().toISOString(), file, sha, ...meta }
    fs.appendFileSync(INDEX(), JSON.stringify(entry) + '\n')
  } catch (e) {
    if (strict) throw e
    console.error('[warn] generation ledger write failed (the draft itself is fine):', e)
  }
}

function entries(): LedgerEntry[] {
  try {
    return fs.readFileSync(INDEX(), 'utf8').split('\n').filter(Boolean)
      .map(l => JSON.parse(l) as LedgerEntry)
  } catch {
    return []
  }
}

/** The most recent generation for a path, or null when arc never wrote it
 *  (a hand-written scene, or one whose ledger entry was cleared). */
export function generatedFor(file: string): { content: string; entry: LedgerEntry } | null {
  const hit = entries().filter(e => e.file === file).at(-1)
  if (!hit) return null
  try {
    return { content: fs.readFileSync(path.join(DIR(), `${hit.sha}.md`), 'utf8'), entry: hit }
  } catch {
    return null
  }
}

/** Forget these paths. Called when a draft is discarded — a generation the
 *  author threw away must never be diffed against a later hand-written
 *  scene at the same path — and after a learning pass consumes them, so the
 *  same edit is never mined twice. */
export function clearGenerated(files: string[]): void {
  try {
    const keep = entries().filter(e => !files.includes(e.file))
    const dropped = entries().filter(e => files.includes(e.file))
    fs.writeFileSync(INDEX(), keep.map(e => JSON.stringify(e)).join('\n') + (keep.length ? '\n' : ''))
    // only unlink blobs no surviving entry still points at
    const live = new Set(keep.map(e => e.sha))
    for (const e of dropped) {
      if (!live.has(e.sha)) fs.rmSync(path.join(DIR(), `${e.sha}.md`), { force: true })
    }
  } catch (e) {
    console.error('[warn] generation ledger clear failed:', e)
  }
}
