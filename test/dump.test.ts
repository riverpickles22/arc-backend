// The brain dump. The pipeline underneath is slice 1's and is tested there;
// what is tested here is the contract this module adds — that the author's
// words reach the disk before anything that can fail, and that what the viewer
// is shown is read back from the files rather than taken from the worker's
// word for it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeStory } from './fixture.ts'

const STORY = makeStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

const { saveRaw, describeFiled, fileDump, decideDump } = await import('../src/dump.ts')

const DUMPS = path.join(STORY, '.arc', 'dumps')
const dumpFiles = (): string[] => (fs.existsSync(DUMPS) ? fs.readdirSync(DUMPS) : [])

test('saveRaw writes the words verbatim and returns where they went', () => {
  const rel = saveRaw('the hog hunters come back in chapter nine', '2026-08-13T12:00:00.000Z')
  assert.equal(rel, path.join('.arc', 'dumps', '2026-08-13T12-00-00-000Z.md'))
  const body = fs.readFileSync(path.join(STORY, rel), 'utf8')
  assert.match(body, /the hog hunters come back in chapter nine/)
  assert.match(body, /2026-08-13T12:00:00\.000Z/, 'stamped, so a pile of dumps stays legible')
})

test('the words are on disk BEFORE the pass runs — a failing pass cannot cost them', async () => {
  const before = dumpFiles().length
  // Engine 'none' makes the run fail at the first thing after the save, which
  // is exactly the ordering under test.
  await assert.rejects(
    fileDump('a boy shelters under a fallen trunk while something hunts him'),
    (e: unknown) => (e as { status?: number }).status === 503,
  )
  const after = dumpFiles()
  assert.equal(after.length, before + 1, 'the dump was saved even though the run never started')
  const saved = after.map(f => fs.readFileSync(path.join(DUMPS, f), 'utf8')).join('\n')
  assert.match(saved, /a boy shelters under a fallen trunk/)
})

test('the 503 tells the author where their words are, rather than only that it failed', async () => {
  await assert.rejects(fileDump('something worth keeping'), (e: unknown) => {
    const err = e as { status?: number; message?: string }
    return err.status === 503 && /\.arc\/dumps\//.test(err.message ?? '')
  })
})

test('an empty dump is a 400 and writes nothing at all', async () => {
  const before = dumpFiles().length
  for (const empty of ['', '   ', '\n\t ']) {
    await assert.rejects(fileDump(empty), (e: unknown) => (e as { status?: number }).status === 400)
  }
  assert.equal(dumpFiles().length, before, 'a blank box is not a thought worth saving')
})

test('what the viewer is shown is read back from the file, not from the worker', () => {
  const filed = describeFiled([{
    path: 'material/hog-hunters-return.yaml',
    content: [
      'id: mat.hog-hunters-return',
      'type: obligation',
      'status: unplaced',
      'body: >',
      '  The hunters who took the hog in the prologue come back for the boy.',
    ].join('\n'),
  }])
  assert.deepEqual(filed, [{
    path: 'material/hog-hunters-return.yaml',
    id: 'mat.hog-hunters-return',
    type: 'obligation',
    status: 'unplaced',
    body: 'The hunters who took the hog in the prologue come back for the boy.',
  }])
})

test('an unparseable or bare material file is still named rather than dropped', () => {
  const filed = describeFiled([
    { path: 'material/broken.yaml', content: 'id: [unclosed' },
    { path: 'material/bare.yaml', content: 'note: nothing useful here\n' },
  ])
  assert.equal(filed.length, 2, 'a file arc cannot read is still a file arc wrote')
  assert.deepEqual(filed.map(f => f.id), ['broken', 'bare'], 'the filename stands in for a missing id')
  assert.deepEqual(filed.map(f => f.type), ['unknown', 'unknown'])
  assert.equal(filed[1].status, 'unplaced', 'unplaced is the honest default for the material layer')
})

test('deciding a run nobody is holding is a clean 404, not a crash', async () => {
  await assert.rejects(decideDump('run-that-never-was', true), (e: unknown) => {
    const err = e as { status?: number; message?: string }
    return err.status === 404 && /on disk either way/.test(err.message ?? '')
  })
})
