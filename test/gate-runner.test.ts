// The gate runner owns the child (A67-6): it launches, walks the row's gate
// ids in order, writes a typed record for every one that ran, keeps the
// refused text with the run, and offers exactly one repair — resuming the
// first attempt's transcript, with the refusal as the only new input.
//
// A transport failure is not a refusal: it earns no repair, and the run ends
// with its kind. Nothing retries further.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { git, installStubCli, makeExampleStory } from './fixture.ts'

const STORY = makeExampleStory()
// A contract with a quoted withhold, so a gate can refuse a first answer.
const sceneFile = path.join(STORY, 'prose', 'ch-02', 'scene-01.md')
fs.writeFileSync(sceneFile, fs.readFileSync(sceneFile, 'utf8').replace(
  'events: [event.the-wreck]\n---',
  ['events: [event.the-wreck]', 'contract:', '  purpose: Let the wreck be known before it is seen.',
   '  must_establish:', '    - The wreck is known before it is seen.', '  must_withhold:', "    - '\"Whitcombe\"'", '---'].join('\n')))
git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'a contract with a quoted withhold')

process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'claude-cli'
process.env.ARC_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arc-home-')))
delete process.env.ANTHROPIC_API_KEY

const LOG = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-runner-'))
process.env.STUB_LOG = LOG
const TAIL = '\n\n=== BRIEFING ===\nwhere each beat lands.\n\n```json\n{"coverage": [{"item": "The wreck is known before it is seen.", "paragraph": 1}]}\n```'
/** The stub answers by launch: the test writes the script, one answer per
 *  line of ANSWERS, and records the argv and cwd of every launch. */
const ANSWERS = path.join(LOG, 'answers.json')
const LAUNCHES = path.join(LOG, 'launches.json')
fs.writeFileSync(LAUNCHES, '[]')
process.env.STUB_ANSWERS = ANSWERS
process.env.STUB_LAUNCHES = LAUNCHES
process.env.PATH = `${installStubCli({
  name: 'runner',
  before: [
    "const fsx = require('node:fs')",
    "const seen = JSON.parse(fsx.readFileSync(process.env.STUB_LAUNCHES, 'utf8'))",
    "seen.push({ argv, cwd: process.cwd(), prompt })",
    "fsx.writeFileSync(process.env.STUB_LAUNCHES, JSON.stringify(seen))",
    "const script = JSON.parse(fsx.readFileSync(process.env.STUB_ANSWERS, 'utf8'))",
    "const step = script[Math.min(seen.length - 1, script.length - 1)]",
    "if (step && step.exit !== undefined) { process.stderr.write(step.stderr || 'stub failed'); process.exit(step.exit) }",
  ].join('\n  '),
  answer: "(step && step.text) || 'nothing'",
})}${path.delimiter}${process.env.PATH}`

const { runReroute } = await import('../src/reroute.ts')
const { readWorkingReceipt, runFilePath } = await import('../src/run.ts')
const { ROW_EXPLORE_SCENE, ROW_EXPLORE_ROUTE } = await import('../src/registry.ts')

type Launch = { argv: string[]; cwd: string; prompt: string }
const launches = (): Launch[] => JSON.parse(fs.readFileSync(LAUNCHES, 'utf8')) as Launch[]
const script = (...steps: ({ text: string } | { exit: number; stderr?: string })[]): void => {
  fs.writeFileSync(ANSWERS, JSON.stringify(steps))
  fs.writeFileSync(LAUNCHES, '[]')
  // A scene holds four routes at most, and these tests keep landing them.
  fs.rmSync(path.join(STORY, '.arc', 'alternatives'), { recursive: true, force: true })
}
const CLEAN = `A wholly different way in, told in words the book never used.${TAIL}`
const WITHHELD = `The Whitcombe light held, and nothing else did.${TAIL}`

async function route(): Promise<{ out: Awaited<ReturnType<typeof runReroute>>; receipt: ReturnType<typeof readWorkingReceipt> }> {
  const out = await runReroute({ scene: 'sc.02-1', count: 1 })
  return { out, receipt: readWorkingReceipt(out.run!) }
}

test('the runner walks the row\'s gate ids in order, and every one that ran leaves a record', async () => {
  script({ text: CLEAN })
  const { out, receipt } = await route()
  assert.equal(out.alternatives.length, 1)
  const ran = receipt!.gates!.filter(g => g.attempt === 1)
  // The leak gate ran on the BRIEF, before the send; then the shape; then
  // the row's remaining ids in the row's order.
  assert.deepEqual(ran.map(g => g.gate), ['leak', 'shape', ...ROW_EXPLORE_SCENE.gates.filter(g => g !== 'leak')])
  assert.equal(ran[0].stage, 'brief')
  assert.ok(ran.slice(1).every(g => g.stage === 'answer'))
  assert.ok(ran.every(g => ['held', 'refused', 'could not judge', 'not applicable'].includes(g.verdict)))
  assert.equal(launches().length, 1, 'an answer that holds needs no repair')
})

test('a gate refusal earns exactly ONE repair, which resumes the first transcript with the refusal as the only new input', async () => {
  script({ text: WITHHELD }, { text: CLEAN })
  const { out, receipt } = await route()

  assert.equal(out.alternatives.length, 1, 'the repair landed')
  assert.match(out.alternatives[0].retried!, /withholds verbatim/, 'and the route carries what was refused the first time')

  const [first, second] = launches()
  assert.equal(launches().length, 2, 'one repair, and no more')
  // The repair RESUMES: the same transcript, from the same directory.
  assert.ok(!first.argv.includes('--resume'), 'the first launch opens a session')
  const opened = first.argv[first.argv.indexOf('--session-id') + 1]
  assert.equal(second.argv[second.argv.indexOf('--resume') + 1], opened, 'the repair resumes it')
  assert.ok(!second.argv.includes('--session-id'), 'and does not open a second')
  assert.equal(second.cwd, first.cwd, 'from the same working directory, which is where the runtime keeps that transcript')

  // The refusal and the previous answer are the only new input — never a
  // fresh slice.
  assert.match(second.prompt, /YOUR PREVIOUS ANSWER WAS REFUSED/)
  assert.ok(!second.prompt.includes('THE DESTINATION'), 'the brief itself is not sent again')

  // Both attempts are on the receipt, and the refused text is kept.
  assert.deepEqual([...new Set(receipt!.gates!.map(g => g.attempt))], [1, 2])
  assert.equal(receipt!.gates!.find(g => g.attempt === 1 && g.verdict === 'refused')?.gate, 'withhold-literals')
  const refused = fs.readdirSync(path.join(STORY, '.arc', 'runs', out.run!, 'refused'))
  assert.equal(refused.length, 1)
  assert.match(fs.readFileSync(runFilePath(out.run!, 'refused', refused[0].replace('.txt', '')), 'utf8'), /Whitcombe/)
  assert.equal(receipt!.ending, 'landed')
})

test('nothing retries further: two refusals end the run refused, with both attempts on the receipt', async () => {
  script({ text: WITHHELD }, { text: WITHHELD })
  const { out, receipt } = await route()
  assert.equal(out.alternatives.length, 0)
  assert.equal(launches().length, 2, 'exactly two launches, ever')
  assert.match(out.refused[0].reason, /withholds verbatim.*arc tried once more, and:.*withholds verbatim/s)
  assert.equal(receipt!.ending, 'refused')
  assert.equal(receipt!.gates!.filter(g => g.verdict === 'refused').length, 2)
  assert.equal(fs.readdirSync(path.join(STORY, '.arc', 'runs', out.run!, 'refused')).length, 1, 'both answers were the same text, kept once under its fingerprint')
})

test('a stop during the repair reaches the author as a stop, and a gate refusal keeps its own ending', async () => {
  // A gate refuses, then the repair fails on the engine: the ending stays
  // `refused`, because that is what stopped the run — and the repair's own
  // failure is on the receipt and in the sentence.
  script({ text: WITHHELD }, { exit: 4, stderr: 'the repair fell over' })
  const { out, receipt } = await route()
  assert.equal(receipt!.ending, 'refused')
  assert.match(out.refused[0].reason, /withholds verbatim.*\. arc tried once more, and: that pass ended before it answered/s, 'two sentences, not a run-on')
  const engine = receipt!.gates!.find(g => g.gate === 'engine')!
  assert.equal(engine.attempt, 2)
  assert.match(String(engine.bar_from), /the repair fell over/)
})

test('every gate record names the launch it belongs to, so two seeds never blur', async () => {
  script({ text: CLEAN })
  const out = await runReroute({ scene: 'sc.02-1', count: 2 })
  const receipt = readWorkingReceipt(out.run!)!
  assert.equal(out.alternatives.length, 2, 'both seeds landed')
  const launches = [...new Set(receipt.gates!.map(g => g.launch))]
  assert.deepEqual(launches, ['late-entry-1', 'pressure-first-1'], 'each seed\'s gates are its own')
  assert.ok(receipt.gates!.every(g => g.attempt === 1))
})

test('a transport failure is not a refusal: no repair, and the run ends with its kind', async () => {
  script({ exit: 3, stderr: 'the engine fell over' })
  const { out, receipt } = await route()
  assert.equal(out.alternatives.length, 0)
  assert.equal(launches().length, 1, 'a transport failure earns no repair')
  assert.equal(out.refused[0].reason, 'that pass ended before it answered, so nothing was written. Ask again.')
  assert.equal(receipt!.ending, 'could not run')
  const gate = receipt!.gates!.find(g => g.gate === 'engine')!
  assert.equal(gate.stage, 'launch')
  assert.equal(gate.verdict, 'could not judge')
  assert.match(String(gate.bar_from), /the engine fell over/, 'the engine\'s own words are on the receipt, not on the page')
})

test('a missing coverage marker refuses the write, because the gate cannot run', async () => {
  script({ text: 'A route with no tail.\n\n=== BRIEFING ===\nnothing machine-readable here.' },
         { text: 'Still no tail.\n\n=== BRIEFING ===\nnor here.' })
  const { out, receipt } = await route()
  assert.equal(out.alternatives.length, 0, 'nothing lands unchecked')
  assert.match(out.refused[0].reason, /no coverage tail/)
  assert.equal(receipt!.gates!.find(g => g.gate === 'coverage-tail')?.verdict, 'refused')
  assert.equal(receipt!.ending, 'refused')
})

test('a gate that genuinely cannot judge is recorded as such — never as passed', async () => {
  // Two paragraphs is under the overlap gate's floor, so it cannot judge.
  script({ text: `A short way in.\n\nAnd out again.${TAIL}` })
  const { out, receipt } = await route()
  assert.equal(out.alternatives.length, 1)
  const overlap = receipt!.gates!.find(g => g.gate === 'overlap')!
  assert.equal(overlap.verdict, 'could not judge')
  assert.equal(overlap.bar, 0.4, 'the bar it could not measure against is still on the record')
  assert.equal(out.alternatives[0].overlap, null, 'and the route says "not reported", never zero')
})

test('a row naming a gate this arc cannot run is refused, never quietly skipped', async () => {
  const { runRowGates, GATES } = await import('../src/gates.ts')
  const { gateCtx } = await import('../src/reroute.ts')
  const ctx = gateCtx({ sceneName: 'sc.x', sceneBody: 'a\n\nb\n\nc', sceneLocks: [], lockedTexts: [], literals: [], andCap: null, wordCap: null, destination: ['x'] })
  const row = { ...ROW_EXPLORE_ROUTE, gates: ['validator'] as never }
  assert.ok(!('validator' in GATES), 'the validator is declared in the registry and not implemented here yet')
  const out = runRowGates(row, ctx, `a\n\nb\n\nc${TAIL}`)
  assert.equal(out.ok, false)
  assert.match(out.reason, /could not check validator/)
  assert.equal(out.gates.find(g => g.gate === 'validator')?.verdict, 'could not judge')
})
