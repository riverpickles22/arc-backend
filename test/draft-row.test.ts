// U1 on the governed path (A69-3): the row decides, the run exists before
// the first token, the receipt says what the brief held, and nothing reaches
// the book unless every gate holds. Runs under the fixture engine — no key,
// no subscription, no model.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { SCENARIOS, STORY, renderScenario, reset } from './fixture-scenarios.ts'

const { runDraft } = await import('../src/draft.ts')
const { readWorkingReceipt } = await import('../src/run.ts')
const { ROW_DRAFT_SCENE } = await import('../src/registry.ts')
const { listRuns } = await import('../src/runs.ts')

const CHAPTER = 'ch.01-ninety-one-stairs'
const lands = SCENARIOS.find(s => s.row === 'draft.scene.one-shot.write' && s.name === 'lands')!
const refused = SCENARIOS.find(s => s.row === 'draft.scene.one-shot.write' && s.name === 'validator-refused')!
const leaned = SCENARIOS.find(s => s.row === 'draft.scene.one-shot.write' && s.name === 'leans-on-proposed')!

test('the run exists before the first token, and its receipt names the row and the request', async () => {
  reset()
  const out = await runDraft(CHAPTER) as { run?: string; file: string | null }
  assert.ok(out.run, 'the response names the run')
  const receipt = readWorkingReceipt(out.run!)
  assert.ok(receipt, 'and the run wrote a working receipt')
  assert.equal(receipt!.request?.gesture, `draft the next scene of ${CHAPTER}`)
  assert.equal(receipt!.request?.cell, 'draft · scene · one-shot')
  assert.equal(receipt!.cell?.job, 'draft')
  assert.equal(receipt!.ending, 'landed')
  assert.ok(receipt!.produced_by?.job_fingerprint, 'and what produced it')
})

test('the receipt carries the layer manifest the assembler built', async () => {
  reset()
  const out = await runDraft(CHAPTER) as { run?: string }
  const receipt = readWorkingReceipt(out.run!)!
  const layers = receipt.slice?.layers
  assert.ok(layers?.length, 'every layer of the writing slice is on the receipt')
  const byLayer = Object.fromEntries(layers!.map(l => [l.layer, l]))
  assert.equal(byLayer['research'].status, 'deferred', 'and research says it is not read yet')
  assert.match(byLayer['research'].because!, /Q16/)
  assert.equal(byLayer['promoted-rules'].status, 'given', 'a draft is told the voice it is writing in')
  assert.ok(receipt.slice!.included.includes('canon'))
  assert.ok(!JSON.stringify(receipt.slice).includes('Ines went up at four'),
    'names and ids only — no prose on a receipt')
})

test('a draft that lands is waiting in the draft layer, not in the book', async () => {
  reset()
  const { result } = await renderScenario(lands)
  const out = result as { file: string | null; reply: string }
  assert.equal(out.file, 'prose/ch-01/scene-02.md')
  assert.ok(fs.existsSync(path.join(STORY, out.file!)), 'the file is on disk')
  assert.match(out.reply, /accept or discard/, 'and the author is told what comes next')
  // The draft layer, not main: the working tree carries it and nothing is
  // committed.
  assert.match(fs.readFileSync(path.join(STORY, out.file!), 'utf8'), /^---\nscene: sc\.01-2/)
})

test('an answer the story rejects leaves nothing behind, and says why in the author\'s words', async () => {
  reset()
  const { result } = await renderScenario(refused)
  const out = result as { file: string | null; reply: string; run?: string }
  assert.equal(out.file, null, 'nothing was written')
  assert.ok(!fs.existsSync(path.join(STORY, 'prose', 'ch-01', 'scene-02.md')),
    'and the file it tried is gone — a draft that failed its gates never existed')
  assert.match(out.reply, /does not fit your record|would not keep it/)
  const receipt = readWorkingReceipt(out.run!)!
  assert.equal(receipt.ending, 'refused')
  const gate = receipt.gates?.find(g => g.gate === 'validator')
  assert.equal(gate?.verdict, 'refused', 'the validator gate is what refused it')
  assert.equal(gate?.bar_from, "the story's own validator")
})

test('the row is the job\'s one definition: the brief opens with the row\'s rules', async () => {
  reset()
  const { seen } = await renderScenario(lands)
  assert.ok(seen[0].brief.startsWith(ROW_DRAFT_SCENE.rules.slice(0, 80)),
    'the drafting brief opens with the row\'s rules, not a copy in draft.ts')
  assert.match(ROW_DRAFT_SCENE.rules, /DRAFTING PASS/)
})

test('the ledger entry names the run that wrote it', async () => {
  reset()
  const out = await runDraft(CHAPTER) as { run?: string }
  const ledger = path.join(STORY, '.arc', 'drafts.jsonl')
  const lines = fs.existsSync(ledger)
    ? fs.readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    : []
  const mine = lines.filter(l => l.run === out.run)
  assert.ok(mine.length, 'what arc wrote is recorded against the run that wrote it')
  assert.equal(mine[0].origin, 'draft')
})

test('every run this pass opened is closed', () => {
  for (const r of listRuns()) {
    if (r.source === 'ui' && r.prompt.startsWith('draft the next scene')) {
      assert.ok(['done', 'refused', 'failed', 'cancelled'].includes(r.state),
        `${r.id} is ${r.state} — a run that never ends is a row the author can press forever`)
    }
  }
})

test('the countable style rules measure the prose, never the scene binding', async () => {
  const { runRowGates, withoutFrontmatter } = await import('../src/gates.ts')
  const { gateCtx } = await import('../src/reroute.ts')
  const { loadFixtures } = await import('../src/fixtures.ts')
  const answer = loadFixtures().find(f => f.row === 'draft.scene.one-shot.write' && f.name === 'lands')!.answer

  // The frontmatter is one long unpunctuated run: measured as prose it is a
  // sentence of seventy-odd words, and any story whose contract states a cap
  // — the novel's says 55 — would refuse every draft on attempt one.
  const { longSentenceViolations } = await import('../src/reroute.ts')
  const whole = longSentenceViolations(answer, 55, [])
  assert.ok(whole.some(v => v.sentence.includes('scene: sc.01-2')),
    'read whole, the binding looks like one enormous sentence')
  assert.deepEqual(longSentenceViolations(withoutFrontmatter(answer), 55, []), [],
    'read as prose, the draft is inside the cap')

  // And the gate runner agrees, because it measures `prose`.
  const ctx = gateCtx({
    sceneName: 'sc.01-2', sceneBody: '', sceneLocks: [], lockedTexts: [], literals: [],
    andCap: 4, wordCap: 55, destination: [], known: [],
  })
  const out = runRowGates({ gates: ['and-chain', 'sentence-length'], answer: 'scene-file' } as never, ctx, answer)
  assert.equal(out.ok, true, out.ok ? '' : out.reason)
})

test('a trial write puts the author\'s own file back, exactly', async () => {
  reset()
  const target = path.join(STORY, 'prose', 'ch-01', 'scene-02.md')
  const mine = '---\nnot: valid frontmatter for a scene\n---\n\nThe author was halfway through this.\n'
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, mine)
  try {
    // The half-written file does not parse, so arc does not see it as a scene
    // and hands its path to the next draft. The draft must not take it.
    await runDraft(CHAPTER).catch(() => {})
    assert.equal(fs.readFileSync(target, 'utf8'), mine,
      'whatever the pass did, the file the author was working on is exactly as they left it')
  } finally {
    fs.rmSync(target, { force: true })
  }
})

// ---- what the prose rests on (A69-6) -------------------------------------

test('a draft that rests on a fact the author has not settled is refused by the leaned-on gate', async () => {
  reset()
  const { result } = await renderScenario(leaned)
  const out = result as { file: string | null; reply: string; run?: string }
  assert.equal(out.file, null, 'nothing was written')
  assert.match(out.reply, /what the draft rests on did not check out \(obj\.keepers-log, rel\.ines-log against what you have settled\)/,
    'the author is told which facts, rendered by code from the gate record')
  const receipt = readWorkingReceipt(out.run!)!
  assert.equal(receipt.ending, 'refused')
  assert.equal(receipt.gates?.find(g => g.gate === 'validator')?.verdict, 'held',
    'the file itself validates — it is the briefing that rests on the log')
  const gate = receipt.gates?.find(g => g.gate === 'leaned-on')
  assert.equal(gate?.verdict, 'refused')
  assert.equal(gate?.measured, 'obj.keepers-log, rel.ines-log', 'what failed')
  for (const id of ['char.ines', 'obj.keepers-log', 'rel.ines-log', 'char.wren']) {
    assert.ok(gate?.measured_against?.includes(id), `${id}: the tail and the file's bindings together are what was measured`)
  }
})

test('the receipt lists under leaned on every state fact given past the freshness distance', async () => {
  reset()
  const out = await runDraft(CHAPTER) as { run?: string }
  const receipt = readWorkingReceipt(out.run!)!
  assert.deepEqual(receipt.slice!.leaned_on!.map(l => l.id), ['char.ines'])
  assert.equal(receipt.slice!.leaned_on![0].as_of, '1910 (year precision)')
  assert.ok(receipt.slice!.leaned_on![0].older_by_days > 0)
})

test('the leans-on tail is read before the coverage tail, and a briefing without one is refused', async () => {
  const { runRowGates, parseLeansOn } = await import('../src/gates.ts')
  const { gateCtx } = await import('../src/reroute.ts')
  const p = parseLeansOn('one\n```leans-on\nchar.ines\n- `char.wren`\n```\ntwo')
  assert.deepEqual(p.leansOn, ['char.ines', 'char.wren'])
  assert.equal(p.briefing, 'one\ntwo', 'and it is cut out, so the coverage parser never sees the fence')

  const ctx = {
    ...gateCtx({ sceneName: 'sc.01-2', sceneBody: '', sceneLocks: [], lockedTexts: [], literals: [], andCap: null, wordCap: null, destination: [], known: [] }),
    settled: ['char.ines'], unsettled: ['obj.keepers-log'],
  }
  const row = { gates: ['leaned-on'], answer: 'scene-file' } as never
  const file = '---\nscene: sc.01-2\n---\n\nProse.\n=== BRIEFING ===\nA note.\n'
  const absent = runRowGates(row, ctx, file)
  assert.equal(absent.ok, false)
  assert.match(absent.ok ? '' : absent.reason, /did not say what it rests on/)
  const ok = runRowGates(row, ctx, file + '```leans-on\nchar.ines\n```\n')
  assert.equal(ok.ok, true, ok.ok ? '' : ok.reason)
  assert.deepEqual(ok.ok ? ok.dropped : null, [], 'the fence is not counted as an unparseable claim')
  const rested = runRowGates(row, ctx, file + '```leans-on\nobj.keepers-log\n```\n')
  assert.match(rested.ok ? '' : rested.reason, /rests on obj\.keepers-log, which you have not settled/)
  const unknown = runRowGates(row, ctx, file + '```leans-on\nchar.nobody\n```\n')
  assert.match(unknown.ok ? '' : unknown.reason, /your record does not hold/)
  // A row naming the gate with no record to check against is refused, never passed.
  const bare = runRowGates(row, gateCtx({ sceneName: '', sceneBody: '', sceneLocks: [], lockedTexts: [], literals: [], andCap: null, wordCap: null, destination: [], known: [] }), file + '```leans-on\nchar.ines\n```\n')
  assert.equal(bare.ok, false)
})

test('the gate reads what the file binds, not only what the tail admits', async () => {
  const { runRowGates, boundIds } = await import('../src/gates.ts')
  const { gateCtx } = await import('../src/reroute.ts')
  assert.deepEqual(boundIds('---\nscene: x\nfacts:\n  - char.ines\n  - obj.keepers-log\nevents: [event.the-wreck]\n---\nbody'),
    ['char.ines', 'obj.keepers-log', 'event.the-wreck'])
  const ctx = {
    ...gateCtx({ sceneName: 'sc.01-2', sceneBody: '', sceneLocks: [], lockedTexts: [], literals: [], andCap: null, wordCap: null, destination: [], known: [] }),
    settled: ['char.ines'], unsettled: ['obj.keepers-log'],
  }
  const row = { gates: ['leaned-on'], answer: 'scene-file' } as never
  // Binds the proposed log, and the tail says nothing about it.
  const quiet = '---\nscene: sc.01-2\nfacts: [char.ines, obj.keepers-log]\n---\n\nProse.\n=== BRIEFING ===\nA note.\n```leans-on\nchar.ines\n```\n'
  const out = runRowGates(row, ctx, quiet)
  assert.equal(out.ok, false, 'binding an id is resting on it')
  assert.match(out.ok ? '' : out.reason, /rests on obj\.keepers-log/)
  // CRLF is still an answer.
  const crlf = '---\r\nscene: sc.01-2\r\nfacts: [char.ines]\r\n---\r\n\r\nProse.\r\n=== BRIEFING ===\r\n**Leans on.**\r\n```leans-on\r\nchar.ines\r\n```\r\n'
  const ok = runRowGates(row, ctx, crlf)
  assert.equal(ok.ok, true, ok.ok ? '' : ok.reason)
  assert.ok(!ok.ok || !/leans on/i.test(ok.briefing), 'and the heading goes with the block')
})

test('the author is told at the landing what the draft leans on', async () => {
  reset()
  const out = await runDraft(CHAPTER) as { reply: string }
  assert.match(out.reply, /It leans on char\.ines as of 1910 \(year precision\) — the record has not looked since\./)
})

