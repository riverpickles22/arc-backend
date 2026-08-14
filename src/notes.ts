// Notes: whatever the author wanted to write down, kept.
//
// FILING IS A WRITE, NOT A PASS. The first cut ran the whole work graph on
// submit — intake, a material worker, a judge — and when the worker answered
// without a usable item the author got a 500 after eleven seconds, having just
// written a real thought. That is the worst failure available to the one
// feature whose whole promise is that nothing is lost. So this module does the
// only thing that cannot fail for an interesting reason: it writes the note
// down. Interpretation is a separate act the author asks for (work.ts).
//
// WHERE THEY LIVE. notes/, in the story repo — committable, and part of the
// story. Not .arc/, which conventions §9 defines as machine working state that
// is gitignored and safe to delete: right for a transient copy of a dump,
// wrong for the author's own notebook. Dumps written under the old design are
// migrated here once, so nothing from that period is lost.
import fs from 'node:fs'
import path from 'node:path'
import { STORY } from './config'
import { HttpError } from './http'

const notesDir = (): string => path.join(STORY, 'notes')
const legacyDir = (): string => path.join(STORY, '.arc', 'dumps')

export interface Note {
  /** The file's own name, which is also its handle. */
  file: string
  id: string
  created: string
  /** Run ids that have worked this note into the story. */
  worked: string[]
  text: string
}

const FM = /^---\n([\s\S]*?)\n---\n?/

/** Notes are markdown with a tiny frontmatter block — the same shape a scene
 *  or an annotation has, so a note is readable by every tool that already
 *  reads this story, including a person with an editor. */
function parseNote(file: string, raw: string): Note {
  const m = raw.match(FM)
  const meta: Record<string, string> = {}
  let worked: string[] = []
  if (m) {
    for (const line of m[1].split('\n')) {
      const at = line.indexOf(':')
      if (at < 0) continue
      const key = line.slice(0, at).trim()
      const value = line.slice(at + 1).trim()
      if (key === 'worked') {
        worked = value.replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(Boolean)
      } else {
        meta[key] = value
      }
    }
  }
  return {
    file,
    id: meta.id || path.basename(file, '.md'),
    created: meta.created || '',
    worked,
    text: (m ? raw.slice(m[0].length) : raw).trim(),
  }
}

const render = (n: Omit<Note, 'file'>): string =>
  `---\nid: ${n.id}\ncreated: ${n.created}\nworked: [${n.worked.join(', ')}]\n---\n\n${n.text.trim()}\n`

/** The whole notebook, newest first. Migrates any pre-notes/ dumps on the way
 *  through, so an author who captured under the old design keeps everything. */
export function listNotes(): Note[] {
  migrateLegacyDumps()
  let names: string[]
  try {
    names = fs.readdirSync(notesDir()).filter(n => n.endsWith('.md'))
  } catch {
    return []
  }
  const out: Note[] = []
  for (const file of names) {
    try {
      out.push(parseNote(file, fs.readFileSync(path.join(notesDir(), file), 'utf8')))
    } catch { /* one unreadable note is not worth failing the notebook over */ }
  }
  return out.sort((a, b) => (b.created || b.file).localeCompare(a.created || a.file))
}

/** One-time move of .arc/dumps/*.md into notes/. Never throws: a migration
 *  that fails must not take the notebook down with it. */
function migrateLegacyDumps(): void {
  try {
    if (!fs.existsSync(legacyDir())) return
    fs.mkdirSync(notesDir(), { recursive: true })
    for (const name of fs.readdirSync(legacyDir())) {
      if (!name.endsWith('.md')) continue
      const raw = fs.readFileSync(path.join(legacyDir(), name), 'utf8')
      // The old format was "<iso>\n\n<text>".
      const gap = raw.indexOf('\n\n')
      const created = gap > 0 ? raw.slice(0, gap).trim() : ''
      const text = (gap > 0 ? raw.slice(gap + 2) : raw).trim()
      const id = `note.${path.basename(name, '.md')}`
      const target = path.join(notesDir(), name)
      if (!fs.existsSync(target)) {
        fs.writeFileSync(target, render({ id, created: created || new Date().toISOString(), worked: [], text }))
      }
      fs.unlinkSync(path.join(legacyDir(), name))
    }
    if (!fs.readdirSync(legacyDir()).length) fs.rmdirSync(legacyDir())
  } catch (e) {
    console.error('[warn] could not migrate .arc/dumps into notes/ (nothing was deleted):', e)
  }
}

/** Write a note down. The only thing this does, on purpose. */
export function addNote(text: string, now = new Date()): Note {
  const body = text.trim()
  if (!body) throw new HttpError(400, 'nothing to file')

  const stamp = now.toISOString()
  const slug = stamp.replace(/[:.]/g, '-')
  const file = `${slug}.md`
  const note: Note = { file, id: `note.${slug}`, created: stamp, worked: [], text: body }

  fs.mkdirSync(notesDir(), { recursive: true })
  fs.writeFileSync(path.join(notesDir(), file), render(note))
  return note
}

/** A note's name is its handle — never a path, so traversal cannot be asked
 *  for in the first place. */
function noteFile(file: string): string {
  if (!file || file.includes('/') || file.includes('\\') || file.includes('..') || !file.endsWith('.md')) {
    throw new HttpError(400, 'not a note file name')
  }
  const abs = path.join(notesDir(), file)
  if (!fs.existsSync(abs)) throw new HttpError(404, 'no such note — it may already be gone')
  return abs
}

export function readNote(file: string): Note {
  return parseNote(file, fs.readFileSync(noteFile(file), 'utf8'))
}

/** Revise a note. The author's words are theirs to change; only the text is
 *  writable, because the id and the stamp are what make it findable later. */
export function updateNote(file: string, text: string): Note {
  const abs = noteFile(file)
  const body = text.trim()
  if (!body) throw new HttpError(400, 'a note with no text is a deletion — delete it instead')
  const current = parseNote(file, fs.readFileSync(abs, 'utf8'))
  const next = { ...current, text: body }
  fs.writeFileSync(abs, render(next))
  return next
}

export function deleteNote(file: string): void {
  fs.unlinkSync(noteFile(file))
}

/** Record that a run took this note up. Never throws: losing the mark is a
 *  smaller harm than failing a run that already did its work. */
export function markWorked(file: string, runId: string): void {
  try {
    const abs = noteFile(file)
    const note = parseNote(file, fs.readFileSync(abs, 'utf8'))
    if (note.worked.includes(runId)) return
    fs.writeFileSync(abs, render({ ...note, worked: [...note.worked, runId] }))
  } catch (e) {
    console.error('[warn] could not mark the note as worked (the run itself stands):', e)
  }
}
