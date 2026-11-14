// U12 on its row (A74-6): the three gates, the plan beside the pair, the run
// and the resemblance on the proposal, and the keyed receipt the review
// episode joins. The model is a STUB `claude`; what is under test is the code
// around it. The 43 tests in learn-style.test.ts still describe the bars.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installStubCli, makeExampleStory, git } from './fixture.ts'

const STORY = makeExampleStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'claude-cli'
const LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arc-learnrow-log-')), 'calls.log')
process.env.STUB_LOG = LOG
process.env.PATH = `${installStubCli({
  name: 'learnrow',
  before: `require('node:fs').appendFileSync(process.env.STUB_LOG, 'call\\n'); require('node:fs').writeFileSync(process.env.STUB_LOG + '.brief', prompt)`,
  answer: `process.env.STUB_ANSWER ?? '[]'`,
})}${path.delimiter}${process.env.PATH}`

const { predicatesOf, matchRule, examplesCited, contractLines } = await import('../src/rule-gates.ts')
const { runLearnStyle, learnKey, independentExamples } = await import('../src/learn-style.ts')
const { readQueue, writeQueue, rememberDismissal, ruleId, parseQueue, renderQueue } = await import('../src/style-queue.ts')
const { ROWS, rowKey, ROW_LEARN_MANUSCRIPT, ROW_UPDATE_RECORD_SCENE } = await import('../src/registry.ts')
const { receiptsOf, readWorkingReceipt, readRecordReceipt } = await import('../src/run.ts')
const { PASS_REGISTRY } = await import('../src/invocation.ts')
const { failedLearns } = await import('../src/episodes.ts')

const FILE = 'prose/ch-01/scene-01.md'
const calls = (): number => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).length : 0)

// ---- the row ---------------------------------------------------------------

test('U12 has its row, reads the interval from U7\'s, and the bare entry is gone', () => {
  assert.ok(ROWS.map(rowKey).includes('learn.manuscript.triggered'))
  const r = ROW_LEARN_MANUSCRIPT
  assert.deepEqual([r.job, r.scope, r.mode, r.depth, r.pattern, r.withholding, r.answer], ['learn', 'manuscript', 'triggered', 'standard', 'sealed', false, 'rules'])
  assert.deepEqual(r.gates, ['two-examples', 'not-in-contract', 'not-declined'])
  assert.deepEqual(r.slice.layers, ['promoted-contract', 'declined'], 'docs/style.proposed.md is read by no prompt (rule 3), so the queue is no layer')
  assert.equal(r.minIndependentExamples, 2, 'the bar lives on the row')
  assert.equal(r.episode, ROW_UPDATE_RECORD_SCENE.episode, 'one address for the interval')
  assert.ok(!('learn-style' in PASS_REGISTRY))
  assert.match(r.rules, /PLAN line/)
})

// ---- the measurements, pure -------------------------------------------------

test('a countable predicate is the same rule however it is worded; a wording is only argued', () => {
  assert.deepEqual(predicatesOf('A chain stops at three. A sentence stops at 40 words.'), ['and-chain:3', 'sentence-length:40'])
  const lines = ['A chain stops at three.', 'Keep the dog observed from outside, never inside his head.']
  assert.equal(matchRule('An and-chain stops at three; past that, use commas.', lines)?.by, 'predicate')
  assert.equal(matchRule('A chain stops at four.', lines)?.by, 'wording', 'a different number is not the same countable rule — only the wording is close, so it is argued, never dropped')
  assert.equal(matchRule('a chain stops at three.', lines)?.by, 'id', 'the same text is the same id')
  assert.equal(matchRule('Observe the dog from outside; never write inside his head.', lines)?.by, 'wording')
  assert.equal(matchRule('Never open on weather.', lines), null)
})

test('two passes at one paragraph are one example, counted from arc\'s own table', () => {
  const table = [{ n: 1, scene: 'a', paragraph: 3 }, { n: 2, scene: 'a', paragraph: 3 }, { n: 3, scene: 'a', paragraph: 6 }]
  assert.equal(examplesCited([1, 2], table), 1)
  assert.equal(examplesCited([1, 3], table), 2)
  assert.equal(examplesCited([1, 99], table), 1, 'a number the table does not hold counts for nothing')
})

test('a refusal and a hand edit of the same paragraph are one example: one key per pair, the scene id and the paragraph', () => {
  const pair = (scene: string, paragraph: number, source: 'revision' | 'refusal' | 'note') =>
    ({ n: 1, scene, paragraph, source, wrote: 'a', kept: 'b', changed: 3 })
  assert.equal(independentExamples([pair(FILE, 3, 'revision'), pair('sc.01-1', 3, 'refusal')]), 1, 'a file and a scene id name one place')
  assert.equal(independentExamples([pair(FILE, 3, 'revision'), pair('sc.01-1', 4, 'note')]), 2)
})

test('headings and the machine\'s labels are not contract lines', () => {
  assert.deepEqual(contractLines('=== STYLE LAYER 2 ===\n# Title\n\n- A rule.\n- Another.\n\nPRECEDENCE: layer 2 wins'), ['A rule. Another.', 'A rule.', 'Another.'])
})

// ---- the run -----------------------------------------------------------------

const INITIAL = git(STORY, 'rev-parse', 'HEAD').trim()
const EDITS: [string, string][] = [
  ['counted the turns aloud, sixty, because a weight wound short ran out in the small hours and a light that stopped turning was a light that lied.', 'counted the turns aloud, sixty. A weight wound short ran out in the small hours.'],
  ['Tonight she trimmed and wound and logged and did not sing.', 'Tonight she trimmed, wound, logged, did not sing.'],
]
{
  const abs = path.join(STORY, FILE)
  let t = fs.readFileSync(abs, 'utf8')
  for (const [a, b] of EDITS) t = t.replace(a, b)
  fs.writeFileSync(abs, t)
  fs.appendFileSync(path.join(STORY, 'docs/style.md'), '\n- A chain stops at three.\n')
  git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'prose: accept sc.01-1')
  fs.appendFileSync(path.join(STORY, 'docs', 'style.evidence.jsonl'), JSON.stringify({
    at: '2026-10-01T10:00:00.000Z', file: FILE, scene: 'sc.01-1', granularity: 'scene', paragraph: null, verdict: 'accepted',
    arcWrote: '', authorKept: '', origin: 'hand', plan: [{ move: 'inventory', how: 'cut what reveals nobody' }], baseline: INITIAL,
  }) + '\n')
  rememberDismissal({ id: ruleId('Cut the because-clause from a routine; list its steps without reasons.'), rule: 'Cut the because-clause from a routine; list its steps without reasons.' }, '2026-09-20T12:00:00.000Z')
}
const head = git(STORY, 'rev-parse', 'HEAD').trim()
const episode = { scene: 'sc.01-1', range: { from: INITIAL, to: head }, diff: 'the combined diff' }

const PENDING = 'Open every scene on its first step.'
test('each gate drops by its own bar; wording is kept and marked; the run and the resemblance ride on the proposal', async () => {
  writeQueue([{ id: ruleId(PENDING), rule: PENDING, section: null, at: '', evidence: [] }])
  process.env.STUB_ANSWER = JSON.stringify([
    { rule: 'Let a list of actions run on commas rather than on repeated and.', section: 'Sentences', layer: 'story', edits: [1, 2] },
    { rule: 'Open every routine on its first step.', section: null, layer: 'story', edits: [1] },
    { rule: PENDING, section: null, layer: 'story', edits: [1, 2] },
    { rule: 'An and chain stops at three; past that, use commas.', section: 'Sentences', layer: 'story', edits: [1, 2] },
    { rule: 'A chain stops at three.', section: null, layer: 'story', edits: [1, 2] },
    { rule: 'Cut the because-clause from a routine; list the steps without giving reasons.', section: 'Sentences', layer: 'story', edits: [1, 2] },
  ])
  const r = await runLearnStyle([FILE], { [FILE]: INITIAL }, { episode })
  delete process.env.STUB_ANSWER
  assert.equal(r.skipped, null)
  assert.deepEqual(r.added.map(x => x.rule), [
    'Let a list of actions run on commas rather than on repeated and.',
    'Cut the because-clause from a routine; list the steps without giving reasons.',
  ])
  const receipt = readWorkingReceipt(r.run!)!
  const gate = (g: string) => receipt.gates!.find(x => x.gate === g)!
  assert.equal(gate('two-examples').measured, 1, 'one rule rested on one place')
  assert.equal(gate('not-in-contract').measured, 3, 'the id and the predicate were already law, and one rule was already waiting in the queue')
  assert.equal(gate('two-examples').bar, 2, 'the aggregate record carries the row\'s bar')
  assert.match(gate('two-examples').bar_from!, /row/)
  assert.equal(gate('not-declined').measured, 0)
  assert.equal(gate('not-declined').argued, 1, 'the wording resemblance is argued, not proven')
  assert.deepEqual(receipt.evidence!.dropped, [{ reason: 'two-examples', count: 1 }, { reason: 'not-in-contract', count: 3 }])
  assert.equal(receipt.evidence!.returned, r.added.length + 4, 'returned = kept + dropped')
  // the proposal names its run, and what it resembles, and the file round-trips both
  const queued = readQueue().filter(q => q.id !== ruleId(PENDING))
  assert.equal(queued.length, 2)
  assert.ok(queued.every(q => q.run === r.run))
  assert.equal(queued[0].resembles, undefined)
  assert.deepEqual(queued[1].resembles, { id: ruleId('Cut the because-clause from a routine; list its steps without reasons.'), at: '2026-09-20T12:00:00.000Z' })
  assert.deepEqual(parseQueue(renderQueue(queued)), queued)
  assert.match(fs.readFileSync(path.join(STORY, 'docs/style.proposed.md'), 'utf8'), /"run":"run\./)
  // the quotes are arc's own, and the plan sat beside the pairs
  assert.match(queued[0].evidence[0].wrote, /because a weight wound short/)
  assert.match(fs.readFileSync(LOG + '.brief', 'utf8'), /THE PLAN IT WAS DRAFTED UNDER: inventory — cut what reveals nobody/)
  assert.match(fs.readFileSync(LOG + '.brief', 'utf8'), /RULES THE AUTHOR DECLINED/)
  assert.doesNotMatch(fs.readFileSync(LOG + '.brief', 'utf8'), /Open every scene on its first step|PENDING RATIFICATION/, 'the queue is read by no prompt')
})

test('a keyed read leaves a keyed receipt in history/; the same episode again does nothing', async () => {
  const key = learnKey(episode)
  const mine = receiptsOf('learn').filter(r => r.key === key)
  assert.equal(mine.length, 1)
  assert.equal(mine[0].ending, 'landed')
  assert.deepEqual(mine[0].result.range, episode.range)
  assert.match(git(STORY, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'history'), new RegExp(`history/${mine[0].run_id}\\.yaml`))
  const n = calls()
  writeQueue([])
  const again = await runLearnStyle([FILE], { [FILE]: INITIAL }, { episode })
  assert.equal(again.skipped, 'already-read')
  assert.equal(calls(), n, 'no model was asked')
  assert.ok(!fs.existsSync(path.join(STORY, '.arc/episodes.json')) || !/"learned"/.test(fs.readFileSync(path.join(STORY, '.arc/episodes.json'), 'utf8')), 'no cache entry stands in for the receipt')
})

test('a read that did not answer is a keyed receipt that did not land, and is listed failed', async () => {
  const other = { scene: 'sc.01-1', range: { from: INITIAL, to: head }, diff: 'a different diff' }
  process.env.STUB_ANSWER = 'not a list at all'
  const r = await runLearnStyle([FILE], { [FILE]: INITIAL }, { episode: other })
  delete process.env.STUB_ANSWER
  assert.equal(r.skipped, 'not-read')
  assert.ok(r.reply)
  const failed = failedLearns()
  assert.deepEqual(failed.map(f => [f.scene, f.key]), [['sc.01-1', learnKey(other)]])
  assert.equal(readQueue().length, 0, 'nothing was queued')
})

test('on the sdk engine it refuses in a sentence, before any token', async () => {
  process.env.ARC_DRAFT_ENGINE = 'sdk'
  process.env.ANTHROPIC_API_KEY = 'a-key-that-must-never-be-used'   // the SDK is chosen only with one (A78-1)
  const n = calls()
  try {
    await assert.rejects(runLearnStyle([FILE], { [FILE]: INITIAL }), /only when it runs on your claude login/)
  } finally { process.env.ARC_DRAFT_ENGINE = 'claude-cli'; delete process.env.ANTHROPIC_API_KEY }
  assert.equal(calls(), n)
})

test('the hand\'s "learn now" records a gesture, not a sentence; what it proposes is in the record; the cap and no-evidence drops are counted', async () => {
  writeQueue([])
  process.env.STUB_ANSWER = JSON.stringify([
    { rule: 'Prefer concrete nouns to abstractions.', section: null, layer: 'story', edits: [1, 2] },
    { rule: 'End a paragraph on an image.', section: null, layer: 'story', edits: [1, 2] },
    { rule: 'Keep dialogue tags to said.', section: null, layer: 'story', edits: [1, 2] },
    { rule: 'Avoid adverbs after verbs.', section: null, layer: 'story', edits: [1, 2] },
  ])
  const r = await runLearnStyle([FILE], { [FILE]: INITIAL })
  delete process.env.STUB_ANSWER
  assert.equal(r.added.length, 3)
  const receipt = readWorkingReceipt(r.run!)!
  assert.equal(receipt.request!.gesture, 'learn now, by hand')
  assert.equal(receipt.key, undefined, 'a hand read carries no key')
  assert.deepEqual(receipt.evidence!.dropped, [{ reason: 'cap', count: 1 }])
  assert.equal(receipt.evidence!.returned, 4, 'returned = kept 3 + dropped 1')
  assert.ok(readRecordReceipt(r.run!), 'the receipt a proposal names is in history/')
  assert.ok(readQueue().every(q => q.run === r.run))
  writeQueue([])
})

test('a keyed read that throws before its run opens still leaves a receipt, ending could not run, and is listed', async () => {
  const early = { scene: 'sc.01-1', range: { from: INITIAL, to: head }, diff: 'a diff that never got read' }
  const files = Object.assign([FILE], { [Symbol.iterator]() { throw new Error('the log would not open') } })
  await assert.rejects(runLearnStyle(files, { [FILE]: INITIAL }, { episode: early }), /would not open/)
  const mine = receiptsOf('learn').filter(x => x.key === learnKey(early))
  assert.equal(mine.length, 1)
  assert.equal(mine[0].ending, 'could not run')
  assert.ok(failedLearns().some(f => f.key === learnKey(early)), 'so the failure is listed')
})
