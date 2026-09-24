// Every run leaves a receipt, and the receipt says what the run was given
// (A67-4). Under the fixture engine: no key, no subscription, no model.
//
// Two homes, and the difference between them is the point — the working
// receipt beside the run may name a path and hold a measurement; the record
// receipt in history/ holds ids, hashes and links only, and a test greps it
// for prose and for absolute paths.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { load as yamlLoad } from 'js-yaml'
// type-only, so nothing under src/ loads before the environment is set
import type { Receipt } from '../src/run.ts'
// Sets the story and the fixture engine before anything under src/ loads.
import { SCENARIOS, SCENE, STORY, renderScenario, reset } from './fixture-scenarios.ts'
import { git } from './fixture.ts'

const { runReroute, listAlternatives, adoptAlternative } = await import('../src/reroute.ts')
const { readWorkingReceipt, runFilePath } = await import('../src/run.ts')
const { ROW_EXPLORE_SCENE, jobFingerprint } = await import('../src/registry.ts')
const { proseScenes } = await import('../src/story.ts')

const runDir = (id: string) => path.join(STORY, '.arc', 'runs', id)
const historyFile = (id: string) => path.join(STORY, 'history', `${id}.yaml`)
const lands = SCENARIOS.find(s => s.row === 'explore.scene.one-shot' && s.name === 'lands')!
const overlap = SCENARIOS.find(s => s.row === 'explore.scene.one-shot' && s.name === 'overlap')!

/** Run a scenario and return the receipt the run wrote. */
async function receiptOf(scenario: typeof lands): Promise<{ receipt: Receipt; run: string }> {
  const { result } = await renderScenario(scenario)
  const run = result.run!
  assert.ok(run, 'the response names the run')
  const receipt = readWorkingReceipt(run)
  assert.ok(receipt, `${run} wrote a working receipt`)
  return { receipt, run }
}

test('a run that lands leaves a receipt with everything the author can ask of it', async () => {
  const { receipt, run } = await receiptOf(lands)

  assert.equal(receipt.run_id, run)
  assert.equal(receipt.parent, null, 'a job\'s own run has no parent')
  assert.equal(receipt.ending, 'landed')
  assert.ok(receipt.decided_at, 'closed')

  // the request as the author made it, and the cell it resolved to
  assert.equal(receipt.request?.gesture, `another way through ${SCENE}`)
  assert.equal(receipt.request?.cell, 'explore · scene · one-shot', 'the cell in words, as the author would read it')
  assert.equal(receipt.request?.subject, SCENE)
  assert.deepEqual(receipt.cell, { job: 'explore', scope: 'scene', mode: 'one-shot', depth: 'standard', stage: null })

  // the brief's slots as ids and fingerprints — never the text, one set per
  // launch of the run
  assert.deepEqual(receipt.brief?.map(b => b.id), ['stable', 'volatile', 'user'])
  assert.deepEqual([...new Set(receipt.brief!.map(b => b.attempt))], ['late-entry-1'])
  assert.ok(receipt.brief!.every(b => /^[0-9a-f]{16}$/.test(b.fingerprint)))
  const text = fs.readFileSync(path.join(runDir(run), 'receipt.yaml'), 'utf8')
  assert.doesNotMatch(text, /REROUTE pass/, 'the rules are named by fingerprint, not copied')
  assert.doesNotMatch(text, /Ines went up at four/, 'and no prose of the scene')

  // three separate readings: withheld by design, dropped for room, added
  assert.ok(receipt.slice!.included.includes('style') && receipt.slice!.included.includes('destination'))
  assert.match(receipt.slice!.withheld_by_design[0], /the current prose of sc\.01-1 \(\d+ paragraphs\)/)
  assert.deepEqual(receipt.slice!.dropped_for_budget, [], 'nothing was dropped for room')
  assert.ok(Array.isArray(receipt.slice!.runtime_added))

  // the fingerprints of everything read
  assert.ok(receipt.context_manifest.some(r => r.id === SCENE), 'the scene it was about')
  assert.ok(receipt.context_manifest.every(r => /^[0-9a-f]+$/.test(r.version)))

  // every gate that ran, with its record — held and not-run read differently
  const gates = receipt.gates!
  assert.ok(gates.length >= 6, `every gate left a record: ${gates.map(g => g.gate).join(', ')}`)
  const leak = gates.find(g => g.gate === 'leak')!
  assert.equal(leak.verdict, 'held')
  assert.equal(leak.stage, 'brief', 'the leak gate ran before the send')
  const overlapGate = gates.find(g => g.gate === 'overlap')!
  assert.equal(overlapGate.verdict, 'held')
  assert.equal(overlapGate.bar, 0.4)
  assert.match(String(overlapGate.bar_from), /MAX_OVERLAP/)
  assert.equal(typeof overlapGate.measured, 'number')
  assert.equal(overlapGate.attempt, 1)
  const notApplicable = gates.filter(g => g.verdict === 'not applicable')
  assert.ok(notApplicable.length > 0, 'a rule the contract does not state is not applicable, never passed')

  // the answer, by fingerprint, with its text kept beside the run
  assert.equal(receipt.answers?.length, 1)
  assert.equal(receipt.answers![0].landed, true)
  const answerFile = runFilePath(run, 'answer', receipt.answers![0].fingerprint)
  assert.ok(fs.existsSync(answerFile), 'the raw answer is kept with the run')
  assert.match(fs.readFileSync(answerFile, 'utf8'), /Wren had gone up before her/)
  assert.ok(fs.existsSync(runFilePath(run, 'brief', receipt.brief!.map(b => b.fingerprint).join(''))) === false, 'the brief is kept whole, under its own fingerprint')
  assert.equal(fs.readdirSync(path.join(runDir(run), 'briefs')).length, 1)

  // claims returned, and what was dropped by reason (A67-8 drops)
  assert.equal(receipt.evidence?.returned, 6)
  assert.deepEqual(receipt.evidence?.dropped, [])

  // the engine as IT reported, the budget estimated and spent, the clock
  assert.equal(receipt.engine?.engine, 'fixture')
  assert.ok(receipt.tokens?.estimated!.input > 0, 'estimated before the send')
  assert.equal(receipt.tokens?.estimated!.output, ROW_EXPLORE_SCENE.budget.outputTokens)
  assert.ok(receipt.tokens?.actual, 'and reconciled after it')
  assert.equal(typeof receipt.wall_clock_ms, 'number')

  // what produced it
  assert.equal(receipt.produced_by?.job_fingerprint, jobFingerprint(ROW_EXPLORE_SCENE))
  assert.ok(receipt.produced_by?.arc_commit === null || /^[0-9a-f]{40}$/.test(receipt.produced_by!.arc_commit!))

  // the envelope, declared and observed
  assert.equal(receipt.envelope?.declared.tools, 'none')
})

test('a refused run leaves the same receipt, with the gate that refused and the text it refused', async () => {
  const { receipt, run } = await receiptOf(overlap)
  assert.equal(receipt.ending, 'refused')
  const refusedGate = receipt.gates!.find(g => g.verdict === 'refused')!
  assert.equal(refusedGate.gate, 'overlap')
  assert.equal(refusedGate.bar, 0.4)
  assert.ok((refusedGate.measured as number) > 0.4, 'the figure beside the bar it was measured against')
  assert.equal(refusedGate.attempt, 1)
  assert.deepEqual(receipt.result.records, [], 'nothing landed')

  // the refused text is kept WITH THE RUN, named by fingerprint — never a
  // proposal, never in history/
  const refusedDir = path.join(runDir(run), 'refused')
  const kept = fs.readdirSync(refusedDir)
  assert.equal(kept.length, 1)
  assert.match(kept[0], /^[0-9a-f]{16}\.txt$/)
  assert.match(fs.readFileSync(path.join(refusedDir, kept[0]), 'utf8'), /Ines went up at four/)
  assert.ok(!fs.existsSync(historyFile(run)), 'a refusal reaches no decision, so nothing joins the record')
})

test('a refusal that never reached the engine still leaves a receipt, with the stage it refused at', async () => {
  reset()
  // A scene with no contract and no key points has no destination, and the
  // pass refuses at the slice — before a token, before an engine.
  const bare = path.join(STORY, 'prose', 'ch-01', 'scene-02.md')
  fs.writeFileSync(bare, [
    '---', 'scene: sc.01-2', 'chapter: ch.01-ninety-one-stairs', 'status: proposed',
    'pov: char.ines', 'events: []', 'facts: [char.ines]', '---', '',
    'A scene with nothing the pass could aim at.', '',
  ].join('\n'))
  await assert.rejects(runReroute({ scene: 'sc.01-2', count: 1 }),
    (e: unknown) => (e as { status?: number }).status === 400 && /no destination/.test((e as Error).message))
  // the newest run directory is the refusal's
  const runs = fs.readdirSync(path.join(STORY, '.arc', 'runs')).filter(d => /^run\.\d+$/.test(d)).sort()
  const receipt = readWorkingReceipt(runs.at(-1)!)!
  assert.ok(receipt, 'the refusal minted a run and wrote its receipt')
  assert.equal(receipt.ending, 'refused')
  const gate = receipt.gates![0]
  assert.equal(gate.gate, 'destination')
  assert.equal(gate.stage, 'slice', 'the stage it refused at, before any token')
  assert.equal(receipt.answers, undefined, 'nothing was ever answered')
  assert.equal(receipt.request?.cell, 'explore · scene · one-shot', 'the cell in words, as the author would read it')
  assert.equal(receipt.request?.subject, 'sc.01-2')
})

test('adopting a route puts its receipt in the record — ids, hashes and links only', async () => {
  const { run } = await receiptOf(lands)
  const alt = listAlternatives(SCENE)[0]
  assert.equal(alt.run, run, 'the route names the run that made it')

  adoptAlternative(SCENE, alt.id)
  const file = historyFile(run)
  assert.ok(fs.existsSync(file), 'the decision appended the record receipt')
  const text = fs.readFileSync(file, 'utf8')
  const record = yamlLoad(text) as Receipt

  assert.equal(record.run_id, run)
  assert.equal(record.ending, 'landed')
  assert.equal(record.author_decision?.decision, 'accepted')
  assert.deepEqual(record.result.records, [alt.scene === SCENE ? proseScenes().find(s => s.scene === SCENE)!.file : ''])
  assert.equal(record.result.commit, null, 'the accept that commits it fills this in')

  // no prose, no absolute path
  assert.doesNotMatch(text, /Wren had gone up before her/, 'no prose of the answer')
  assert.doesNotMatch(text, /Ines went up at four/, 'no prose of the scene')
  assert.doesNotMatch(text, /^\s*[-\w]*:\s*\/[A-Za-z]/m, 'no absolute path')
  assert.doesNotMatch(text, new RegExp(STORY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'not even this machine\'s story path')
  assert.match(text, /job_fingerprint/, 'but the links are there')
  assert.ok((record.waiting_on_author_ms ?? -1) >= 0, 'and how long it waited on the author')
})

test('a run that launched twice accounts for both: two briefs, two answers, the tokens summed, the right one landed', async () => {
  // The overlap scenario refuses the first answer, so the pass repairs once:
  // two launches under one run.
  const { receipt, run } = await receiptOf(overlap)
  // The fixture engine keeps no transcript, so the repair sends the SAME
  // brief again with the refusal on the end (A67-6) — never a fresh slice.
  // On the CLI, which resumes, only the refusal goes; test/gate-runner.test
  // holds that half.
  assert.equal(receipt.brief?.filter(b => b.id === 'stable').length, 2, 'one brief per launch on an engine that cannot resume')
  const second = receipt.brief!.filter(b => b.attempt === 'late-entry-2')
  assert.deepEqual(second.map(b => b.id), ['stable', 'volatile', 'user'])
  assert.equal(second.find(b => b.id === 'stable')!.fingerprint, receipt.brief!.find(b => b.attempt === 'late-entry-1' && b.id === 'stable')!.fingerprint, 'the same slice, not a fresh one')
  assert.notEqual(second.find(b => b.id === 'user')!.fingerprint, receipt.brief!.find(b => b.attempt === 'late-entry-1' && b.id === 'user')!.fingerprint, 'with the refusal on the end')
  assert.deepEqual([...new Set(receipt.brief!.map(b => b.attempt))], ['late-entry-1', 'late-entry-2'])
  assert.equal(fs.readdirSync(path.join(runDir(run), 'briefs')).length, 2, 'both are kept beside the run')
  assert.ok(receipt.gates!.filter(g => g.attempt === 1).length > 0, 'the first answer was gated')
  // The repair never reached a content gate — the fixture has no answer for
  // its brief — and that failure is itself a record, at the launch stage.
  const repair = receipt.gates!.filter(g => g.attempt === 2)
  // The leak gate proved the repair's brief before the send; then the
  // fixture had no answer for it, which is the launch's own record.
  assert.deepEqual(repair.map(g => g.gate), ['leak', 'engine'])
  assert.equal(repair[0].stage, 'brief')
  assert.equal(repair[0].verdict, 'held')
  assert.equal(repair[1].stage, 'launch')
  assert.equal(repair[1].verdict, 'could not judge')
  assert.match(String(repair[1].bar_from), /no recorded answer/, 'the engine\'s own words are here, not on the page')
  assert.deepEqual(receipt.answers?.map(a => a.landed), [false], 'so the run holds one answer, refused')
  assert.ok(receipt.tokens!.estimated!.input > 0, 'both launches were estimated for')
  assert.equal(receipt.ending, 'refused')
  assert.equal(fs.readdirSync(path.join(runDir(run), 'refused')).length, 1, 'the refused text is kept once, by fingerprint')
})

test('the accept that commits an adopted route stamps its commit onto the receipt', async () => {
  const { createArcServer } = await import('../src/server.ts')
  const server = createArcServer()
  await new Promise<void>(resolve => server.listen(0, resolve))
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
  try {
    const { run } = await receiptOf(lands)
    const alt = listAlternatives(SCENE)[0]
    adoptAlternative(SCENE, alt.id)
    const scene = proseScenes().find(s => s.scene === SCENE)!

    const res = await fetch(`${base}/api/prose/accept`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'prose: another way through', files: [scene.file] }),
    })
    assert.equal(res.status, 200)
    const { hash } = await res.json() as { hash: string }
    assert.match(hash, /^[0-9a-f]{7,40}$/)

    const record = yamlLoad(fs.readFileSync(historyFile(run), 'utf8')) as Receipt
    assert.equal(record.result.commit, hash, 'the run that wrote the route names the commit that took it')

    // And the receipt itself is committed, beside the artefact — in its own
    // commit right behind the accept, because no file can hold the hash of
    // the commit that contains it.
    assert.match(git(STORY, 'ls-files', 'history').trim(), new RegExp(`history/${run.replace('.', '\\.')}\\.yaml`), 'the record receipt is tracked')
    const log = git(STORY, 'log', '--oneline', '-2').trim().split('\n')
    assert.match(log[0], new RegExp(`Record: the receipt for ${hash}`))
    assert.match(log[1], /prose: another way through/, 'the accept the author asked for')
    assert.equal(git(STORY, 'status', '--short', '--', 'history').trim(), '', 'nothing left dirty under history/')
  } finally {
    server.close()
  }
})
