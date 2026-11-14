// The style bootstrap on its row (A74-7): learn · manuscript · one-shot. The
// model is a STUB `claude`; what is under test is the code around it — the
// row, the brief (the pending queue never in it), the run, the receipt, the
// layer forced to story, and the ratchet that fell to four.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installStubCli, makeExampleStory, git } from './fixture.ts'

const STORY = makeExampleStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'claude-cli'
const LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arc-bootrow-log-')), 'calls.log')
process.env.STUB_LOG = LOG
process.env.PATH = `${installStubCli({
  name: 'bootrow',
  before: `require('node:fs').appendFileSync(process.env.STUB_LOG, 'call\\n'); require('node:fs').writeFileSync(process.env.STUB_LOG + '.brief', prompt)`,
  answer: `process.env.STUB_ANSWER ?? '[]'`,
})}${path.delimiter}${process.env.PATH}`

const { runBootstrapStyle } = await import('../src/bootstrap-style.ts')
const { readQueue, writeQueue, rememberDismissal, ruleId, parseQueue, renderQueue } = await import('../src/style-queue.ts')
const { ROWS, rowKey, ROW_LEARN_MANUSCRIPT, ROW_LEARN_MANUSCRIPT_FROM_PROSE } = await import('../src/registry.ts')
const { readWorkingReceipt, readRecordReceipt } = await import('../src/run.ts')
const { PASS_REGISTRY } = await import('../src/invocation.ts')

const FILE = 'prose/ch-01/scene-01.md'
const calls = (): number => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).length : 0)
const brief = (): string => fs.readFileSync(LOG + '.brief', 'utf8')

test('the bootstrap has its own row, beside the triggered one, and the bare entry is gone', () => {
  const keys = ROWS.map(rowKey)
  assert.ok(keys.includes('learn.manuscript.one-shot'))
  assert.ok(keys.includes('learn.manuscript.triggered'), 'a distinct key from the triggered row')
  const r = ROW_LEARN_MANUSCRIPT_FROM_PROSE
  assert.deepEqual([r.job, r.scope, r.mode, r.depth, r.pattern, r.withholding, r.answer], ['learn', 'manuscript', 'one-shot', 'standard', 'sealed', false, 'rules'])
  assert.deepEqual(r.gates, ['two-examples', 'not-in-contract', 'not-declined'])
  assert.deepEqual(r.fixtures, ['bootstraps'])
  assert.equal(r.slice, ROW_LEARN_MANUSCRIPT.slice, 'the learner\'s slice, shared')
  assert.equal(r.rules, ROW_LEARN_MANUSCRIPT.rules)
  assert.equal(r.envelope, ROW_LEARN_MANUSCRIPT.envelope)
  assert.ok(!('bootstrap' in PASS_REGISTRY))
  assert.equal(r.episode, undefined, 'asked for once, by hand: no episode')
})

const EDITS: [string, string][] = [
  ['counted the turns aloud, sixty, because a weight wound short ran out in the small hours and a light that stopped turning was a light that lied.', 'counted the turns aloud, sixty. A weight wound short ran out in the small hours.'],
  ['Tonight she trimmed and wound and logged and did not sing.', 'Tonight she trimmed, wound, logged, did not sing.'],
]
{
  const abs = path.join(STORY, FILE)
  let t = fs.readFileSync(abs, 'utf8')
  for (const [a, b] of EDITS) t = t.replace(a, b)
  fs.writeFileSync(abs, t)
  git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'prose: the scene as reworked')
  rememberDismissal({ id: ruleId('Open every scene on weather.'), rule: 'Open every scene on weather.' }, '2026-09-20T12:00:00.000Z')
}
// an agent's key point, in the same directory: not the author's, so not in the brief
fs.writeFileSync(path.join(STORY, 'annotations', 'note-900.yaml'),
  "id: note.900\nby: agent\nstatus: keypoint\nanchor:\n  scene: sc.01-1\n  paragraph: 1\n  quote: The wind\nbody: AN AGENT KEY POINT THE AUTHOR NEVER WROTE\ncreated_at: '2026-10-01'\n")
const PENDING = 'A PENDING RULE THAT NO PROMPT MAY SEE.'

test('it launches through the row: a receipt, the run in the marker, story layer forced, the brief free of the queue', async () => {
  writeQueue([{ id: ruleId(PENDING), rule: PENDING, section: null, at: '', evidence: [] }])
  process.env.STUB_ANSWER = JSON.stringify([
    { rule: 'Let a list of actions run on commas rather than on repeated and.', section: 'Sentences', layer: 'author', edits: [1, 2] },
    { rule: PENDING, section: null, layer: 'story', edits: [1, 2] },
  ])
  const n = calls()
  const r = await runBootstrapStyle()
  delete process.env.STUB_ANSWER
  assert.equal(calls(), n + 1)
  assert.equal(r.skipped, null)
  assert.ok(r.run, 'the run id is returned')
  assert.deepEqual(r.added.map(x => x.rule), ['Let a list of actions run on commas rather than on repeated and.'])
  assert.equal(r.added[0].layer, 'story', 'story layer whatever the model recommended')

  // the brief: the contract and the declined list, never the queue (rule 3), and the notes as context
  assert.match(brief(), /THE CONTRACT AS IT STANDS/)
  assert.match(brief(), /RULES THE AUTHOR DECLINED[\s\S]*Open every scene on weather/)
  assert.doesNotMatch(brief(), /NO PROMPT MAY SEE|ALREADY PENDING/)
  assert.match(brief(), /IT MOVED TO:/, 'history pairs are labelled as movement')
  assert.match(brief(), /THE AUTHOR'S OWN NOTES \(context only\)/)
  assert.doesNotMatch(brief(), /AN AGENT KEY POINT/, 'an agent\'s key point is never presented as the author\'s')
  assert.ok(brief().indexOf("THE AUTHOR'S OWN NOTES") < brief().indexOf('=== THE EDITS ==='), 'the notes come before the edits')
  assert.ok(brief().indexOf('=== THE EDITS ===') < brief().indexOf('Answer with the JSON array.'), 'the answer contract follows the edits, after the notes (rule 8)')

  // the run: a receipt that names the row and the hand's gesture; the gate dropped the queued rule
  const receipt = readWorkingReceipt(r.run!)!
  assert.equal(receipt.request!.gesture, 'learn from the history of your prose, by hand')
  assert.ok(receipt.context_manifest.some(x => x.id === 'annotations' && x.version), 'the notes are their own read on the receipt')
  assert.match(receipt.request!.cell, /learn · manuscript · one-shot/)
  assert.equal(receipt.key, undefined)
  const gate = (g: string) => receipt.gates!.find(x => x.gate === g)!
  assert.equal(gate('not-in-contract').measured, 1, 'the pending rule was dropped in code')
  assert.equal(receipt.evidence!.returned, 2)
  assert.ok(readRecordReceipt(r.run!), 'the receipt is committed to history/ because it proposed')

  // the marker carries the run and round-trips
  const queued = readQueue().filter(q => q.id !== ruleId(PENDING))
  assert.equal(queued.length, 1)
  assert.equal(queued[0].run, r.run)
  assert.deepEqual(parseQueue(renderQueue(queued)), queued)
  assert.match(fs.readFileSync(path.join(STORY, 'docs/style.proposed.md'), 'utf8'), new RegExp(`"run":"${r.run}"`))
  writeQueue([])
})

test('on the sdk engine it refuses in a sentence, before any token', async () => {
  process.env.ARC_DRAFT_ENGINE = 'sdk'
  const n = calls()
  try {
    await assert.rejects(runBootstrapStyle(), /only when it runs on your claude login/)
  } finally { process.env.ARC_DRAFT_ENGINE = 'claude-cli' }
  assert.equal(calls(), n)
})

test('an answer that is not a list leaves a receipt that did not land and queues nothing', async () => {
  process.env.STUB_ANSWER = 'not a list at all'
  const r = await runBootstrapStyle()
  delete process.env.STUB_ANSWER
  assert.equal(r.skipped, 'not-read')
  assert.ok(r.reply)
  assert.equal(readQueue().length, 0)
})
