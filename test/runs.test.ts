// Runs on the wire. Two properties carry this story: an id is genuinely
// exclusive once HTTP makes concurrent creation ordinary, and Run.emit reaches
// the stream without ever being able to fail a run on a listener's behalf.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeStory } from './fixture.ts'

const STORY = makeStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

const { Run, claimRunId, nextRunId, subscribeRuns, unfinishedRuns, recordLaunch, launchesOf } = await import('../src/run.ts')
const { openRun, listRuns, getRun, observe, closeRun, pendingOutcome, endRun, stopRun, attachLaunch, stateOfEnding, deleteRunTranscripts, finishObserved, liveIds } = await import('../src/runs.ts')

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
  assert.equal(summary.state, 'running')
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
  assert.equal(out.run.state, 'failed', 'and honestly reported: it never ended, so it did not finish')
  assert.equal(out.run.ending, 'unfinished')
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
  assert.equal(after?.state, 'done', 'a rejection is a decision, and the run is done')
  assert.equal(after?.decision, 'rejected')
  assert.equal(after?.ending, 'landed')
  const abandoned = openRun('something to abandon', 'ui')
  closeRun(abandoned.id, 'abandoned')
  assert.equal(listRuns().find(x => x.id === abandoned.id)?.state, 'cancelled')
})

// ---- the closed set of states, the ending, the stop (A67-3) ---------------

test('a run ends once, with an ending from the closed set, and the state follows it', () => {
  for (const [ending, state] of [['landed', 'done'], ['refused', 'refused'], ['could not run', 'failed'], ['timed out', 'failed'], ['budget', 'failed'], ['unreadable', 'failed'], ['cancelled', 'cancelled'], ['unfinished', 'failed']] as const) {
    assert.equal(stateOfEnding(ending), state)
  }
  const r = openRun('a run that ends', 'ui')
  const after = endRun(r.id, 'refused', { gate: 'overlap' })
  assert.equal(after?.state, 'refused')
  assert.equal(after?.ending, 'refused')
  const events = getRun(r.id).events
  assert.equal(events.at(-1)?.event, 'run.ended')
  assert.deepEqual((events.at(-1)?.detail as { ending: string }).ending, 'refused')
  // a second ending changes nothing — the first one wins
  endRun(r.id, 'landed')
  assert.equal(getRun(r.id).run.ending, 'refused')
  assert.equal(getRun(r.id).events.filter(e => e.event === 'run.ended').length, 1)
})

test('a stop ends a running run cancelled, kills what it holds, and is not a second ending for a run that is over', () => {
  const r = openRun('a run to stop', 'ui')
  let killed = 0
  const detach = attachLaunch(r.id, { attempt: '1', sessionId: null, scratchDir: '', expectedTranscript: null, result: Promise.reject(new Error('x')).catch(() => undefined) as never, stop: () => { killed++ } })
  const stopped = stopRun(r.id)
  assert.equal(stopped.state, 'cancelled')
  assert.equal(stopped.ending, 'cancelled')
  assert.equal(killed, 1, 'the child was reached')
  detach()
  assert.equal(stopRun(r.id).ending, 'cancelled', 'stopping again changes nothing')
  const done = openRun('a run that is over', 'ui')
  endRun(done.id, 'landed')
  assert.equal(stopRun(done.id).state, 'done', 'a stop after the ending is not a second ending')
  assert.throws(() => stopRun('run.9999'), (e: unknown) => (e as { status?: number }).status === 404)
})

test('the run record is on disk before anything is launched, in the author\'s words, with its subject', () => {
  const run = new Run('ui', 'another way through sc.01-1', { subject: 'sc.01-1' })
  const root = JSON.parse(fs.readFileSync(path.join(RUNS, run.id, 'root.json'), 'utf8'))
  assert.equal(root.raw_author_input, 'another way through sc.01-1')
  assert.equal(root.subject, 'sc.01-1')
  assert.doesNotMatch(root.raw_author_input, /REROUTE pass/, 'never the brief')
})

test('a run that did not finish is one arc was executing: a launch on record, no ending, not live', () => {
  const launched = (label: string): InstanceType<typeof Run> => {
    const r = new Run('ui', label)
    recordLaunch(r.id, { attempt: '1', session_id: 's', scratch_dir: '/x', expected_transcript: null, at: '' })
    return r
  }
  const dead = launched('killed with the backend')
  const ended = launched('ended properly'); ended.end('landed')
  const decided = launched('decided'); decided.emit('author.decision', undefined, { decision: 'accepted' })
  const receipted = launched('has a receipt')
  fs.mkdirSync(path.join(STORY, 'history'), { recursive: true })
  fs.writeFileSync(path.join(STORY, 'history', `${receipted.id}.yaml`), `run_id: ${receipted.id}\n`)
  // A session's own run — observed, never executed by arc — has no launch.
  const observed = new Run('claude-code', 'a prompt the author typed in a session')

  const ids = unfinishedRuns().map(u => u.id)
  assert.ok(ids.includes(dead.id))
  assert.ok(!ids.includes(ended.id))
  assert.ok(!ids.includes(decided.id))
  assert.ok(!ids.includes(receipted.id))
  assert.ok(!ids.includes(observed.id), 'a run arc only observed left nothing in flight')
  const entry = unfinishedRuns().find(u => u.id === dead.id)!
  assert.equal(entry.prompt, 'killed with the backend')
  assert.ok(entry.started_at)

  // A run this process is still working is not one that did not finish.
  const working = launched('still going')
  assert.ok(unfinishedRuns().map(u => u.id).includes(working.id), 'on disk it looks the same')
  assert.ok(!unfinishedRuns(new Set([working.id])).map(u => u.id).includes(working.id), 'and the registry says otherwise')
})

test('the briefing never reports a run in flight as one that did not finish', () => {
  const r = openRun('a route in flight', 'ui')
  recordLaunch(r.id, { attempt: '1', session_id: 's', scratch_dir: '/x', expected_transcript: null, at: '' })
  assert.ok(liveIds().has(r.id))
  assert.ok(!unfinishedRuns(liveIds()).map(u => u.id).includes(r.id))
  endRun(r.id, 'landed')
  assert.ok(!liveIds().has(r.id), 'and once it is over it is not live either')
})

test('a session\'s run is over when the session stops, with no ending — arc never executed it', () => {
  const r = openRun('a prompt in a session', 'claude-code')
  assert.equal(listRuns().find(x => x.id === r.id)?.state, 'running')
  finishObserved(r.id)
  const after = listRuns().find(x => x.id === r.id)
  assert.equal(after?.state, 'done')
  assert.equal(after?.ending, undefined, 'no ending: there was no receipt to close')
})

test('a launch attached to a run that is already over is stopped, never held', () => {
  const r = openRun('a run that ends before its repair', 'ui')
  endRun(r.id, 'cancelled')
  let stopped = 0
  const detach = attachLaunch(r.id, { attempt: '2', sessionId: null, scratchDir: '', expectedTranscript: null, result: Promise.resolve() as never, stop: () => { stopped++ } })
  assert.equal(stopped, 1, 'the child that arrived late was stopped')
  detach()
})

test('a stop keeps what waits for the author, and a later failure does not relabel the ending', () => {
  const r = openRun('a run holding a proposal', 'ui')
  endRun(r.id, 'cancelled')
  assert.equal(listRuns().find(x => x.id === r.id)?.ending, 'cancelled')
  endRun(r.id, 'could not run', { error: 'on the way out' })
  const after = listRuns().find(x => x.id === r.id)
  assert.equal(after?.ending, 'cancelled', 'the first ending wins')
  assert.equal(after?.state, 'cancelled')
})

test('a live run\'s transcript is not deleted from under its child', () => {
  const r = openRun('still working', 'ui')
  recordLaunch(r.id, { attempt: '1', session_id: 's', scratch_dir: '/x', expected_transcript: null, at: '' })
  assert.throws(() => deleteRunTranscripts(r.id), (e: unknown) => (e as { status?: number }).status === 409)
  endRun(r.id, 'cancelled')
  assert.deepEqual(deleteRunTranscripts(r.id).removed, [], 'once it is over, it deletes')
})

test('a run\'s transcripts are deletable by id, from the launches it recorded, even after a restart', () => {
  const run = new Run('ui', 'left a transcript')
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-transcripts-'))
  const expected = path.join(tdir, 'expected.jsonl'); fs.writeFileSync(expected, '{}')
  const reported = path.join(tdir, 'reported.jsonl'); fs.writeFileSync(reported, '{}')
  recordLaunch(run.id, { attempt: '1', session_id: 's', scratch_dir: '/x', expected_transcript: expected, at: '' })
  recordLaunch(run.id, { attempt: '1', session_id: 's', scratch_dir: '/x', expected_transcript: null, transcript_path: reported, at: '' })
  assert.equal(launchesOf(run.id).length, 2)
  // never registered — the state after a restart
  const out = deleteRunTranscripts(run.id)
  assert.deepEqual(out.removed.sort(), [expected, reported].sort())
  assert.ok(!fs.existsSync(expected) && !fs.existsSync(reported))
  assert.deepEqual(deleteRunTranscripts(run.id).removed, [], 'nothing left to remove')
  assert.throws(() => deleteRunTranscripts('run.9999'), (e: unknown) => (e as { status?: number }).status === 404)
})
