// THE BLAST-RADIUS GATE: "minimal" means minimal (A72-6).
//
// U2's row makes one claim louder than any other — that a notes revision
// changes the passages the author's notes point at and NOTHING ELSE. Until
// now that claim was a declaration on the row: the gate was a stub that
// answered `could not judge`, so every receipt said "minimal" was not yet
// checked, and a pass that rewrote a paragraph nobody asked about landed in
// the draft layer wearing the label anyway.
//
// This is the check. It is PURE — two paragraph lists and the notes that
// license changes between them — so it can be measured in a test without a
// story, a model or a disk, and so the row cannot drift into comparing the
// wrong two things: the before side is the scene AS THE PASS WAS HANDED IT,
// pending edits included, never HEAD.
//
// It is CONSERVATIVE about ambiguity. A note whose passage cannot be placed in
// the handed scene unambiguously licenses nothing; a change the alignment
// cannot attribute to a licensed passage is outside the scope. When in doubt
// the gate refuses rather than widens, because the cost of a wrong refusal is
// one repair, and the cost of a wrong allowance is the author's paragraph.
import type { ResolvedAnnotation } from 'arc-canon-graph'
import { alignParagraphs, mainInsertionPoint } from 'arc-canon-graph'
import { paragraphsOf } from 'arc-canon-graph/annotations.ts'

/** The paragraph model every surface shares — ONE definition, arc-core's:
 *  blank-line separated, trimmed, empties dropped. Trailing whitespace is not
 *  a change; whitespace INSIDE a paragraph is, because the model compares
 *  the trimmed paragraph whole. Re-exported so the gate's tests exercise the
 *  same function the gate runs. */
export { paragraphsOf }

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** What the handed notes LICENSE: which source paragraphs may change, and
 *  whether the whole scene may — with the reason for each, so the receipt can
 *  say why a change was allowed as plainly as why one was refused. */
export interface LicensedScope {
  /** 0-based indices into the before side */
  paragraphs: Set<number>
  whole: boolean
  /** one line per note, in the author's terms */
  because: string[]
  /** notes that licensed nothing, and why — orphaned, ambiguous, not the
   *  author's */
  ignored: string[]
  /** each note that licensed something, with its own range — so a change
   *  can be owed to THE note it fell in, not only to the merged set (A72-7) */
  notes: { id: string; range: 'scene' | [number, number] }[]
}

/** THE COVERED RANGE OF ONE NOTE, resolved against the before side.
 *
 *  A passage note records the verbatim text of every paragraph it covered
 *  (`anchor.paragraphs`, A49-1). The resolution gives where the FIRST one
 *  is now; the rest must follow it contiguously, in order, or the note no
 *  longer describes one passage and cannot license one. A single occurrence
 *  found elsewhere is a drifted passage, which is fine; two occurrences is
 *  ambiguity, which licenses nothing. */
function coveredRange(before: string[], n: ResolvedAnnotation): [number, number] | 'ambiguous' | 'orphaned' {
  const texts = (n.anchor.paragraphs?.length ? n.anchor.paragraphs : [n.anchor.quote ?? '']).map(norm)
  const normed = before.map(norm)
  const matchesAt = (start: number): boolean =>
    texts.every((t, k) => {
      const p = normed[start + k]
      // `anchor.paragraphs` records whole paragraphs (annotations.ts); when a
      // note predates that field only its `quote` is known, which may be a
      // fragment of the first paragraph — so the first entry is matched by
      // containment and the rest exactly
      return p !== undefined && (k === 0 ? p.includes(t) : p === t)
    })
  const at = n.resolution.paragraph
  if (at !== null && at >= 0 && matchesAt(at)) return [at, at + texts.length - 1]
  const hits: number[] = []
  for (let i = 0; i + texts.length <= normed.length; i++) if (matchesAt(i)) hits.push(i)
  if (hits.length === 1) return [hits[0], hits[0] + texts.length - 1]
  if (hits.length > 1) return 'ambiguous'
  return 'orphaned'
}

/** What a set of handed notes licenses on a before side. Only the AUTHOR'S
 *  open notes count: a note arc wrote may be handed for context, but it was
 *  never an instruction to change the book, and letting it widen the set
 *  would let a pass license its own edits. */
export function licensedScope(before: string[], notes: ResolvedAnnotation[]): LicensedScope {
  const scope: LicensedScope = { paragraphs: new Set(), whole: false, because: [], ignored: [], notes: [] }
  for (const n of notes) {
    if (n.kind === 'keypoint') { scope.ignored.push(`${n.id}: a key point marks what a passage must get across, it does not ask for change`); continue }
    if (n.by === 'agent') { scope.ignored.push(`${n.id}: arc wrote it, so it licenses nothing`); continue }
    if (n.status && n.status !== 'open') { scope.ignored.push(`${n.id}: ${n.status}, not open`); continue }
    if (n.resolution.state === 'orphaned' || n.resolution.state === 'no-scene') {
      scope.ignored.push(`${n.id}: its passage is no longer in the scene`); continue
    }
    if (n.anchor.paragraph == null) {
      // A scene note is about the section: every paragraph may change, and
      // the receipt says that was the author's own scope, not arc's.
      scope.whole = true
      scope.notes.push({ id: n.id, range: 'scene' })
      scope.because.push(`${n.id} is about the whole scene`)
      continue
    }
    const range = coveredRange(before, n)
    if (range === 'ambiguous') { scope.ignored.push(`${n.id}: its passage appears more than once, so it cannot be placed`); continue }
    if (range === 'orphaned') { scope.ignored.push(`${n.id}: its passage is no longer in the scene`); continue }
    const [from, to] = range
    for (let i = from; i <= to; i++) scope.paragraphs.add(i)
    scope.notes.push({ id: n.id, range: [from, to] })
    scope.because.push(from === to ? `${n.id} points at ¶${from + 1}` : `${n.id} covers ¶${from + 1}–¶${to + 1}`)
  }
  return scope
}

/** One change the alignment found, said in the before side's terms. */
export interface Change {
  kind: 'changed' | 'del' | 'ins' | 'split' | 'join'
  /** the before-side paragraph(s) it touches; for an insertion, the one it
   *  sits beside */
  source: number[]
  /** for an insertion: the before-side index it was spliced in front of, so
   *  the record can say *before ¶1* for one at the top rather than *after* a
   *  paragraph it is not after */
  at?: number
  /** 0-based draft index, when there is one */
  draft: number | null
  licensed: boolean
}

export interface Radius {
  ok: boolean
  changes: Change[]
  /** the changes outside the licensed scope, 1-based for the author */
  outside: string[]
  scope: LicensedScope
}

/** MEASURE IT. Every difference between the before and after sides is
 *  attributed to a source paragraph, and each attribution is checked against
 *  the licensed set:
 *
 *  · a rewritten or deleted paragraph is licensed if its source is;
 *  · an inserted paragraph is licensed if it sits BESIDE a licensed source
 *    paragraph — the rewrite of a passage may come back as two paragraphs,
 *    and the extra one lands next to the one it grew from. An insertion in a
 *    gap no note touches is a new paragraph nobody asked for;
 *  · a split is a rewrite plus an adjacent insertion; a join is a rewrite
 *    plus an adjacent deletion. Both are judged by their sources, so a join
 *    that swallows an unlicensed neighbour is refused for the neighbour.
 *
 *  Reordered text falls out as deletions and insertions where it was and
 *  where it went, and both ends are judged — moving a paragraph nobody asked
 *  about is changing prose nobody asked about. */
export function blastRadius(before: string[], after: string[], scope: LicensedScope): Radius {
  const aligned = alignParagraphs(before, after)
  const licensed = (i: number): boolean => scope.whole || scope.paragraphs.has(i)
  const changes: Change[] = []
  for (const a of aligned) {
    if (a.kind === 'same') continue
    if (a.kind === 'changed') {
      changes.push({ kind: 'changed', source: [a.mainIndex!], draft: a.draftIndex, licensed: licensed(a.mainIndex!) })
    } else if (a.kind === 'del') {
      changes.push({ kind: 'del', source: [a.mainIndex!], draft: null, licensed: licensed(a.mainIndex!) })
    } else {
      // An insertion belongs to the passage it sits beside: the source
      // paragraph before the insertion point, or the one at it.
      const at = mainInsertionPoint(aligned, a.draftIndex!)
      const beside = [at - 1, at].filter(i => i >= 0 && i < before.length)
      const ok = scope.whole || beside.some(i => scope.paragraphs.has(i))
      changes.push({ kind: 'ins', source: beside, at, draft: a.draftIndex, licensed: ok })
    }
  }
  // Name splits and joins for the record, by the shape they leave: a rewrite
  // with an insertion right after it, or with a deletion right after it.
  for (let i = 0; i < changes.length - 1; i++) {
    const c = changes[i], n = changes[i + 1]
    if (c.kind === 'changed' && n.kind === 'ins' && n.source.includes(c.source[0])) { c.kind = 'split' }
    if (c.kind === 'changed' && n.kind === 'del' && n.source[0] === c.source[0] + 1) { c.kind = 'join' }
  }
  const place = (c: Change): string =>
    c.at === 0 ? 'a new paragraph before ¶1' : `a new paragraph after ¶${c.at ?? (c.source[0] ?? -1) + 1}`
  const outside = changes.filter(c => !c.licensed).map(c => c.kind === 'ins' ? place(c) : `¶${c.source[0] + 1}`)
  return { ok: outside.length === 0, changes, outside: [...new Set(outside)], scope }
}

/** THE CHANGES THE ANSWER DID MAKE, in scope, as the receipt names them —
 *  so a held gate is as legible as a refused one: not only "nothing outside"
 *  but "¶5 changed, and that was licensed". */
export const changedNames = (r: Radius): string[] =>
  [...new Set(r.changes.filter(c => c.licensed).map(c =>
    c.kind === 'ins' ? (c.at === 0 ? 'a new paragraph before ¶1' : `a new paragraph after ¶${c.at ?? 0}`) : `¶${c.source[0] + 1}`))]

/** The licensed scope as the receipt names it: `¶3`, `¶5–¶6`, `scene`. */
export const scopeNames = (scope: LicensedScope): string[] => {
  if (scope.whole) return ['scene']
  const idx = [...scope.paragraphs].sort((a, b) => a - b)
  const out: string[] = []
  for (let i = 0; i < idx.length; i++) {
    let j = i
    while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) j++
    out.push(i === j ? `¶${idx[i] + 1}` : `¶${idx[i] + 1}–¶${idx[j] + 1}`)
    i = j
  }
  return out
}

/** The sentence the author reads. Names what moved outside the notes, in
 *  paragraph numbers they can find on the page, and what to do next. */
export const overreachSentence = (outside: string[]): string =>
  `that revision changed ${outside.join(', ')}, which none of your notes point at — nothing was written. Ask again; if it keeps reaching past your notes, widen a note or ask for a clean pass instead.`
