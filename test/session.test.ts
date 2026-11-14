// The session timer (A76-4): start, switch, stop, the state, and a count
// left running — over the wire and as functions, on a synthetic story.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { git, makeStory } from './fixture.ts'

const story = makeStory()
process.env.ARC_STORY_PATH = story
const { createArcServer } = await import('../src/server.ts')
const { countedIntervals, pingSession, sessionState, startSession, stopSession, IDLE_MINUTES } = await import('../src/session.ts')

const server = createArcServer()
await new Promise<void>(resolve => server.listen(0, resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
test.after(() => server.close())

const post = (p: string, body: unknown = {}) =>
  fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const lines = (): Record<string, string>[] => {
  try { return fs.readFileSync(path.join(story, '.arc', 'sessions.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] }
}
const reset = (): void => { for (const f of ['sessions.jsonl', 'session.json', 'session.closed.json']) fs.rmSync(path.join(story, '.arc', f), { force: true }) }

test('over the wire: nothing counts until started; start, switch and stop each answer the state', async () => {
  reset()
  assert.deepEqual(await (await fetch(base + '/api/session')).json(), { running: null, closed: null })

  const started = await (await post('/api/session/start', { kind: 'writing' })).json()
  assert.equal(started.running.kind, 'writing')
  const switched = await (await post('/api/session/start', { kind: 'record' })).json()
  assert.equal(switched.running.kind, 'record')
  assert.equal((await (await post('/api/session/ping', { input: new Date().toISOString() })).json()).running.kind, 'record')
  assert.deepEqual(await (await fetch(base + '/api/session')).json(), switched)

  const stopped = await post('/api/session/stop')
  assert.equal(stopped.status, 200)
  assert.deepEqual(await stopped.json(), { running: null, closed: null })
  // a stretch shorter than a millisecond is not written, so over a fast wire
  // only the order and the endings are certain
  const written = lines().map(l => `${l.kind}/${l.ended}`)
  assert.ok(written.every(w => w === 'writing/switched' || w === 'record/stopped'), written.join(', '))
  assert.ok(!fs.existsSync(path.join(story, '.arc', 'session.json')), 'nothing left running')
})

test('over the wire: a kind that is not writing or the record is a 400, and starts nothing', async () => {
  reset()
  for (const body of [{}, { kind: 'reading' }, { kind: 3 }]) {
    const res = await post('/api/session/start', body)
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.match((await res.json()).error, /kind must be "writing" or "record"/)
  }
  assert.deepEqual(await (await fetch(base + '/api/session')).json(), { running: null, closed: null })
  assert.equal((await fetch(base + '/api/session/stop')).status, 405)
})

test('the timer is working state: it commits nothing and leaves the story\'s status alone', async () => {
  const head = git(story, 'rev-parse', 'HEAD')
  const status = git(story, 'status', '--porcelain', '--', 'prose', 'canon')
  await post('/api/session/start', { kind: 'writing' })
  await post('/api/session/stop')
  assert.equal(git(story, 'rev-parse', 'HEAD'), head)
  assert.equal(git(story, 'status', '--porcelain', '--', 'prose', 'canon'), status)
})

// The clock in these tests runs a day ahead of the fixture's files, so the
// files show no activity unless a test touches one at a time it names.
const ZERO = Math.ceil((Date.now() + 86_400_000) / 3_600_000) * 3_600_000
const T = (min: number): Date => new Date(ZERO + min * 60_000)
const touch = (rel: string, min: number): void => {
  const abs = path.join(story, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, 'x\n')
  fs.utimesSync(abs, T(min), T(min))
}

test('starting one kind ends the other; the same kind carries on; stop ends it', () => {
  reset()
  startSession('writing', T(0))
  assert.deepEqual(startSession('writing', T(1)).running, { kind: 'writing', since: T(0).toISOString() }, 'the same kind is not a new stretch')
  pingSession(T(20).toISOString(), T(20))
  startSession('record', T(30))
  stopSession(T(45))
  assert.deepEqual(lines(), [
    { kind: 'writing', start: T(0).toISOString(), end: T(30).toISOString(), ended: 'switched' },
    { kind: 'record', start: T(30).toISOString(), end: T(45).toISOString(), ended: 'stopped' },
  ])
  assert.deepEqual(stopSession(T(50)), { running: null, closed: null }, 'a stop with nothing running is no error, and was no idle close')
  assert.equal(lines().length, 2)
})

test('input in the viewer keeps a count open; with none for half an hour it closes at the last input, marked idle', () => {
  reset()
  startSession('writing', T(0))
  // the viewer checks in every minute, but the author last touched it at 10
  for (let m = 1; m <= 40; m++) pingSession(m <= 10 ? T(m).toISOString() : T(10).toISOString(), T(m))
  assert.equal(sessionState(T(40)).running?.kind, 'writing', 'thirty minutes after the last input it still runs')
  assert.deepEqual(sessionState(T(41)), { running: null, closed: { kind: 'writing', at: T(10).toISOString(), idleMinutes: IDLE_MINUTES } })
  assert.deepEqual(lines(), [{ kind: 'writing', start: T(0).toISOString(), end: T(10).toISOString(), ended: 'idle' }])
  // the next press clears what the viewer says
  assert.equal(startSession('record', T(50)).closed, null)
  reset()
})

test('a change to the story\'s files keeps a count open with the viewer asleep, and a late check-in loses none of it', () => {
  reset()
  startSession('writing', T(0))
  // no check-in at all: the author writes in their own editor, then a note
  touch('prose/ch-01/scene-01.md', 25)
  touch('notes/later.md', 50)
  assert.equal(sessionState(T(70)).running?.kind, 'writing', 'the note at 50 is twenty minutes ago')
  // the measure counts a running count up to its last activity
  assert.deepEqual(countedIntervals(story, T(70)).map(i => i.end), [T(50).toISOString()])
  // the suspended tab wakes with an old input time: it moves nothing back
  pingSession(T(5).toISOString(), T(75))
  // and the night: closed at the last change, not at the morning
  assert.equal(sessionState(T(600)).running, null)
  assert.deepEqual(lines(), [{ kind: 'writing', start: T(0).toISOString(), end: T(50).toISOString(), ended: 'idle' }])
  fs.rmSync(path.join(story, 'notes'), { recursive: true, force: true })
  reset()
})

test('a count with no activity after its start writes no line, and the author is still told it stopped', () => {
  reset()
  touch('prose/ch-01/scene-01.md', -5)   // a change from before the count is no activity in it
  startSession('record', T(0))
  assert.deepEqual(sessionState(T(31)), { running: null, closed: { kind: 'record', at: T(0).toISOString(), idleMinutes: IDLE_MINUTES } })
  assert.deepEqual(lines(), [], 'no length, no line')
  assert.deepEqual(sessionState(T(90)).closed?.at, T(0).toISOString(), 'it stays until the next press')
  assert.equal(stopSession(T(91)).closed, null, 'a press clears it')
  reset()
})
