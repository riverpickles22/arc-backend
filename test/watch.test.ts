// The watcher. The property under test is not "did it notice" — it is whether
// arc tells the truth about WHOSE change it was. Crediting a run with an edit
// it did not make turns a receipt from a record into a guess, so attribution
// is deliberately conservative and anything unclaimed is external.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { StreamMessage } from '../src/run.ts'
import { makeStory } from './fixture.ts'

const STORY = makeStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

const { Run, subscribeRuns, publishStream } = await import('../src/run.ts')
const { claimantOf, _resetClaims } = await import('../src/runs.ts')
const { classify, watchedPrefixes, startWatcher, stopWatcher } = await import('../src/watch.ts')

test('the watched set is the story record and the author\'s own writing', () => {
  const watched = watchedPrefixes()
  for (const d of ['canon', 'material', 'docs', 'prose', 'annotations', 'notes']) {
    assert.ok(watched.includes(d), `${d}/ is watched`)
  }
  assert.equal(watched.includes('.arc'), false, 'machine working state is not the author\'s business')
})

test('paths outside the watched set are ignored entirely', () => {
  const out = classify([
    '.arc/runs/run.0001/events.jsonl',
    '.git/index',
    'node_modules/thing/index.js',
    'README.md',
    'canon/entities/characters/carlos.yaml',
  ])
  assert.deepEqual(out.map(c => c.path), ['canon/entities/characters/carlos.yaml'],
    'only the story record survives the filter')
})

test('a change nobody claimed is external — the honest default', () => {
  _resetClaims()
  const out = classify(['prose/ch-01/scene-01.md'])
  assert.equal(out[0].run, null, 'no run authorised it, so no run is credited')
})

test('a change a run claimed is attributed to that run', () => {
  _resetClaims()
  const run = new Run('cli', 'file this as material')
  run.recordExpansion('n1', 'WRITE mat.hog-hunters')

  assert.equal(claimantOf('material/hog-hunters.yaml'), run.id,
    'the minting convention is the id-to-path mapping arc actually makes')
  assert.equal(classify(['material/hog-hunters.yaml'])[0].run, run.id)
})

test('a claim explains only its own path, never its neighbours', () => {
  _resetClaims()
  const run = new Run('cli', 'one narrow claim')
  run.recordExpansion('n1', 'WRITE mat.only-this-one')

  assert.equal(claimantOf('material/only-this-one.yaml'), run.id)
  assert.equal(claimantOf('material/something-else.yaml'), null, 'a neighbour is not covered')
  assert.equal(claimantOf('canon/entities/characters/carlos.yaml'), null, 'nor is canon')
})

test('two runs claiming different paths are told apart', () => {
  _resetClaims()
  const a = new Run('cli', 'run a')
  const b = new Run('cli', 'run b')
  a.recordExpansion('n1', 'WRITE mat.from-a')
  b.recordExpansion('n1', 'WRITE mat.from-b')

  assert.equal(claimantOf('material/from-a.yaml'), a.id)
  assert.equal(claimantOf('material/from-b.yaml'), b.id)
})

test('a path-shaped grant is taken as the path it is', () => {
  _resetClaims()
  const run = new Run('cli', 'a claim naming a path')
  run.recordExpansion('n1', 'WRITE prose/ch-01/scene-01.md')
  assert.equal(claimantOf('prose/ch-01/scene-01.md'), run.id)
})

test('watcher events ride the same stream as run events', () => {
  const seen: StreamMessage[] = []
  const stop = subscribeRuns(m => seen.push(m))

  const run = new Run('ui', 'a run and a file change, one subscription')
  publishStream({ run: null, at: new Date().toISOString(), event: 'files.external', detail: { files: ['prose/x.md'] } })
  stop()

  assert.ok(seen.some(m => m.run === run.id && m.event === 'run.started'), 'run events arrive')
  const ext = seen.find(m => m.event === 'files.external')
  assert.ok(ext, 'and so do file events')
  assert.equal(ext!.run, null, 'an external change carries no run, which is the whole point')
})

test('starting and stopping the watcher is safe and idempotent', () => {
  assert.doesNotThrow(() => { startWatcher(); startWatcher() })
  assert.doesNotThrow(() => { stopWatcher(); stopWatcher() })
})

test('the watcher sees a real write and calls it external when no run claimed it', async () => {
  _resetClaims()
  const seen: StreamMessage[] = []
  const stop = subscribeRuns(m => { if (m.event.startsWith('files.')) seen.push(m) })
  startWatcher()

  fs.mkdirSync(path.join(STORY, 'notes'), { recursive: true })
  fs.writeFileSync(path.join(STORY, 'notes', 'watched-note.md'), 'a change made outside any run\n')
  await new Promise(r => setTimeout(r, 700))

  stopWatcher()
  stop()

  const ext = seen.find(m => m.event === 'files.external')
  assert.ok(ext, 'the change was noticed')
  assert.equal(ext!.run, null)
  assert.match(JSON.stringify(ext!.detail), /watched-note\.md/)
})
