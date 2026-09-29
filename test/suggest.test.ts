// THE WRITER'S MENU (A69-10): the pure parts of the two rows that offer
// wordings and write nothing, and the refusals they make before a run is
// minted. The engine never runs here; the rows' path under the fixture
// engine — the brief they render and what the gates do to a list — is
// fixture-engine.test.ts, over the revise.selection.one-shot.quick and
// explore.selection.one-shot scenarios.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeStory } from './fixture.ts'

process.env.ARC_STORY_PATH = makeStory()
process.env.ARC_DRAFT_ENGINE = 'none'
const { parseSuggestions, suggestAssignment, runSuggest } = await import('../src/suggest.ts')
const { REPHRASE_RULES, SYNONYM_RULES, ROW_REPHRASE, ROW_SYNONYMS } = await import('../src/registry.ts')
const { parseOptions, runRowGates } = await import('../src/gates.ts')
const { gateCtx } = await import('../src/reroute.ts')

test('the rephrase rules make the author\'s own contract the authority, and promise nothing is written', () => {
  assert.match(REPHRASE_RULES, /REPHRASE pass/)
  assert.match(REPHRASE_RULES, /THE CONTRACT BELOW IS BINDING/)
  assert.match(REPHRASE_RULES, /YOU HAVE NO TOOLS/, 'a sealed pass')
  assert.match(REPHRASE_RULES, /not even the option the author picks/, 'the author places it, never arc')
  assert.match(REPHRASE_RULES, /3 to 5/)
  assert.match(REPHRASE_RULES, /JSON array/)
})

test('the synonym rules ask for nuance, drop-in replacements, and the book\'s own period', () => {
  assert.match(SYNONYM_RULES, /SYNONYM pass/)
  assert.match(SYNONYM_RULES, /nuance/)
  assert.match(SYNONYM_RULES, /drop-in/)
  assert.match(SYNONYM_RULES, /period or register/)
  assert.match(SYNONYM_RULES, /YOU HAVE NO TOOLS/)
})

test('the assignment carries what the author pointed at, and says so only when there is something to say', () => {
  const full = suggestAssignment({
    selection: 'He was very tired.',
    paragraph: 'The oars were heavy. He was very tired. The coast refused to come closer.',
    sceneContext: 'Scene sc.01-1, chapter ch.01.',
  })
  assert.match(full, /SCENE CONTEXT/)
  assert.match(full, /THE PARAGRAPH IT SITS IN/)
  assert.match(full, /He was very tired\./)
  assert.match(full, /The coast refused to come closer\./)

  const bare = suggestAssignment({ selection: 'walked' })
  assert.doesNotMatch(bare, /SCENE CONTEXT/, 'no file, no line about one')
  assert.doesNotMatch(bare, /THE PARAGRAPH/, 'a selection with no paragraph still works')
  assert.match(bare, /THE SELECTION/)
})

test('the menu is shown the ratified contract and nothing else of the record', () => {
  for (const row of [ROW_REPHRASE, ROW_SYNONYMS]) {
    assert.deepEqual([...row.slice.layers], ['promoted-rules'])
    assert.deepEqual([...row.slice.floor], ['promoted-rules'],
      'a menu with no contract is the generic button these rows exist not to be')
    assert.deepEqual([...row.slice.dropOrder], [], 'so there is nothing to drop')
    assert.equal(row.pattern, 'sealed', 'no craft plan at this scope — nothing here writes prose')
    assert.equal(row.withholding, false, 'the pass is handed the very words it is rephrasing')
    assert.equal(row.answer, 'options')
  }
})

test('parseSuggestions handles fences, junk entries, and caps the list', () => {
  assert.deepEqual(parseSuggestions('```json\n["one","two"]\n```'), ['one', 'two'])
  assert.deepEqual(parseSuggestions('Here you go: ["a", "", 3, "b"] hope that helps'), ['a', 'b'])
  assert.equal(parseSuggestions(JSON.stringify(['1', '2', '3', '4', '5', '6', '7', '8'])).length, 6)
  assert.throws(() => parseSuggestions('no array here'), /JSON array/)
  assert.throws(() => parseSuggestions('{"not": "an array"}'), Error)
  // One reader, so what a gate measured and what the author is shown cannot
  // differ: the gate runner reads the same list through parseOptions.
  assert.equal(parseOptions('no array here'), null)
  assert.deepEqual(parseOptions('["a","b"]'), ['a', 'b'])
})

test('three to six wordings, or the menu is refused and says which it was', () => {
  const ctx = gateCtx({
    sceneName: '', sceneBody: '', sceneLocks: [], lockedTexts: [], literals: [],
    andCap: null, wordCap: null, destination: [], known: [],
  })
  const row = { gates: ['options-shape'], answer: 'options' } as never
  assert.equal(runRowGates(row, ctx, JSON.stringify(['a', 'b', 'c'])).ok, true)
  assert.equal(runRowGates(row, ctx, JSON.stringify(['a', 'b', 'c', 'd', 'e', 'f'])).ok, true)

  const thin = runRowGates(row, ctx, JSON.stringify(['a', 'b']))
  assert.equal(thin.ok, false)
  assert.match(thin.ok ? '' : thin.reason, /offered 2 wordings where arc asks for 3 to 6/)

  const many = runRowGates(row, ctx, JSON.stringify(['a', 'b', 'c', 'd', 'e', 'f', 'g']))
  assert.equal(many.ok, false, 'seven is a pass avoiding a decision')

  // Unreadable is its own thing: the author is told arc could not read them,
  // not that the pass offered the wrong number.
  const lost = runRowGates(row, ctx, 'I am not sure what you want.')
  assert.equal(lost.ok, false)
  assert.equal(lost.ok ? false : lost.unreadable, true)
  assert.match(lost.ok ? '' : lost.reason, /could not read those wordings/)
})

test('A RULE COSTS A WORDING, NEVER THE MENU', () => {
  // Five wordings of which one runs long are four good wordings and a near
  // miss. Refusing the answer would throw the four away to punish the one.
  const ctx = gateCtx({
    sceneName: '', sceneBody: '', sceneLocks: [], lockedTexts: [], literals: [],
    andCap: null, wordCap: 8, destination: [], known: [],
  })
  const row = { gates: ['options-shape', 'sentence-length'], answer: 'options' } as never
  const long = 'A wording that runs on and on and on past the cap the author set.'
  const out = runRowGates(row, ctx, JSON.stringify(['Short one.', long, 'Short two.', 'Short three.']))
  assert.equal(out.ok, true, 'the menu stands')
  assert.deepEqual(JSON.parse(out.ok ? out.body : '[]'), ['Short one.', 'Short two.', 'Short three.'],
    'lighter by the one that broke the rule')
  const record = out.gates.find(g => g.gate === 'sentence-length')!
  assert.equal(record.verdict, 'held', 'the gate did its work and the answer stands')
  assert.equal(record.measured, '1 of 4 dropped', 'and the receipt says how many went')
  assert.deepEqual(record.measured_against, [long], 'and which')
})

test('a menu whose every wording breaks a rule is refused — there is nothing to show', async () => {
  const { outcomeSentence } = await import('../src/run.ts')
  const ctx = gateCtx({
    sceneName: '', sceneBody: '', sceneLocks: [], lockedTexts: [], literals: [],
    andCap: null, wordCap: 3, destination: [], known: [],
  })
  const row = { gates: ['options-shape', 'sentence-length'], answer: 'options' } as never
  const out = runRowGates(row, ctx, JSON.stringify([
    'A wording well over the cap.', 'Another wording over the cap.', 'A third one over the cap.',
  ]))
  assert.equal(out.ok, false)
  assert.match(out.ok ? '' : out.reason, /every wording that pass offered breaks a rule you ratified/)
  // AND THE RECEIPT SAYS THE GATE REFUSED. A drop is not a refusal while
  // anything survives, but when it takes the last wording there is no answer
  // left — and `outcomeSentence` reads the refused record to tell the author
  // WHICH rule cost them the menu, rather than falling back to a sentence
  // that names nothing (A69-10 review).
  const record = out.gates.find(g => g.gate === 'sentence-length')!
  assert.equal(record.verdict, 'refused')
  assert.match(outcomeSentence({ ending: 'refused', gates: out.gates }) ?? '', /sentence/i,
    'the author is told which rule, not just that something went wrong')
})

test('what the author selected never reaches the run\'s gesture', async () => {
  const { resolveRequest } = await import('../src/request.ts')
  // The gesture is copied verbatim into a committed record (A67-4), which
  // holds ids, hashes and links. The words the author highlighted are their
  // book, and they belong in the ask — kept with the run, gitignored.
  for (const kind of ['rephrase', 'synonyms'] as const) {
    const r = resolveRequest({
      said: kind === 'rephrase' ? 'other wordings for the selection' : 'other words for the selection',
      job: kind === 'rephrase' ? 'revise' : 'explore',
      scope: 'selection', mode: 'one-shot',
      ...(kind === 'rephrase' ? { depth: 'quick' as const } : {}),
      subject: 'prose/ch-01/scene-01.md',
    })
    assert.doesNotMatch(r.gesture, /"/, 'nothing quoted from the book')
    assert.match(r.cell, kind === 'rephrase' ? /revise · selection · one-shot · quick/ : /explore · selection · one-shot/)
  }
  // And the words themselves are in the ask, where the pass needs them.
  assert.match(suggestAssignment({ selection: 'the eighty-fourth' }), /the eighty-fourth/)
})

test('an empty selection, and no engine at all, are refused before a run is minted', async () => {
  const { listRuns } = await import('../src/runs.ts')
  const before = listRuns().length
  await assert.rejects(
    () => runSuggest({ kind: 'rephrase', selection: '   ' }),
    (e: unknown) => {
      const err = e as { status?: number; message?: string }
      assert.equal(err.status, 400)
      assert.match(err.message!, /nothing is selected — highlight the words/)
      return true
    })
  // No engine configured is the author's setup, not their selection, and the
  // sentence names the fix. A run and a receipt on disk for a pass that could
  // never have started are a record of nothing (A69-10 review).
  await assert.rejects(
    () => runSuggest({ kind: 'rephrase', selection: 'something' }),
    (e: unknown) => {
      const err = e as { status?: number; message?: string }
      assert.equal(err.status, 503)
      assert.match(err.message!, /log in with {2}claude|ANTHROPIC_API_KEY/)
      return true
    })
  assert.equal(listRuns().length, before, 'and neither opened a run')
})
