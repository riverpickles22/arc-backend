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
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { STORY } from './config'

const DIR = () => path.join(STORY, '.arc', 'generated')
const INDEX = () => path.join(STORY, '.arc', 'drafts.jsonl')

interface LedgerEntry {
  at: string
  file: string
  sha: string
  engine?: string
  scene?: string
}

/** Record what the drafting pass just wrote. Never throws: a ledger failure
 *  must never fail a draft — losing the learning signal is a smaller harm
 *  than losing the scene. */
export function recordGenerated(file: string, content: string, meta: { engine?: string; scene?: string } = {}): void {
  try {
    const sha = createHash('sha256').update(content).digest('hex').slice(0, 16)
    fs.mkdirSync(DIR(), { recursive: true })
    fs.writeFileSync(path.join(DIR(), `${sha}.md`), content)
    const entry: LedgerEntry = { at: new Date().toISOString(), file, sha, ...meta }
    fs.appendFileSync(INDEX(), JSON.stringify(entry) + '\n')
  } catch (e) {
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
