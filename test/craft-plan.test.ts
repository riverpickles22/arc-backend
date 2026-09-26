// The craft plan (A69-4): what the author wants the reader to feel and the
// craft a writing pass is given to produce it are two different things, and
// the pass receives only the second.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STORY, renderScenario, reset } from './fixture-scenarios.ts'

const { runDraft } = await import('../src/draft.ts')
const { readWorkingReceipt } = await import('../src/run.ts')
const { planSentence, runRowGates } = await import('../src/gates.ts')
const { CRAFT_MOVES, ROW_DRAFT_SCENE } = await import('../src/registry.ts')
const { gateCtx } = await import('../src/reroute.ts')
const { SCENARIOS } = await import('./fixture-scenarios.ts')

const CHAPTER = 'ch.01-ninety-one-stairs'
const plan = SCENARIOS.find(s => s.row === 'draft.scene.one-shot.craft-plan')!

test('a line said now returns a plan and writes nothing, before a token is spent on prose', async () => {
  reset()
  const out = await runDraft(CHAPTER, 'more dread')
  assert.equal(out.file, null, 'no prose yet')
  assert.ok(out.plan?.moves.length, 'and a plan to read')
  assert.match(out.reply, /^Writing toward: /)
  assert.equal(out.reply, `Writing toward: ${planSentence(out.plan!)}`)
  const receipt = readWorkingReceipt(out.run!)!
  assert.equal((receipt.intent as { said?: string }).said, 'more dread')
  assert.equal(receipt.cell?.stage, null, 'the run is the job\'s')
})

test('THE PASS THAT WRITES NEVER SEES THE EFFECT', async () => {
  reset()
  const { seen } = await renderScenario(plan)
  const reading = seen[0].brief
  assert.match(reading, /more dread/, 'the reading is shown the line — translating it is its whole job')

  // And the writing stage, briefed with the plan that came back.
  const settled = await runDraft(CHAPTER, 'more dread')
  reset()
  const briefs: string[] = []
  const { observeBriefs } = await import('../src/fixtures.ts')
  const stop = observeBriefs(b => { if (b.row.endsWith('.write')) briefs.push(b.brief) })
  await runDraft(CHAPTER, 'more dread', settled.plan!).catch(() => {})
  stop()
  assert.ok(briefs.length, 'the write stage was briefed')
  assert.ok(!/dread/i.test(briefs[0]),
    'the word the author said is nowhere in the brief the writing pass received')
  for (const m of settled.plan!.moves) {
    assert.ok(briefs[0].includes(m.how), 'and every clause of the craft is')
  }
})

test('no line, no reading — and the receipt says there was nothing to translate', async () => {
  reset()
  const out = await runDraft(CHAPTER)
  assert.ok(out.file, 'it drafts at once')
  const intent = readWorkingReceipt(out.run!)!.intent as { said: string | null; note?: string }
  assert.equal(intent.said, null)
  assert.equal(intent.note, 'nothing to translate')
})

test('the author can withdraw the line, and the receipt records that they did', async () => {
  reset()
  const out = await runDraft(CHAPTER, 'more dread', null)
  assert.ok(out.file, 'it drafts')
  const intent = readWorkingReceipt(out.run!)!.intent as { said: string | null; plan: unknown; withdrawn?: boolean }
  assert.equal(intent.said, 'more dread', 'what they said is still on record')
  assert.equal(intent.plan, null)
  assert.equal(intent.withdrawn, true, 'and so is the fact that they took it back')
})

test('the vocabulary is closed: a move arc does not know is refused, never sent on', () => {
  const ctx = gateCtx({
    sceneName: '', sceneBody: '', sceneLocks: [], lockedTexts: [], literals: [],
    andCap: null, wordCap: null, destination: [], known: [],
  })
  const row = { gates: ['plan-vocabulary'], answer: 'craft-plan' } as never
  const ok = runRowGates(row, ctx, '```json\n{"moves":[{"move":"narrative_distance","how":"closer"}]}\n```')
  assert.equal(ok.ok, true)

  const strange = runRowGates(row, ctx, '```json\n{"moves":[{"move":"raise_the_stakes","how":"more"}]}\n```')
  assert.equal(strange.ok, false)
  assert.match(strange.ok ? '' : strange.reason, /arc does not know how to ask a writing pass for — raise_the_stakes/)
  assert.equal(strange.gates.find(g => g.gate === 'plan-vocabulary')?.verdict, 'refused')

  const unreadable = runRowGates(row, ctx, 'I think we should make it scarier.')
  assert.equal(unreadable.ok, false)
})

test('the record carries ids, never the wording — a plan stays comparable across sittings', async () => {
  reset()
  const out = await runDraft(CHAPTER, 'more dread')
  const receipt = readWorkingReceipt(out.run!)!
  const intent = receipt.intent as { plan: { moves: { move: string; how: string }[] } }
  const ids = new Set(Object.keys(CRAFT_MOVES))
  for (const m of intent.plan.moves) {
    assert.ok(ids.has(m.move), `${m.move} is one of arc's ids`)
    // The DESCRIPTION beside the id in CRAFT_MOVES is rules text, not record:
    // if it were copied here, rewording it would silently rewrite history.
    assert.notEqual(m.how, CRAFT_MOVES[m.move as keyof typeof CRAFT_MOVES])
  }
  // The gate reads ids too, so a plan and the check on it speak one language.
  const gate = receipt.gates?.find(g => g.gate === 'plan-vocabulary')
  assert.equal(gate?.verdict, 'held')
  assert.ok([...ids].some(id => String(gate?.measured ?? '').includes(id)))

  // The rules the reading is given DO carry the wording, and that is why
  // editing it moves the job fingerprint: the model is being told something
  // different. An id is never edited for readability.
  const { jobFingerprint } = await import('../src/registry.ts')
  const stage = ROW_DRAFT_SCENE.stages.find(s => s.id === 'craft-plan')!
  for (const [id, copy] of Object.entries(CRAFT_MOVES)) {
    assert.ok(stage.rules.includes(id), id)
    assert.ok(stage.rules.includes(copy), `the rules explain ${id}`)
  }
  const reworded = { ...ROW_DRAFT_SCENE, rules: ROW_DRAFT_SCENE.rules.replace('DRAFTING PASS', 'DRAFTING STEP') }
  assert.notEqual(jobFingerprint(reworded), jobFingerprint(ROW_DRAFT_SCENE),
    'a changed brief is a changed job, and waiting drafts are labelled as written by an older arc')
})

test('the plan is ephemeral: it is on the receipt and nowhere else', async () => {
  reset()
  const out = await runDraft(CHAPTER, 'more dread')
  const fs = await import('node:fs')
  const path = await import('node:path')
  // No file of its own anywhere in the story.
  const stray = fs.readdirSync(STORY).filter(f => f.toLowerCase().includes('plan'))
  assert.deepEqual(stray, [], 'a craft plan is never a record of its own')
  assert.ok(fs.existsSync(path.join(STORY, '.arc', 'runs', out.run!, 'receipt.yaml')))
})

test('the decision copies the line and the plan into the evidence log', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { proseAccept } = await import('../src/story.ts')
  reset()
  const settled = await runDraft(CHAPTER, 'more dread')
  const out = await runDraft(CHAPTER, 'more dread', settled.plan!)
  assert.ok(out.file, 'the draft landed')

  proseAccept(undefined, [out.file!])
  const log = path.join(STORY, 'docs', 'style.evidence.jsonl')
  const rows = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  const mine = rows.filter(r => r.file === out.file && r.said)
  assert.ok(mine.length, 'the decision wrote a row carrying what was asked for')
  assert.equal(mine[0].said, 'more dread', 'the line, in the author\'s words')
  assert.deepEqual(mine[0].plan, settled.plan!.moves, 'and the craft it became')
  assert.equal(mine[0].origin, 'draft')
})

test('the reading carries the layers it declares, and nothing of the story', async () => {
  reset()
  const { seen } = await renderScenario(plan)
  const brief = seen[0].brief
  // Its slice declares the contract and the line. Not the record, not the
  // voices, not the style contract — a reading handed those would cost its
  // budget on a real book and the receipt would understate what it was shown.
  assert.match(brief, /more dread/, 'the line it is here to translate')
  assert.ok(!brief.includes('THE RECORD AT THIS MOMENT'), 'no canon')
  assert.ok(!brief.includes('VOICE'), 'no voices')
  assert.ok(!brief.includes("THE AUTHOR'S STYLE CONTRACT"), 'no style contract')

  const receipt = readWorkingReceipt((await runDraft(CHAPTER, 'more dread')).run!)!
  assert.deepEqual(receipt.slice!.layers!.map(l => l.layer), ['contract', 'intent'],
    'and the receipt names exactly the layers the slice declares')
  assert.deepEqual(receipt.slice!.included, ['intent'],
    'of which only the line was there to give — this scene has no contract yet')
})

test('a move the author edits into something arc does not know is refused at the door', async () => {
  const { runDraft: draft } = await import('../src/draft.ts')
  await assert.rejects(
    () => draft(CHAPTER, 'more dread', { moves: [{ move: 'raise_the_stakes', how: 'write about dread' }] } as never),
    (e: unknown) => {
      // It is refused wherever the check lives; what matters is that the
      // writing pass never receives a move outside the six.
      assert.ok(e)
      return true
    })
})
