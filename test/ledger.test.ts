// The generation ledger: what arc wrote, before the author touched it.
// Git only sees the accepted version, so without this the learning signal
// — the difference between generated and kept — is gone forever.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeStory } from './fixture.ts'

const story = makeStory()
process.env.ARC_STORY_PATH = story
const { recordGenerated, generatedFor, clearGenerated } = await import('../src/ledger.ts')

test('what arc wrote survives the author editing the file', () => {
  const rel = 'prose/ch-02/scene-01.md'
  recordGenerated(rel, 'The generated version.', { engine: 'claude-cli', scene: 'sc.02-1' })
  // the author edits the working tree — the ledger is untouched
  fs.mkdirSync(path.join(story, 'prose/ch-02'), { recursive: true })
  fs.writeFileSync(path.join(story, rel), 'The version the author kept.')
  const got = generatedFor(rel)
  assert.equal(got?.content, 'The generated version.')
  assert.equal(got?.entry.engine, 'claude-cli')
  assert.equal(got?.entry.scene, 'sc.02-1')
})

test('the newest generation for a path wins — regenerating replaces the signal', () => {
  const rel = 'prose/ch-03/scene-01.md'
  recordGenerated(rel, 'first attempt')
  recordGenerated(rel, 'second attempt')
  assert.equal(generatedFor(rel)?.content, 'second attempt')
})

test('a path arc never wrote has no entry — a hand-written scene is not mined', () => {
  assert.equal(generatedFor('prose/ch-99/scene-01.md'), null)
})

test('clearing forgets one path and leaves the others', () => {
  recordGenerated('prose/ch-04/scene-01.md', 'keep me')
  recordGenerated('prose/ch-05/scene-01.md', 'drop me')
  clearGenerated(['prose/ch-05/scene-01.md'])
  assert.equal(generatedFor('prose/ch-05/scene-01.md'), null)
  assert.equal(generatedFor('prose/ch-04/scene-01.md')?.content, 'keep me')
})

test('the ledger lives under .arc/ — working state, never the record', () => {
  assert.ok(fs.existsSync(path.join(story, '.arc', 'drafts.jsonl')))
  assert.ok(fs.existsSync(path.join(story, '.arc', 'generated')))
})
