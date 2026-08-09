// The drafting pass's deterministic pieces: scene slot assignment and the
// assignment message. The generation itself is a live-model concern (story
// A2-4's acceptance run), never exercised in tests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeStory } from './fixture.ts'

const story = makeStory()
process.env.ARC_STORY_PATH = story
const draftMod = await import('../src/draft.ts')
const { sceneSlot, draftUserMessage } = draftMod

test('first scene of a chapter: slot 01, id from the chapter number', () => {
  const slot = sceneSlot('ch.02-dogs-of-the-neighborhood', 2, [])
  assert.deepEqual(slot, { file: 'prose/ch-02/scene-01.md', sceneId: 'sc.02-1' })
})

test('next scene number follows the highest existing file in that chapter dir', () => {
  const files = ['prose/ch-00/scene-01.md', 'prose/ch-00/scene-03.md', 'prose/ch-01/scene-07.md']
  const slot = sceneSlot('ch.00-prologue', 0, files)
  assert.deepEqual(slot, { file: 'prose/ch-00/scene-04.md', sceneId: 'sc.00-4' })
})

test('chapter id without a number falls back to zero-padded order', () => {
  const slot = sceneSlot('ch.finale', 13, [])
  assert.deepEqual(slot, { file: 'prose/ch-13/scene-01.md', sceneId: 'sc.13-1' })
})

test('other chapters’ files never advance the counter', () => {
  const slot = sceneSlot('ch.05-x', 5, ['prose/ch-04/scene-09.md'])
  assert.equal(slot.file, 'prose/ch-05/scene-01.md')
})

test('assignment message: path, id, guidance, and existing scenes all present', () => {
  const msg = draftUserMessage('ch.02-x', 'sc.02-2', 'prose/ch-02/scene-02.md', ' tighter, colder ', [{ scene: 'sc.02-1', file: 'prose/ch-02/scene-01.md' }])
  assert.match(msg, /Draft scene sc\.02-2 of chapter ch\.02-x/)
  assert.match(msg, /exactly this path: prose\/ch-02\/scene-02\.md/)
  assert.match(msg, /already has 1 scene\(s\): sc\.02-1/)
  assert.match(msg, /AUTHOR'S GUIDANCE \(binding\): tighter, colder/)
})

test('assignment message without guidance or siblings', () => {
  const msg = draftUserMessage('ch.03-x', 'sc.03-1', 'prose/ch-03/scene-01.md', undefined, [])
  assert.match(msg, /first scene/)
  assert.doesNotMatch(msg, /GUIDANCE/)
})
