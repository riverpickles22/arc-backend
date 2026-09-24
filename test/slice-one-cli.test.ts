// SLICE 1 UNDER A RUNTIME (A67-13, criterion 1 — the two halves the fixture
// engine cannot prove).
//
// The fixture engine is a recorded answer, not a process: it emits no
// `system/init` event and spawns no child, so on that harness the observed
// envelope is empty and a stop has nothing to kill. Asserting either there
// would pass over no data, which is worse than not asserting it — it retires
// the question. Both are proven here instead, against a stub runtime that
// reports an init event the way the real one does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { git, installStubCli, makeExampleStory } from './fixture.ts'

const ANSWER = [
  'Ines was already on the stairs when the sea changed its mind about the morning.',
  '',
  'She had counted forty-one steps before she let herself hear it, and forty-two before she let herself stop.',
  '',
  'Wren\'s coat hung where Wren had left it, and the salt on its shoulders had dried into a map of nothing.',
  '',
  'By the time the light turned again there was no one to tell, and she told the light.',
  '',
  '=== BRIEFING ===',
  'The wreck is reached from the stairs.',
  '',
  '```json',
  '{"coverage": [{"item": "The wreck is known before it is seen.", "paragraph": 2}, {"item": "Wren is absent.", "paragraph": 3}]}',
  '```',
].join('\n')

const STORY = makeExampleStory()
const sceneFile = path.join(STORY, 'prose', 'ch-02', 'scene-01.md')
fs.writeFileSync(sceneFile, fs.readFileSync(sceneFile, 'utf8').replace(
  'events: [event.the-wreck]\n---',
  'events: [event.the-wreck]\ncontract:\n  purpose: Let the wreck be known before it is seen.\n  must_establish:\n    - The wreck is known before it is seen.\n    - Wren is absent.\n---'))
git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'scene contract')
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'claude-cli'
process.env.ARC_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arc-home-')))
delete process.env.ANTHROPIC_API_KEY

// The first launch answers at once; every later one sleeps until it is
// killed — so one seed lands and the other is there to be stopped.
const COUNTER = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arc-slice1-')), 'launches')
fs.writeFileSync(COUNTER, '')
process.env.STUB_COUNTER = COUNTER
process.env.PATH = `${installStubCli({
  name: 'slice1',
  before: [
    "const fsx = require('node:fs'); const n = fsx.readFileSync(process.env.STUB_COUNTER, 'utf8').length; fsx.appendFileSync(process.env.STUB_COUNTER, 'x')",
    "if (n > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000)",
  ].join('\n  '),
  answer: JSON.stringify(ANSWER),
})}${path.delimiter}${process.env.PATH}`

const { createArcServer } = await import('../src/server.ts')
const { readWorkingReceipt } = await import('../src/run.ts')
const server = createArcServer()
await new Promise<void>(resolve => server.listen(0, resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
test.after(() => server.close())
const get = (p: string) => fetch(base + p)
const post = (p: string, body: unknown) =>
  fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

test('the receipt lists what the runtime added as OBSERVED, with where — never as "none", and never as arc\'s declaration', async () => {
  const res = await (await post('/api/prose/reroute', { scene: 'sc.02-1', count: 1 })).json() as { alternatives: unknown[]; run?: string }
  assert.ok(res.alternatives.length, 'a route landed, so there is a receipt to read')
  const r = readWorkingReceipt(res.run!)!

  const added = r.slice?.runtime_added ?? []
  // THE ASSERTION THAT MATTERS: there is something here. arc does not control
  // the runtime's environment, and a receipt that reports nothing was added is
  // claiming knowledge it does not have — the exact lie the envelope's proof
  // classes exist to prevent.
  assert.ok(added.length > 0, 'the runtime added things, and the receipt says so')
  assert.ok(!added.some(a => /^none$/i.test(a)), 'never the word none')
  for (const entry of added) {
    assert.match(entry, / — /, 'each says WHERE it was observed, not merely that it was')
  }
  assert.ok(added.some(a => a.startsWith('user_level_instructions')),
    'user-level instructions among them: the runtime does not report them, so they are listed as present on disk')

  // And the envelope keeps the proof class of each field apart. A field that
  // is merely observed must never be filed as proven.
  const obs = (r.envelope?.observed ?? [])[0]
  assert.ok(obs, 'one observation per launch')
  assert.ok(Object.keys(obs.recorded ?? {}).length > 0, 'recorded fields, with where each was seen')
  for (const [, v] of Object.entries(obs.recorded ?? {})) assert.ok(v.observed_in, 'each names where')
  assert.ok(!Object.keys(obs.proven ?? {}).some(k => k in (obs.recorded ?? {})),
    'no field is both proven and merely recorded')
})

test('a route stopped from the viewer ends cancelled ON THE RECEIPT, and what landed stays', async () => {
  // The stub answers its first launch at once and sleeps in every later one.
  // The test above used the first, so the counter is reset here: this run
  // needs one seed that lands and one that is still working when the stop
  // arrives, which is the only shape in which "what landed stays" means
  // anything.
  fs.writeFileSync(COUNTER, '')
  const request = post('/api/prose/reroute', { scene: 'sc.02-1', count: 2 })
    .then(r => r.json() as Promise<{ alternatives: { id: string }[]; refused: { seed: string; outcome?: string }[]; run?: string }>)

  let id: string | undefined
  for (let i = 0; i < 60 && !id; i++) {
    await sleep(100)
    const { runs } = await (await get('/api/runs')).json() as { runs: { id: string; state: string; subject?: string }[] }
    id = runs.find(r => r.subject === 'sc.02-1' && r.state === 'running')?.id
  }
  assert.ok(id, 'the run is listed while it works, which is what makes it stoppable')

  const stopped = await post(`/api/runs/${id}/stop`, {})
  assert.equal(stopped.status, 200)
  const out = await request

  // THE POINT: the ending the author is shown, the ending the run registry
  // holds and the ending on the RECEIPT are one ending. A stop that left the
  // receipt saying anything else would make the record disagree with the page.
  const r = readWorkingReceipt(out.run!)!
  assert.equal(r.ending, 'cancelled')
  const { runs } = await (await get('/api/runs')).json() as { runs: { id: string; ending?: string }[] }
  assert.equal(runs.find(x => x.id === out.run)?.ending, 'cancelled', 'the registry says the same')

  // What landed stays: a stop is not a rollback.
  assert.equal(out.alternatives.length, 1, 'the seed that finished before the stop kept its route')
  const [refusal] = out.refused
  assert.ok(refusal, 'and the one that did not is reported rather than dropped')
  assert.match(refusal.outcome ?? '', /^you stopped it before it landed — ask again to try from where the scene stands now\.$/,
    'in one sentence rendered by code, ending in the keystroke that is on the page')
})
