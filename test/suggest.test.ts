// The suggest pass: prompt construction and parsing are pure and tested
// here; the engine round-trip is the same seam every other pass uses.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeStory } from './fixture.ts'

process.env.ARC_STORY_PATH = makeStory()
process.env.ARC_DRAFT_ENGINE = 'none'
const { buildSuggestPrompt, parseSuggestions, runSuggest } = await import('../src/suggest.ts')

test('the rephrase prompt carries the style contract, the selection, and the paragraph', () => {
  const p = buildSuggestPrompt({
    kind: 'rephrase',
    selection: 'He was very tired.',
    paragraph: 'The oars were heavy. He was very tired. The coast refused to come closer.',
    style: 'THE NO-COMMENT LAW: never explain a feeling the body can show.',
  })
  assert.match(p, /REPHRASE pass/)
  assert.match(p, /NO-COMMENT LAW/, 'the author\'s own rules are the authority')
  assert.match(p, /He was very tired\./)
  assert.match(p, /The coast refused to come closer\./)
  assert.match(p, /JSON array/)
})

test('the synonym prompt asks for nuance and drop-in replacements', () => {
  const p = buildSuggestPrompt({ kind: 'synonyms', selection: 'walked', style: '(none)' })
  assert.match(p, /SYNONYM pass/)
  assert.match(p, /nuance/)
  assert.match(p, /drop-in/)
})

test('scene context appears when supplied and is absent when not', () => {
  const withCtx = buildSuggestPrompt({ kind: 'rephrase', selection: 'x', style: 's', sceneContext: 'Scene sc.01-1, chapter ch.01.' })
  assert.match(withCtx, /SCENE CONTEXT/)
  const without = buildSuggestPrompt({ kind: 'rephrase', selection: 'x', style: 's' })
  assert.doesNotMatch(without, /SCENE CONTEXT/)
})

test('parseSuggestions handles fences, junk entries, and caps the list', () => {
  assert.deepEqual(parseSuggestions('```json\n["one","two"]\n```'), ['one', 'two'])
  assert.deepEqual(parseSuggestions('Here you go: ["a", "", 3, "b"] hope that helps'), ['a', 'b'])
  assert.equal(parseSuggestions(JSON.stringify(['1', '2', '3', '4', '5', '6', '7', '8'])).length, 6)
  assert.throws(() => parseSuggestions('no array here'), /JSON array/)
  assert.throws(() => parseSuggestions('{"not": "an array"}'), Error)
})

test('no engine → 503; empty selection → 400', async () => {
  await assert.rejects(runSuggest({ kind: 'rephrase', selection: 'something' }), (e: unknown) => (e as { status?: number }).status === 503)
  // selection guard sits behind the engine guard, so it is covered by the
  // route's own 400 — asserted here at the module level for direct callers
  process.env.ARC_DRAFT_ENGINE = 'claude-cli'
  await assert.rejects(runSuggest({ kind: 'rephrase', selection: '   ' }), (e: unknown) => (e as { status?: number }).status === 400)
  process.env.ARC_DRAFT_ENGINE = 'none'
})
