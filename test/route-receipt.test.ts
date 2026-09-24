// The receipt as the author reads it, and the one sentence a run that did
// not land says (A67-11).
//
// Two rules are load-bearing here and are what these tests hold:
//   1. The projection is a projection. Fingerprints, session ids, transcript
//      paths and the git revision stay on disk; none of them belongs on a
//      page beside the prose.
//   2. The sentence is arc's, never the model's. It is rendered from the
//      ending and the gate records, and it ends in the keystroke that comes
//      next — so a refused answer can never write arc's own copy.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeExampleStory } from './fixture.ts'

const STORY = makeExampleStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

const { outcomeSentence } = await import('../src/run.ts')
const reroute = await import('../src/reroute.ts')

// The sentence is only ever shown where NO route was produced, so the
// keystroke it names has to be one that is on the page: a cancel for a route
// that does not exist sends the author hunting for a control that is not there.
const NEXT = /ask again to try from where the scene stands now\.$/

test('a run that landed has no sentence: nothing went wrong, so nothing is said', () => {
  assert.equal(outcomeSentence({ ending: 'landed', gates: [] }), null)
  assert.equal(outcomeSentence({}), null)
})

test('every ending that is not landed renders one sentence, ending in the next keystroke', () => {
  for (const ending of ['refused', 'could not run', 'timed out', 'budget', 'unreadable', 'cancelled', 'unfinished'] as const) {
    const line = outcomeSentence({ ending, gates: [] })
    assert.ok(line, `${ending} says something`)
    assert.match(line!, NEXT, `${ending} ends in the next keystroke`)
    assert.equal(line!.split('. ').length, 1, `${ending} is one sentence`)
  }
})

test('a refusal names the gate in the author\'s words, with what it measured and the bar', () => {
  const line = outcomeSentence({
    ending: 'refused',
    gates: [
      { gate: 'locks', verdict: 'held', attempt: 1 },
      { gate: 'overlap', verdict: 'refused', measured: 0.62, bar: 0.4, attempt: 2 },
    ],
  })!
  assert.match(line, /reused too much of the original wording/, 'the gate id is never the author\'s word for it')
  assert.match(line, /0\.62 against 0\.4/, 'what it measured, and the bar')
  assert.doesNotMatch(line, /overlap:/, 'not the id')
  assert.match(line, NEXT)
})

test('the sentence carries no git word, no runtime word and no file path', () => {
  for (const ending of ['refused', 'could not run', 'timed out', 'budget', 'unreadable', 'cancelled', 'unfinished'] as const) {
    const line = outcomeSentence({ ending, gates: [{ gate: 'leak', verdict: 'refused', attempt: 1 }] })!
    assert.doesNotMatch(line, /\b(commit|git|sha|sha256|revision|HEAD|branch)\b/i, ending)
    assert.doesNotMatch(line, /\b(session|transcript|token|tokens|model|sdk|cli|stderr|exit code|process)\b/i, ending)
    assert.doesNotMatch(line, /\.arc\/|\.yaml|\.jsonl|\//, ending)
  }
})

test('an unknown gate id still renders a sentence rather than nothing', () => {
  const line = outcomeSentence({ ending: 'refused', gates: [{ gate: 'a-gate-from-later', verdict: 'refused', attempt: 1 }] })!
  assert.match(line, /the a-gate-from-later check did not hold/)
  assert.match(line, NEXT)
})

test('a route written by an older arc has no receipt, and that is what the reader is told', () => {
  assert.equal(reroute.routeReceipt({ id: 'alt-00000001', scene: 'sc.02-1' } as never), null)
  assert.equal(reroute.routeReceipt({ id: 'alt-00000002', scene: 'sc.02-1', run: 'run.9999' } as never), null,
    'and a run whose working receipt is gone reads the same way, rather than throwing')
})

test('the projection is a projection: what the author reads, and nothing the record keeps for arc', async () => {
  const { Run, emptyReceipt, writeWorkingReceipt } = await import('../src/run.ts')
  const { registerRun } = await import('../src/runs.ts')
  const run = new Run('ui', 'another way through this scene', { subject: 'sc.02-1' })
  registerRun(run)
  const r = emptyReceipt(run)
  r.request = { gesture: 'another way through this scene', cell: 'explore·scene·withholding·standard', subject: 'sc.02-1' }
  r.cell = { job: 'explore', scope: 'scene', mode: 'withholding', depth: 'standard', stage: null }
  r.slice = {
    included: ['style', 'contract', 'pack'],
    withheld_by_design: ['the current prose of sc.02-1 (8 paragraphs)'],
    dropped_for_budget: ['siblings'],
    runtime_added: ['user-level instructions (~/CLAUDE.md)'],
  }
  r.gates = [{ gate: 'leak', verdict: 'held', attempt: 1, bar: 0, measured: 0 }]
  r.engine = { engine: 'fixture', model: 'claude-fixture', runtime: null }
  r.ending = 'landed'
  r.wall_clock_ms = 41_000
  r.produced_by = { arc_commit: 'deadbeefdeadbeef', job_fingerprint: 'feedfacefeedface' }
  r.context_manifest = [{ id: 'sc.02-1', version: 'aaaabbbbccccdddd' }]
  r.brief = [{ attempt: 'late-entry-1', id: 'user', fingerprint: '1111222233334444', cached: false }]
  writeWorkingReceipt(r)

  const out = reroute.routeReceipt({ id: 'alt-12345678', scene: 'sc.02-1', run: run.id } as never)!
  assert.ok(out, 'a run with a receipt has one')

  // The three readings arrive separate, which is the whole point of them.
  assert.deepEqual(out.given, ['style', 'contract', 'pack'])
  assert.deepEqual(out.withheld_by_design, ['the current prose of sc.02-1 (8 paragraphs)'])
  assert.deepEqual(out.dropped_for_budget, ['siblings'])
  assert.deepEqual(out.runtime_added, ['user-level instructions (~/CLAUDE.md)'])
  assert.equal(out.request?.gesture, 'another way through this scene')
  // A ROUTE ON DISK LANDED. It is there because it passed its gates; a stop
  // that killed a later seed, or a sibling that was refused, is the RUN's
  // ending and not this route's — and a route telling the author it was
  // stopped while they are reading it is simply false.
  assert.equal(out.ending, 'landed')
  assert.equal(out.outcome, null, 'it landed, so it says nothing about why it did not')
  assert.deepEqual(out.gates, [{ gate: 'leak', says: 'the scene\u2019s own prose kept out of the brief', verdict: 'held', attempt: 1, bar: 0, measured: 0 }],
    'and a gate arrives with the author\'s word for what it checks, never only arc\'s id')

  // And what the author never sees: the whole of arc's own bookkeeping.
  const text = JSON.stringify(out)
  for (const secret of ['deadbeefdeadbeef', 'feedfacefeedface', 'aaaabbbbccccdddd', '1111222233334444']) {
    assert.ok(!text.includes(secret), `${secret} stayed on disk`)
  }
  for (const key of ['produced_by', 'context_manifest', 'brief', 'story_revision', 'result', 'intent', 'claims']) {
    assert.ok(!(key in out), `${key} is not part of what the author reads`)
  }
})

test('a rewrite\'s run is about the ROUTE, which is what the viewer\'s stop has to match', async () => {
  // The viewer cannot know the run id until the request it is waiting on
  // comes back, so while a pass works it finds the run by its subject. A
  // reroute's subject is the scene; a REWRITE's is the route — and a viewer
  // that looked for the scene would show "working…" for minutes with no stop
  // beside it. This pins the value the two sides agree on.
  const { resolveRequest } = await import('../src/request.ts')
  const scene = resolveRequest({
    said: 'another way through sc.02-1', job: 'explore', scope: 'scene', mode: 'one-shot', subject: 'sc.02-1',
  })
  assert.equal(scene.subject, 'sc.02-1')
  const rewrite = resolveRequest({
    said: 'rewrite this route from my notes on it', job: 'explore', scope: 'route', mode: 'one-shot', subject: 'alt-12345678',
  })
  assert.equal(rewrite.subject, 'alt-12345678', 'the rewrite is about the route, not the scene it sits on')
})
