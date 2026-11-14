// THE STYLE PAGE IS GOVERNED (A74-8): the declined list is served, a dismissal
// of a proposal that resembles a declined rule lands on THAT entry, and
// ratify / dismiss put the author's word on the receipt of the run that
// proposed the rule — the decision commit, then the receipt's own commit,
// nothing tracked left dirty. The model is a stub `claude`; the HTTP route is
// the real one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { installStubCli, makeExampleStory, git } from './fixture.ts'

const STORY = makeExampleStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'claude-cli'
process.env.ARC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-governed-home-'))
process.env.PATH = `${installStubCli({
  name: 'governed',
  answer: `process.env.STUB_ANSWER ?? '[]'`,
})}${path.delimiter}${process.env.PATH}`

const { runLearnStyle } = await import('../src/learn-style.ts')
const { readQueue, writeQueue, rememberDismissal, readDismissed, ruleId, appendTouchstones } = await import('../src/style-queue.ts')
const { ROW_LEARN_MANUSCRIPT, rowStatus, readStatusReceipts } = await import('../src/registry.ts')
const { readRecordReceipt, readWorkingReceipt } = await import('../src/run.ts')
const { createArcServer } = await import('../src/server.ts')

const server = createArcServer()
await new Promise<void>(resolve => server.listen(0, resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
test.after(() => server.close())
const post = (p: string, body: unknown) =>
  fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const style = async () => (await (await fetch(`${base}/api/style`)).json()) as {
  proposed: { id: string; rule: string; run?: string; resembles?: { id: string; at: string } }[]
  dismissed: { id: string; rule: string; at: string }[]
}

const FILE = 'prose/ch-01/scene-01.md'
const DECLINED = 'Cut the because-clause from a routine; list its steps without reasons.'
const WORDED = 'Cut the because-clause from a routine; list the steps without giving reasons.'
const CLEAN = 'Let a list of actions run on commas rather than on repeated and.'
const OLD = '2026-09-20T12:00:00.000Z'
const INITIAL = git(STORY, 'rev-parse', 'HEAD').trim()
{
  const abs = path.join(STORY, FILE)
  let t = fs.readFileSync(abs, 'utf8')
  for (const [a, b] of [
    ['counted the turns aloud, sixty, because a weight wound short ran out in the small hours and a light that stopped turning was a light that lied.', 'counted the turns aloud, sixty. A weight wound short ran out in the small hours.'],
    ['Tonight she trimmed and wound and logged and did not sing.', 'Tonight she trimmed, wound, logged, did not sing.'],
  ]) t = t.replace(a, b)
  fs.writeFileSync(abs, t)
  git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'prose: accept sc.01-1')
  fs.appendFileSync(path.join(STORY, 'docs', 'style.evidence.jsonl'), JSON.stringify({
    at: '2026-10-01T10:00:00.000Z', file: FILE, scene: 'sc.01-1', granularity: 'scene', paragraph: null, verdict: 'accepted',
    arcWrote: '', authorKept: '', origin: 'hand', baseline: INITIAL,
  }) + '\n')
  rememberDismissal({ id: ruleId(DECLINED), rule: DECLINED }, OLD)
  git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'seed')
}
const statuses = () => rowStatus(ROW_LEARN_MANUSCRIPT, readStatusReceipts(), true)
const dirty = () => git(STORY, 'status', '--porcelain', '-uno').trim()
const subjects = (n: number) => git(STORY, 'log', `-${n}`, '--format=%s').trim().split('\n')

test('the declined list is served; a proposal that resembles one carries it; the row is not yet attended', async () => {
  process.env.STUB_ANSWER = JSON.stringify([
    { rule: CLEAN, section: 'Sentences', layer: 'story', edits: [1, 2] },
    { rule: WORDED, section: 'Sentences', layer: 'story', edits: [1, 2] },
  ])
  const head = git(STORY, 'rev-parse', 'HEAD').trim()
  const r = await runLearnStyle([FILE], { [FILE]: INITIAL }, { episode: { scene: 'sc.01-1', range: { from: INITIAL, to: head }, diff: 'd' } })
  delete process.env.STUB_ANSWER
  assert.equal(r.added.length, 2)
  const s = await style()
  assert.deepEqual(s.dismissed, [{ id: ruleId(DECLINED), rule: DECLINED, at: OLD }])
  assert.ok(s.proposed.every(p => p.run === r.run))
  assert.deepEqual(s.proposed.find(p => p.rule === WORDED)!.resembles, { id: ruleId(DECLINED), at: OLD })
  assert.equal(statuses(), 'built', 'nobody has decided anything this run proposed')
})

test('dismissing a proposal that resembles a declined rule lands on the same entry, with the newer date; the receipt is stamped and committed', async () => {
  const worded = (await style()).proposed.find(p => p.rule === WORDED)!
  const run = worded.run!
  const res = await post('/api/style/proposed', { id: worded.id, action: 'dismiss' })
  assert.equal(res.status, 200)
  const after = (await style()).dismissed
  assert.equal(after.length, 1, 'one line for the idea, not one per wording')
  assert.equal(after[0].id, ruleId(DECLINED))
  assert.equal(after[0].rule, DECLINED, 'the words first turned down are kept')
  assert.ok(after[0].at > OLD, 'the date moved')
  // the decision on the run's receipt, with the hash of the decision's commit
  const receipt = readRecordReceipt(run)!
  assert.equal(receipt.author_decision?.decision, 'rejected')
  assert.match(receipt.author_decision?.note ?? '', /dismissed/)
  const decisionCommit = git(STORY, 'log', '--grep=^style: dismiss', '-1', '--format=%h').trim()
  assert.equal(receipt.result.commit, decisionCommit)
  // two commits: the decision, then the receipt behind it; nothing tracked dirty
  assert.match(subjects(2)[0], /^Record: the receipt for /)
  assert.match(subjects(2)[1], /^style: dismiss proposed rule/)
  assert.equal(dirty(), '')
  assert.equal(git(STORY, 'show', '--stat', '--format=', decisionCommit).includes(`history/${run}.yaml`), true, 'the decision rode in the decision commit')
  assert.equal(statuses(), 'attended')
})

test('ratifying the other proposal of the same run adds to the same receipt', async () => {
  const clean = (await style()).proposed.find(p => p.rule === CLEAN)!
  const res = await post('/api/style/proposed', { id: clean.id, action: 'ratify', layer: 'story' })
  assert.equal(res.status, 200)
  const receipt = readRecordReceipt(clean.run!)!
  assert.equal(receipt.author_decision?.decision, 'accepted', 'the latest word')
  assert.match(receipt.author_decision?.note ?? '', /dismissed .*; ratified /)
  assert.equal(receipt.result.commit, git(STORY, 'log', '--grep=^style: ratify', '-1', '--format=%h').trim())
  assert.match(fs.readFileSync(path.join(STORY, 'docs/style.md'), 'utf8'), /commas rather than on repeated and/)
  assert.equal(dirty(), '')
})

test('a proposal with no run is decided as before and touches no receipt', async () => {
  writeQueue([{ id: ruleId('Never open on weather.'), rule: 'Never open on weather.', section: null, at: '', evidence: [] }])
  const before = fs.readdirSync(path.join(STORY, 'history')).sort()
  const n = Number(git(STORY, 'rev-list', '--count', 'HEAD').trim())
  const res = await post('/api/style/proposed', { id: ruleId('Never open on weather.'), action: 'dismiss' })
  assert.equal(res.status, 200)
  assert.deepEqual(fs.readdirSync(path.join(STORY, 'history')).sort(), before)
  assert.equal(Number(git(STORY, 'rev-list', '--count', 'HEAD').trim()), n + 1, 'one commit, no receipt commit')
  assert.deepEqual(readDismissed().map(d => d.rule), [DECLINED, 'Never open on weather.'])
  assert.equal(readQueue().length, 0)
})

test('declining the same rule again keeps one entry and moves its date', () => {
  rememberDismissal({ id: ruleId(DECLINED), rule: 'different words' }, '2027-01-01T00:00:00.000Z')
  const d = readDismissed().filter(x => x.id === ruleId(DECLINED))
  assert.deepEqual(d, [{ id: ruleId(DECLINED), rule: DECLINED, at: '2027-01-01T00:00:00.000Z', also: [ruleId(WORDED)] }], 'the absorbed wording is kept')
})

test('the wording just declined is declined by id too: one visible line, and the learner cannot bring it back', async () => {
  const entry = readDismissed().find(d => d.id === ruleId(DECLINED))!
  assert.deepEqual(entry.also, [ruleId(WORDED)], 'the entry remembers the wording it absorbed')
  assert.match(fs.readFileSync(path.join(STORY, 'docs/style.dismissed.md'), 'utf8'), /"also":\["p-/, 'and the marker round-trips it')
  process.env.STUB_ANSWER = JSON.stringify([{ rule: WORDED, section: 'Sentences', layer: 'story', edits: [1, 2] }])
  const r = await runLearnStyle([FILE], { [FILE]: INITIAL })
  delete process.env.STUB_ANSWER
  assert.equal(r.added.length, 0)
  const gate = readWorkingReceipt(r.run!)!.gates!.find(g => g.gate === 'not-declined')!
  assert.equal(gate.measured, 1, 'dropped, and proven rather than argued')
  assert.ok(!gate.argued)
  assert.equal(readQueue().length, 0)
})

test('only the decision lands: an uncommitted hand edit to the contract stays in the working tree and out of the commit', async () => {
  const RULE = 'End a paragraph on an image.'
  fs.appendFileSync(path.join(STORY, 'docs/style.md'), '\n- MY HAND EDIT, not yet committed.\n')
  writeQueue([{ id: ruleId(RULE), rule: RULE, section: null, at: '', evidence: [] }])
  const res = await post('/api/style/proposed', { id: ruleId(RULE), action: 'ratify', layer: 'story' })
  assert.equal(res.status, 200)
  const committed = git(STORY, 'show', 'HEAD:docs/style.md')
  assert.match(committed, /End a paragraph on an image/)
  assert.doesNotMatch(committed, /MY HAND EDIT/)
  const working = fs.readFileSync(path.join(STORY, 'docs/style.md'), 'utf8')
  assert.match(working, /End a paragraph on an image/)
  assert.match(working, /MY HAND EDIT/)
  assert.equal(working.match(/End a paragraph on an image/g)!.length, 1, 'the rule is there once')
  git(STORY, 'checkout', '--', 'docs/style.md')
})

test('a declined touchstone is listed in the author\'s words: its quality and where it is, never an id', async () => {
  appendTouchstones([{ id: 't-abc12345', quality: 'Slow time', scene: 'sc.01-1', file: FILE, paragraph: 2, passage: 'For nine days the sea had smelled only of itself.', at: '' }])
  const res = await post('/api/style/proposed', { id: 't-abc12345', action: 'dismiss', kind: 'touchstone' })
  assert.equal(res.status, 200)
  const d = readDismissed().find(x => x.id === 't-abc12345')!
  assert.match(d.rule, /^touchstone: Slow time \(scene 1 of .+, paragraph 3\)$/)
  assert.doesNotMatch(d.rule, /sc\.01-1|¶/)
})
