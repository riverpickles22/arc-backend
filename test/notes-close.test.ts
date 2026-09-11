// A note the book has answered closes itself — at the accept, and by
// resolving, never deleting (A63-4).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { git, makeStory, writeScene } from './fixture.ts'

const STORY = makeStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

const { closeAnsweredNotes, createAnnotation, annotations, updateAnnotation } = await import('../src/annotations.ts')
const { recordGenerated } = await import('../src/ledger.ts')
const { proseAccept, proseDraft } = await import('../src/story.ts')

const FILE = 'prose/ch-01/scene-01.md'
const abs = path.join(STORY, FILE)
const status = (id: string) => annotations().find(n => n.id === id)?.status

const reset = () => {
  git(STORY, 'checkout', 'HEAD', '--', '.'); git(STORY, 'clean', '-fdq')
  fs.rmSync(path.join(STORY, '.arc'), { recursive: true, force: true })
  fs.rmSync(path.join(STORY, 'annotations'), { recursive: true, force: true })
  writeScene(STORY, FILE, 'sc.01-1', 'Original first paragraph.\n\nSecond paragraph.')
  git(STORY, 'add', '-A'); if (git(STORY, 'status', '--porcelain').trim()) git(STORY, 'commit', '-qm', 'seed')
}

test('the notes a change was written from resolve when that change is accepted', () => {
  reset()
  const answered = createAnnotation({ scene: 'sc.01-1', paragraph: 0, quote: 'Original first', body: 'slower' })
  const bystander = createAnnotation({ scene: 'sc.01-1', body: 'a thought the pass was never handed' })
  const already = createAnnotation({ scene: 'sc.01-1', body: 'closed by the author already' })
  updateAnnotation(already.id, { status: 'dropped' })
  const kp = createAnnotation({ scene: 'sc.01-1', paragraph: 0, quote: 'Original first', body: 'a marker', kind: 'keypoint' })
  git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'notes')

  // The pass writes, and the ledger records what it was handed.
  const next = fs.readFileSync(abs, 'utf8').replace('Original first paragraph.', 'A slower first paragraph.')
  fs.writeFileSync(abs, next)
  recordGenerated(FILE, next, { origin: 'revise', scene: 'sc.01-1', notes: [answered.id, already.id, kp.id] })

  // Not yet: the change is a proposal until the author takes it.
  assert.equal(status(answered.id), 'open')

  proseAccept(undefined, [FILE])
  const closed = closeAnsweredNotes([FILE])
  assert.deepEqual(closed, [answered.id], 'exactly the open note the pass was handed')
  assert.equal(status(answered.id), 'resolved', 'resolved — it still exists for the style learner')
  assert.equal(status(bystander.id), 'open', 'a note the pass never saw is untouched')
  assert.equal(status(already.id), 'dropped', 'the author\'s own decision stands')
  assert.equal(annotations().find(n => n.id === kp.id)?.kind, 'keypoint', 'a keypoint is never a note to close')
  assert.equal(proseDraft().changes.length, 0)
})

test('a file the ledger never wrote closes nothing, and never throws', () => {
  reset()
  assert.deepEqual(closeAnsweredNotes([FILE]), [])
  assert.deepEqual(closeAnsweredNotes(['prose/does/not/exist.md']), [])
})
