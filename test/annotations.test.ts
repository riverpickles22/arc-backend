// Annotations (conventions §14). The property that matters: a note follows
// its quote, and when the quote is gone it orphans honestly rather than
// reattaching to whatever now occupies its index.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { git, makeStory, writeScene } from './fixture.ts'

const story = makeStory()
process.env.ARC_STORY_PATH = story
const { annotations, createAnnotation, updateAnnotation, orphaned } = await import('../src/annotations.ts')
const { HttpError } = await import('../src/http.ts')

function resetScene(body: string) {
  writeScene(story, 'prose/ch-01/scene-01.md', 'sc.01-1', body)
}

test('a note is filed against a real scene and comes back resolved', () => {
  resetScene('First paragraph here.\n\nSecond paragraph mentions Diego in the doorway.')
  const n = createAnnotation({ scene: 'sc.01-1', paragraph: 1, quote: 'Diego in the doorway', body: 'Diego is furniture here.' })
  assert.match(n.id, /^note\.\d{3}$/)
  assert.equal(n.status, 'open')
  assert.equal(n.resolution.state, 'resolved')
  assert.equal(n.resolution.paragraph, 1)
})

test('an edit above the note drifts it — the quote wins over the index', () => {
  resetScene('A NEW opening paragraph.\n\nFirst paragraph here.\n\nSecond paragraph mentions Diego in the doorway.')
  const n = annotations().find(x => x.body.startsWith('Diego is furniture'))!
  assert.equal(n.resolution.state, 'drifted')
  assert.equal(n.resolution.paragraph, 2)
  assert.match(n.resolution.note!, /moved from paragraph 2 to 3/)
})

test('when the passage is rewritten away the note orphans, keeping its quote', () => {
  resetScene('Something else entirely.\n\nAnd another thing.')
  const n = annotations().find(x => x.body.startsWith('Diego is furniture'))!
  assert.equal(n.resolution.state, 'orphaned')
  assert.equal(n.resolution.paragraph, null)
  assert.equal(n.anchor.quote, 'Diego in the doorway')   // the thought survives its anchor
  assert.equal(orphaned().length, 1)
})

test('a dropped note leaves the orphan list — it is no longer the author’s problem', () => {
  const n = annotations()[0]
  updateAnnotation(n.id, { status: 'dropped' })
  assert.equal(orphaned().length, 0)
  assert.equal(annotations()[0].status, 'dropped')
})

test('guards: unknown scene, empty body, bad status, unknown id', () => {
  assert.throws(() => createAnnotation({ scene: 'sc.99-9', paragraph: 0, quote: 'x', body: 'y' }), HttpError)
  assert.throws(() => createAnnotation({ scene: 'sc.01-1', paragraph: 0, quote: 'x', body: '   ' }), HttpError)
  assert.throws(() => updateAnnotation('note.001', { status: 'nonsense' }), HttpError)
  assert.throws(() => updateAnnotation('note.999', { status: 'open' }), HttpError)
})

test('a note can be revised — the thought changes, the anchor does not', () => {
  const before = annotations()[0]
  const after = updateAnnotation(before.id, { body: '  Sharper on the second reading.  ' })
  assert.equal(after.body, 'Sharper on the second reading.')   // trimmed
  assert.deepEqual(after.anchor, before.anchor)                // never re-anchored
  assert.equal(after.status, before.status)
  assert.equal(after.id, before.id)
})

test('status and body can move together, or one without the other', () => {
  const id = annotations()[0].id
  const both = updateAnnotation(id, { status: 'working', body: 'Revised while working.' })
  assert.equal(both.status, 'working')
  assert.equal(both.body, 'Revised while working.')
  assert.equal(updateAnnotation(id, { body: 'Body only.' }).status, 'working')
  assert.equal(updateAnnotation(id, { status: 'open' }).body, 'Body only.')
})

test('an edit cannot empty a note, and an empty patch is refused', () => {
  const id = annotations()[0].id
  assert.throws(() => updateAnnotation(id, { body: '   ' }), HttpError)   // that is what drop is for
  assert.throws(() => updateAnnotation(id, {}), HttpError)
  assert.ok(annotations()[0].body.trim().length > 0)
})

test('notes live in annotations/ as ordinary editable yaml', () => {
  const files = fs.readdirSync(path.join(story, 'annotations'))
  assert.ok(files.some(f => /^note-\d{3}\.yaml$/.test(f)))
  git(story, 'checkout', 'HEAD', '--', '.')
  git(story, 'clean', '-fdq')
})
