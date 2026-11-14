// EVERY ROW THAT WRITES PROSE SAYS WHETHER ITS ANSWER MUST COME BACK WHOLE
// (A75-2). A row whose answer is prose either lists `answer-whole` with a
// floor, or carries one line saying why it has no subject to measure against.
// Never neither, and never both. The author's bar, 2026-11-14: three tenths
// of the subject's words wherever a row has a subject.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeStory } from './fixture.ts'

process.env.ARC_STORY_PATH = makeStory()
process.env.ARC_DRAFT_ENGINE = 'none'

const { GATES } = await import('../src/gates.ts')
const { gateCtx } = await import('../src/gate-ctx.ts')
const registry = await import('../src/registry.ts')
const { ROWS, WRITES_PROSE, rowKey, jobFingerprint, ROUTE_MIN_SHARE_OF_SUBJECT,
  ROW_DRAFT_SCENE, ROW_REVISE_SCENE, ROW_REVISE_SELECTION, ROW_REVISE_SCENE_STAGED, ROW_REPHRASE, ROW_SYNONYMS } = registry
type Row = (typeof ROWS)[number]

const prose = ROWS.filter(r => WRITES_PROSE.includes(r.answer))
/** The launch that writes: a staged row's write stage, or the row itself. */
const writer = (r: Row) => r.pattern === 'staged' ? r.stages.find(s => WRITES_PROSE.includes(s.answer)) : r

test('every prose-writing row lists answer-whole with a stated floor, or carries a one-line reason it does not', () => {
  assert.equal(prose.length, 8, `the prose rows are found: ${prose.map(rowKey).join(', ')}`)
  for (const r of prose) {
    const key = rowKey(r)
    const lists = r.gates.includes('answer-whole')
    if (lists) {
      assert.equal(typeof r.minShareOfSubject, 'number', `${key} lists the gate and states its floor`)
      assert.equal(r.noAnswerWhole, undefined, `${key} lists the gate, so it gives no reason for its absence`)
      // A staged row's gate runs at its write stage, whose list is its own.
      assert.ok(writer(r)!.gates.includes('answer-whole'), `${key}: the stage that writes lists it too`)
    } else {
      assert.equal(r.minShareOfSubject, undefined, `${key} states no floor for a gate it does not list`)
      assert.equal(typeof r.noAnswerWhole, 'string', `${key} says why it does not list the gate`)
      assert.ok(r.noAnswerWhole!.trim().length > 20 && !r.noAnswerWhole!.includes('\n'), `${key}: one line, with something in it`)
      if (r.pattern === 'staged') assert.ok(r.stages.every(s => !s.gates.includes('answer-whole')), `${key}: no stage lists it either`)
    }
  }
  // No row outside the prose shapes carries either.
  for (const r of ROWS.filter(x => !prose.includes(x))) {
    assert.ok(!r.gates.includes('answer-whole') && r.noAnswerWhole === undefined, `${rowKey(r)} writes no prose`)
  }
})

test('the drafting rows: each decision, as the author set them', () => {
  // A subject to measure against: the clean pass (scene, and passage) and
  // the minimal revision, at the route's bar.
  for (const r of [ROW_REVISE_SCENE, ROW_REVISE_SELECTION, ROW_REVISE_SCENE_STAGED]) {
    assert.equal(r.minShareOfSubject, ROUTE_MIN_SHARE_OF_SUBJECT, rowKey(r))
    assert.equal(r.minShareOfSubject, 0.3, rowKey(r))
    assert.equal(r.gates.at(-1), 'answer-whole', `${rowKey(r)}: after every gate already there`)
  }
  // None: a new scene, and the menu.
  for (const r of [ROW_DRAFT_SCENE, ROW_REPHRASE, ROW_SYNONYMS]) assert.ok(r.noAnswerWhole, rowKey(r))
  assert.ok(ROW_REVISE_SCENE.stages.find(s => s.id === 'write')!.fixtures.includes('truncated'))
})

test('a reason is not part of the job: rewording it moves no fingerprint', () => {
  assert.equal(jobFingerprint({ ...ROW_DRAFT_SCENE, noAnswerWhole: 'another way of saying it' }), jobFingerprint(ROW_DRAFT_SCENE))
})

test('a passage answer is measured against the passage it rebuilds, never the whole scene', () => {
  const gate = GATES['answer-whole']!
  const para = (n: number) => Array.from({ length: n }, () => 'word').join(' ')
  // A scene of 200 words; the passage handed to rebuild is 40 of them.
  const scene = [para(80), para(40), para(80)].join('\n\n')
  const ctx = { ...gateCtx({ sceneName: 'sc.01-1', sceneBody: scene, sceneLocks: [], lockedTexts: [], literals: [], andCap: null, wordCap: null, destination: [] }), subjectPassage: para(40) }
  const a = (p: string) => ({ body: p, prose: p, briefing: '', coverage: null, dropped: [], returned: 0, overlap: null, leansOn: null })
  // An honest passage of 36 words is a fifth of the scene and nine tenths of the passage: it holds.
  const held = gate(ctx, a(para(36)), ROW_REVISE_SELECTION)
  assert.equal(held.verdict, 'held')
  assert.equal(held.record.measured, 0.9)
  assert.equal(held.record.bar_from, 'minShareOfSubject on the revise · selection · one-shot · standard row, as a share of the words of the passage it rebuilds')
  // Eight words of a forty-word passage is a fragment of it.
  const short = gate(ctx, a(para(8)), ROW_REVISE_SELECTION)
  assert.equal(short.verdict, 'refused')
  assert.equal(short.record.proof, 'floor')
  assert.match(short.verdict === 'refused' ? short.reason : '', /it is 20% as long as the passage it rebuilds, where arc keeps one at 30% or more/)
})

test('the author\'s sentence follows the record: a passage floor reads as the passage, a scene floor as the scene', async () => {
  const { outcomeSentence } = await import('../src/run.ts')
  const passageFrom = 'minShareOfSubject on the revise · selection · one-shot · standard row, as a share of the words of the passage it rebuilds'
  const sceneFrom = 'minShareOfSubject on the revise · scene · one-shot · standard row, as a share of the words of the scene itself'
  const said = (bar_from: string, proof = 'floor') => outcomeSentence({
    ending: 'refused',
    gates: [{ gate: 'answer-whole', verdict: 'refused', attempt: 1, stage: 'answer', proof,
      ...(proof === 'floor' ? { measured: 0.2, bar: 0.3, bar_from } : { measured: 9, bar: 4, bar_from: 'claims', floor: { measured: 0.2, bar: 0.3, bar_from } }) }],
  })!
  assert.match(said(passageFrom), /too short to be the whole passage it rebuilds \(20% against 30%\)/)
  assert.doesNotMatch(said(passageFrom), /whole scene/)
  assert.match(said(passageFrom, 'paragraphs+floor'), /too short to be the whole passage it rebuilds, and places its beats/)
  assert.match(said(sceneFrom), /too short to be the whole scene \(20% against 30%\)/)
})

test('with no floor on a passage, the observation names the passage too', () => {
  const ctx = { ...gateCtx({ sceneName: 'sc.01-1', sceneBody: 'one two three', sceneLocks: [], lockedTexts: [], literals: [], andCap: null, wordCap: null, destination: [] }), subjectPassage: 'two' }
  const v = GATES['answer-whole']!(ctx, { body: 'two', prose: 'two', briefing: '', coverage: null, dropped: [], returned: 0, overlap: null, leansOn: null }, { ...ROW_REVISE_SELECTION, minShareOfSubject: undefined })
  assert.ok(v.record.measured_against!.includes('floor: not checked — the row states no share of the passage'), JSON.stringify(v.record.measured_against))
})

test('the floor\'s record names its row whole: the notes revision and the clean pass share job, scope and mode but not an address', () => {
  const ctx = gateCtx({ sceneName: 'sc.01-1', sceneBody: 'one two three four five six seven eight nine ten', sceneLocks: [], lockedTexts: [], literals: [], andCap: null, wordCap: null, destination: [] })
  const a = { body: 'one', prose: 'one', briefing: '', coverage: null, dropped: [], returned: 0, overlap: null, leansOn: null }
  const quick = GATES['answer-whole']!(ctx, a, ROW_REVISE_SCENE_STAGED).record.bar_from
  const clean = GATES['answer-whole']!(ctx, a, ROW_REVISE_SCENE).record.bar_from
  assert.match(quick!, /revise · scene · one-shot · quick row/)
  assert.match(clean!, /revise · scene · one-shot · standard row/)
  assert.notEqual(quick, clean)
})
