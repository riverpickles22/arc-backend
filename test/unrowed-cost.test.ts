// A76-2: the four launches with no row record what they cost.
//
// The lenses, intake, the judgment and the material worker launch bare
// through `runCliPrompt`, so no receipt carries their tokens. Each now emits
// one `launch.cost` event per launch on its run's events.jsonl, with the
// tokens the engine reported, the wall clock and the model — and writes NO
// launches.jsonl, whose presence doctor and the briefing read as a run that
// owes a receipt. A STUB `claude` on PATH answers in the streamed shape, by
// the pass the child was launched for (ARC_PASS), so no model is reached.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { installStubCli, makeExampleStory } from './fixture.ts'

const STORY = makeExampleStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'claude-cli'
process.env.PATH = `${installStubCli({
  name: 'cost',
  answer: `({
    judge: JSON.stringify({ verdict: 'accept', argued: [], asked: [] }),
    intent: JSON.stringify({ operations: ['capture'], anchors: [], inferred_scope: 'story', authority: 'exploratory', ambiguity: 'low', requested_outcome: 'a stub idea' }),
    material: JSON.stringify({ items: [{ slug_hint: 'stub-idea', type: 'character-need', status: 'unplaced', body: 'a stub idea' }], account: 'filed one' }),
  })[process.env.ARC_PASS] ?? JSON.stringify([{ about: 'stub', claim: 'a stub claim', evidence: 'stub evidence' }])`,
})}${path.delimiter}${process.env.PATH}`

const { Run } = await import('../src/run.ts')
const { getRun } = await import('../src/runs.ts')
const { doctorRecords } = await import('../src/doctor.ts')
const { runIntent, decide } = await import('../src/orchestrate.ts')
const { runLensFanOut, LENSES } = await import('../src/lenses.ts')
const { runJudge } = await import('../src/judge.ts')
const { runIntake } = await import('../src/intent.ts')
const { runMaterialWorker } = await import('../src/material.ts')
const { deriveClaim } = await import('../src/orchestrate.ts')
const { proseScenes } = await import('../src/story.ts')

interface Cost {
  pass: string
  launch: string
  tokens: { estimated: { input: number; output: number | null }; actual: { input: number; output: number; cacheCreation: number; cacheRead: number } }
  wall_clock_ms: number
  model: string | null
}

/** The run's `launch.cost` events, read back from disk through the run
 *  record's own reader (the test's runs are not registered, so `getRun`
 *  reads events.jsonl). */
const costsOf = (id: string): Cost[] =>
  getRun(id).events.filter(e => e.event === 'launch.cost').map(e => e.detail as Cost)

const runDir = (id: string) => path.join(STORY, '.arc', 'runs', id)

/** What every bare launch must carry: the pass, the tokens as the stub
 *  reported them (input is the prompt's length, output the answer's), the
 *  wall clock and the model. */
function assertCost(l: Cost, pass: string): void {
  assert.equal(l.pass, pass)
  assert.ok(l.tokens, `${l.launch} carries tokens`)
  assert.ok(l.tokens.actual.input > 0, `${l.launch}: actual input tokens as the engine reported them`)
  assert.ok(l.tokens.actual.output > 0, `${l.launch}: actual output tokens`)
  assert.equal(typeof l.tokens.actual.cacheRead, 'number', `${l.launch}: the engine's whole Tokens object`)
  assert.ok(l.tokens.estimated.input > 0, `${l.launch}: an input estimate`)
  assert.equal(l.tokens.estimated.output, null, 'no row, so no output ceiling to estimate from')
  assert.equal(typeof l.wall_clock_ms, 'number', `${l.launch}: wall clock`)
  assert.ok(l.wall_clock_ms >= 0)
  assert.equal(l.model, 'stub-model', 'the model as the runtime reported it')
}

const ENVELOPE = {
  operations: ['capture'] as 'capture'[], anchors: [],
  scope_roots: { temporal: [], location: [], surface: [] },
  inferred_scope: 'story' as const, authority: 'exploratory' as const, ambiguity: 'low' as const,
  requested_outcome: 'a stub idea', open_questions: [],
}

test('the chapter read leaves six costs on its run, one per lens and one for the synthesis', async () => {
  const scene = proseScenes()[0]
  assert.ok(scene, 'the example story has a scene to read')
  const run = new Run('cli', 'a76-2: the lenses record their cost')
  const out = await runLensFanOut(scene, run)
  assert.ok(out.findings.length > 0, 'the stub found something, so the synthesis launched')

  const launches = costsOf(run.id)
  assert.deepEqual(launches.map(l => l.launch).sort(),
    [...LENSES.map(s => `lenses:${s.name}`), 'lenses:synthesis'].sort(),
    'six launches, each named, none summed away')
  for (const l of launches) assertCost(l, 'lenses')
})

test('the judgment records its cost on the run of the work it judged', async () => {
  const run = new Run('cli', 'a76-2: the judgment records its cost')
  const j = await runJudge({
    envelope: ENVELOPE, rawAuthorInput: 'a stub idea', claim: deriveClaim(ENVELOPE),
    contextUsed: '', produced: [], checks: { proven: 'ok', ok: true }, boundRules: [], workerReply: '',
  }, run)
  assert.equal(j.verdict, 'accept')
  const launches = costsOf(run.id)
  assert.deepEqual(launches.map(l => l.launch), ['judge'])
  assertCost(launches[0], 'judge')
})

test('intake records its cost on its run', async () => {
  const run = new Run('cli', 'a76-2: intake records its cost')
  const env = await runIntake('a stub idea', run)
  assert.deepEqual(env.operations, ['capture'])
  const launches = costsOf(run.id)
  assert.deepEqual(launches.map(l => l.launch), ['intent'])
  assertCost(launches[0], 'intent')
})

test('the material worker records its cost on its run', async () => {
  const run = new Run('cli', 'a76-2: the material worker records its cost')
  const out = await runMaterialWorker(ENVELOPE, '', deriveClaim(ENVELOPE), run, 'node.1')
  assert.ok(out.actions.some(a => a.tool === 'write_material_file' && a.ok), 'the worker filed its item')
  const launches = costsOf(run.id)
  assert.deepEqual(launches.map(l => l.launch), ['material'])
  assertCost(launches[0], 'material')
})

test('a chapter read and a decided worked note leave no launches.jsonl, and doctor counts no run without its receipt', async () => {
  const lens = new Run('cli', 'a76-2: a chapter read doctor must not count')
  await runLensFanOut(proseScenes()[0], lens)
  const outcome = await runIntent('a stub idea', 'cli')
  await decide(outcome, 'accepted')

  for (const id of [lens.id, outcome.run.id]) {
    assert.ok(!fs.existsSync(path.join(runDir(id), 'launches.jsonl')), `${id} wrote no launches.jsonl`)
    assert.ok(costsOf(id).length > 0, `${id} still carries its costs, as events`)
  }
  assert.deepEqual(costsOf(outcome.run.id).map(c => c.launch), ['intent', 'material', 'judge'],
    'intake, the worker and the judgment each on the worked note\'s run')
  const counts = doctorRecords(STORY, process.env.ARC_HOME!, new Set()).counts
  assert.equal(counts.find(c => c.id === 'runs-without-receipt')!.count, 0)
})
