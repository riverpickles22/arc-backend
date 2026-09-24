// SLICE 1, END TO END: the machine-truth bar (A67-13, criterion 1).
//
// Every property below is proven somewhere else in this suite, one at a time,
// on a harness built for it. This file is the other thing an integration
// story is for: the same properties on ONE governed path, in one sitting,
// through the same doors the author uses — so that a change which keeps every
// unit test green and still breaks the loop has somewhere to fail.
//
// The engine is the fixture engine: a recorded answer keyed by the
// fingerprint of the rendered brief. No key, no subscription, no model. What
// that buys here is that "the brief reached the engine" is a fact this test
// can observe rather than infer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
// Sets the story and the engine before anything under src/ loads.
import { dump as yamlDump, load as yamlLoad } from 'js-yaml'
import { SCENE, STORY, STRAY_CLAIM, reset } from './fixture-scenarios.ts'
import type { BriefSeen } from '../src/fixtures.ts'

const { runReroute, adoptAlternative, listRoutes } = await import('../src/reroute.ts')
const { observeBriefs } = await import('../src/fixtures.ts')
const { readWorkingReceipt } = await import('../src/run.ts')
const { leaks } = await import('../src/gates.ts')
const { proseScenes } = await import('../src/story.ts')
const { unfinishedRuns } = await import('../src/run.ts')
const { doctorRecords } = await import('../src/doctor.ts')

const QUOTING_NOTE = path.join(STORY, 'annotations', 'note-005.yaml')
const openTheQuotingNote = () => {
  const t = fs.readFileSync(QUOTING_NOTE, 'utf8')
  fs.writeFileSync(QUOTING_NOTE, t.replace(/^status: resolved$/m, 'status: open'))
}
const sceneBody = () => proseScenes().find(s => s.scene === SCENE)!.body

/** Run something with every brief that reaches the engine recorded. */
async function watching<T>(work: () => Promise<T>): Promise<{ seen: BriefSeen[]; out: T }> {
  const seen: BriefSeen[] = []
  const stop = observeBriefs(b => seen.push(b))
  try { return { seen, out: await work() } } finally { stop() }
}

test('a seeded leak fires the gate BEFORE the send: nothing reaches the engine, and the receipt says where it stopped', async () => {
  reset()
  // The author's own note quotes the scene it is about — the commonest way a
  // withheld passage walks back into a brief that must not carry it.
  openTheQuotingNote()

  const { seen, out } = await watching(() => runReroute({ scene: SCENE, count: 1 }))

  assert.equal(out.alternatives.length, 0)
  assert.equal(seen.length, 0, 'THE POINT: not one brief reached the engine, so nothing was spent')
  const [refusal] = out.refused
  assert.ok(refusal, 'and the author is told, rather than being handed silence')
  // The sentence has to say what happened. A refusal before the send is not
  // an answer arc read back and disliked, and a stock phrase that says it was
  // tells the author arc spent something it did not.
  assert.match(refusal.outcome ?? '', /^arc would not send it: /,
    'never "arc read the answer back" — there was no answer')
  assert.match(refusal.outcome ?? '', /the scene’s own prose reached the brief \(1 against 0\)/,
    'the leak gate by name, in the author\'s words, with what it measured')
  assert.match(refusal.outcome ?? '', /ask again to try from where the scene stands now\.$/)
  // And the passage itself, so the author can go and find the note that
  // carried it in. This is the one place it belongs: shown, never committed.
  assert.match(refusal.reason, /a light that stopped turning was a light that lied/,
    'the refusal names the passage that would have gone')

  const r = readWorkingReceipt(out.run!)!
  assert.equal(r.ending, 'refused')
  const leak = (r.gates ?? []).find(g => g.gate === 'leak')!
  assert.equal(leak.verdict, 'refused')
  assert.equal(leak.stage, 'brief', 'the stage says it never got past the brief')
  assert.equal(leak.bar, 0)
  assert.ok((leak.measured as number) > 0)
  reset()
})

test('the receipt names the request as the author made it, in the author\'s words and not the brief\'s', async () => {
  reset()
  const out = await runReroute({ scene: SCENE, count: 1 })
  assert.ok(out.alternatives.length, 'a route landed to have a receipt')
  const r = readWorkingReceipt(out.run!)!

  // The request, in the author's own words — compared, not merely present.
  // A regression that put the rendered brief's first line here would pass any
  // truthiness check, and it is the one thing this field must never hold.
  assert.equal(r.request?.gesture, `another way through ${SCENE}`)
  assert.equal(r.raw_author_input, `another way through ${SCENE}`, 'the run says the same')
  assert.equal(r.request?.subject, SCENE)
  assert.equal(r.request?.cell, 'explore · scene · one-shot')
  assert.deepEqual({ job: r.cell?.job, scope: r.cell?.scope, mode: r.cell?.mode },
    { job: 'explore', scope: 'scene', mode: 'one-shot' }, 'and the cell is broken out')

  // What the runtime added on its own is NOT asserted here, and deliberately
  // so: the fixture engine has no runtime, so `runtime_added` is empty and
  // every assertion over it would pass over nothing — which is worse than no
  // assertion, because it retires the question. It needs a runtime that emits
  // an init event, and it is proven in slice-one-cli.test.ts against the stub.
  assert.deepEqual(r.slice?.runtime_added, [],
    'the fixture engine adds nothing, which is why the observed envelope is proven elsewhere')
  reset()
})

test('a coverage claim citing a beat the destination never held is dropped, counted, and never silently kept', async () => {
  reset()
  const out = await runReroute({ scene: SCENE, count: 1, guidance: 'give the supply boat a line' })
  const alt = out.alternatives[0]
  assert.ok(alt, 'the answer landed; it is the CLAIM that is outside the slice, not the route')

  const dropped = alt.dropped ?? []
  assert.ok(dropped.length > 0, 'the stray claim was dropped')
  assert.ok(dropped.every(d => typeof d.count === 'number' && d.count > 0), 'and counted, by reason')
  const kept = (alt.coverage ?? []).map(c => c.item).join(' | ')
  assert.ok(!kept.includes(STRAY_CLAIM), 'the beat the destination never held is not shown as covered')

  const r = readWorkingReceipt(out.run!)!
  assert.ok((r.evidence?.dropped ?? []).length > 0, 'and the receipt carries the count, by reason')
  reset()
})

test('a run killed mid-flight is one the briefing can name, with the ending the receipt says once it is closed', async () => {
  reset()
  const out = await runReroute({ scene: SCENE, count: 1 })
  const id = out.run!

  // WHAT A KILL ACTUALLY LEAVES, and not a finished receipt with its ending
  // rubbed out. The receipt is written once the slice is known and before the
  // first token: the brief's slots, the estimated tokens, the gates that ran
  // at the brief — and nothing from the answer, because there was none. The
  // event log stops at `run.started`. The launch record is what says arc
  // EXECUTED this run, and it is the field that keeps a run arc merely
  // observed out of both counts; the fixture engine spawns no child and
  // writes none, so the simulation supplies it.
  const dir = path.join(STORY, '.arc', 'runs', id)
  const full = readWorkingReceipt(id)!
  const killed = {
    ...full,
    decided_at: '',
    gates: (full.gates ?? []).filter(g => g.stage === 'brief'),
  }
  delete killed.ending
  delete killed.answers
  delete killed.engine
  delete killed.wall_clock_ms
  delete killed.evidence
  fs.writeFileSync(path.join(dir, 'receipt.yaml'), yamlDump(killed))
  fs.writeFileSync(path.join(dir, 'events.jsonl'),
    fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
      .split('\n').filter(l => l.includes('"run.started"')).join('\n') + '\n')
  fs.writeFileSync(path.join(dir, 'launches.jsonl'), JSON.stringify({
    attempt: 'late-entry-1', session_id: 'a-session', scratch_dir: path.join(dir, 'scratch'),
    expected_transcript: null, at: new Date().toISOString(),
  }) + '\n')

  assert.ok(unfinishedRuns(new Set(), STORY).some(u => u.id === id), 'the briefing can name it')
  assert.equal(doctorRecords(STORY).counts.find(c => c.id === 'runs-without-receipt')!.count, 1,
    'and so can the terminal')

  const { deleteRunTranscripts } = await import('../src/runs.ts')
  deleteRunTranscripts(id)

  const closed = readWorkingReceipt(id)!
  assert.equal(closed.ending, 'unfinished', 'closed with what actually happened')
  assert.equal(closed.raw_author_input, `another way through ${SCENE}`,
    'and everything the run had got as far as recording is still there')
  assert.ok(!unfinishedRuns(new Set(), STORY).some(u => u.id === id))
  assert.equal(doctorRecords(STORY).counts.find(c => c.id === 'runs-without-receipt')!.count, 0,
    'the two records agree, which is the only way the author can act on either')
  reset()
})

test('a run killed before it wrote any receipt at all is closed from its root record', async () => {
  // The other shape a kill leaves, and the branch `closeUnfinished` carries
  // code for: the backend died between the run record and the receipt. There
  // is nothing to reopen, so the close is rebuilt from `root.json` — and the
  // field that must survive is the one that says what the author asked for.
  reset()
  const out = await runReroute({ scene: SCENE, count: 1 })
  const id = out.run!
  const dir = path.join(STORY, '.arc', 'runs', id)
  fs.rmSync(path.join(dir, 'receipt.yaml'))
  fs.writeFileSync(path.join(dir, 'events.jsonl'),
    fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
      .split('\n').filter(l => l.includes('"run.started"')).join('\n') + '\n')
  fs.writeFileSync(path.join(dir, 'launches.jsonl'), JSON.stringify({
    attempt: 'late-entry-1', session_id: 'a-session', scratch_dir: path.join(dir, 'scratch'),
    expected_transcript: null, at: new Date().toISOString(),
  }) + '\n')

  assert.equal(doctorRecords(STORY).counts.find(c => c.id === 'runs-without-receipt')!.count, 1)
  const { deleteRunTranscripts } = await import('../src/runs.ts')
  deleteRunTranscripts(id)

  const built = readWorkingReceipt(id)!
  assert.equal(built.ending, 'unfinished')
  assert.equal(built.raw_author_input, `another way through ${SCENE}`,
    'rebuilt from the root record, which calls it raw_author_input and not anything else')
  assert.equal(doctorRecords(STORY).counts.find(c => c.id === 'runs-without-receipt')!.count, 0)
  reset()
})

test('the record receipt joins history/ at the decision, and holds no prose', async () => {
  reset()
  const out = await runReroute({ scene: SCENE, count: 1 })
  const alt = out.alternatives[0]
  assert.ok(alt)
  const body = sceneBody()

  adoptAlternative(SCENE, alt.id)

  const file = path.join(STORY, 'history', `${out.run}.yaml`)
  assert.ok(fs.existsSync(file), 'one record receipt for the run the author decided about')
  const text = fs.readFileSync(file, 'utf8')

  // NO PROSE. The record is committed and as public as the repo is; the
  // working receipt keeps what is needed to read a run back, and this keeps
  // ids, hashes and links. FIVE words, not the gate's eight: the gate's bar is
  // about a quotation, and the record's rule is simply that the book is not in
  // it.
  assert.deepEqual(leaks(text, { text: [body], allowed: [], spanWords: 5 }), [],
    'no run of the scene reaches the committed record')
  assert.deepEqual(leaks(text, { text: [alt.body], allowed: [], spanWords: 5 }), [],
    'and no run of the route either')

  // The decision, read as a value and not as a word that appears somewhere in
  // the file — the route's own prose contains "accepted", so a match over the
  // whole document would be true whatever the author decided.
  const doc = yamlLoad(text) as { author_decision?: { decision?: string }; result?: { records?: string[] } }
  assert.equal(doc.author_decision?.decision, 'accepted')
  assert.ok((doc.result?.records ?? []).length, 'and a link to what it produced')

  // And the working receipt is still the one with the detail, beside the run.
  assert.ok(readWorkingReceipt(out.run!)?.gates?.length, 'the gates stay in the working record')
  reset()
})

test('a passage the leak gate found never reaches the committed record, though the working one keeps it', async () => {
  // `measured_against` is the one field of a gate record that holds free text
  // rather than ids, and the leak gate puts the found passage there — by
  // definition a run of the withheld manuscript. It belongs in the working
  // receipt, which is gitignored and is what the author reads. A committed
  // record that carried it would put the book in a file that was never meant
  // to hold it, and no gate would have to change for that to happen: one
  // repair after a leak, and this receipt is the one the adopt commits.
  const { toRecordReceipt } = await import('../src/run.ts')
  const body = sceneBody()
  const passage = body.split(/\s+/).slice(4, 16).join(' ')
  const record = toRecordReceipt({
    run_id: 'run.0001', source: 'ui', raw_author_input: 'another way through',
    started_at: '', decided_at: '', story_revision: null, story_revision_at_decision: null,
    gates: [
      { gate: 'leak', verdict: 'refused', attempt: 1, stage: 'brief', bar: 0, measured: 1, measured_against: [passage] },
      { gate: 'locks', verdict: 'held', attempt: 1, bar: 0, measured: 0, measured_against: ['lock-001', 'lock-002'] },
    ],
    intent: null, claims: [], scope_expansions: [], context_manifest: [], checks: null, judgment: null,
    result: { records: [], commit: null },
  })
  const text = JSON.stringify(record)
  assert.deepEqual(leaks(text, { text: [body], allowed: [], spanWords: 5 }), [],
    'the passage does not reach the record')
  assert.deepEqual(record.gates![1].measured_against, ['lock-001', 'lock-002'],
    'and ids, which is what the record is for, are kept exactly')
})

test('every route the author is handed carries its receipt, and the fingerprints it read stay on the server', async () => {
  reset()
  await runReroute({ scene: SCENE, count: 1 })
  const listed = listRoutes(SCENE).alternatives
  assert.ok(listed.length, 'a route is waiting')
  for (const a of listed) {
    assert.ok(a.run, 'every route names the run that made it')
    assert.ok(a.receipt, 'and carries the receipt the author reads')
    assert.equal(a.receipt!.ending, 'landed')
    assert.equal(a.receipt!.outcome, null)
    assert.ok(!('reads' in a), 'and the fingerprints of what it read stay on the server')
  }
  reset()
})
