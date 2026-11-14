// THE ANSWER CAME BACK WHOLE (A75-1).
//
// A route once landed with every gate green although its body began
// mid-word, held a seventh of the words of the scene it re-imagined, and had
// four paragraphs while its own coverage claims placed beats at a seventh and
// a ninth. This gate is the one that reads the prose as a whole answer, by
// count alone: two proofs that refuse, and one observation that never does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diagnosticComplaint, diagnosticsIn } from 'arc-canon-graph/author-language.ts'
import { makeStory } from './fixture.ts'

process.env.ARC_STORY_PATH = makeStory()
process.env.ARC_DRAFT_ENGINE = 'none'

const { GATES, runRowGates } = await import('../src/gates.ts')
const { gateCtx } = await import('../src/reroute.ts')
const { outcomeSentence } = await import('../src/run.ts')
const { ROW_EXPLORE_SCENE, ROW_EXPLORE_ROUTE, ROUTE_MIN_SHARE_OF_SUBJECT } = await import('../src/registry.ts')

const gate = GATES['answer-whole']!

/** A subject of exactly 100 words in ten paragraphs, so a share reads off
 *  the body's word count directly. */
const SUBJECT = Array.from({ length: 10 }, (_, i) => `Paragraph ${i + 1} of the scene runs to ten words, exactly.`).join('\n\n')
const ctx = gateCtx({
  sceneName: 'sc.01-1', sceneBody: SUBJECT, sceneLocks: [], lockedTexts: [],
  literals: [], andCap: null, wordCap: null, destination: ['the beat'],
})

/** A body of `paras` paragraphs and `words` words in all. */
function body(paras: number, words: number, opening = 'She'): string {
  const each = Math.floor(words / paras)
  return Array.from({ length: paras }, (_, i) => {
    const n = i === paras - 1 ? words - each * (paras - 1) : each
    return [i === 0 ? opening : 'word', ...Array.from({ length: n - 1 }, () => 'word')].join(' ')
  }).join('\n\n')
}

const answer = (prose: string, paragraphs: (number | null)[]) => ({
  body: prose, prose, briefing: '',
  coverage: paragraphs.map(p => ({ item: 'the beat', paragraph: p })),
  claims: paragraphs.map(p => ({ item: 'the beat', paragraph: p })),
  dropped: [], returned: paragraphs.length, overlap: null, leansOn: null,
})

const clean = (s: string) => assert.deepEqual(diagnosticsIn(s), [], diagnosticComplaint(s, diagnosticsIn(s)))

test('the gate is declared on both route rows, after every gate already there, and the floor is the row\'s number', () => {
  for (const row of [ROW_EXPLORE_SCENE, ROW_EXPLORE_ROUTE]) {
    assert.equal(row.gates.at(-1), 'answer-whole')
    assert.deepEqual(row.gates.slice(0, -1), ['leak', 'locks', 'lock-order', 'withhold-literals', 'and-chain', 'sentence-length', 'overlap', 'coverage-tail'])
    assert.equal(row.minShareOfSubject, 0.3)
  }
  assert.equal(ROUTE_MIN_SHARE_OF_SUBJECT, 0.3)
  assert.ok(ROW_EXPLORE_SCENE.fixtures.includes('truncated'))
})

test('proof 1 alone: a claim naming a paragraph the body does not have refuses, measured as the highest named against the count', () => {
  const v = gate(ctx, answer(body(4, 60), [2, 7, 9]), ROW_EXPLORE_SCENE)
  assert.equal(v.verdict, 'refused')
  assert.equal(v.record.proof, 'paragraphs')
  assert.equal(v.record.measured, 9)
  assert.equal(v.record.bar, 4)
  assert.match(v.record.bar_from!, /coverage claims/)
  assert.ok(v.verdict === 'refused' && /places its beats as far as paragraph 9 and has 4 paragraphs/.test(v.reason))
  assert.ok(v.verdict === 'refused' && !/as long as the scene/.test(v.reason), 'the floor held, so the sentence does not name it')
  if (v.verdict === 'refused') clean(v.reason)
})

test('proof 2 alone: a body under the row\'s share of the subject refuses, with the bar and the row it came from on the record', () => {
  const v = gate(ctx, answer(body(4, 14), [1, 3]), ROW_EXPLORE_SCENE)
  assert.equal(v.verdict, 'refused')
  assert.equal(v.record.proof, 'floor')
  assert.equal(v.record.measured, 0.14)
  assert.equal(v.record.bar, 0.3)
  assert.equal(v.record.bar_from, 'minShareOfSubject on the explore · scene · one-shot row, as a share of the words of the scene itself')
  assert.ok(v.verdict === 'refused' && /it is 14% as long as the scene it re-imagines, where arc keeps one at 30% or more/.test(v.reason))
  if (v.verdict === 'refused') clean(v.reason)
  // the rewrite row names itself
  assert.equal(gate(ctx, answer(body(4, 14), [1]), ROW_EXPLORE_ROUTE).record.bar_from, 'minShareOfSubject on the explore · route · one-shot row, as a share of the words of the scene itself')
})

test('the share is compared unrounded: a body at 0.295 of its subject is refused against 0.30', () => {
  const big = gateCtx({
    sceneName: 'sc.01-1', sceneBody: SUBJECT + '\n\n' + SUBJECT, sceneLocks: [], lockedTexts: [],
    literals: [], andCap: null, wordCap: null, destination: ['the beat'],
  })
  const v = gate(big, answer(body(4, 59), [1, 2]), ROW_EXPLORE_SCENE)
  assert.equal(v.verdict, 'refused', '59 of 200 words is under the floor, however it rounds')
  assert.equal(v.record.measured, 0.295)
  assert.ok(v.verdict === 'refused' && /it is 29% as long as the scene it re-imagines, where arc keeps one at 30% or more/.test(v.reason))
  assert.equal(gate(big, answer(body(4, 60), [1, 2]), ROW_EXPLORE_SCENE).verdict, 'held', 'and 60 of 200 is on it')
})

test('on the rewrite row the floor is the scene\'s, never the route being rewritten: a rewrite as long as its parent still refuses under 0.30 of the scene', () => {
  // The parent route is a fragment of 20 words against a 100-word scene;
  // its rewrite is exactly as long. Measured against the parent it would be
  // whole; measured against the scene it is a fifth.
  const parent = body(4, 20)
  const rewrite = body(4, 20, 'Light')
  assert.equal(rewrite.split(/\s+/).length, parent.split(/\s+/).length, 'as long as the route it rewrites')
  const v = gate(ctx, answer(rewrite, [1, 2]), ROW_EXPLORE_ROUTE)
  assert.equal(v.verdict, 'refused')
  assert.equal(v.record.proof, 'floor')
  assert.deepEqual([v.record.measured, v.record.bar], [0.2, 0.3])
  assert.match(v.record.bar_from!, /explore · route · one-shot row, as a share of the words of the scene itself$/)
  assert.ok(v.record.measured_against!.includes("floor: 0.2 of the scene's words, against 0.3"))
})

test('both proofs together: the incident itself — four paragraphs, a seventh of the words, claims at a seventh and a ninth', () => {
  const v = gate(ctx, answer(body(4, 14, 'ight'), [7, 9]), ROW_EXPLORE_SCENE)
  assert.equal(v.verdict, 'refused')
  assert.equal(v.record.proof, 'paragraphs+floor')
  assert.deepEqual([v.record.measured, v.record.bar], [9, 4], 'the first proof carries the measurement')
  assert.deepEqual(v.record.floor, { measured: 0.14, bar: 0.3, bar_from: 'minShareOfSubject on the explore · scene · one-shot row, as a share of the words of the scene itself' },
    'and the second keeps its own figures, structured, beside it')
  assert.ok(v.record.measured_against!.includes('opening: the body begins on a lowercase letter'))
  assert.ok(v.verdict === 'refused' && /paragraph 9 and has 4 paragraphs, and it is 14% as long/.test(v.reason), 'the sentence names both')
})

test('a late entry at 0.47 of its subject holds', () => {
  const v = gate(ctx, answer(body(5, 47), [1, 3, 5]), ROW_EXPLORE_SCENE)
  assert.equal(v.verdict, 'held')
  assert.equal(v.record.measured, 0.47)
  assert.equal(v.record.bar, 0.3)
  assert.equal(v.record.proof, undefined)
})

test('a row that states no floor skips that proof, and the record says it was not checked', () => {
  const noFloor = { ...ROW_EXPLORE_SCENE, minShareOfSubject: undefined }
  const v = gate(ctx, answer(body(4, 10), [1, 4]), noFloor)
  assert.equal(v.verdict, 'held', 'a tenth of the subject, and nothing measured it')
  assert.ok(v.record.measured_against!.includes('floor: not checked — the row states no share of the scene'))
  assert.deepEqual([v.record.measured, v.record.bar], [4, 4], 'what was measured is the proof that ran')
  // and run with no row at all, the same
  assert.ok(gate(ctx, answer(body(4, 10), [1]))!.record.measured_against!.some(m => /^floor: not checked/.test(m)))
  // the paragraphs proof still runs without a floor
  assert.equal(gate(ctx, answer(body(4, 10), [5]), noFloor).verdict, 'refused')
})

test('a lowercase opening is recorded and alone never refuses; a capital or an opening quotation mark records nothing', () => {
  const lower = gate(ctx, answer(body(4, 60, 'ight'), [1, 2]), ROW_EXPLORE_SCENE)
  assert.equal(lower.verdict, 'held')
  assert.ok(lower.record.measured_against!.includes('opening: the body begins on a lowercase letter'))
  for (const opening of ['Light', '"Light', '“Light', '‘light']) {
    const v = gate(ctx, answer(body(4, 60, opening), [1, 2]), ROW_EXPLORE_SCENE)
    assert.equal(v.verdict, 'held', opening)
    assert.ok(!v.record.measured_against!.some(m => m.startsWith('opening:')), `${opening} records nothing`)
  }
})

test('through the runner: after coverage-tail on the route row, and a claim that was dropped still names a paragraph', () => {
  const tail = (p: number) => `\n\n=== BRIEFING ===\nwhere it lands.\n\n\`\`\`json\n{"coverage": [{"item": "the beat", "paragraph": 1}, {"item": "a beat nobody asked for", "paragraph": ${p}}]}\n\`\`\``
  const held = runRowGates(ROW_EXPLORE_SCENE, ctx, body(4, 60) + tail(3))
  assert.equal(held.ok, true)
  const names = held.gates.map(g => g.gate)
  assert.equal(names.at(-1), 'answer-whole')
  assert.equal(names.indexOf('answer-whole'), names.indexOf('coverage-tail') + 1)
  const out = runRowGates(ROW_EXPLORE_SCENE, ctx, body(4, 60) + tail(8))
  assert.equal(out.ok, false, 'the stray claim is dropped from the coverage, and still placed a beat in ¶8 of four')
  assert.equal(out.gates.at(-1)!.gate, 'answer-whole')
  assert.equal(out.gates.at(-1)!.measured, 8)
})

test('the author\'s sentence names the proof that failed — no gate id, no git word, never "agent"', () => {
  const floor = { measured: 0.173, bar: 0.3, bar_from: 'the row' }
  const said = (proof: string, measured: number, bar: number) => outcomeSentence({
    ending: 'refused',
    gates: [{ gate: 'answer-whole', verdict: 'refused', attempt: 1, stage: 'answer', proof, measured, bar, ...(proof === 'paragraphs+floor' ? { floor } : {}) },
      { gate: 'answer-whole', verdict: 'refused', attempt: 2, stage: 'answer', proof, measured, bar, ...(proof === 'paragraphs+floor' ? { floor } : {}) }],
  })!
  assert.match(said('paragraphs', 9, 4), /places its beats in paragraphs it does not have \(9 against 4\)/)
  // the floor in whole percentages, the notation of the gate's own reason
  assert.match(said('floor', 0.14, 0.3), /too short to be the whole scene \(14% against 30%\)/)
  assert.match(said('floor', 0.295, 0.3), /\(29% against 30%\)/, 'a share under the floor never reads as the floor')
  assert.match(said('paragraphs+floor', 9, 4), /too short to be the whole scene, and places its beats in paragraphs it does not have \(17% against 30%; paragraph 9 against 4\)/)
  for (const proof of ['paragraphs', 'floor', 'paragraphs+floor']) {
    const line = said(proof, 1, 2)
    assert.doesNotMatch(line, /answer-whole|\bproof\b/)
    assert.doesNotMatch(line, /\b(commit|git|sha|revision|HEAD|branch)\b/i)
    assert.doesNotMatch(line, /\bagents?\b/i)
    clean(line)
  }
})
