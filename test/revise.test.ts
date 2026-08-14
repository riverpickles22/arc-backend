// Write fan-out. The properties that matter are the ones that make writing
// safe: conflicts surfaced BEFORE anything is written, overlapping write sets
// serialised, staleness decided by fingerprint, and a worker that cannot
// reach canon however much a note implies it should.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { ResolvedAnnotation } from 'arc-canon-graph'
import { makeStory, writeScene } from './fixture.ts'

const STORY = makeStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

writeScene(STORY, 'prose/ch-01/scene-02.md', 'sc.01-2', 'A second scene, so two clusters can be disjoint.')

const {
  clusterNotes, planRevisionGraph, scheduleWaves, buildConflictPrompt, parseConflicts,
  buildRevisePrompt, runRevisionFanOut,
} = await import('../src/revise.ts')
const { checkPathWrite, checkRecordWrite } = await import('../src/capability.ts')

const note = (id: string, scene: string, body: string, over: Partial<ResolvedAnnotation> = {}): ResolvedAnnotation => ({
  id,
  anchor: { scene, paragraph: 0, quote: 'Original first paragraph.' },
  body,
  status: 'open',
  created_at: '2026-08-13',
  resolution: { state: 'resolved', paragraph: 0 },
  ...over,
} as ResolvedAnnotation)

// ---- clustering ----------------------------------------------------------

test('notes cluster by scene — the natural write-set boundary', () => {
  const clusters = clusterNotes([
    note('note.001', 'sc.01-1', 'Diego is furniture here.'),
    note('note.002', 'sc.01-1', 'The chin-scratch should land harder.'),
    note('note.003', 'sc.01-2', 'This opening is slack.'),
  ])
  assert.equal(clusters.length, 2)
  assert.deepEqual(clusters.map(c => c.scene), ['sc.01-1', 'sc.01-2'])
  assert.equal(clusters[0].notes.length, 2, 'two notes on one scene are one revision, not two')
  assert.ok(clusters[0].file.endsWith('scene-01.md'), 'the file is found by reading, not by guessing a path')
})

test('a note whose anchor is lost is excluded rather than guessed at', () => {
  const clusters = clusterNotes([
    note('note.gone', 'sc.01-1', 'about a passage that no longer exists',
      { resolution: { state: 'orphaned' } } as Partial<ResolvedAnnotation>),
    note('note.missing', 'sc.99-9', 'about a scene that never existed',
      { resolution: { state: 'no-scene' } } as Partial<ResolvedAnnotation>),
  ])
  assert.deepEqual(clusters, [], 'arc never guesses where a thought now belongs')
})

test('only open notes are worked', () => {
  const clusters = clusterNotes([
    note('note.done', 'sc.01-1', 'already handled', { status: 'resolved' }),
    note('note.dropped', 'sc.01-1', 'thrown away', { status: 'dropped' }),
  ])
  assert.deepEqual(clusters, [])
})

// ---- claims: prose only, and only its own ---------------------------------

test('a revision worker may write ITS OWN scene and nothing else', () => {
  const clusters = clusterNotes([
    note('note.001', 'sc.01-1', 'a'),
    note('note.003', 'sc.01-2', 'b'),
  ])
  const [a, b] = planRevisionGraph(clusters)

  assert.equal(checkPathWrite(a.claim, clusters[0].file).ok, true, 'its own scene')
  assert.equal(checkPathWrite(a.claim, clusters[1].file).ok, false, 'never the other node\'s scene')
  assert.equal(checkPathWrite(b.claim, clusters[0].file).ok, false)
})

test('a revision worker cannot touch canon, however much a note implies it', () => {
  const [node] = planRevisionGraph(clusterNotes([note('note.001', 'sc.01-1', 'give him a brother named Tomás')]))
  assert.deepEqual(node.claim.creates, [], 'it may create nothing')
  assert.deepEqual(node.claim.proposes, [], 'and propose nothing')

  const check = checkRecordWrite(node.claim, {
    added: [{ id: 'char.brother', file: 'canon/entities/characters/brother.yaml', status: 'proposed' }],
    modified: [], removed: [],
  })
  assert.equal(check.ok, false, 'the gate refuses a canon write')
  assert.equal(checkPathWrite(node.claim, 'canon/entities/characters/brother.yaml').ok, false)
})

test('every node fingerprints what it read, so staleness has something to compare', () => {
  for (const n of planRevisionGraph(clusterNotes([note('note.001', 'sc.01-1', 'x')]))) {
    assert.ok(n.reads.length, 'it declares what it read')
    assert.deepEqual(Object.keys(n.read_versions).every(k => n.reads.includes(k)), true)
  }
})

// ---- scheduling: overlap serialises, disjoint runs together ----------------

test('disjoint write sets share a wave; overlapping ones are serialised', () => {
  const disjoint = planRevisionGraph(clusterNotes([
    note('note.001', 'sc.01-1', 'a'),
    note('note.003', 'sc.01-2', 'b'),
  ]))
  assert.equal(scheduleWaves(disjoint).length, 1, 'two scenes, one wave — safe to run at once')
  assert.equal(scheduleWaves(disjoint)[0].length, 2)

  // Two nodes contending for the same file must never share a wave: one would
  // overwrite the other and the loser would never know.
  const contending = [
    { ...disjoint[0], id: 'a', writes: ['prose/ch-01/scene-01.md'] },
    { ...disjoint[0], id: 'b', writes: ['prose/ch-01/scene-01.md'] },
  ]
  const waves = scheduleWaves(contending)
  assert.equal(waves.length, 2, 'serialised')
  assert.deepEqual(waves.map(w => w.length), [1, 1])
})

test('a node overlapping only one of several still gets its own wave', () => {
  const base = planRevisionGraph(clusterNotes([note('note.001', 'sc.01-1', 'a')]))[0]
  const waves = scheduleWaves([
    { ...base, id: 'a', writes: ['x.md'] },
    { ...base, id: 'b', writes: ['y.md'] },
    { ...base, id: 'c', writes: ['x.md'] },
  ])
  assert.equal(waves.length, 2)
  assert.deepEqual(waves[0].map(n => n.id), ['a', 'b'])
  assert.deepEqual(waves[1].map(n => n.id), ['c'])
})

// ---- conflicts: surfaced before anything is written ------------------------

test('the conflict pass is told to surface tensions, never to resolve them', () => {
  const p = buildConflictPrompt([
    note('note.001', 'sc.01-1', 'Make Manuel seem more suspicious here.'),
    note('note.007', 'sc.05-1', 'The Manuel reveal feels too obvious.'),
  ])
  assert.match(p, /note\.001/)
  assert.match(p, /note\.007/)
  assert.match(p, /NOT resolving/)
  assert.match(p, /Do not suggest which note should win/)
})

test('a conflict needs two notes and a stated tension, or it is not one', () => {
  const out = parseConflicts(JSON.stringify([
    { between: ['note.001', 'note.007'], tension: 'One asks for more suspicion, the other for less.' },
    { between: ['note.001'], tension: 'only one note' },
    { between: ['note.002', 'note.003'] },
    { between: ['note.004', 'note.005'], tension: '   ' },
  ]))
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].between, ['note.001', 'note.007'])
  assert.deepEqual(parseConflicts('the model wrote prose instead'), [])
})

test('NOTHING is written while a conflict stands', async () => {
  const before = fs.readFileSync(path.join(STORY, 'prose/ch-01/scene-01.md'), 'utf8')
  const { Run } = await import('../src/run.ts')

  // Engine 'none' makes the conflict pass fail, which must be treated as
  // "unchecked", never as "no conflicts" — a failed check is not a licence.
  const report = await runRevisionFanOut([note('note.001', 'sc.01-1', 'x')], new Run('cli', 'revise'))

  assert.ok(report.conflicts.length, 'it refused rather than guessed')
  assert.match(report.conflicts[0].tension, /could not check/)
  assert.deepEqual(report.revisions, [], 'no revision was attempted')
  assert.deepEqual(report.scenes_changed, [])
  assert.equal(fs.readFileSync(path.join(STORY, 'prose/ch-01/scene-01.md'), 'utf8'), before,
    'the prose is byte-identical')
})

test('no open notes is a clean empty report, not an error', async () => {
  const { Run } = await import('../src/run.ts')
  const report = await runRevisionFanOut([], new Run('cli', 'revise nothing'))
  assert.equal(report.clusters, 0)
  assert.deepEqual(report.revisions, [])
  assert.deepEqual(report.conflicts, [])
})

// ---- what the worker is told ----------------------------------------------

test('the revision prompt binds the contract and forbids inventing canon', () => {
  const p = buildRevisePrompt('sc.01-1', 'The morning smelled of coffee.', [
    note('note.001', 'sc.01-1', 'Diego is furniture here.'),
  ], 'THE NO-COMMENT LAW: never explain a feeling.')

  assert.match(p, /NO-COMMENT LAW/, 'the author\'s own rules are the authority')
  assert.match(p, /note\.001/, 'and the note is named, so the revision has provenance')
  assert.match(p, /Never invent a fact about the world/)
  assert.match(p, /Change as little as the notes require/)
  assert.match(p, /The morning smelled of coffee/)
})

test('every revision carries the notes that caused it', () => {
  const clusters = clusterNotes([
    note('note.001', 'sc.01-1', 'a'),
    note('note.002', 'sc.01-1', 'b'),
  ])
  assert.deepEqual(clusters[0].notes.map(n => n.id), ['note.001', 'note.002'],
    'provenance starts at the cluster and rides to the receipt')
})
