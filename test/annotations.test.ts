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
  updateAnnotation(n.id, 'dropped')
  assert.equal(orphaned().length, 0)
  assert.equal(annotations()[0].status, 'dropped')
})

test('guards: unknown scene, empty body, bad status, unknown id', () => {
  assert.throws(() => createAnnotation({ scene: 'sc.99-9', paragraph: 0, quote: 'x', body: 'y' }), HttpError)
  assert.throws(() => createAnnotation({ scene: 'sc.01-1', paragraph: 0, quote: 'x', body: '   ' }), HttpError)
  assert.throws(() => updateAnnotation('note.001', 'nonsense'), HttpError)
  assert.throws(() => updateAnnotation('note.999', 'open'), HttpError)
})

test('notes live in annotations/ as ordinary editable yaml', () => {
  const files = fs.readdirSync(path.join(story, 'annotations'))
  assert.ok(files.some(f => /^note-\d{3}\.yaml$/.test(f)))
  git(story, 'checkout', 'HEAD', '--', '.')
  git(story, 'clean', '-fdq')
})
