// THE BLAST-RADIUS GATE, measured (A72-6). Pure: two paragraph lists and the
// notes that license changes between them. No story, no model, no disk.
//
// The claim it holds is U2's loudest: a minimal revision changes what the
// notes point at and NOTHING ELSE. Pinned here, case by case, in the shapes an
// answer actually comes back in — a rewrite in scope, a rewrite out of scope,
// an insertion beside a licensed passage and one in a gap nobody touched, a
// deletion, a split, a join that swallows a neighbour, duplicate paragraphs,
// text that moved, a note that covers several paragraphs, a scene-scoped
// note, a note arc wrote, a note whose passage is gone, and whitespace — the
// last explicitly, because "unchanged" has to mean what the paragraph model
// means.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ResolvedAnnotation } from 'arc-canon-graph'
import { blastRadius, changedNames, licensedScope, overreachSentence, paragraphsOf, scopeNames } from '../src/blast-radius.ts'

const BEFORE = [
  'One. The first paragraph, as the author left it.',
  'Two. The second, which a note points at.',
  'Three. The third, untouched by any note.',
  'Four. The fourth, which a two-paragraph note begins on.',
  'Five. The fifth, which that note runs into.',
  'Six. The last, untouched.',
]

const note = (id: string, paragraph: number | null, over: Partial<ResolvedAnnotation> = {}): ResolvedAnnotation => ({
  id, body: 'slower here', status: 'open',
  anchor: paragraph === null
    ? { scene: 'sc.01-1' }
    : { scene: 'sc.01-1', paragraph, quote: BEFORE[paragraph].slice(0, 12), paragraphs: [BEFORE[paragraph]] },
  resolution: { state: 'resolved', paragraph },
  ...over,
})

const measure = (after: string[], notes: ResolvedAnnotation[]) =>
  blastRadius(BEFORE, after, licensedScope(BEFORE, notes))

const with_ = (changes: Record<number, string | null>, inserts: Record<number, string[]> = {}): string[] => {
  const out: string[] = []
  BEFORE.forEach((p, i) => {
    if (inserts[i]) out.push(...inserts[i])
    const c = changes[i]
    if (c === null) return
    out.push(c ?? p)
  })
  if (inserts[BEFORE.length]) out.push(...inserts[BEFORE.length])
  return out
}

// ---- in scope, and out ------------------------------------------------------

test('a rewrite of the paragraph a note points at is in scope, and nothing else changed', () => {
  const r = measure(with_({ 1: 'Two, rewritten as the note asked.' }), [note('note.1', 1)])
  assert.equal(r.ok, true)
  assert.deepEqual(r.changes.map(c => [c.kind, c.source, c.licensed]), [['changed', [1], true]])
  assert.deepEqual(scopeNames(r.scope), ['¶2'])
})

test('a rewrite of a paragraph no note points at is refused, by number', () => {
  const r = measure(with_({ 1: 'Two, rewritten.', 2: 'Three, which nobody asked about.' }), [note('note.1', 1)])
  assert.equal(r.ok, false)
  assert.deepEqual(r.outside, ['¶3'])
  assert.match(overreachSentence(r.outside), /changed ¶3, which none of your notes point at/)
  assert.match(overreachSentence(r.outside), /nothing was written/)
})

test('an answer that changes nothing is in scope — the pass may decline to change', () => {
  assert.equal(measure([...BEFORE], [note('note.1', 1)]).ok, true)
})

// ---- insertions and deletions ------------------------------------------------

test('a paragraph inserted beside a licensed passage belongs to its replacement', () => {
  // the rewrite came back as two paragraphs: the one it grew from, plus one
  const grew = measure(with_({ 1: 'Two, the first half.' }, { 2: ['Two, the second half, new.'] }), [note('note.1', 1)])
  assert.equal(grew.ok, true, grew.outside.join(', '))
  assert.ok(grew.changes.some(c => c.kind === 'split' || c.kind === 'ins'))
  // or before it
  const ahead = measure(with_({}, { 1: ['A lead-in to two, new.'] }), [note('note.1', 1)])
  assert.equal(ahead.ok, true, ahead.outside.join(', '))
})

test('a paragraph inserted in a gap no note touches is a new paragraph nobody asked for', () => {
  const r = measure(with_({}, { 5: ['Something new between five and six.'] }), [note('note.1', 1)])
  assert.equal(r.ok, false)
  assert.deepEqual(r.outside, ['a new paragraph after ¶5'])
  // and one at the very top is BEFORE ¶1, not after a paragraph it is not after
  const top = measure(with_({}, { 0: ['A new opening nobody asked for.'] }), [note('note.1', 1)])
  assert.equal(top.ok, false)
  assert.deepEqual(top.outside, ['a new paragraph before ¶1'])
})

test('a held measurement names what DID change, so the receipt is as legible as a refusal', () => {
  const r = measure(with_({ 1: 'Two, rewritten.' }, { 2: ['Two, continued.'] }), [note('note.1', 1)])
  assert.equal(r.ok, true)
  assert.deepEqual(changedNames(r), ['¶2', 'a new paragraph after ¶2'])
})

test('deleting the licensed paragraph is in scope; deleting any other is not', () => {
  assert.equal(measure(with_({ 1: null }), [note('note.1', 1)]).ok, true)
  const r = measure(with_({ 2: null }), [note('note.1', 1)])
  assert.equal(r.ok, false)
  assert.deepEqual(r.outside, ['¶3'])
})

test('a join that swallows an unlicensed neighbour is refused for the neighbour', () => {
  // two and three become one paragraph; only two was licensed
  const joined = [...BEFORE]
  joined.splice(1, 2, `${BEFORE[1]} ${BEFORE[2]}`)
  const r = measure(joined, [note('note.1', 1)])
  assert.equal(r.ok, false)
  assert.deepEqual(r.outside, ['¶3'])
  // and licensed on both sides, the same join is fine
  assert.equal(measure(joined, [note('note.1', 1), note('note.2', 2)]).ok, true)
})

// ---- the shapes that fool an index --------------------------------------------

test('duplicate paragraphs: the resolved index is what the note licenses, not every copy', () => {
  const dup = [...BEFORE]; dup[4] = BEFORE[1]   // five reads the same as two
  const n = note('note.1', 1)
  const scope = licensedScope(dup, [n])
  assert.deepEqual([...scope.paragraphs], [1], 'the one it resolved to')
  const after = [...dup]; after[4] = 'Five, rewritten, though it read like two.'
  const r = blastRadius(dup, after, scope)
  assert.equal(r.ok, false)
  assert.deepEqual(r.outside, ['¶5'])
})

test('a note whose passage now appears more than once licenses nothing', () => {
  const dup = [...BEFORE]; dup[4] = BEFORE[1]
  // the note resolved to nowhere in particular — only its words are known
  const n = note('note.1', 1, { resolution: { state: 'drifted', paragraph: null } })
  const scope = licensedScope(dup, [n])
  assert.equal(scope.paragraphs.size, 0)
  assert.match(scope.ignored[0], /appears more than once/)
})

test('text that moved is judged at both ends', () => {
  // three moves to the end; nobody asked
  const moved = [...BEFORE]; const [three] = moved.splice(2, 1); moved.push(three)
  const r = measure(moved, [note('note.1', 1)])
  assert.equal(r.ok, false)
  assert.ok(r.outside.length >= 1)
})

// ---- what a note covers ----------------------------------------------------------

test('a two-paragraph note licenses its whole covered range, not only the first paragraph', () => {
  const n = note('note.4', 3, { anchor: { scene: 'sc.01-1', paragraph: 3, quote: 'Four.', paragraphs: [BEFORE[3], BEFORE[4]] } })
  const scope = licensedScope(BEFORE, [n])
  assert.deepEqual([...scope.paragraphs].sort(), [3, 4])
  assert.deepEqual(scopeNames(scope), ['¶4–¶5'])
  assert.equal(measure(with_({ 3: 'Four, rewritten.', 4: 'Five, rewritten.' }), [n]).ok, true)
})

test('a covered range that no longer runs contiguously licenses nothing', () => {
  const broken = [...BEFORE]; broken.splice(4, 0, 'Something between four and five now.')
  const n = note('note.4', 3, { anchor: { scene: 'sc.01-1', paragraph: 3, quote: 'Four.', paragraphs: [BEFORE[3], BEFORE[4]] } })
  const scope = licensedScope(broken, [n])
  assert.equal(scope.paragraphs.size, 0, 'the passage it described is not one passage any more')
})

test('a scene-scoped author note licenses the whole scene, and the record says why', () => {
  const scope = licensedScope(BEFORE, [note('note.s', null)])
  assert.equal(scope.whole, true)
  assert.deepEqual(scopeNames(scope), ['scene'])
  assert.match(scope.because[0], /about the whole scene/)
  assert.equal(measure(with_({ 0: 'One, rewritten.', 5: 'Six, rewritten.' }), [note('note.s', null)]).ok, true)
})

test('a note arc wrote never widens the set, and neither does a key point', () => {
  const agent = note('note.a', 2, { by: 'agent' })
  const kp = note('kp.1', 2, { kind: 'keypoint' })
  const scope = licensedScope(BEFORE, [note('note.1', 1), agent, kp])
  assert.deepEqual([...scope.paragraphs], [1])
  assert.ok(scope.ignored.some(s => s.startsWith('note.a') && /licenses nothing/.test(s)))
  assert.ok(scope.ignored.some(s => s.startsWith('kp.1')))
})

test('an orphaned note, and a resolved one, license nothing', () => {
  const orphan = note('note.o', 2, { resolution: { state: 'orphaned', paragraph: null } })
  const done = note('note.d', 2, { status: 'resolved' })
  const scope = licensedScope(BEFORE, [orphan, done])
  assert.equal(scope.paragraphs.size, 0)
  assert.equal(scope.ignored.length, 2)
})

// ---- whitespace, explicitly ---------------------------------------------------

test('trailing whitespace is not a change; whitespace inside a paragraph is', () => {
  const trailing = BEFORE.map(p => p + '   ')
  assert.deepEqual(paragraphsOf(trailing.join('\n\n')), BEFORE, 'the paragraph model trims')
  assert.equal(blastRadius(BEFORE, paragraphsOf(trailing.join('\n\n')), licensedScope(BEFORE, [])).ok, true)
  // the model compares the trimmed paragraph whole, so a doubled space inside
  // ¶3 is a change to ¶3 — and ¶3 is not licensed
  const inner = [...BEFORE]; inner[2] = BEFORE[2].replace('The third', 'The  third')
  assert.notEqual(inner[2], BEFORE[2], 'the doubled space is really there')
  const r = blastRadius(BEFORE, inner, licensedScope(BEFORE, [note('note.1', 1)]))
  assert.equal(r.ok, false)
  assert.deepEqual(r.outside, ['¶3'])
  // and a blank-line count between paragraphs is not a change either
  assert.deepEqual(paragraphsOf(BEFORE.join('\n\n\n\n')), BEFORE)
})
