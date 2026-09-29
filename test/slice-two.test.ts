// SLICE 2, END TO END: the machine-truth bar (A69-12, criterion 1).
//
// Every property below is proven somewhere else in this suite, one at a time,
// on a harness built for it. This file is the other thing an integration
// story is for: the same properties on ONE governed path, in one sitting,
// through the same doors the author uses — so a change that keeps every unit
// test green and still breaks the writing loop has somewhere to fail.
//
// Slice 1 asked whether a route could show its receipt. Slice 2 asks the
// question §2 rests on: is the brief the story model, and can the author read
// what the pass was given? So the properties here are about WHAT REACHED THE
// PASS — the craft rather than the effect, every layer named with an honest
// status, a floor that refuses rather than a brief that quietly shrinks — and
// about what the record says afterwards.
//
// The engine is the fixture engine: a recorded answer keyed by the
// fingerprint of the rendered brief. No key, no subscription, no model. What
// that buys here is that "this brief reached the engine" is a fact this test
// observes rather than infers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
// Sets the story and the engine before anything under src/ loads.
import { SCENE, STORY, reset } from './fixture-scenarios.ts'
import type { BriefSeen } from '../src/fixtures.ts'

const { runDraft } = await import('../src/draft.ts')
const { runRedraft } = await import('../src/redraft.ts')
const { runWorkNotes } = await import('../src/work-notes.ts')
const { observeBriefs } = await import('../src/fixtures.ts')
const { readWorkingReceipt } = await import('../src/run.ts')
const { assembleWritingSlice, WRITING_LAYERS } = await import('../src/slice.ts')
const { ROWS, ROW_DRAFT_SCENE, WRITING_SLICE, jobFingerprint, rowKey } = await import('../src/registry.ts')
const { proseScenes } = await import('../src/story.ts')
const { createAnnotation } = await import('../src/annotations.ts')
const { HttpError } = await import('../src/http.ts')

const CHAPTER = 'ch.01-ninety-one-stairs'
const EFFECT = 'more dread'

/** Run something with every brief that reaches the engine recorded. */
async function watching<T>(work: () => Promise<T>): Promise<{ seen: BriefSeen[]; out: T }> {
  const seen: BriefSeen[] = []
  const stop = observeBriefs(b => seen.push(b))
  try { return { seen, out: await work() } } finally { stop() }
}

const sceneBody = (id = SCENE) => proseScenes().find(s => s.scene === id)?.body ?? ''

// ---- 1. the line becomes craft, and the craft is what the pass receives ----

test('a line that names an effect reaches the pass as craft, and the effect itself reaches nothing', async () => {
  reset()
  // First call: the reading alone. Nothing is written, and the author is
  // handed one line to read, edit or drop.
  const { seen: readingSeen, out: plan } = await watching(() => runDraft(CHAPTER, EFFECT))
  assert.equal(plan.file, null, 'no prose yet — the author has not said go')
  assert.ok(plan.plan?.moves.length, 'and a plan to read')
  assert.equal(readingSeen.length, 1, 'one cheap reading, and only that')
  assert.match(readingSeen[0].brief, /more dread/,
    'the reading IS shown the line — translating it is its whole job')

  // Second call: the write, briefed with the craft the author settled.
  const { seen: writeSeen, out: drafted } = await watching(() => runDraft(CHAPTER, EFFECT, plan.plan!))
  assert.ok(drafted.file, 'the draft landed')
  const write = writeSeen.find(b => b.row.endsWith('.write'))
  assert.ok(write, 'the write stage was briefed')

  // THE PROPERTY THE SLICE IS FOR. A pass told to write dread writes about
  // dread; a pass told what dread is made of writes the scene.
  assert.ok(!/dread/i.test(write.brief),
    'the word the author said appears nowhere in the brief the writing pass received')
  for (const m of plan.plan!.moves) {
    assert.ok(write.brief.includes(m.how), 'and every clause of the craft does')
  }
})

// ---- 2. every layer of §4's table, with a status the author can read ------

test('every layer of the story model is in the brief or named on the receipt, and none reads "missing"', async () => {
  reset()
  const out = await runDraft(CHAPTER)
  const receipt = readWorkingReceipt(out.run!)!
  const layers = receipt.slice!.layers!

  assert.deepEqual(layers.map(l => l.layer), [...WRITING_LAYERS],
    'all twelve — §4\'s eleven and the lock notice its floor sentence names')
  for (const l of layers) {
    assert.ok(['given', 'not shown', 'deferred', 'none'].includes(l.status), `${l.layer}: ${l.status}`)
    if (l.status !== 'given') {
      assert.ok(l.because && l.because.length > 3, `${l.layer} says why it is not given`)
    }
  }
  assert.ok(!JSON.stringify(layers).includes('missing'),
    'never "missing": "arc chose not to show it", "arc ran out of room" and "there is nothing to show" are three different facts about a book')

  // Research is the layer arc does not read yet, and it says so rather than
  // claiming the book cites nothing.
  const research = layers.find(l => l.layer === 'research')!
  assert.equal(research.status, 'deferred')
  assert.match(research.because!, /research is not read yet/)
})

test('a layer dropped for room reads "not shown", and the floor never drops', async () => {
  const subject = { chapter: CHAPTER, sceneId: 'sc.01-2' }
  const row = (inputTokens: number) => ({ ...ROW_DRAFT_SCENE, slice: WRITING_SLICE, budget: { ...ROW_DRAFT_SCENE.budget, inputTokens } })

  const whole = assembleWritingSlice(row(40_000), subject)
  assert.deepEqual(whole.manifest.filter(l => l.status === 'not shown'), [], 'room for everything')

  // Tight enough that the droppable layers must go, roomy enough for the floor.
  let dropped: string[] = []
  for (let budget = whole.estimate; budget > 200; budget -= 250) {
    const s = assembleWritingSlice(row(budget), subject)
    const gone = s.manifest.filter(l => l.status === 'not shown')
    if (!gone.length) continue
    dropped = gone.map(l => l.layer)
    for (const l of gone) assert.equal(l.because, 'room ran out', 'and it says so in the author\'s words')
    for (const f of WRITING_SLICE.floor) {
      assert.notEqual(s.manifest.find(m => m.layer === f)!.status, 'not shown', `${f} is floor and never drops`)
    }
    break
  }
  assert.ok(dropped.length, 'a tight allowance drops something')
})

test('a slice that cannot hold its floor refuses before a token, in the author\'s words', () => {
  const tiny = { ...ROW_DRAFT_SCENE, slice: WRITING_SLICE, budget: { ...ROW_DRAFT_SCENE.budget, inputTokens: 60 } }
  assert.throws(
    () => assembleWritingSlice(tiny, { chapter: CHAPTER, sceneId: 'sc.01-2' }),
    (e: unknown) => {
      assert.ok(e instanceof HttpError && e.status === 400, 'refused, not crashed')
      assert.match(e.message, /sc\.01-2|scene/, 'the sentence names the scene')
      assert.ok(!/slice|layer|token budget|inputTokens/i.test(e.message.split('—')[0]),
        'and none of arc\'s own vocabulary is in it')
      return true
    })
})

// ---- 3. the record says what may bear weight, and the gate holds it -------

test('a state fact past the freshness distance is listed as leaned on — proven from the manifest', async () => {
  reset()
  // The example is CURRENT: the keeper's snapshot is recorded to the year and
  // ch.01 runs inside that year, so nothing is stale and nothing is claimed.
  const clean = await runDraft(CHAPTER)
  assert.deepEqual(readWorkingReceipt(clean.run!)!.slice!.leaned_on, [],
    'a year-precision state contains a scene in that year')

  // Moved back five years, its window closes long before the chapter.
  const file = path.join(STORY, 'canon', 'entities', 'characters', 'ines.yaml')
  const original = fs.readFileSync(file, 'utf8')
  assert.ok(original.includes('date: "1910", precision: year'))
  try {
    fs.writeFileSync(file, original.replace('date: "1910", precision: year', 'date: "1905", precision: year'))
    // The brief moved, so the fixture store has no answer; what is under test
    // is the receipt the slice writes BEFORE a token is spent.
    const aged = await runDraft(CHAPTER).catch(() => null)
    const leaned = readWorkingReceipt(aged!.run ?? (await import('../src/runs.ts')).listRuns()[0].id)!.slice!.leaned_on!
    assert.deepEqual(leaned.map(l => l.id), ['char.ines'])
    assert.equal(leaned[0].as_of, '1905 (year precision)')
    assert.ok(leaned[0].older_by_days > 0, 'and how far past, counted')
  } finally {
    fs.writeFileSync(file, original)
  }
})

test('an answer that rests the prose on a proposed id is refused, and nothing is written', async () => {
  reset()
  const before = sceneBody('sc.01-2')
  const out = await runDraft(CHAPTER, 'lean on the log', {
    moves: [{ move: 'inventory', how: 'name the log and its six columns; let the entry be the last thing she does' }],
  })
  assert.equal(out.file, null, 'nothing was written')
  assert.equal(sceneBody('sc.01-2'), before, 'and the draft layer is as it was')
  const gates = readWorkingReceipt(out.run!)!.gates ?? []
  const leanedOn = gates.filter(g => g.gate === 'leaned-on')
  assert.ok(leanedOn.length, 'the gate ran')
  assert.ok(leanedOn.some(g => g.verdict === 'refused'),
    'and refused: a fact the author has not settled cannot be the ground a scene stands on')
})

// ---- 4. the conflict reading stops the revision ---------------------------

test('two notes that pull against each other stop the revision, and the scene is byte-equal', async () => {
  reset()
  // The two notes the `conflict-found` fixture was recorded against: more of
  // the dog, and less of him, on the same paragraph.
  createAnnotation({ scene: SCENE, paragraph: 0, quote: 'Ninety-one stairs.', body: 'more of the dog on the way up — he should be the reason she counts', by: 'author' })
  createAnnotation({ scene: SCENE, paragraph: 0, quote: 'Ninety-one stairs.', body: 'less of the dog here; he is doing too much work this early', by: 'author' })
  const before = sceneBody()

  const out = await runWorkNotes({ scene: SCENE, mode: 'revise' })
  assert.ok(out.conflicts.length, 'the tension the author has to settle')
  assert.equal(out.changed, false)
  assert.equal(sceneBody(), before, 'THE POINT: the scene on disk is byte-equal — nothing was written')
  assert.match(out.reply, /nothing was written/, 'and the author is told so in their own words')

  // And the run is over rather than parked: arc declined to write and said
  // why, and the author's next move is to settle the notes and ask again.
  const receipt = readWorkingReceipt(out.run!)!
  assert.equal(receipt.ending, 'refused')
})

// ---- 5. nothing reaches the Changes reading without a row -----------------

test('every draft-layer entry carries a run whose receipt names a row — no other path wrote one', async () => {
  // ONE OF EACH WRITING PASS, through the doors the author uses. Each runs
  // from a clean story, because each recorded brief was recorded against one
  // — a draft leaves a second scene behind, and the clean pass that followed
  // would be briefed with a chapter it never saw.
  const index = path.join(STORY, '.arc', 'drafts.jsonl')
  const readIndex = (): { file: string; origin?: string; run?: string }[] =>
    fs.existsSync(index)
      ? fs.readFileSync(index, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
      : []

  const entries: { file: string; origin?: string; run?: string }[] = []
  const receipts = new Map<string, ReturnType<typeof readWorkingReceipt>>()
  const passes: [string, () => Promise<{ file: string | null }>][] = [
    ['the draft', () => runDraft(CHAPTER)],
    ['the clean pass', () => runRedraft({ scene: SCENE })],
    ['the passage rebuild', () => runRedraft({ scene: SCENE, paragraphs: [2, 3] })],
  ]
  for (const [what, run] of passes) {
    reset()
    const out = await run()
    assert.ok(out.file, `${what} landed`)
    for (const e of readIndex()) {
      entries.push(e)
      // The receipt lives under .arc/ too, so it must be read before the
      // next reset takes it.
      if (e.run) receipts.set(e.run, readWorkingReceipt(e.run))
    }
  }
  assert.equal(entries.length, 3, 'three passes, three entries in the draft layer')

  const keys = new Set(ROWS.flatMap(r =>
    r.pattern === 'staged' && r.stages.length
      ? [rowKey(r), ...r.stages.map(st => rowKey({ ...r, stage: st.id }))]
      : [rowKey(r)]))
  const fingerprints = new Set(ROWS.map(jobFingerprint))

  for (const e of entries) {
    assert.ok(e.run, `${e.file} was written with no run to name — an unrowed pass on a governed surface`)
    const receipt = receipts.get(e.run)!
    assert.ok(receipt, `${e.run} left no receipt`)
    const cell = receipt.cell!
    const key = `${cell.job}.${cell.scope}.${cell.mode}${cell.depth && cell.depth !== 'standard' ? `.${cell.depth}` : ''}`
    assert.ok(keys.has(key) || keys.has(`${key}.${cell.stage}`),
      `${e.run} names the cell ${key}, which no row admits`)
    assert.ok(fingerprints.has(receipt.produced_by!.job_fingerprint!),
      `${e.run} was produced by a job the registry does not hold`)
  }
})

// ---- 6. nothing of arc's own vocabulary reaches the author ----------------

test('every gate a row declares has author-facing words — no raw id reaches a receipt or a refusal', async () => {
  const { gateName } = await import('../src/run.ts')
  const declared = new Set(ROWS.flatMap(r => [
    ...r.gates,
    ...(r.pattern === 'staged' ? r.stages.flatMap(s => s.gates) : []),
  ]))
  assert.ok(declared.size >= 8, 'the rows declare gates to name')
  for (const id of declared) {
    // The fallbacks are `the <id> check` and `the <id> check did not hold`.
    // A gate id is arc's vocabulary; rule 9 keeps it off the author's page.
    assert.notEqual(gateName(id), `the ${id} check`, `${id} has no name the author can read`)
    assert.ok(!gateName(id).includes(id), `${id} leaks its own id into the name the author reads`)
  }
})

// ---- 7. the ratchet, from this side ---------------------------------------

test('the rows cover every pass that writes into the Changes reading', () => {
  const keys = ROWS.map(rowKey)
  for (const cell of ['draft.scene.one-shot', 'revise.scene.one-shot', 'revise.selection.one-shot', 'revise.scene.one-shot.quick']) {
    assert.ok(keys.includes(cell), `${cell} has a row`)
  }
  // And the selection menu, which writes nothing but still runs from a row.
  assert.ok(keys.includes('explore.selection.one-shot'), 'synonyms')
  assert.ok(keys.includes('revise.selection.one-shot.quick'), 'rephrase')
})
