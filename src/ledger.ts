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
export function recordGenerated(file: string, content: string, meta: { engine?: string; scene?: string; origin?: string; notes?: string[]; run?: string; route?: string; reads?: { id: string; version: string }[]; v?: number; job?: string } = {}, strict = false): void {
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
