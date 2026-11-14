// THE NOTE LIFECYCLE AT PARAGRAPH GRAIN (A72-7).
//
// A handed note resolves — never deletes — when the paragraph its change
// landed in is accepted, and stays open when that paragraph is discarded.
// Until now every note a pass was handed closed together, at scene grain,
// the moment the scene had nothing pending left: accept one paragraph of a
// three-note revision and discard the rest, and all three closed.
//
// WHAT RESOLVES A NOTE IS PROVENANCE, NOT A READING. At the landing the pass
// records, per handed note, which paragraphs it was about and which produced
// spans are attributable to it (`attribute`, from the same alignment the
// blast-radius gate measured). At a decision arc asks only whether those
// spans are now in the book (`answeredStates`): present at HEAD is accepted,
// present in the working tree and not at HEAD is still waiting, present in
// neither is GONE — rejected, discarded, or replaced by the author's own
// hand — and a gone span leaves its note open for the author, because taking
// other text is not taking that change. Nothing here resolves an old quote
// against text the revision replaced, and nothing here says the model met
// the note: resolution is provenance about an accepted edit.
//
// ONLY THE VERSION HANDED. A note the author edited while the draft waited
// is a new instruction, and the draft did not answer it; the recorded
// instruction fingerprint has to match or the note stays open.
//
// DERIVED FROM STATE, SO IT SURVIVES A RESTART. Every answer here is read
// off the ledger, HEAD and the working tree at the moment it is asked;
// nothing is remembered in memory, a note already resolved is skipped, and
// running the settlement twice resolves nothing twice.
import fs from 'node:fs'
import path from 'node:path'
import type { ResolvedAnnotation } from 'arc-canon-graph'
import { STORY } from './config'
import { sha16 } from './records'
import { blastRadius, licensedScope, paragraphsOf } from './blast-radius'
import type { LedgerEntry } from './ledger'

/** WHAT ONE HANDED NOTE IS OWED, recorded at the landing. */
export interface NoteAttribution {
  id: string
  /** the instruction as handed (`noteInstruction`): body and anchor, never
   *  status — flipping a note to *working* is not editing it */
  version: string
  /** the paragraphs of the handed scene the note was about, 1-based for the
   *  record; `scene` for a note about the whole section; null when the note
   *  could not be placed and so licensed nothing */
  source: 'scene' | [number, number] | null
  /** the spans this note's change produced: the paragraphs that must be in
   *  the book for it to count as taken, and the ones that must be gone —
   *  WITH HOW MANY TIMES EACH READ in the book at the landing and in the
   *  landed scene, because a scene can say the same line twice: a paragraph
   *  the pass inserted that already appeared once is not in the book until
   *  it appears twice, and a paragraph the pass deleted that was never in
   *  the book (a pending hand edit) cannot be judged taken by the book
   *  lacking it. Absent on an older entry, which then counts 1 and 0. */
  spans: Span[]
}

export interface Span {
  added: string[]
  removed: string[]
  /** occurrences of each `added` / `removed` text at HEAD when the pass
   *  landed, and in what it landed */
  head?: { added: number[]; removed: number[] }
  landed?: { added: number[]; removed: number[] }
}

/** The instruction a note carries: its words and where they point. Status
 *  is left out on purpose — see the header. */
export const noteInstruction = (n: { body: string; anchor: { scene: string; paragraph?: number; quote?: string } }): string =>
  sha16(JSON.stringify({ body: n.body, scene: n.anchor.scene, paragraph: n.anchor.paragraph ?? null, quote: n.anchor.quote ?? null }))

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** ATTRIBUTE THE CHANGES TO THE NOTES, at the landing. The same alignment the
 *  gate measured, read the other way: every change the pass made is owed to
 *  the notes whose range it fell in — a scene note is owed every change —
 *  so a note that produced no change has no spans and never resolves on its
 *  own. Pure: two paragraph lists and the notes, no disk. */
export function attribute(before: string[], after: string[], notes: ResolvedAnnotation[], head: string[] = before): NoteAttribution[] {
  const scope = licensedScope(before, notes)
  const radius = blastRadius(before, after, scope)
  const headN = head.map(norm), afterN = after.map(norm)
  const count = (side: string[], t: string): number => side.filter(p => p === norm(t)).length
  const span = (added: string[], removed: string[]): Span => ({
    added, removed,
    head: { added: added.map(t => count(headN, t)), removed: removed.map(t => count(headN, t)) },
    landed: { added: added.map(t => count(afterN, t)), removed: removed.map(t => count(afterN, t)) },
  })
  return notes.map(n => {
    const placed = scope.notes.find(s => s.id === n.id)
    const owed = (source: number[]): boolean => {
      if (!placed) return false
      const r = placed.range
      return r === 'scene' || source.some(i => i >= r[0] && i <= r[1])
    }
    const spans: NoteAttribution['spans'] = []
    for (const c of radius.changes) {
      if (!owed(c.source)) continue
      if (c.kind === 'ins') spans.push(span([after[c.draft!]], []))
      else if (c.kind === 'del') spans.push(span([], [before[c.source[0]]]))
      else spans.push(span([after[c.draft!]], [before[c.source[0]]]))
    }
    return {
      id: n.id, version: noteInstruction(n),
      source: placed ? (placed.range === 'scene' ? 'scene' : [placed.range[0] + 1, placed.range[1] + 1]) : null,
      spans,
    }
  })
}

export type AnsweredState = 'waiting' | 'partly' | 'accepted' | 'gone' | 'edited' | 'nothing'

/** WHERE EACH NOTE'S CHANGE STANDS, read off the two versions of the scene.
 *  `main` is the book (HEAD), `draft` the working tree. Pure. */
export function answeredStates(
  attribution: NoteAttribution[],
  main: string[], draft: string[],
  noteNow: (id: string) => { body: string; anchor: { scene: string; paragraph?: number; quote?: string } } | undefined,
): { id: string; state: AnsweredState; accepted: number; of: number }[] {
  const mainN = main.map(norm), draftN = draft.map(norm)
  const count = (side: string[], t: string): number => side.filter(p => p === norm(t)).length
  // A SPAN IS ON A SIDE when that side reads the added text at least as many
  // times as the landed scene did, and the removed text no more times.
  const on = (side: string[], s: Span): boolean =>
    s.added.every((t, i) => count(side, t) >= (s.landed?.added[i] ?? 1))
    && s.removed.every((t, i) => count(side, t) <= (s.landed?.removed[i] ?? 0))
  // AND THE BOOK HAS TO HAVE MOVED toward it since the landing for it to be
  // accepted: a duplicate line the book already held, or a deletion of
  // words the book never held, is not a decision the author made.
  const moved = (s: Span): boolean =>
    s.added.some((t, i) => count(mainN, t) > (s.head?.added[i] ?? 0))
    || s.removed.some((t, i) => count(mainN, t) < (s.head?.removed[i] ?? 1))
  const settled = main.length === draft.length && main.every((p, i) => norm(p) === norm(draft[i]))
  return attribution.map(a => {
    const now = noteNow(a.id)
    const of = a.spans.length
    if (!now || noteInstruction(now) !== a.version) return { id: a.id, state: 'edited', accepted: 0, of }
    if (!of) return { id: a.id, state: 'nothing', accepted: 0, of }
    const accepted = a.spans.filter(s => on(mainN, s) && moved(s)).length
    const waiting = a.spans.filter(s => !(on(mainN, s) && moved(s)) && on(draftN, s)).length
    const gone = of - accepted - waiting
    if (a.source === 'scene') {
      // THE GROOMING CONVENTION FOR A SCENE NOTE: it resolves after the scene
      // settles, if at least one of its changes was taken; all-discard
      // leaves it open. While anything of it waits, it waits.
      if (!settled) return { id: a.id, state: accepted ? 'partly' : waiting ? 'waiting' : 'gone', accepted, of }
      return { id: a.id, state: accepted ? 'accepted' : 'gone', accepted, of }
    }
    if (gone) return { id: a.id, state: 'gone', accepted, of }
    if (accepted === of) return { id: a.id, state: 'accepted', accepted, of }
    return { id: a.id, state: accepted ? 'partly' : 'waiting', accepted, of }
  })
}

// ---- the record of what resolved what ------------------------------------

/** One line per automatic resolution: which decision took which note's
 *  change. Inspection now, and slice 4's episodes later; never read back to
 *  decide anything. Beside the ledger, and NOT cleared with it — a discard
 *  forgets the draft, not the decisions already made. */
const LINKS = () => path.join(STORY, '.arc', 'note-resolutions.jsonl')

export interface NoteResolution {
  at: string
  note: string
  version: string
  file: string
  /** the decision (`Judgment.decision`) whose accept completed the change */
  decision: string | null
  spans: number
}

export function recordNoteResolution(r: Omit<NoteResolution, 'at'>): void {
  try {
    fs.mkdirSync(path.dirname(LINKS()), { recursive: true })
    fs.appendFileSync(LINKS(), JSON.stringify({ at: new Date().toISOString(), ...r }) + '\n')
  } catch (e) {
    console.error('[warn] could not record which decision resolved the note (the note is resolved):', e)
  }
}

export function readNoteResolutions(): NoteResolution[] {
  try {
    return fs.readFileSync(LINKS(), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as NoteResolution)
  } catch {
    return []
  }
}

/** The paragraphs of a scene file's body, frontmatter stripped. */
export const bodyParagraphs = (raw: string): string[] => {
  const m = raw.match(/^---\n[\s\S]*?\n---\n?/)
  return paragraphsOf(m ? raw.slice(m[0].length) : raw)
}

/** The attribution an entry carries, if the pass that wrote it recorded one
 *  (A72-7); an older entry has only its handed list. */
export const attributionOf = (entry: LedgerEntry | undefined | null): NoteAttribution[] | null =>
  entry?.attribution ?? null
