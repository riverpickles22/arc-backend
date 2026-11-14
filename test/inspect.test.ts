// U9 · INSPECT · SCENE · THE PENDING DIFF (A72-10): a reading of one pending
// change, rowed and receipted, that writes nothing and vetoes nothing.
//
// The pure half — what a citation may name, and what happens to a claim that
// rests on nothing — is tested without a story. The pass is tested with the
// stub CLI: that it reads the diff the author is looking at and refuses one
// that has moved, that it leaves the draft layer exactly as it found it, that
// an answer it cannot read ends the run unreadable rather than standing as a
// reading that found nothing, and that a stop ends it cancelled.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { git, installStubCli, makeExampleStory } from './fixture.ts'

const STORY = makeExampleStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

const { inspectReply, runInspect } = await import('../src/inspect.ts')
const { readFindings, resolveCite, resolveCitations, citedScope } = await import('../src/citations.ts')
const { ROW_INSPECT_SCENE, rowKey } = await import('../src/registry.ts')
const { baseOf } = await import('../src/base.ts')
const { proseDraft } = await import('../src/story.ts')
const { getRun, stopRun } = await import('../src/runs.ts')

const FILE = 'prose/ch-01/scene-01.md'
const abs = path.join(STORY, FILE)
const SCENE = 'sc.01-1'
const status = (e: unknown) => (e as { status?: number }).status

const reset = () => {
  git(STORY, 'checkout', 'HEAD', '--', '.'); git(STORY, 'clean', '-fdq')
  fs.rmSync(path.join(STORY, '.arc'), { recursive: true, force: true })
}
/** One pending change of the author's own, waiting to be decided. */
const pending = (): string => {
  const raw = fs.readFileSync(abs, 'utf8')
  fs.writeFileSync(abs, raw.replace('The wind did what it did.', 'The wind got up at midnight.'))
  return baseOf(FILE)
}
const answering = (findings: unknown) =>
  installStubCli({ answer: JSON.stringify('```json\n' + JSON.stringify(findings) + '\n```') })

// ---- what a citation may name ------------------------------------------------

test('a reading that could not be read is not a reading that found nothing', () => {
  assert.equal(readFindings('I had trouble with that, sorry.'), null, 'not an answer')
  assert.deepEqual(readFindings('```json\n[]\n```'), [], 'an empty array IS an answer, and a good one')
  assert.equal(readFindings('[{"claim": ""}]')?.length, 0, 'a finding with no claim is not a finding')
})

test('a citation resolves to a record id the brief carried, or a paragraph of the scene it read', () => {
  // the bar is the RENDERED brief, not a manifest: an id the pass was never
  // shown must not resolve, and one it was shown must not be dropped
  const scope = citedScope('=== THE RECORD ===\nchar.ines is at place.whitcombe-light\n', 'One.\n\nTwo.\n\nThree.')
  assert.equal(resolveCite('char.ines', scope), null)
  assert.equal(resolveCite('¶2', scope), null)
  assert.equal(resolveCite('paragraph 3', scope), null)
  assert.match(resolveCite('¶9', scope)!, /points at paragraph 9, and the scene has 3/)
  assert.match(resolveCite('char.nobody', scope)!, /arc was not shown anything called char\.nobody/)
})

test('a claim that rests on nothing is dropped and counted; one that rests on something keeps only what resolved', () => {
  const scope = citedScope('char.ines keeps the light', 'One.\n\nTwo.')
  const { kept, dropped } = resolveCitations([
    { section: 'what this changed', claim: 'rests on the record', cites: ['char.ines', 'char.nobody'] },
    { section: 'conflicts', claim: 'rests on nothing arc was shown', cites: ['event.invented'] },
    { section: 'to verify', claim: 'cites nothing at all', cites: [] },
  ], scope)
  assert.deepEqual(kept.map(f => [f.claim, f.cites]), [['rests on the record', ['char.ines']]],
    'the citation arc could not place does not render as one it could')
  assert.deepEqual(dropped.map(d => d.claim), ['rests on nothing arc was shown', 'cites nothing at all'])
  assert.match(dropped[1].why, /cites nothing/)
})

test('what the author reads says what came back AND what was dropped — never silence', () => {
  assert.match(inspectReply(0, 0), /nothing to say about it/)
  assert.match(inspectReply(0, 2), /Not reported/)
  assert.match(inspectReply(2, 0), /2 things to say about it — all argued, none of it in your book/)
  assert.match(inspectReply(1, 1), /One reading was dropped/)
  for (const s of [inspectReply(0, 0), inspectReply(0, 2), inspectReply(2, 1)]) {
    assert.doesNotMatch(s, /\b(git|commit|token|prompt|model)\b/i)
  }
})

test('the row declares the ceilings slice 3 gives it, and the gate that holds its claims up', () => {
  assert.equal(rowKey(ROW_INSPECT_SCENE), 'inspect.scene.one-shot')
  assert.deepEqual(ROW_INSPECT_SCENE.budget, { outputTokens: 12_000, wallClockMs: 20 * 60 * 1000, inputTokens: 40_000 })
  assert.deepEqual([...ROW_INSPECT_SCENE.gates], ['citations'])
  assert.equal(ROW_INSPECT_SCENE.answer, 'reading')
  assert.equal(ROW_INSPECT_SCENE.envelope.tools, 'none', 'a reading is read-only by its envelope, not by its manners')
  assert.equal(ROW_INSPECT_SCENE.withholding, false, 'the prose IS the subject; a leak gate here would refuse every honest brief')
})

// ---- the pass ------------------------------------------------------------------

test('the citation bar is what the brief carried, and nothing wider', () => {
  // the canon layer's TEXT is a traversal pack; its declared ids are the
  // scene's own frontmatter, and the two differ in both directions. Reading
  // the rendered brief is the one bar arc can prove (A72-10 review).
  const scope = citedScope('=== WHAT IS TRUE ===\nobj.keepers-log — the log she keeps\nrel.ines-log\n', 'One.')
  assert.equal(resolveCite('obj.keepers-log', scope), null, 'shown, so it resolves')
  assert.match(resolveCite('char.wren', scope)!, /was not shown/, 'never shown, so it does not')
  assert.ok(!scope.ids.has('scene-01.md'), 'and a filename is not an id')
})

test('a kept finding carries only the citations arc could place', () => {
  const scope = citedScope('char.ines keeps the light', 'One.\n\nTwo.')
  const { kept } = resolveCitations([{ section: 'style', claim: 'a', cites: ['char.ines', 'char.nobody'] }], scope)
  assert.deepEqual(kept[0].cites, ['char.ines'])
})

test('a scene with nothing pending has nothing to read, and a scene arc does not have is said so', async () => {
  reset()
  await assert.rejects(runInspect(SCENE, 'x'), (e: unknown) => status(e) === 409 && /nothing waiting to be decided/.test(String((e as Error).message)))
  await assert.rejects(runInspect('sc.99-9', 'x'), (e: unknown) => status(e) === 404)
})

test('the reading is about the diff the author is looking at: a base that has moved refuses before anything is spent', async () => {
  reset()
  const read = pending()
  fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace('The wind got up at midnight.', 'The wind got up at midnight, and stayed up.'))
  await assert.rejects(runInspect(SCENE, read), (e: unknown) => status(e) === 409)
  await assert.rejects(runInspect(SCENE, undefined), (e: unknown) => status(e) === 400, 'and it fails closed')
})

test('a reading comes back argued, cites what it rests on, drops what it cannot place — and the change is still there to accept', async () => {
  reset()
  const before = fs.readFileSync(abs, 'utf8')
  const base = pending()
  const pendingBytes = fs.readFileSync(abs, 'utf8')
  const bin = answering([
    { section: 'what this changed', claim: 'the wind now has an hour', cites: ['¶7', 'char.ines'] },
    { section: 'conflicts', claim: 'this contradicts the storm', cites: ['event.invented-by-the-model'] },
  ])
  process.env.PATH = `${bin}:${process.env.PATH}`
  process.env.ARC_DRAFT_ENGINE = 'claude-cli'
  try {
    const out = await runInspect(SCENE, base)
    assert.equal(out.register, 'argued')
    // THE BASE IT READ, even if the words move while it runs: the viewer
    // tells a current reading from an outdated one by exactly this.
    fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace('The wind got up at midnight.', 'The wind got up, and the author changed it again.'))
    assert.equal(out.base, base, 'the reading names the diff it read, not the one that stands now')
    assert.notEqual(baseOf(FILE), base, 'and the scene really has moved')
    fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace('The wind got up, and the author changed it again.', 'The wind got up at midnight.'))
    assert.equal(out.scene, SCENE)
    assert.deepEqual(out.findings.map(f => f.claim), ['the wind now has an hour'])
    assert.deepEqual(out.findings[0].cites, ['¶7', 'char.ines'])
    assert.deepEqual(out.dropped.map(d => d.claim), ['this contradicts the storm'])
    assert.match(out.reply, /dropped/)
    assert.equal(out.base, base, 'the reading names the diff it was made about')

    // IT WROTE NOTHING. Not the scene, not the book, not the draft layer.
    assert.equal(fs.readFileSync(abs, 'utf8'), pendingBytes, 'the author\'s pending words are untouched')
    assert.match(git(STORY, 'show', `HEAD:${FILE}`), /The wind did what it did\./, 'and the book is where it was')
    assert.notEqual(before, pendingBytes)
    const draft = proseDraft()
    assert.equal(draft.changes.filter(c => c.file === FILE).length, 1, 'the change is still pending, still acceptable')

    // AND IT LEFT A RECEIPT that names the diff it read.
    const { run } = getRun(out.run)
    assert.equal(run.state, 'done')
    const receipt = fs.readFileSync(path.join(STORY, '.arc', 'runs', out.run, 'receipt.yaml'), 'utf8')
    assert.match(receipt, new RegExp(`base:${SCENE}`), 'the receipt names the base it read')
    assert.match(receipt, /citations/, 'and the gate that held its claims up')
  } finally {
    process.env.ARC_DRAFT_ENGINE = 'none'
  }
})

test('an answer arc cannot read ends the run unreadable — it must never stand as a reading that found nothing', async () => {
  reset()
  const base = pending()
  const bin = installStubCli({ answer: JSON.stringify('I had a look and it seems fine to me.') })
  process.env.PATH = `${bin}:${process.env.PATH}`
  process.env.ARC_DRAFT_ENGINE = 'claude-cli'
  try {
    const out = await runInspect(SCENE, base)
    assert.deepEqual(out.findings, [])
    assert.deepEqual(out.dropped, [])
    assert.match(out.reply, /could not read|not checked|arc/i)
    assert.equal(getRun(out.run).run.ending, 'unreadable')
  } finally { process.env.ARC_DRAFT_ENGINE = 'none' }
})

test('a reading the author stops ends cancelled, and says so', async () => {
  reset()
  const base = pending()
  const bin = installStubCli({ answer: JSON.stringify('```json\n[]\n```'), delayMs: 1500, name: 'slow' })
  process.env.PATH = `${bin}:${process.env.PATH}`
  process.env.ARC_DRAFT_ENGINE = 'claude-cli'
  try {
    const reading = runInspect(SCENE, base)
    const { runs } = await import('../src/runs.ts').then(m => ({ runs: m.listRuns() }))
    const live = runs.find(r => r.state === 'running' && r.subject === SCENE)
    if (live) stopRun(live.id)
    const out = await reading
    if (live) {
      assert.deepEqual(out.findings, [])
      assert.equal(getRun(out.run).run.ending, 'cancelled')
    }
  } finally { process.env.ARC_DRAFT_ENGINE = 'none' }
})
