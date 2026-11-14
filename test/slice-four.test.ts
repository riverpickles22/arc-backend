// SLICE 4, END TO END (A74-9): the machine bar of agent-workflows §11 row 4,
// asserted across the pieces the earlier cards built — accept, the review
// episode, the typed proposals, the author's decision, the duplicate gate that
// remembers a never, and the learner.
//
// Deterministic by construction: no credential in the environment, the model
// is the STUB `claude` the other slice tests use (and, for one scenario, the
// fixture engine's recorded answer). What is under test is everything around
// the model. Unit behaviour stays in update-record / episodes / proposals /
// learn-row / style-governed tests; this file asserts the SEQUENCES.
//
// One disposable copy of the worked example, put back to its first commit
// between scenarios (config resolves the story path at module load, so a
// second copy cannot be had in one process; the reset is the scenario boundary).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { load as yamlLoad } from 'js-yaml'
import { installStubCli, makeExampleStory, git } from './fixture.ts'

const STORY = makeExampleStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'claude-cli'
// No author layer, and no credential of any kind in the environment.
process.env.ARC_AUTHOR_STYLE = path.join(STORY, 'no-author-layer.md')
for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) delete process.env[k]
const LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arc-slice-four-log-')), 'reads.log')
process.env.STUB_LOG = LOG

process.env.PATH = `${installStubCli({
  name: 'slice-four',
  before: `
    if (process.env.STUB_FAIL === '1') { process.stderr.write('stub refused'); process.exit(1) }
    const isU7 = prompt.includes('=== THE ACCEPTED CHANGE')
    require('node:fs').appendFileSync(process.env.STUB_LOG, (isU7 ? 'u7' : 'learn') + '\\n')`,
  answer: `prompt.includes('=== THE ACCEPTED CHANGE') ? (process.env.STUB_U7 ?? '[]') : (process.env.STUB_LEARN ?? '[]')`,
})}${path.delimiter}${process.env.PATH}`

const { createArcServer } = await import('../src/server.ts')
const { unreadEpisodes, episodesSettled } = await import('../src/episodes.ts')
const { runUpdateRecord } = await import('../src/update-record.ts')
const { runLearnStyle } = await import('../src/learn-style.ts')
const { runBootstrapStyle } = await import('../src/bootstrap-style.ts')
const { readQueue, rememberDismissal, ruleId } = await import('../src/style-queue.ts')
const { proposalOrigins } = await import('../src/ledger.ts')
const { readProposalDecisions } = await import('../src/evidence.ts')
const { buildCandidate } = await import('../src/proposals.ts')
const { takenIds } = await import('../src/records.ts')
const { validateStory } = await import('../src/canon.ts')
const { ROWS, ROW_UPDATE_RECORD_SCENE, ROW_LEARN_MANUSCRIPT, rowKey, rowStatus, readStatusReceipts } = await import('../src/registry.ts')
const { askRow, EngineError } = await import('../src/engine.ts')
const { receiptsOf, readWorkingReceipt } = await import('../src/run.ts')
const { baseOf } = await import('../src/base.ts')
const { proseScenes } = await import('../src/story.ts')

const server = createArcServer()
await new Promise<void>(resolve => server.listen(0, resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
test.after(() => server.close())
const post = (p: string, body: unknown) =>
  fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const get = async <T>(p: string): Promise<T> => (await fetch(base + p)).json() as Promise<T>

const A = 'prose/ch-01/scene-01.md'
const B = 'prose/ch-02/scene-01.md'
const SEED = git(STORY, 'rev-parse', 'HEAD').trim()
const LOG_PARA = ['Then the log.', 'Then the log, and the barometer beside it.']
const WIND_PARA = ['The wind did what it did.', 'The wind did what it did, and rattled the storm lantern.']
const obj = (value: string, extra: Record<string, unknown> = {}) =>
  ({ class: 'stated', subject: 'new', type: 'object', field: 'name', value, evidence: ['¶5'], note: `${value}.`, ...extra })
const BAROMETER = JSON.stringify([obj('The barometer'), { ...obj('The tide table'), class: 'implied' }])

const sceneOf = (file: string): string => proseScenes().find(s => s.file === file)!.scene
const read = (rel: string): string => fs.readFileSync(path.join(STORY, rel), 'utf8')
const exists = (rel: string): boolean => fs.existsSync(path.join(STORY, rel))
const head = (): string => git(STORY, 'rev-parse', 'HEAD').trim()
const commits = (): number => Number(git(STORY, 'rev-list', '--count', 'HEAD').trim())
const reads = (kind = 'u7'): number => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(l => l === kind).length : 0)
const settle = async (): Promise<void> => { await new Promise(r => setTimeout(r, 80)); await episodesSettled() }
const edit = (file: string, [from, to]: string[]): void => {
  fs.writeFileSync(path.join(STORY, file), read(file).replace(from, to))
}
const accept = async (file: string): Promise<void> => {
  const res = await post('/api/prose/accept', { files: [file], bases: { [file]: baseOf(file) } })
  assert.equal(res.status, 200, await res.clone().text())
}
/** an accept that starts nothing: the engine is off for the one request */
const acceptOffline = async (file: string): Promise<void> => {
  process.env.ARC_DRAFT_ENGINE = 'none'
  try { await accept(file) } finally { process.env.ARC_DRAFT_ENGINE = 'claude-cli' }
}
const historyReceipts = () => (exists('history') ? fs.readdirSync(path.join(STORY, 'history')) : []).filter(f => f.endsWith('.yaml'))
  .map(f => yamlLoad(read(`history/${f}`)) as {
    run_id: string; cell?: { job: string }; ending?: string; key?: string
    result: { range?: { from: string; to: string } | null; commit: string | null }
    author_decision?: { decision: string }
    gates?: { gate: string; verdict: string; bar_from?: string }[]
  })
const u7History = () => historyReceipts().filter(r => r.cell?.job === 'update-record')
const attention = async (): Promise<string[]> =>
  (await get<{ proposedRecords: { id: string }[] }>('/api/attention')).proposedRecords.map(r => r.id)

const reset = (): void => {
  git(STORY, 'reset', '-q', '--hard', SEED); git(STORY, 'clean', '-fdxq')
  for (const k of ['STUB_U7', 'STUB_LEARN', 'STUB_FAIL']) delete process.env[k]
  fs.rmSync(LOG, { force: true })
  process.env.ARC_DRAFT_ENGINE = 'claude-cli'
}

// ---- (a) accept → episode due → typed proposals, each with an origin and a receipt ------------

test('(a) an accept with no credential files typed proposals after the response; each has a ledger origin, and the receipt in history/ carries the range', async () => {
  reset()
  process.env.STUB_U7 = BAROMETER
  edit(A, LOG_PARA)
  await accept(A)
  const accepted = head()
  await settle()

  assert.equal(reads('u7'), 1, 'one reading of the accept, started after the response had gone')
  for (const id of ['obj.the-barometer', 'obj.the-tide-table']) {
    assert.match(read(`canon/entities/objects/${id.slice(4)}.yaml`), /^status: proposed$/m, `${id} is a proposed record, not canon`)
  }
  // the origin: ledger first, naming its class, run, key and evidence ids
  const origins = proposalOrigins()
  const barometer = origins.find(o => o.canon === 'obj.the-barometer')!, table = origins.find(o => o.canon === 'obj.the-tide-table')!
  assert.deepEqual([barometer.class, table.class], ['stated', 'implied'])
  assert.deepEqual(barometer.evidence, ['¶5'])
  assert.match(barometer.key!, /^[0-9a-f]{16}$/)
  assert.equal(barometer.run, table.run)
  assert.equal(barometer.range!.to, accepted)
  // the receipt in the record carries the range, and names the same run
  const landed = u7History().filter(r => r.run_id === barometer.run)
  assert.equal(landed.length, 1)
  assert.equal(landed[0].result.range!.to, accepted)
  assert.equal(landed[0].result.range!.from, git(STORY, 'rev-parse', `${accepted}^`).trim())
  assert.equal(git(STORY, 'status', '--porcelain', '--', 'history').trim(), '', 'and it is committed, not left behind')
  // nothing is written to the evidence log by filing: only a decision does
  assert.deepEqual(readProposalDecisions(), [])
  assert.equal(read('docs/style.evidence.jsonl').split('\n').filter(l => l.includes('"kind":"proposal"')).length, 0, 'the log holds the accept\'s verdict and no proposal')
  // the drawer's source: both are listed, classed (the example's own legacy proposals are class null), and the read is not unread
  const listed = (await get<{ proposedRecords: { id: string; class: string | null; run: string }[] }>('/api/attention')).proposedRecords
  assert.deepEqual(listed.filter(p => p.class).map(p => [p.id, p.class]).sort(), [['obj.the-barometer', 'stated'], ['obj.the-tide-table', 'implied']])
  assert.deepEqual(unreadEpisodes(), [])
  assert.ok(validateStory().ok, validateStory().output)
})

test('(a) the same, on the fixture engine\'s recorded answer: no model at all, and the duplicate is refused', async () => {
  reset()
  delete process.env.STUB_U7
  process.env.ARC_DRAFT_ENGINE = 'fixture'
  try {
    edit(A, LOG_PARA)
    git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'prose: accept sc.01-1')
    const r = await runUpdateRecord('sc.01-1')
    assert.deepEqual([r.proposed, r.refused], [1, 1], 'the instrument is filed; Wren, whom the record holds, is refused as a duplicate')
    assert.equal(proposalOrigins().find(o => o.canon === 'obj.the-barometer')?.class, 'stated')
    assert.equal(readWorkingReceipt(r.run)!.cell!.job, 'update-record')
    assert.equal(reads('u7'), 0, 'the stub was never spawned')
  } finally { process.env.ARC_DRAFT_ENGINE = 'claude-cli' }
})

// ---- (b) the same key → no second receipt, no duplicate ----------------------------------

test('(b) the same accepts read again: no run, no second receipt, nothing filed twice', async () => {
  reset()
  process.env.STUB_U7 = BAROMETER
  edit(A, LOG_PARA); await accept(A); await settle()
  const before = { reads: reads(), history: u7History().length, receipts: receiptsOf('update-record').length, origins: proposalOrigins().length, files: fs.readdirSync(path.join(STORY, 'canon/entities/objects')).sort(), commits: commits() }
  const res = await post('/api/record/update', { scene: sceneOf(A) })
  assert.equal(res.status, 200)
  const body = await res.json() as { nothingNew?: boolean; proposed: number; reply: string }
  assert.deepEqual([body.nothingNew, body.proposed], [true, 0])
  assert.match(body.reply, /already read/)
  await settle()
  assert.deepEqual({ reads: reads(), history: u7History().length, receipts: receiptsOf('update-record').length, origins: proposalOrigins().length, files: fs.readdirSync(path.join(STORY, 'canon/entities/objects')).sort(), commits: commits() }, before)
})

// ---- (c) a failed read is listed, completed by hand, filed once ---------------------------

test('(c) a read that fails is listed as unread, never retried on its own, and the hand completes it without filing twice', async () => {
  reset()
  process.env.STUB_U7 = BAROMETER
  process.env.STUB_FAIL = '1'
  edit(A, LOG_PARA); await accept(A); await settle()
  const scene = sceneOf(A)
  const listed = unreadEpisodes()
  assert.deepEqual(listed.map(u => [u.scene, u.count, u.state]), [[scene, 1, 'failed']])
  assert.match(listed[0].title, /^scene \d+ of /, 'named in the author\'s words')
  assert.deepEqual((await get<{ unread: unknown[] }>('/api/briefing')).unread, listed, 'the briefing lists it')
  assert.deepEqual((await get<{ unread: unknown[] }>('/api/attention')).unread, listed, 'and so does the drawer')
  assert.ok(!exists('canon/entities/objects/the-barometer.yaml'))
  // a later, unrelated commit does not relaunch it
  const n = reads()
  edit(B, ['because counting', 'because plain counting']); await acceptOffline(B)
  await settle()
  assert.equal(reads(), n)
  // the keystroke: the model answers this time
  delete process.env.STUB_FAIL
  const res = await post('/api/record/update', { scene })
  const body = await res.json() as { proposed: number }
  assert.equal(res.status, 200)
  assert.equal(body.proposed, 2)
  assert.ok(!unreadEpisodes().some(u => u.scene === scene), 'the line is gone')
  const filed = (): string[] => fs.readdirSync(path.join(STORY, 'canon/entities/objects')).filter(f => /barometer|tide/.test(f))
  assert.deepEqual(filed().sort(), ['the-barometer.yaml', 'the-tide-table.yaml'])
  // and once more: still nothing new, nothing doubled
  const again = await (await post('/api/record/update', { scene })).json() as { nothingNew?: boolean; proposed: number }
  assert.deepEqual([again.nothingNew, again.proposed], [true, 0])
  assert.equal(filed().length, 2)
  assert.equal(proposalOrigins().filter(o => o.canon === 'obj.the-barometer').length, 1)
})

// ---- (d) never → in the evidence log → refused as a duplicate ------------------------------

test('(d) never removes the proposal, is on record with its key, and the same fact is refused next time — by id and under a fresh id', async () => {
  reset()
  process.env.STUB_U7 = JSON.stringify([obj('The barometer')])
  edit(A, LOG_PARA); await accept(A); await settle()
  const id = 'obj.the-barometer'
  const origin = proposalOrigins().find(o => o.canon === id)!
  const res = await post('/api/record/proposals', { ids: [id], action: 'never' })
  assert.equal(res.status, 200, await res.clone().text())
  assert.ok(!exists('canon/entities/objects/the-barometer.yaml'), 'the proposed record is gone')
  const d = readProposalDecisions().at(-1)!
  assert.deepEqual([d.id, d.verdict, d.class, d.run], [id, 'never', 'stated', origin.run])
  assert.match(d.key, /^[0-9a-f]{16}$/)
  assert.equal(read('docs/style.evidence.jsonl').split('\n').filter(l => l.includes('"verdict":"never"')).length, 1, 'it is in the evidence log')
  assert.ok(!(await attention()).includes(id))
  // the proposing run's receipt now carries the author's word
  assert.equal(historyReceipts().find(r => r.run_id === origin.run)!.author_decision?.decision, 'rejected')
  assert.ok(validateStory().ok)

  // the same fact again, by the same id: the id is free, the gate refuses it by key
  const again = await runUpdateRecord(sceneOf(A), undefined, undefined, { rerun: true })
  assert.deepEqual([again.proposed, again.refused], [0, 1])
  assert.ok(!exists('canon/entities/objects/the-barometer.yaml'))
  assert.ok(readWorkingReceipt(again.run)!.gates!.some(g => g.gate === 'duplicate'), 'the receipt names the gate')

  // and under a fresh id: with the old id taken a new proposal would be minted
  // as a different id; the refusal is by name and field, not by id
  const occupied = new Set(takenIds()); occupied.add(id)
  const fresh = buildCandidate({ class: 'stated', subject: 'new', type: 'object', field: 'name', value: 'The  Barometer', evidence: [] }, { scene: 'sc.01-1', era: null, taken: occupied })
  assert.ok(fresh.ok && fresh.id !== id, 'a fresh id would have been minted')
  process.env.STUB_U7 = JSON.stringify([obj('The  Barometer')])
  const respelled = await runUpdateRecord(sceneOf(A), undefined, undefined, { rerun: true })
  assert.deepEqual([respelled.proposed, respelled.refused], [0, 1], 'the same fact, spelled again, is the same fact')
  assert.deepEqual(readProposalDecisions().length, 1, 'refusing writes no decision of its own')
})

// ---- (e) approve → one decision commit, validator green, locks not applicable, receipt stamped

test('(e) approve is one decision commit through the lane; the validator stays green; the lock check says not applicable; the receipt carries the decision', async () => {
  reset()
  process.env.STUB_U7 = JSON.stringify([obj('The barometer')])
  edit(A, LOG_PARA); await accept(A); await settle()
  const id = 'obj.the-barometer', rel = 'canon/entities/objects/the-barometer.yaml'
  const origin = proposalOrigins().find(o => o.canon === id)!
  const before = read(rel), n = commits()
  const res = await post('/api/record/proposals', { ids: [id], action: 'approve' })
  assert.equal(res.status, 200, await res.clone().text())
  const out = await res.json() as { reply: string }
  assert.equal(commits(), n + 2, 'one commit for the decision, then the receipt joins the record behind it')
  assert.equal(read(rel), before.replace('status: proposed', 'status: canon'), 'status is the one line that changed')
  assert.equal(git(STORY, 'show', `HEAD~1:${rel}`), read(rel))
  assert.equal(git(STORY, 'status', '--porcelain', '--', 'canon', 'docs', 'history').trim(), '', 'nothing tracked left dirty')
  assert.ok(validateStory().ok, validateStory().output)
  assert.ok(!(await attention()).includes(id))
  const r = historyReceipts().find(x => x.run_id === origin.run)!
  assert.equal(r.author_decision?.decision, 'accepted')
  assert.equal(r.result.commit, git(STORY, 'rev-parse', '--short', 'HEAD~1').trim(), 'the receipt names the decision commit')
  assert.ok(r.gates!.some(g => g.gate === 'locks' && g.verdict === 'not applicable'), 'the lock check records not applicable for canon')
  assert.equal(readProposalDecisions().at(-1)!.verdict, 'approved')
  assert.equal(rowStatus(ROW_UPDATE_RECORD_SCENE, readStatusReceipts(), true), 'attended')
  assert.doesNotMatch(out.reply, /obj\.|sc\.0|[0-9a-f]{7}/, 'the reply speaks the author\'s words')
})

// ---- (f) the learner: one rule from two scenes, a declined predicate dropped ----------------

test('(f) the learner proposes one rule from edits in two scenes and drops a rule that restates a declined one', async () => {
  reset()
  const DECLINED = 'A chain stops at three.'
  rememberDismissal({ id: ruleId(DECLINED), rule: DECLINED }, '2026-09-20T12:00:00.000Z')
  const CLEAN = 'Let a list of actions run on commas rather than on repeated and.'
  edit(A, ['Tonight she trimmed and wound and logged and did not sing.', 'Tonight she trimmed, wound, logged, did not sing.'])
  edit(B, ['and Ines counted\nthe stairs down because counting was the only arithmetic left to her.', 'and Ines counted\nthe stairs down.'])
  git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'prose: accept two scenes')
  process.env.STUB_LEARN = JSON.stringify([
    { rule: CLEAN, section: 'Sentences', layer: 'story', edits: [1, 2] },
    { rule: 'An and-chain stops at three; past that, use commas.', section: 'Sentences', layer: 'story', edits: [1, 2] },
    { rule: 'Never open on weather.', section: null, layer: 'story', edits: [1] },
  ])
  const r = await runLearnStyle([A, B], { [A]: SEED, [B]: SEED })
  assert.equal(r.added.length, 1, JSON.stringify(r))
  assert.equal(r.added[0].rule, CLEAN)
  const queued = readQueue()
  assert.deepEqual(queued.map(q => q.rule), [CLEAN])
  assert.equal(queued[0].run, r.run, 'the proposal carries its run')
  assert.equal(new Set(queued[0].evidence.map(e => e.scene)).size, 2, 'its evidence stands in two scenes')
  const gates = readWorkingReceipt(r.run!)!.gates!
  assert.equal(gates.find(g => g.gate === 'not-declined')!.measured, 1, 'the declined predicate was dropped, proven')
  assert.equal(gates.find(g => g.gate === 'two-examples')!.measured, 1, 'and the rule resting on one place was dropped')
  assert.equal(rowStatus(ROW_LEARN_MANUSCRIPT, readStatusReceipts(), true), 'built', 'nobody has decided it yet')
})

// ---- (g) the ratchet reads four; the sdk engine refuses every rowed pass ------------------------

test('(g) BARE_SEAM_CALLS reads 4, counted in the source and in its pin; no slice-4 pass launches without a row', () => {
  const pin = fs.readFileSync(path.join(import.meta.dirname, 'pass-registry.test.ts'), 'utf8')
  assert.match(pin, /const BARE_SEAM_CALLS = 4\b/, 'the ratchet\'s own pin')
  const src = path.join(import.meta.dirname, '..', 'src')
  const bare = fs.readdirSync(src).filter(f => f.endsWith('.ts') && f !== 'engine.ts')
    .filter(f => fs.readFileSync(path.join(src, f), 'utf8').split('\n').some(l => /\brunCliPrompt\s*\(/.test(l) && !/^\s*(\/\/|\*)/.test(l)))
  assert.deepEqual(bare.sort(), ['intent.ts', 'judge.ts', 'lenses.ts', 'material.ts'])
  const keys = ROWS.map(rowKey)
  for (const k of ['update-record.scene.triggered', 'learn.manuscript.triggered', 'learn.manuscript.one-shot']) assert.ok(keys.includes(k), k)
})

test('(g) the sdk engine refuses every rowed pass in one sentence, and an accept under it lands and starts nothing', async () => {
  reset()
  // two prose commits made by hand, so each pass has something to read before it is refused
  edit(A, LOG_PARA); git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'prose: accept sc.01-1')
  edit(A, ['Tonight she trimmed and wound and logged and did not sing.', 'Tonight she trimmed, wound, logged, did not sing.'])
  git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'prose: accept sc.01-1 again')
  process.env.ARC_DRAFT_ENGINE = 'sdk'
  try {
    for (const row of ROWS) {
      await assert.rejects(askRow(row, { blocks: [{ id: 'ask', text: 'x', cached: false }] }, { runId: 'run.9999' }), (e: unknown) => {
        assert.ok(e instanceof EngineError && e.kind === 'envelope', rowKey(row))
        assert.match(e.message, /cannot show what that pass was given/)
        return true
      })
    }
    // the three passes slice 4 moved onto rows, at their own doors
    for (const [name, fn] of [
      ['U7', () => runUpdateRecord(sceneOf(A))],
      ['U12', () => runLearnStyle([A], { [A]: SEED })],
      ['bootstrap', () => runBootstrapStyle()],
    ] as const) {
      await assert.rejects(Promise.resolve().then(fn), (e: unknown) => {
        assert.equal((e as { status?: number }).status, 400, name)
        assert.match((e as Error).message, /login/, name)
        return true
      })
    }
    // an accept never waits on, or fails because of, the engine
    edit(B, ['because counting', 'because plain counting'])
    const n = commits()
    await accept(B); await settle()
    assert.equal(commits(), n + 1)
    assert.equal(reads('u7'), 0)
    assert.deepEqual(unreadEpisodes().map(u => u.state), ['due'], 'listed, not failed: arc did not try')
    assert.ok(!exists('canon/entities/objects/the-barometer.yaml'))
  } finally { process.env.ARC_DRAFT_ENGINE = 'claude-cli' }
})

// ---- (h) delete .arc/ → the unread accepts are still known from the record ---------------------

test('(h) with .arc/ deleted the unread accepts are still known; what a landed receipt in history/ covers is not', async () => {
  reset()
  process.env.STUB_U7 = '[]'
  edit(A, LOG_PARA); await accept(A); await settle()
  assert.deepEqual(unreadEpisodes(), [], 'the first accept was read, and its receipt is in history/')
  edit(A, WIND_PARA); await acceptOffline(A)
  edit(B, ['because counting', 'because plain counting']); await acceptOffline(B)
  const want = unreadEpisodes()
  assert.deepEqual(want.map(u => [u.scene, u.count, u.state]).sort(), [[sceneOf(A), 1, 'due'], [sceneOf(B), 1, 'due']].sort())
  fs.rmSync(path.join(STORY, '.arc'), { recursive: true, force: true })
  assert.deepEqual(unreadEpisodes(), want, 'rebuilt from git and the receipts in history/')
  assert.deepEqual((await get<{ unread: unknown[] }>('/api/briefing')).unread, want)
})
