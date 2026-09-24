// The registry row (A67-1): the table that admits a launch, its two first
// rows, the job fingerprint, and the status derived at startup. The type
// half — a sealed row cannot carry a toolbelt, a session or a subagent
// depth; an investigation row does not compile without its read set and
// its pool — lives in src/registry.types.test.ts and is proven by tsc.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeStory } from './fixture.ts'

process.env.ARC_STORY_PATH = makeStory()
process.env.ARC_DRAFT_ENGINE = 'none'

const {
  ROWS, ROW_EXPLORE_SCENE, ROW_EXPLORE_ROUTE, ROUTE_WALL_CLOCK_MS, ROUTE_OUTPUT_TOKENS,
  findRow, rowKey, jobFingerprint, rowStatus, readStatusReceipts, fixturesRecorded, registryStatus,
} = await import('../src/registry.ts')
const { PASS_REGISTRY } = await import('../src/invocation.ts')
const { buildReroutePrompt, buildRevisePrompt } = await import('../src/reroute.ts')
const { loadFixtures } = await import('../src/fixtures.ts')
const RECORDED = loadFixtures()

test('U4 and U5 are the first rows: sealed, withholding, keyed by their cell', () => {
  assert.deepEqual(ROWS.map(rowKey), ['explore.scene.one-shot', 'explore.route.one-shot'])
  for (const row of [ROW_EXPLORE_SCENE, ROW_EXPLORE_ROUTE]) {
    assert.equal(row.pattern, 'sealed')
    assert.equal(row.withholding, true)
    assert.equal(row.answer, 'coverage-tail')
    assert.deepEqual(row.envelope, {
      tools: 'none', subagents: 'none', projectContext: 'none', runtimeAdditions: 'user-level',
      network: 'none', directory: 'scratch', transcript: 'delete-at-decision',
    })
    assert.ok(!('session' in row.envelope), 'session none, by the sealed type')
    assert.ok(row.slice.floor.every(l => row.slice.layers.includes(l)), 'the floor is made of declared layers')
    assert.ok(row.slice.dropOrder.every(l => !row.slice.floor.includes(l)), 'nothing on the floor drops')
    assert.ok(row.gates.includes('overlap') && row.gates.includes('coverage-tail'))
  }
})

test('the budgets are Q3\'s, decided 2026-09-13 for this row only', () => {
  assert.equal(ROUTE_WALL_CLOCK_MS, 20 * 60 * 1000, 'twenty minutes per call — the one evidence-based number')
  assert.equal(ROUTE_OUTPUT_TOKENS, 12_000, 'about four times the novel\'s longest scene')
  for (const row of ROWS) assert.deepEqual(row.budget, { outputTokens: 12_000, wallClockMs: 20 * 60 * 1000 })
})

test('the rules text lives on the row, and the pass reads it from there — one address per job', () => {
  const scene = { scene: 'sc.x', chapter: 'ch.x', status: 'proposed', pov: null, events: [], facts: [], contract: null, file: 'prose/x.md', body: '' }
  const u4 = buildReroutePrompt({ scene, pack: '', style: '', siblings: '', notes: [], destination: ['a'], knownRoute: '', inferred: '', locked: [], seed: { id: 's', text: 's' } })
  assert.ok(u4.stable.startsWith(ROW_EXPLORE_SCENE.rules), 'the reroute brief opens with the U4 row\'s rules')
  const u5 = buildRevisePrompt({ scene, pack: '', style: '', destination: ['a'], knownRoute: '', locked: [], routeBody: 'r', notes: [] })
  assert.ok(u5.stable.startsWith(ROW_EXPLORE_ROUTE.rules), 'the rewrite brief opens with the U5 row\'s rules')
  assert.match(ROW_EXPLORE_SCENE.rules, /ANOTHER WAY THROUGH/)
  assert.match(ROW_EXPLORE_ROUTE.rules, /ROUTE REWRITE/)
})

test('the reroute configuration the rows replace is gone from PASS_REGISTRY', () => {
  assert.ok(!('reroute' in PASS_REGISTRY))
  assert.ok(!('reroute-revise' in PASS_REGISTRY))
})

test('findRow answers a listed cell and nothing else — never a neighbour', () => {
  assert.equal(findRow({ job: 'explore', scope: 'scene', mode: 'one-shot' }), ROW_EXPLORE_SCENE)
  assert.equal(findRow({ job: 'explore', scope: 'route', mode: 'one-shot', depth: 'standard' }), ROW_EXPLORE_ROUTE)
  assert.equal(findRow({ job: 'explore', scope: 'scene', mode: 'batch' }), undefined, 'a mode the rows do not list')
  assert.equal(findRow({ job: 'explore', scope: 'scene', mode: 'one-shot', depth: 'quick' }), undefined, 'a depth the rows do not carry is not mapped to standard')
  assert.equal(findRow({ job: 'draft', scope: 'scene', mode: 'one-shot' }), undefined, 'draft has no row until slice 2')
})

test('the job fingerprint moves with the rules, the slice, the gates and the budget — not with the fixture list', () => {
  const base = jobFingerprint(ROW_EXPLORE_SCENE)
  assert.match(base, /^[0-9a-f]{16}$/)
  assert.notEqual(base, jobFingerprint(ROW_EXPLORE_ROUTE))
  assert.notEqual(base, jobFingerprint({ ...ROW_EXPLORE_SCENE, rules: ROW_EXPLORE_SCENE.rules + ' ' }), 'a changed word of the rules')
  assert.notEqual(base, jobFingerprint({ ...ROW_EXPLORE_SCENE, gates: ['locks'] }), 'a changed gate set')
  assert.notEqual(base, jobFingerprint({ ...ROW_EXPLORE_SCENE, slice: { ...ROW_EXPLORE_SCENE.slice, floor: [] } }), 'a changed slice')
  assert.notEqual(base, jobFingerprint({ ...ROW_EXPLORE_SCENE, budget: { outputTokens: 1, wallClockMs: 1 } }), 'a changed budget')
  assert.equal(base, jobFingerprint({ ...ROW_EXPLORE_SCENE, fixtures: [] }), 'recording a fixture is not a change to the job')
})

test('both rows are built: every fixture they name is recorded under their key', () => {
  for (const row of ROWS) assert.equal(fixturesRecorded(row, RECORDED), true, rowKey(row))
  assert.equal(fixturesRecorded({ ...ROW_EXPLORE_SCENE, fixtures: ['lands', 'nope'] }, RECORDED), false)
  assert.equal(fixturesRecorded({ ...ROW_EXPLORE_SCENE, fixtures: [] }, RECORDED), false, 'a row with no fixtures proves nothing')
})

// ---- status, derived from hand-written receipts ---------------------------

const fp = jobFingerprint(ROW_EXPLORE_SCENE)
// The shape A67-4 actually writes: the fingerprint under produced_by, the
// subject under request. The flat fields are the older shape and still read.
const receipt = (over: Record<string, unknown>) => ({
  produced_by: { arc_commit: null, job_fingerprint: fp }, author_decision: { decision: 'accepted' },
  request: { gesture: 'another way through sc.01-1', cell: 'explore.scene.one-shot', subject: 'sc.01-1' },
  ending: 'landed', ...over,
})
const batchRow = { ...ROW_EXPLORE_SCENE, mode: 'batch' as const }
const bfp = jobFingerprint(batchRow)

test('status: designed until the fixtures are recorded, built once they are', () => {
  assert.equal(rowStatus(ROW_EXPLORE_SCENE, [], false), 'designed')
  assert.equal(rowStatus(ROW_EXPLORE_SCENE, [receipt({})], false), 'designed', 'a receipt does not make code exist')
  assert.equal(rowStatus(ROW_EXPLORE_SCENE, [], true), 'built')
})

test('status: attended needs a receipt with an author decision AND this row\'s job fingerprint', () => {
  assert.equal(rowStatus(ROW_EXPLORE_SCENE, [receipt({})], true), 'attended')
  assert.equal(rowStatus(ROW_EXPLORE_SCENE, [receipt({ author_decision: { decision: 'rejected' } })], true), 'attended', 'a rejection is a decision')
  assert.equal(rowStatus(ROW_EXPLORE_SCENE, [receipt({ produced_by: { job_fingerprint: 'older-arc' } })], true), 'built', 'a receipt from an older arc attends nothing')
  assert.equal(rowStatus(ROW_EXPLORE_SCENE, [{ job_fingerprint: fp, author_decision: { decision: 'accepted' }, subject: 'sc.01-1', ending: 'landed' }], true), 'attended', 'the older flat shape still attends')
  assert.equal(rowStatus(ROW_EXPLORE_SCENE, [receipt({ author_decision: undefined })], true), 'built', 'a run without a decision attends nothing')
  assert.equal(rowStatus(ROW_EXPLORE_SCENE, [{ run_id: 'run.0001' } as never], true), 'built', 'the notes-work receipts that predate the fields')
})

test('status: a one-shot row is never batch-eligible, however attended', () => {
  const many = [receipt({ request: { subject: 'sc.01-1' } }), receipt({ request: { subject: 'sc.01-2' }, ending: 'refused' })]
  assert.equal(rowStatus(ROW_EXPLORE_SCENE, many, true), 'attended')
})

test('status: batch-eligible is earned — more than one subject, one ending not landed, no violation', () => {
  const b = (over: Record<string, unknown>) => receipt({ produced_by: { job_fingerprint: bfp }, ...over })
  const on = (subject: string, over: Record<string, unknown> = {}) => b({ request: { subject }, ...over })
  assert.equal(rowStatus(batchRow, [on('sc.01-1'), on('sc.01-2', { ending: 'refused' })], true), 'batch-eligible')
  assert.equal(rowStatus(batchRow, [on('sc.01-1'), on('sc.01-1', { ending: 'refused' })], true), 'attended', 'one subject only')
  assert.equal(rowStatus(batchRow, [on('sc.01-1'), on('sc.01-2')], true), 'attended', 'every ending landed — nothing observed going wrong')
  assert.equal(rowStatus(batchRow, [on('sc.01-1'), on('sc.01-2', { ending: 'refused', invariant_violations: ['2'] })], true), 'attended', 'an invariant violation disqualifies')
  assert.equal(rowStatus(batchRow, [b({})], true), 'attended', 'one receipt proves the plumbing, not the job')
})

test('receipts are read from history/, and one that does not parse attends nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-history-'))
  fs.writeFileSync(path.join(dir, 'run.0001.yaml'), `job_fingerprint: ${fp}\nauthor_decision:\n  decision: accepted\nsubject: sc.01-1\nending: landed\n`)
  fs.writeFileSync(path.join(dir, 'run.0002.yaml'), 'run_id: run.0002\nraw_author_input: an old receipt\n')
  fs.writeFileSync(path.join(dir, 'run.0003.yaml'), ':\n  - : [')
  fs.writeFileSync(path.join(dir, 'notes.md'), 'not a receipt')
  const receipts = readStatusReceipts(dir)
  assert.equal(receipts.length, 2)
  assert.equal(rowStatus(ROW_EXPLORE_SCENE, receipts, true), 'attended')
  assert.deepEqual(readStatusReceipts(path.join(dir, 'missing')), [])
})

test('registryStatus reads the story\'s history and reports every row', () => {
  const status = registryStatus()
  assert.deepEqual(status.map(s => s.key), ['explore.scene.one-shot', 'explore.route.one-shot'])
  assert.deepEqual(status.map(s => s.status), ['built', 'built'], 'no receipt in this story yet')
  assert.equal(status[0].fingerprint, fp)
})
