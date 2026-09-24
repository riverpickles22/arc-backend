// A running route can be stopped (A67-3), end to end over HTTP: the run
// exists before the first token, is listed while it works, is joined by the
// hook rather than duplicated, and a stop kills the child, keeps the route
// that landed, and ends the run cancelled. A backend killed mid-run leaves a
// run the briefing names, and its transcript is deletable by id.
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
// The first launch answers at once; every later one sleeps until stopped —
// so a two-seed route lands one and is stopped in the other.
const COUNTER = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arc-stop-')), 'launches')
fs.writeFileSync(COUNTER, '')
process.env.STUB_COUNTER = COUNTER
process.env.PATH = `${installStubCli({
  name: 'stop',
  before: [
    "const fsx = require('node:fs'); const n = fsx.readFileSync(process.env.STUB_COUNTER, 'utf8').length; fsx.appendFileSync(process.env.STUB_COUNTER, 'x')",
    "if (n > 0 && !process.env.STUB_FAST) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000)",
  ].join('\n  '),
  answer: JSON.stringify(ANSWER),
})}${path.delimiter}${process.env.PATH}`

const { createArcServer } = await import('../src/server.ts')
const { listAlternatives } = await import('../src/reroute.ts')
const { unfinishedRuns, Run, recordLaunch } = await import('../src/run.ts')
const server = createArcServer()
await new Promise<void>(resolve => server.listen(0, resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
test.after(() => server.close())
const get = (p: string) => fetch(base + p)
const post = (p: string, body: unknown) =>
  fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type Summary = { id: string; state: string; ending?: string; prompt: string; subject?: string }
async function runningRoute(): Promise<Summary | undefined> {
  const { runs } = await (await get('/api/runs')).json() as { runs: Summary[] }
  return runs.find(r => r.subject === 'sc.02-1' && r.state === 'running')
}

test('a route run exists before the first token, in the author\'s words, and a stop keeps what landed and ends it cancelled', async () => {
  const request = post('/api/prose/reroute', { scene: 'sc.02-1', count: 2 }).then(r => r.json() as Promise<{ alternatives: { id: string }[]; refused: { seed: string; reason: string }[]; run?: string }>)
  let run: Summary | undefined
  for (let i = 0; i < 100 && !run; i++) { await sleep(50); run = await runningRoute() }
  assert.ok(run, 'the run is listed while it works')
  assert.equal(run.prompt, 'another way through sc.02-1', 'labelled in the author\'s words, never the brief')
  const root = JSON.parse(fs.readFileSync(path.join(STORY, '.arc', 'runs', run.id, 'root.json'), 'utf8'))
  assert.equal(root.subject, 'sc.02-1', 'its record was on disk before the seam was called')

  // the hook joins the run arc launched rather than opening a second one —
  // from the scratch directory the child actually runs in (A67-2)
  const firstLaunch = JSON.parse(fs.readFileSync(path.join(STORY, '.arc', 'runs', run.id, 'launches.jsonl'), 'utf8').split('\n')[0]) as { scratch_dir: string }
  fs.mkdirSync(firstLaunch.scratch_dir, { recursive: true })
  const hooked = await (await post('/api/agents/hook', { event: 'UserPromptSubmit', session: 'child-1', cwd: firstLaunch.scratch_dir, source: 'claude-code', run: run.id, prompt: 'the brief the child was handed' })).json() as { run: string }
  assert.equal(hooked.run, run.id)
  const { runs } = await (await get('/api/runs')).json() as { runs: Summary[] }
  assert.equal(runs.filter(r => r.prompt.includes('the brief the child was handed')).length, 0, 'no run wears the prompt text')
  assert.equal(runs.filter(r => r.subject === 'sc.02-1').length, 1, 'exactly one run for the route request')

  // let the first seed land, then stop during the second
  for (let i = 0; i < 100 && listAlternatives('sc.02-1').length === 0; i++) await sleep(50)
  assert.equal(listAlternatives('sc.02-1').length, 1, 'the first seed landed and is on disk')
  await sleep(200)
  const stopped = await (await post(`/api/runs/${run.id}/stop`, {})).json() as { run: Summary }
  assert.equal(stopped.run.state, 'cancelled')
  assert.equal(stopped.run.ending, 'cancelled')

  const out = await request
  assert.equal(out.run, run.id)
  assert.equal(out.alternatives.length, 1, 'what landed stays')
  assert.equal(out.refused.length, 1)
  assert.equal(out.refused[0].reason, 'stopped before it landed')
  assert.equal(listAlternatives('sc.02-1').length, 1)

  const detail = await (await get(`/api/runs/${run.id}`)).json() as { run: Summary; events: { event: string; detail?: { ending?: string } }[] }
  assert.equal(detail.run.state, 'cancelled')
  const ended = detail.events.filter(e => e.event === 'run.ended')
  assert.equal(ended.length, 1)
  assert.equal(ended[0].detail?.ending, 'cancelled')

  // the launches were recorded, so the transcripts are named by id
  const launches = fs.readFileSync(path.join(STORY, '.arc', 'runs', run.id, 'launches.jsonl'), 'utf8').trim().split('\n')
    .map(l => JSON.parse(l) as { attempt: string; session_id: string | null; expected_transcript: string | null; transcript_path?: string | null })
  const started = launches.filter(l => l.expected_transcript !== null)
  assert.equal(started.length, 2, 'one record per launch, written before the child ran')
  assert.ok(started.every(l => l.session_id && l.expected_transcript!.endsWith(`${l.session_id}.jsonl`)), 'the transcript is named before the run')
  assert.notEqual(started[0].session_id, started[1].session_id, 'no two launches of one run share a session')
  assert.ok(launches.some(l => typeof l.transcript_path === 'string'), 'and where the runtime said it wrote it')
})

test('stopping a run that is over, or unknown, is honest', async () => {
  assert.equal((await post('/api/runs/run.9999/stop', {})).status, 404)
})

test('a run killed with the backend is named by the briefing as unfinished, and its transcript is deletable by id', async () => {
  // What a killed backend leaves: a run record with launches and no ending.
  const dead = new Run('ui', 'another way through sc.02-1', { subject: 'sc.02-1' })
  const transcript = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arc-dead-')), 'dead.jsonl')
  fs.writeFileSync(transcript, '{}')
  recordLaunch(dead.id, { attempt: 'late-entry-1', session_id: 's', scratch_dir: '/x', expected_transcript: transcript, at: '' })

  assert.ok(unfinishedRuns().some(u => u.id === dead.id), 'found at startup')
  const b = await (await get('/api/briefing')).json() as { unfinished: { id: string; prompt: string }[] }
  const named = b.unfinished.find(u => u.id === dead.id)
  assert.ok(named, 'the briefing names it')
  assert.equal(named.prompt, 'another way through sc.02-1')

  const detail = await (await get(`/api/runs/${dead.id}`)).json() as { run: Summary }
  assert.equal(detail.run.state, 'failed')
  assert.equal(detail.run.ending, 'unfinished')

  const del = await fetch(`${base}/api/runs/${dead.id}/transcript`, { method: 'DELETE' })
  assert.equal(del.status, 200)
  assert.deepEqual((await del.json() as { removed: string[] }).removed, [transcript])
  assert.ok(!fs.existsSync(transcript))
})
