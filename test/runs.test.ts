// Runs on the wire. Two properties carry this story: an id is genuinely
// exclusive once HTTP makes concurrent creation ordinary, and Run.emit reaches
// the stream without ever being able to fail a run on a listener's behalf.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeStory } from './fixture.ts'

const STORY = makeStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

const { Run, claimRunId, nextRunId, subscribeRuns } = await import('../src/run.ts')
const { openRun, listRuns, getRun, observe, closeRun, pendingOutcome } = await import('../src/runs.ts')

const RUNS = path.join(STORY, '.arc', 'runs')

test('claimRunId is exclusive — a hundred claims yield a hundred distinct ids', () => {
  const ids = Array.from({ length: 100 }, () => claimRunId())
  assert.equal(new Set(ids).size, 100, 'no id was handed out twice')
  for (const id of ids) assert.ok(fs.existsSync(path.join(RUNS, id)), `${id} owns its directory`)
})

test('nextRunId alone is NOT exclusive — which is why claimRunId exists', () => {
  // Pinning the reason rather than the fix: two reads with no write between
  // them agree, and agreeing is precisely the bug when both then claim it.
  assert.equal(nextRunId(), nextRunId())
})

test('concurrent run creation never collides', async () => {
  const runs = await Promise.all(Array.from({ length: 12 }, async (_, i) => {
    await new Promise(r => setTimeout(r, i % 3))   // interleave the claims
    return new Run('cli', `concurrent ${i}`)
  }))
  const ids = runs.map(r => r.id)
  assert.equal(new Set(ids).size, ids.length, 'twelve runs, twelve ids')
})

test('emit reaches events.jsonl and every subscriber', () => {
  const seen: { id: string; event: string }[] = []
  const stop = subscribeRuns(m => seen.push({ id: m.run!, event: m.event }))

  const run = new Run('ui', 'a prompt worth recording')
  run.emit('intent.resolved', undefined, { ok: true })
  stop()
  run.emit('task.completed', undefined, { after: 'unsubscribe' })

  assert.deepEqual(seen.map(s => s.event), ['run.started', 'intent.resolved'],
    'events arrive live, and stop when the subscriber leaves')
  assert.ok(seen.every(s => s.id === run.id), 'each carries the run it belongs to')

  const log = fs.readFileSync(path.join(RUNS, run.id, 'events.jsonl'), 'utf8').trim().split('\n')
  assert.equal(log.length, 3, 'the log is still the record, including what the stream missed')
})

test('a subscriber that throws never fails the run that was reporting to it', () => {
  const stop = subscribeRuns(() => { throw new Error('this listener is broken') })
  const run = new Run('cli', 'a run with a hostile audience')
  assert.doesNotThrow(() => run.emit('task.completed', undefined, { fine: true }))
  stop()
  assert.equal(run.events.length, 2, 'and the run kept its own record')
})

// ---- the registry --------------------------------------------------------

test('a run is open and addressable before anything has read the prompt', () => {
  const summary = openRun('make Manuel seem more suspicious here', 'claude-code')
  assert.equal(summary.state, 'working')
  assert.equal(summary.prompt, 'make Manuel seem more suspicious here')
  assert.equal(summary.source, 'claude-code')
  assert.ok(summary.started_at, 'stamped')

  const listed = listRuns().find(r => r.id === summary.id)
  assert.ok(listed, 'and it is listed immediately')
})

test('an empty prompt opens no run', () => {
  const before = listRuns().length
  assert.throws(() => openRun('   '), (e: unknown) => (e as { status?: number }).status === 400)
  assert.equal(listRuns().length, before)
})

test('observed actions land on the run; an unknown run is a clean 404', () => {
  const r = openRun('a session doing its own thing', 'claude-code')
  observe(r.id, { tool: 'Edit', path: 'prose/ch-01/scene-01.md' })
  const detail = getRun(r.id)
  assert.equal(detail.run.events, 2, 'run.started plus the observation')
  assert.match(JSON.stringify(detail.events), /scene-01/)

  assert.throws(() => observe('run.9999', {}), (e: unknown) => (e as { status?: number }).status === 404)
})

test('getRun falls back to disk for a run this process never held', () => {
  const run = new Run('cli', 'from an earlier boot')
  run.emit('task.completed', undefined, { done: true })
  // Never registered — exactly the state after a restart.
  const out = getRun(run.id)
  assert.equal(out.run.prompt, 'from an earlier boot', 'read back from root.json')
  assert.equal(out.run.state, 'closed', 'and honestly reported as no longer live')
  assert.equal(out.events.length, 2)
})

test('an unknown or malformed run id is a 404, never a path', () => {
  for (const bad of ['run.9999', '../../etc', 'not-a-run', '']) {
    assert.throws(() => getRun(bad), (e: unknown) => (e as { status?: number }).status === 404, `should refuse ${bad}`)
  }
})

test('a run with no pipeline behind it cannot be decided', () => {
  const r = openRun('nothing has produced anything yet', 'ui')
  assert.throws(() => pendingOutcome(r.id), (e: unknown) => (e as { status?: number }).status === 404)
})

test('closing a run records the decision and stops it awaiting', () => {
  const r = openRun('something to close', 'ui')
  closeRun(r.id, 'rejected')
  const after = listRuns().find(x => x.id === r.id)
  assert.equal(after?.state, 'closed')
  assert.equal(after?.decision, 'rejected')
})
