// THE NOTE LIFECYCLE, pure (A72-7): what a pass owes each handed note, and
// where that stands against the two versions of the scene. No disk, no git.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ResolvedAnnotation } from 'arc-canon-graph'
import { answeredStates, attribute, noteInstruction } from '../src/note-lifecycle.ts'

const BEFORE = ['One, as the author left it.', 'Two, which a note points at.', 'Three, untouched.', 'Four, which another note points at.']

const note = (id: string, paragraph: number | null, over: Partial<ResolvedAnnotation> = {}): ResolvedAnnotation => ({
  id, body: 'slower here', status: 'open',
  anchor: paragraph === null ? { scene: 'sc.01-1' } : { scene: 'sc.01-1', paragraph, quote: BEFORE[paragraph].slice(0, 8), paragraphs: [BEFORE[paragraph]] },
  resolution: { state: 'resolved', paragraph },
  ...over,
})
const n2 = note('note-2', 1), n4 = note('note-4', 3), ns = note('note-s', null)
const now = (notes: ResolvedAnnotation[]) => (id: string) => notes.find(n => n.id === id)

test('each change is owed to the note whose range it fell in; a note that produced no change is owed nothing', () => {
  const after = ['One, as the author left it.', 'Two, rewritten.', 'Three, untouched.', BEFORE[3]]
  const a = attribute(BEFORE, after, [n2, n4])
  assert.deepEqual(a.map(x => [x.id, x.source, x.spans.length]), [['note-2', [2, 2], 1], ['note-4', [4, 4], 0]])
  assert.deepEqual([a[0].spans[0].added, a[0].spans[0].removed], [['Two, rewritten.'], ['Two, which a note points at.']])
  assert.deepEqual([a[0].spans[0].head, a[0].spans[0].landed], [{ added: [0], removed: [1] }, { added: [1], removed: [0] }], 'and how many times each read, at HEAD and as landed')
  assert.equal(a[0].version, noteInstruction(n2))
})

test('a scene note is owed every change; a deletion is owed as something that must be gone', () => {
  const after = ['One, slower.', 'Three, untouched.', 'Four, which another note points at.']
  const a = attribute(BEFORE, after, [ns])
  assert.equal(a[0].source, 'scene')
  assert.deepEqual(a[0].spans.map(s => [s.added, s.removed]), [
    [['One, slower.'], ['One, as the author left it.']],
    [[], ['Two, which a note points at.']],
  ])
})

test('a note arc wrote, or one that cannot be placed, is owed nothing', () => {
  const after = ['One, as the author left it.', 'Two, rewritten.', 'Three, untouched.', 'Four, which another note points at.']
  const agent = note('note-a', 1, { by: 'agent' })
  const lost = note('note-o', 1, { resolution: { state: 'orphaned', paragraph: null }, anchor: { scene: 'sc.01-1', paragraph: 1, quote: 'nowhere', paragraphs: ['Nowhere in the scene.'] } })
  const a = attribute(BEFORE, after, [agent, lost])
  assert.deepEqual(a.map(x => [x.source, x.spans.length]), [[null, 0], [null, 0]])
})

test('where it stands: waiting while pending, accepted once in the book, gone when in neither', () => {
  const after = ['One, as the author left it.', 'Two, rewritten.', 'Three, untouched.', 'Four, rewritten too.']
  const a = attribute(BEFORE, after, [n2, n4])
  const states = (main: string[], draft: string[]) => answeredStates(a, main, draft, now([n2, n4])).map(s => [s.id, s.state])
  assert.deepEqual(states(BEFORE, after), [['note-2', 'waiting'], ['note-4', 'waiting']])
  // ¶2 accepted, ¶4 still pending
  const main2 = [...BEFORE]; main2[1] = 'Two, rewritten.'
  assert.deepEqual(states(main2, after), [['note-2', 'accepted'], ['note-4', 'waiting']])
  // ¶4 rejected instead: its draft went back to the book's words
  const draft2 = [...after]; draft2[3] = BEFORE[3]
  assert.deepEqual(states(main2, draft2), [['note-2', 'accepted'], ['note-4', 'gone']])
  // the author replaced ¶4's generated words by hand before deciding
  const byHand = [...after]; byHand[3] = 'Four, in their own words.'
  assert.deepEqual(states(BEFORE, byHand), [['note-2', 'waiting'], ['note-4', 'gone']])
  // unrelated text inserted above leaves ¶4's span identifiable
  const shifted = ['A new opening.', ...after]
  assert.deepEqual(states(BEFORE, shifted), [['note-2', 'waiting'], ['note-4', 'waiting']])
})

test('a line the scene already says once: inserting it again is not in the book until the book says it twice', () => {
  const dup = [...BEFORE, 'Three, untouched.']   // the pass repeats ¶3 at the end
  const a = attribute(BEFORE, dup, [n4])   // n4 is on the last paragraph, which the repeat lands beside
  assert.equal(a[0].spans.length, 1)
  assert.deepEqual(a[0].spans[0].head, { added: [1], removed: [] })
  assert.deepEqual(a[0].spans[0].landed, { added: [2], removed: [] })
  const st = (main: string[], draft: string[]) => answeredStates(a, main, draft, now([n4]))[0].state
  assert.equal(st(BEFORE, dup), 'waiting', 'the book says it once, as it did; nothing is accepted yet')
  assert.equal(st(dup, dup), 'accepted')
  assert.equal(st(BEFORE, BEFORE), 'gone', 'rejected: the draft is back to once')
})

test('deleting words the book never held is not a decision the book can show: never accepted, waiting until the author decides', () => {
  // ¶2 was a pending hand edit at launch — in the handed scene, not at HEAD
  const head = [...BEFORE]; head[1] = 'Two, as the book has it.'
  const after = BEFORE.filter((_, i) => i !== 1)
  const a = attribute(BEFORE, after, [n2], head)
  assert.deepEqual(a[0].spans[0].head, { added: [], removed: [0] })
  const st = (main: string[], draft: string[]) => answeredStates(a, main, draft, now([n2]))[0].state
  assert.equal(st(head, after), 'waiting', 'HEAD lacking words it never had proves nothing')
  const rejected = [...BEFORE]
  assert.equal(st(head, rejected), 'gone', 'and after the author puts their paragraph back, it is gone, not accepted')
})

test('a multi-paragraph note follows every span; partly when some are in', () => {
  const wide = note('note-w', 1, { anchor: { scene: 'sc.01-1', paragraph: 1, quote: 'Two', paragraphs: [BEFORE[1], BEFORE[2]] } })
  const after = ['One, as the author left it.', 'Two, rewritten.', 'Three, rewritten.', 'Four, which another note points at.']
  const a = attribute(BEFORE, after, [wide])
  assert.deepEqual(a[0].source, [2, 3]); assert.equal(a[0].spans.length, 2)
  const main1 = [...BEFORE]; main1[1] = 'Two, rewritten.'
  assert.deepEqual(answeredStates(a, main1, after, now([wide])).map(s => [s.state, s.accepted, s.of]), [['partly', 1, 2]])
  const main2 = [...main1]; main2[2] = 'Three, rewritten.'
  assert.equal(answeredStates(a, main2, after, now([wide]))[0].state, 'accepted')
})

test('a scene note waits for the scene to settle, resolves if anything of it was taken, and stays open on all-discard', () => {
  const after = ['One, slower.', 'Two, slower.', 'Three, untouched.', 'Four, which another note points at.']
  const a = attribute(BEFORE, after, [ns])
  const st = (main: string[], draft: string[]) => answeredStates(a, main, draft, now([ns]))[0].state
  assert.equal(st(BEFORE, after), 'waiting')
  const one = [...BEFORE]; one[0] = 'One, slower.'
  assert.equal(st(one, after), 'partly', 'not settled yet: ¶2 still pends')
  assert.equal(st(one, one), 'accepted', 'settled with one change taken and the other put back')
  assert.equal(st(BEFORE, BEFORE), 'gone', 'settled with nothing taken: open for the author')
})

test('only the version handed resolves: a note edited while the draft waited is a new instruction', () => {
  const after = ['One, as the author left it.', 'Two, rewritten.', 'Three, untouched.', 'Four, which another note points at.']
  const a = attribute(BEFORE, after, [n2])
  const edited = { ...n2, body: 'no — faster, actually' }
  const main = [...BEFORE]; main[1] = 'Two, rewritten.'
  assert.equal(answeredStates(a, main, after, now([edited]))[0].state, 'edited')
  assert.equal(answeredStates(a, main, after, now([{ ...n2, status: 'working' }]))[0].state, 'accepted', 'flipping it to working is not editing it')
})
