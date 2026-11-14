// A note the book has answered closes itself — at the accept, by resolving,
// never deleting (A63-4) — and AT PARAGRAPH GRAIN (A72-7): a note resolves
// when the paragraph its change landed in is accepted, and stays open when
// that paragraph is discarded, whatever else in the scene was taken.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { git, makeStory, writeScene } from './fixture.ts'

const STORY = makeStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

const { closeAnsweredNotes, answeredNow, settleAnsweredNotes, createAnnotation, annotations, updateAnnotation } = await import('../src/annotations.ts')
const { recordGenerated } = await import('../src/ledger.ts')
const { attribute, readNoteResolutions } = await import('../src/note-lifecycle.ts')
const { paragraphsOf } = await import('../src/blast-radius.ts')
const { proseAccept, proseAcceptParagraph, proseRejectParagraph, proseAcceptSentence, proseDiscard, proseDraft } = await import('../src/story.ts')
const { baseOf } = await import('../src/base.ts')
/** THE BASE a decision is made about (A72-3), taken the moment before the
 *  decision — which is what a viewer that has just rendered the diff sends. */
const basesOf = (files?: string[]): Record<string, string> =>
  Object.fromEntries((files ?? []).map(f => [f, baseOf(f)]))

const FILE = 'prose/ch-01/scene-01.md'
const abs = path.join(STORY, FILE)
const status = (id: string) => annotations().find(n => n.id === id)?.status
const change = () => proseDraft().changes.find(c => c.file === FILE)
const badges = () => { const c = change(); return c ? (answeredNow(c) ?? []).map(a => [a.id, a.state]) : [] }

const P1 = 'Original first paragraph.', P2 = 'Second paragraph, as written.', P3 = 'Third paragraph, left alone.'
const reset = (body = `${P1}\n\n${P2}\n\n${P3}`) => {
  git(STORY, 'checkout', 'HEAD', '--', '.'); git(STORY, 'clean', '-fdq')
  fs.rmSync(path.join(STORY, '.arc'), { recursive: true, force: true })
  fs.rmSync(path.join(STORY, 'annotations'), { recursive: true, force: true })
  writeScene(STORY, FILE, 'sc.01-1', body)
  git(STORY, 'add', '-A'); if (git(STORY, 'status', '--porcelain').trim()) git(STORY, 'commit', '-qm', 'seed')
}

/** THE PASS LANDS: the scene as handed → the revision, and the ledger
 *  records what each handed note is owed, exactly as `work-notes.ts` does. */
const landed = (edits: Record<number, string | null>, handed: string[], inserts: Record<number, string[]> = {}) => {
  const raw = fs.readFileSync(abs, 'utf8')
  const fm = raw.match(/^---\n[\s\S]*?\n---\n/)![0]
  const before = paragraphsOf(raw.slice(fm.length))
  const after: string[] = []
  before.forEach((p, i) => { if (inserts[i]) after.push(...inserts[i]); if (edits[i] !== null) after.push(edits[i] ?? p) })
  if (inserts[before.length]) after.push(...inserts[before.length])
  // the notes AS HANDED — resolved against the scene before the pass wrote,
  // which is what the cluster carried into the landing
  const notes = annotations().filter(n => handed.includes(n.id))
  const next = fm + '\n' + after.join('\n\n') + '\n'
  fs.writeFileSync(abs, next)
  recordGenerated(FILE, next, { origin: 'revise', scene: 'sc.01-1', notes: handed, attribution: attribute(before, after, notes) })
}
const commitNotes = () => { git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'notes') }

// ---- the whole-scene accept, as before ----------------------------------------

test('an accept that is refused leaves the notes it would have closed open', () => {
  reset()
  const answered = createAnnotation({ scene: 'sc.01-1', paragraph: 0, quote: 'Original first', body: 'slower' })
  commitNotes()
  landed({ 0: 'A slower first paragraph.' }, [answered.id])

  // The author reads the diff — and then types in the scene in another view.
  const read = basesOf([FILE])
  fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace('A slower first paragraph.', 'Slower still, in their own hand.'))

  assert.throws(() => proseAccept(undefined, [FILE], read),
    (e: unknown) => (e as { status?: number }).status === 409)
  // Notes close only after an accept returns, so a refused one closes none —
  // the structure says so, and this says the structure holds (A72-3).
  assert.equal(status(answered.id), 'open', 'nothing was answered, because nothing was accepted')
  assert.equal(proseDraft().changes.length, 1, 'and the change is still waiting')
})

test('the notes a change was written from resolve when that change is accepted whole; bystanders, the author\'s own decisions and key points are untouched', () => {
  reset()
  const answered = createAnnotation({ scene: 'sc.01-1', paragraph: 0, quote: 'Original first', body: 'slower' })
  const bystander = createAnnotation({ scene: 'sc.01-1', body: 'a thought the pass was never handed' })
  const already = createAnnotation({ scene: 'sc.01-1', body: 'closed by the author already' })
  updateAnnotation(already.id, { status: 'dropped' })
  const kp = createAnnotation({ scene: 'sc.01-1', paragraph: 0, quote: 'Original first', body: 'a marker', kind: 'keypoint', by: 'author' })
  const agent = createAnnotation({ scene: 'sc.01-1', paragraph: 0, quote: 'Original first', body: 'arc thinks: slower', by: 'agent' })
  commitNotes()
  landed({ 0: 'A slower first paragraph.' }, [answered.id, already.id, kp.id, agent.id])

  // Not yet: the change is a proposal until the author takes it.
  assert.equal(status(answered.id), 'open')
  assert.deepEqual(badges(), [[answered.id, 'waiting']], 'the badge is on the handed note whose change pends, and no other')

  proseAccept(undefined, [FILE], basesOf([FILE]))
  const closed = closeAnsweredNotes([FILE])
  assert.deepEqual(closed, [answered.id], 'exactly the open note the pass was handed')
  assert.equal(status(answered.id), 'resolved', 'resolved — it still exists for the style learner')
  assert.equal(status(bystander.id), 'open', 'a note the pass never saw is untouched')
  assert.equal(status(already.id), 'dropped', 'the author\'s own decision stands')
  assert.equal(status(agent.id), 'open', 'a note arc wrote was never an instruction, so nothing answers it')
  assert.equal(annotations().find(n => n.id === kp.id)?.kind, 'keypoint', 'a keypoint is never a note to close')
  assert.equal(proseDraft().changes.length, 0)
  // the link, for inspection and slice 4
  const link = readNoteResolutions().find(r => r.note === answered.id)
  assert.ok(link && link.file === FILE && typeof link.decision === 'string', 'which decision resolved it is on record')
  // and again, after a restart, resolves nothing twice
  assert.deepEqual(closeAnsweredNotes([FILE]), [])
  assert.equal(readNoteResolutions().length, 1)
})

test('a file the ledger never wrote closes nothing, and never throws', () => {
  reset()
  assert.deepEqual(closeAnsweredNotes([FILE]), [])
  assert.deepEqual(closeAnsweredNotes(['prose/does/not/exist.md']), [])
})

test('an entry from before attribution was recorded closes every handed note at scene grain, once nothing pends — as it always did', () => {
  reset()
  const a = createAnnotation({ scene: 'sc.01-1', paragraph: 0, quote: 'Original first', body: 'slower' })
  const b = createAnnotation({ scene: 'sc.01-1', paragraph: 1, quote: 'Second', body: 'cut it' })
  commitNotes()
  const next = fs.readFileSync(abs, 'utf8').replace(P1, 'A slower first paragraph.').replace(P2, 'Second, cut.')
  fs.writeFileSync(abs, next)
  recordGenerated(FILE, next, { origin: 'revise', scene: 'sc.01-1', notes: [a.id, b.id] })
  assert.deepEqual(badges(), [], 'no provenance, no paragraph-grain badge — the rail falls back to the handed list')
  proseAcceptParagraph(FILE, { side: 'draft', paragraph: 0 }, baseOf(FILE))
  assert.deepEqual(closeAnsweredNotes([FILE]), [], 'still pending: the old rule waits for the scene')
  proseAcceptParagraph(FILE, { side: 'draft', paragraph: 1 }, baseOf(FILE))
  assert.deepEqual(closeAnsweredNotes([FILE]).sort(), [a.id, b.id].sort())
})

// ---- paragraph grain (A72-7) --------------------------------------------------------

test('two notes on two paragraphs: accepting one paragraph resolves its note and leaves the other reading answered in the draft', () => {
  reset()
  const a = createAnnotation({ scene: 'sc.01-1', paragraph: 0, quote: 'Original first', body: 'slower' })
  const b = createAnnotation({ scene: 'sc.01-1', paragraph: 1, quote: 'Second', body: 'cut it' })
  commitNotes()
  landed({ 0: 'A slower first paragraph.', 1: 'Second, cut.' }, [a.id, b.id])
  assert.deepEqual(badges(), [[a.id, 'waiting'], [b.id, 'waiting']])

  proseAcceptParagraph(FILE, { side: 'draft', paragraph: 0 }, baseOf(FILE))
  assert.deepEqual(closeAnsweredNotes([FILE]), [a.id], 'its paragraph is in the book')
  assert.equal(status(a.id), 'resolved')
  assert.equal(status(b.id), 'open', 'the other paragraph still waits')
  assert.deepEqual(badges(), [[b.id, 'waiting']], 'and the rail still says so')
  assert.equal(proseDraft().changes.length, 1)
})

test('accepting one of two sentences does not resolve the note; the rest of the paragraph still waits', () => {
  reset()
  const a = createAnnotation({ scene: 'sc.01-1', paragraph: 0, quote: 'Original first', body: 'slower' })
  commitNotes()
  landed({ 0: 'A slower first sentence. A slower second sentence.' }, [a.id])
  proseAcceptSentence(FILE, { paragraph: 0, side: 'draft', sentence: 0 }, baseOf(FILE))
  assert.deepEqual(closeAnsweredNotes([FILE]), [])
  assert.equal(status(a.id), 'open')
  assert.deepEqual(badges(), [[a.id, 'waiting']])
  proseAcceptSentence(FILE, { paragraph: 0, side: 'draft', sentence: 1 }, baseOf(FILE))
  assert.deepEqual(closeAnsweredNotes([FILE]), [], 'both new sentences are in, but the original one is still there: the paragraph is not yet what the pass wrote')
  // the deletion of the original sentence is the last decision of the three
  proseAcceptSentence(FILE, { paragraph: 0, side: 'main', sentence: 0 }, baseOf(FILE))
  assert.deepEqual(closeAnsweredNotes([FILE]), [a.id], 'the whole paragraph is in now')
})

test('a discarded paragraph leaves its note open — and no badge — even when the rest of the scene was accepted', () => {
  reset()
  const a = createAnnotation({ scene: 'sc.01-1', paragraph: 0, quote: 'Original first', body: 'slower' })
  const b = createAnnotation({ scene: 'sc.01-1', paragraph: 1, quote: 'Second', body: 'cut it' })
  commitNotes()
  landed({ 0: 'A slower first paragraph.', 1: 'Second, cut.' }, [a.id, b.id])

  proseRejectParagraph(FILE, { side: 'draft', paragraph: 1 }, baseOf(FILE))
  assert.deepEqual(badges(), [[a.id, 'waiting']], 'b\'s change is gone, so its badge is')
  proseAcceptParagraph(FILE, { side: 'draft', paragraph: 0 }, baseOf(FILE))
  assert.deepEqual(closeAnsweredNotes([FILE]), [a.id])
  assert.equal(proseDraft().changes.length, 0, 'the scene has settled')
  assert.equal(status(b.id), 'open', 'taking other text is not taking b\'s change')
  assert.deepEqual(closeAnsweredNotes([FILE]), [], 'and settling does not close it either')
})

test('discarding the whole draft leaves every note open, the scene note included', () => {
  reset()
  const a = createAnnotation({ scene: 'sc.01-1', paragraph: 0, quote: 'Original first', body: 'slower' })
  const s = createAnnotation({ scene: 'sc.01-1', body: 'the whole thing drags' })
  commitNotes()
  landed({ 0: 'A slower first paragraph.', 2: 'Third, quicker.' }, [a.id, s.id])
  proseDiscard(FILE, baseOf(FILE))
  assert.deepEqual(closeAnsweredNotes([FILE]), [])
  assert.equal(status(a.id), 'open'); assert.equal(status(s.id), 'open')
  assert.deepEqual(badges(), [])
})

test('a scene note resolves after the scene settles if anything of it was taken — the grooming convention, tested on its own', () => {
  reset()
  const s = createAnnotation({ scene: 'sc.01-1', body: 'the whole thing drags' })
  commitNotes()
  landed({ 0: 'One, quicker.', 2: 'Third, quicker.' }, [s.id])
  proseAcceptParagraph(FILE, { side: 'draft', paragraph: 0 }, baseOf(FILE))
  assert.deepEqual(closeAnsweredNotes([FILE]), [], 'not settled: the other paragraph still waits')
  assert.deepEqual(badges(), [[s.id, 'partly']])
  proseRejectParagraph(FILE, { side: 'draft', paragraph: 2 }, baseOf(FILE))
  assert.equal(proseDraft().changes.length, 0)
  assert.deepEqual(closeAnsweredNotes([FILE]), [s.id], 'settled, with one of its changes in the book')
})

test('a note across two paragraphs follows both: partly accepted after one, resolved after the other', () => {
  reset()
  const w = createAnnotation({ scene: 'sc.01-1', paragraph: 0, quote: 'Original first paragraph. Second paragraph', body: 'these two run together' })
  commitNotes()
  assert.equal(annotations().find(n => n.id === w.id)?.anchor.paragraphs?.length, 2, 'the anchor covers both')
  landed({ 0: 'One, run on.', 1: 'Two, run on.' }, [w.id])
  proseAcceptParagraph(FILE, { side: 'draft', paragraph: 0 }, baseOf(FILE))
  assert.deepEqual(closeAnsweredNotes([FILE]), [])
  assert.deepEqual(badges(), [[w.id, 'partly']])
  proseAcceptParagraph(FILE, { side: 'draft', paragraph: 1 }, baseOf(FILE))
  assert.deepEqual(closeAnsweredNotes([FILE]), [w.id])
})

test('a deletion the note asked for resolves it when the deletion is accepted', () => {
  reset()
  const a = createAnnotation({ scene: 'sc.01-1', paragraph: 1, quote: 'Second', body: 'cut this paragraph' })
  commitNotes()
  landed({ 1: null }, [a.id])
  assert.deepEqual(badges(), [[a.id, 'waiting']])
  proseAcceptParagraph(FILE, { side: 'main', paragraph: 1 }, baseOf(FILE))
  assert.deepEqual(closeAnsweredNotes([FILE]), [a.id])
})

test('a note edited while the draft waited is a new instruction: the accept does not close it', () => {
  reset()
  const a = createAnnotation({ scene: 'sc.01-1', paragraph: 0, quote: 'Original first', body: 'slower' })
  commitNotes()
  landed({ 0: 'A slower first paragraph.' }, [a.id])
  updateAnnotation(a.id, { body: 'no — faster, and shorter' })
  assert.deepEqual(badges(), [], 'the draft does not answer what the note says now')
  proseAccept(undefined, [FILE], basesOf([FILE]))
  assert.deepEqual(closeAnsweredNotes([FILE]), [])
  assert.equal(status(a.id), 'open')
})

test('the author replaces the generated span by hand before accepting: the note stays open; unrelated text inserted above does not disturb it', () => {
  reset()
  const a = createAnnotation({ scene: 'sc.01-1', paragraph: 0, quote: 'Original first', body: 'slower' })
  const b = createAnnotation({ scene: 'sc.01-1', paragraph: 1, quote: 'Second', body: 'cut it' })
  commitNotes()
  landed({ 0: 'A slower first paragraph.', 1: 'Second, cut.' }, [a.id, b.id])
  // their own hand over a's span, and a new paragraph of their own above b's
  const raw = fs.readFileSync(abs, 'utf8')
  fs.writeFileSync(abs, raw.replace('A slower first paragraph.', 'My own first paragraph.').replace('Second, cut.', 'A paragraph of my own.\n\nSecond, cut.'))
  assert.deepEqual(badges(), [[b.id, 'waiting']], 'a\'s change is gone; b\'s is still there to find')
  proseAccept(undefined, [FILE], basesOf([FILE]))
  assert.deepEqual(closeAnsweredNotes([FILE]), [b.id])
  assert.equal(status(a.id), 'open', 'accepting their own words is not accepting arc\'s change for a')
})

test('the author deletes the generated span before accepting: the note stays open, and the wire says no note is answered', () => {
  reset()
  const a = createAnnotation({ scene: 'sc.01-1', paragraph: 0, quote: 'Original first', body: 'slower' })
  commitNotes()
  landed({ 0: 'A slower first paragraph.' }, [a.id])
  const raw = fs.readFileSync(abs, 'utf8')
  fs.writeFileSync(abs, raw.replace('A slower first paragraph.\n\n', ''))
  const c = change()!
  assert.deepEqual(answeredNow(c), [], 'provenance exists and nothing of it pends: an empty list, not the handed-list fallback')
  proseAccept(undefined, [FILE], basesOf([FILE]))
  assert.deepEqual(closeAnsweredNotes([FILE]), [])
  assert.equal(status(a.id), 'open')
})

test('a crash between the commit and the close: the startup sweep resolves what the book already answered, once', () => {
  reset()
  const a = createAnnotation({ scene: 'sc.01-1', paragraph: 0, quote: 'Original first', body: 'slower' })
  commitNotes()
  landed({ 0: 'A slower first paragraph.' }, [a.id])
  proseAccept(undefined, [FILE], basesOf([FILE]))   // the route would close now; the process died instead
  assert.equal(status(a.id), 'open')
  assert.deepEqual(settleAnsweredNotes(), [a.id])
  assert.equal(status(a.id), 'resolved')
  assert.deepEqual(settleAnsweredNotes(), [])
})
