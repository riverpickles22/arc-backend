// The record-maintenance burden, read from a planted record (A76-4).
//
// A synthetic story with three sessions, each more than the session gap
// apart: one the timer never counted (so the burden is inferred from commit
// times, and the printout must say it fell back), and two counted by the
// timer, the last closed on its own when nothing happened. Then the same
// story with the timer's sessions only, which must not say it fell back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { git, writeScene } from './fixture.ts'
import { MEASURES, burdenSessions, burdenTrend, kindOfCommit, type StoryRecord } from '../src/measure.ts'

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(BACKEND, 'src', 'measure-cli.ts')
const STORY = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-test-burden-'))

const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(STORY, rel)), { recursive: true })
  fs.writeFileSync(path.join(STORY, rel), text)
}
const commitAt = (at: string, message: string): void => {
  git(STORY, 'add', '-A')
  execFileSync('git', ['-C', STORY, 'commit', '-qm', message], { env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } })
}
const interval = (kind: string, start: string, end: string, ended = 'switched') => JSON.stringify({ kind, start, end, ended })

git(STORY, 'init', '-q')
git(STORY, 'config', 'user.email', 'test@test')
git(STORY, 'config', 'user.name', 'test')
write('.gitignore', '.arc/\n')
write('canon/story.yaml', 'title: A Test Story\n')

// SESSION ONE, no timer: prose at 10:00, the record at 10:30, prose at 11:00,
// a note at 11:10, and one of arc's own receipts at 11:20, which is no
// author time. Inferred: 30 minutes writing, 30 + 10 on the record.
writeScene(STORY, 'prose/ch-01/scene-01.md', 'sc.01-1', 'One.')
commitAt('2026-10-01T10:00:00Z', 'a scene')
write('canon/entities/characters/ann.yaml', 'id: char.ann\ntype: character\nname: Ann\nstatus: canon\n')
commitAt('2026-10-01T10:30:00Z', 'Ann')
writeScene(STORY, 'prose/ch-01/scene-01.md', 'sc.01-1', 'One. Two.')
commitAt('2026-10-01T11:00:00Z', 'more of the scene')
write('notes/a-thought.md', 'A thought.\n')
commitAt('2026-10-01T11:10:00Z', 'a thought')
write('history/run.0001.yaml', 'run_id: run.0001\n')
commitAt('2026-10-01T11:20:00Z', 'a receipt')

// SESSION TWO, the timer: an hour writing, a quarter-hour on the record. The
// prose commit inside it is not counted — the timer decides a session it counted.
write('.arc/sessions.jsonl', [
  interval('writing', '2026-10-03T09:00:00.000Z', '2026-10-03T10:00:00.000Z'),
  interval('record', '2026-10-03T10:00:00.000Z', '2026-10-03T10:15:00.000Z', 'stopped'),
  // SESSION THREE: five minutes on the record, then forty writing, closed idle
  interval('record', '2026-10-05T08:55:00.000Z', '2026-10-05T09:00:00.000Z'),
  interval('writing', '2026-10-05T09:00:00.000Z', '2026-10-05T09:40:00.000Z', 'idle'),
].join('\n') + '\n')
writeScene(STORY, 'prose/ch-01/scene-01.md', 'sc.01-1', 'One. Two. Three.')
commitAt('2026-10-03T09:30:00Z', 'the scene again')

const run = (...args: string[]): string =>
  execFileSync(process.execPath, ['--import', 'tsx', CLI, STORY, ...args], { cwd: BACKEND, encoding: 'utf8' })
interface Burden { status: string; value: string; totals: Record<string, unknown>; rows: Record<string, unknown>[] }
const burdenOf = (...args: string[]): Burden =>
  (JSON.parse(run('--json', ...args)) as { measures: (Burden & { id: string })[] }).measures.find(m => m.id === 'record-maintenance-burden')!

test('criterion 1: the timer\'s durations are what the script reads, per session, dated, with a trend', () => {
  const b = burdenOf()
  assert.equal(b.status, 'measured')
  assert.deepEqual(b.rows.map(r => [r.start, r.source, r.writing_minutes, r.record_minutes, r.burden]), [
    ['2026-10-01T10:00:00.000Z', 'commit times (inferred)', 30, 40, 1.33],
    ['2026-10-03T09:00:00.000Z', 'timer', 60, 15, 0.25],
    ['2026-10-05T08:55:00.000Z', 'timer', 40, 5, 0.13],
  ])
  // over the timed sessions only: the inferred 1.33 is on another scale
  assert.equal(b.totals.trend, 'falling')
  assert.equal(b.totals.trend_over, 'timer')
  assert.deepEqual(b.totals.trend_burdens, [0.25, 0.13])
  assert.match(b.value, /^0\.13 record minutes per writing minute in the last session \(2026-10-05, 5 on the record, 40 writing, by timer\); 3 sessions, trend falling over the 2 timed sessions \(0\.25 → 0\.13\)\./)
})

test('criterion 2: a session with no timer falls back to commit times, and says so', () => {
  const b = burdenOf()
  assert.equal(b.totals.fell_back, true)
  assert.equal(b.totals.inferred_sessions, 1)
  assert.match(b.value, /FELL BACK to commit times for 1 of 3 sessions: the timer counted nothing in it, so the time between commits was inferred, not counted\./)
  const text = run()
  const block = text.split(/\n(?=\d\. )/).find(x => x.startsWith('4. record-maintenance burden'))!
  assert.match(block, /FELL BACK to commit times/)
  assert.match(block, /\n {3}default definition — confirm or change: Author minutes on the record divided by minutes writing, per session/)
  assert.match(block, /FALLBACK \(inferred, and printed when used\)/)
  assert.match(block, /session 2026-10-01 10:00: .*source commit times \(inferred\)/)
})

test('the timer\'s sessions alone do not say they fell back', () => {
  const b = burdenOf('--since', '2026-10-02')
  assert.equal(b.totals.fell_back, false)
  assert.equal(b.rows.length, 2)
  assert.doesNotMatch(b.value, /FELL BACK/)
  assert.equal(b.totals.trend, 'falling')
})

test('kinds, sessions and the trend, as pure functions', () => {
  assert.equal(kindOfCommit(['prose/ch-01/scene-01.md', 'docs/style.evidence.jsonl']), 'writing', 'an accept is writing')
  assert.equal(kindOfCommit(['docs/style.md']), 'record')
  assert.equal(kindOfCommit(['history/run.0001.yaml']), null, 'arc\'s receipts are no author time')
  // one commit alone has no time before it: zero minutes, no burden
  const lone = burdenSessions([], [{ at: '2026-10-01T10:00:00.000Z', kind: 'writing' }])
  assert.deepEqual(lone.map(s => [s.writing_minutes, s.record_minutes, s.burden]), [[0, 0, null]])
  // a gap longer than the idle bound counts for the bound, not the gap
  const long = burdenSessions([], [
    { at: '2026-10-01T10:00:00.000Z', kind: 'writing' }, { at: '2026-10-01T12:00:00.000Z', kind: 'writing' },
    { at: '2026-10-01T12:10:00.000Z', kind: 'record' },
  ])
  assert.deepEqual(long.map(s => [s.writing_minutes, s.record_minutes]), [[30, 10]])
  // with fewer than two timed sessions the trend is the inference's, and says so
  const inferredOnly = [
    ...burdenSessions([], [{ at: '2026-10-01T10:00:00.000Z', kind: 'writing' }, { at: '2026-10-01T10:20:00.000Z', kind: 'writing' }, { at: '2026-10-01T10:30:00.000Z', kind: 'record' }]),
    ...burdenSessions([], [{ at: '2026-10-03T10:00:00.000Z', kind: 'writing' }, { at: '2026-10-03T10:20:00.000Z', kind: 'writing' }, { at: '2026-10-03T10:40:00.000Z', kind: 'record' }]),
  ]
  assert.deepEqual(burdenTrend(inferredOnly), { direction: 'rising', over: 'commit times (inferred)', burdens: [0.5, 1] })
  // a record-only session has no burden to divide, and the trend skips it
  const s = burdenSessions([
    { kind: 'record', start: '2026-10-01T10:00:00.000Z', end: '2026-10-01T10:30:00.000Z', ended: 'stopped' },
    { kind: 'writing', start: '2026-10-02T10:00:00.000Z', end: '2026-10-02T11:00:00.000Z', ended: 'switched' },
    { kind: 'record', start: '2026-10-02T11:00:00.000Z', end: '2026-10-02T11:30:00.000Z', ended: 'stopped' },
  ], [])
  assert.deepEqual(s.map(x => x.burden), [null, 0.5])
  assert.equal(burdenTrend(s), null, 'one measured session is no trend')
})

test('the headline is the last session with writing time, and says when the last one had none', () => {
  const compute = MEASURES.find(m => m.id === 'record-maintenance-burden')!.compute
  const rec = (intervals: StoryRecord['intervals']) => ({ since: null, intervals, stamps: [] }) as unknown as StoryRecord
  const w = { kind: 'writing' as const, start: '2026-10-01T10:00:00.000Z', end: '2026-10-01T11:00:00.000Z', ended: 'switched' as const }
  const r = { kind: 'record' as const, start: '2026-10-01T11:00:00.000Z', end: '2026-10-01T11:30:00.000Z', ended: 'stopped' as const }
  const lateRecord = { kind: 'record' as const, start: '2026-10-03T10:00:00.000Z', end: '2026-10-03T10:20:00.000Z', ended: 'stopped' as const }
  assert.match(compute(rec([w, r, lateRecord])).value, /^0\.5 record minutes per writing minute in the last session with writing time — no writing time in the last session — \(2026-10-01/)
  assert.match(compute(rec([lateRecord])).value, /^no writing time in any session yet, so nothing to divide by \(1 session, 20 minutes on the record\)/)
})
