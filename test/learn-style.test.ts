// The style learning pass. The diff arithmetic and the evidence-materializing
// step are pure and tested here; the engine round-trip is the same seam every
// other pass uses. The tests that matter most are the ones that pin the
// safety properties: zero tokens when there is nothing to learn, and evidence
// that can only come from arc's own diff table.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { makeStory, writeScene } from './fixture.ts'

const STORY = makeStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

const {
  editPairs, changedWords, significant, buildLearnPrompt, parseProposals, materialize,
  runLearnStyle, MIN_CHANGED_WORDS, MAX_PROPOSALS_PER_RUN, QUEUE_SUPPRESS_AT,
} = await import('../src/learn-style.ts')
const { parseQueue, renderQueue, ruleId, readQueue, writeQueue, ratifyRule, queuePath, placeRule } =
  await import('../src/style-queue.ts')
const { recordGenerated, generatedFor } = await import('../src/ledger.ts')

// ---- the diff arithmetic -------------------------------------------------

test('an unedited scene produces no pairs at all', () => {
  const text = 'One paragraph.\n\nAnd another one here.'
  assert.deepEqual(editPairs(text, text, 'sc.01-1'), [])
})

test('a rewritten paragraph pairs against the paragraph it replaced', () => {
  const wrote = 'He was very tired.\n\nThe coast refused to come closer.'
  const kept = 'His arms had stopped arguing with the oars.\n\nThe coast refused to come closer.'
  const pairs = editPairs(wrote, kept, 'sc.01-1')
  assert.equal(pairs.length, 1, 'only the changed paragraph is a pair')
  assert.equal(pairs[0].n, 1)
  assert.equal(pairs[0].wrote, 'He was very tired.')
  assert.equal(pairs[0].kept, 'His arms had stopped arguing with the oars.')
  assert.equal(pairs[0].scene, 'sc.01-1')
})

test('a cut paragraph is a pair with an empty kept side; a purely added one is not', () => {
  const wrote = 'Keep me.\n\nArc wrote this whole thing and it was cut.'
  const kept = 'Keep me.\n\nThe author added this instead, entirely their own.'
  const pairs = editPairs(wrote, kept, 'sc.01-1')
  assert.equal(pairs.length, 1)
  assert.equal(pairs[0].kept, 'The author added this instead, entirely their own.')

  // Nothing on arc's side to compare against → no pair, no rule.
  const added = editPairs('Keep me.', 'Keep me.\n\nA brand new paragraph the author wrote.', 'sc.01-1')
  assert.deepEqual(added, [], 'an addition cannot support a rule about how arc writes')

  const cut = editPairs('Keep me.\n\nArc wrote this and it died.', 'Keep me.', 'sc.01-1')
  assert.equal(cut.length, 1)
  assert.equal(cut[0].kept, '', 'a cut is a pair with an empty kept side')
})

test('changedWords counts word-level edits, not characters', () => {
  assert.equal(changedWords('the same words', 'the same words'), 0)
  assert.equal(changedWords('he was very tired', 'he was tired'), 1)
  assert.equal(changedWords('', 'three whole words here'), 4)
  assert.equal(changedWords('a b c', ''), 3)
})

test('the minimum-changed-word bar filters typo fixes out before the model', () => {
  const pairs = editPairs(
    'The boat was gray and slow.\n\nHe rowed for a long while, and the light did not change at all.',
    'The boat was grey and slow.\n\nHe rowed. The light did not change.',
    'sc.01-1',
  )
  assert.equal(pairs.length, 2, 'both paragraphs differ')
  const kept = significant(pairs)
  assert.equal(kept.length, 1, 'the one-word spelling fix is below the bar')
  assert.match(kept[0].wrote, /rowed for a long while/)
  assert.ok(kept[0].changed >= MIN_CHANGED_WORDS)
})

// ---- the prompt ----------------------------------------------------------

test('the prompt numbers the pairs, carries the contract, and forbids quoting', () => {
  const pairs = editPairs('He was very tired indeed today.', 'His arms had quit.', 'sc.01-1')
  const p = buildLearnPrompt({ pairs, style: 'THE NO-COMMENT LAW: never explain a feeling.', pending: ['Never open on weather.'] })
  assert.match(p, /--- EDIT 1 \(sc\.01-1\) ---/)
  assert.match(p, /ARC WROTE: He was very tired indeed today\./)
  assert.match(p, /AUTHOR KEPT: His arms had quit\./)
  assert.match(p, /NO-COMMENT LAW/, "the existing contract is present so rules aren't re-proposed")
  assert.match(p, /Never open on weather\./, 'the pending queue is present for the same reason')
  assert.match(p, /Cite edit NUMBERS only/)
  assert.match(p, /Do NOT quote the prose/)
})

test('an empty pending queue leaves that block out entirely', () => {
  const p = buildLearnPrompt({ pairs: editPairs('a b c d e', 'f g h i j', 'sc.01-1'), style: 's', pending: [] })
  assert.doesNotMatch(p, /ALREADY PENDING/)
})

test('a cut paragraph is labelled, not shown as an empty line', () => {
  const p = buildLearnPrompt({ pairs: editPairs('Arc wrote this and it died here.', '', 'sc.01-1'), style: 's', pending: [] })
  assert.match(p, /AUTHOR KEPT: \(cut entirely\)/)
})

// ---- parsing and the trust property --------------------------------------

test('parseProposals strips fences and drops entries with no rule text', () => {
  const out = parseProposals('```json\n[{"rule":"Cut the adverb.","section":"Diction","edits":[1,2]},{"section":"x","edits":[3]},{"rule":"   "}]\n```')
  assert.equal(out.length, 1)
  assert.deepEqual(out[0], { rule: 'Cut the adverb.', section: 'Diction', edits: [1, 2] })
  assert.throws(() => parseProposals('no array here'), /JSON array/)
})

test('evidence is materialized from arc\'s own diff table — model text can never become a quote', () => {
  const pairs = editPairs('He was very tired indeed.', 'His arms had quit arguing.', 'sc.01-1')
  const proposals = parseProposals(JSON.stringify([
    // A model trying to supply its own quote: the extra field is simply not read.
    { rule: 'Show fatigue in the body.', section: 'Diction', edits: [1], quote: 'A QUOTE ARC NEVER WROTE' },
  ]))
  const out = materialize(proposals, pairs, '2026-08-13T00:00:00Z')
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].evidence, [{ scene: 'sc.01-1', wrote: 'He was very tired indeed.', kept: 'His arms had quit arguing.' }])
  assert.equal(JSON.stringify(out).includes('ARC NEVER WROTE'), false)
})

test('a proposal citing no real edit number is dropped, and the cap holds', () => {
  const pairs = editPairs('a b c d e f g', 'h i j k l m n', 'sc.01-1')
  assert.equal(materialize([{ rule: 'Groundless.', section: null, edits: [99] }], pairs, 'now').length, 0)
  assert.equal(materialize([{ rule: 'Groundless.', section: null, edits: [] }], pairs, 'now').length, 0)

  const many = Array.from({ length: 8 }, (_, i) => ({ rule: `Rule ${i}.`, section: null, edits: [1] }))
  assert.equal(materialize(many, pairs, 'now').length, MAX_PROPOSALS_PER_RUN)
})

// ---- the queue file ------------------------------------------------------

test('the queue round-trips through its markdown file', () => {
  const rules = [
    { id: ruleId('Cut the adverb.'), rule: 'Cut the adverb.', section: 'Diction', at: '2026-08-13T00:00:00Z', evidence: [{ scene: 'sc.01-1', wrote: 'He ran quickly.', kept: 'He ran.' }] },
    { id: ruleId('No weather openings.'), rule: 'No weather openings.', section: null, at: '2026-08-13T00:00:00Z', evidence: [] },
  ]
  const text = renderQueue(rules)
  assert.deepEqual(parseQueue(text), rules)
  assert.match(text, /Nothing here binds anything/, 'the file says out loud that it binds nothing')
  assert.match(text, /### Diction/, 'and reads sensibly in a plain editor')
  assert.deepEqual(parseQueue(renderQueue([])), [])
})

test('a mangled entry is skipped, never fatal — the Style page must still load', () => {
  const good = renderQueue([{ id: 'p-1', rule: 'Good rule.', section: null, at: '', evidence: [] }])
  assert.equal(parseQueue(`<!-- arc:proposed {not json} -->\n\n${good}`).length, 1)
})

test('the same rule text is the same id, so a re-argued rule collapses instead of stacking', () => {
  assert.equal(ruleId('Cut the adverb.'), ruleId('  cut the adverb.  '))
  assert.notEqual(ruleId('Cut the adverb.'), ruleId('Keep the adverb.'))
})

// ---- the pass, end to end ------------------------------------------------

const SCENE = 'prose/ch-01/scene-01.md'
const scenePath = path.join(STORY, SCENE)

test('a scene with no ledger entry never reaches the model — zero tokens', async () => {
  writeQueue([])
  const r = await runLearnStyle([SCENE])
  assert.equal(r.skipped, 'no-edits')
  assert.equal(r.pairsConsidered, 0)
  assert.deepEqual(r.added, [])
})

test('a scene accepted unedited never reaches the model either', async () => {
  writeQueue([])
  const onDisk = fs.readFileSync(scenePath, 'utf8')
  recordGenerated(SCENE, onDisk, { engine: 'sdk' })
  assert.ok(generatedFor(SCENE), 'the ledger has it')

  const r = await runLearnStyle([SCENE])
  assert.equal(r.skipped, 'no-edits', 'identical text yields no pairs, so no engine is consulted')
  assert.equal(generatedFor(SCENE), null, 'and the ledger entry is consumed either way')
})

test('a full queue suppresses the pass entirely rather than growing homework', async () => {
  writeQueue(Array.from({ length: QUEUE_SUPPRESS_AT }, (_, i) => ({
    id: `p-full-${i}`, rule: `Pending rule ${i}.`, section: null, at: '', evidence: [],
  })))
  recordGenerated(SCENE, '---\nscene: sc.01-1\n---\n\nSomething arc wrote that differs a great deal.', {})
  const r = await runLearnStyle([SCENE])
  assert.equal(r.skipped, 'queue-full')
  assert.equal(generatedFor(SCENE)?.entry.file, SCENE, 'and the ledger is left alone for a later run')
})

test('the pass writes only the queue — the rest of the story tree is byte-identical', async () => {
  writeQueue([])
  const snapshot = execFileSync('git', ['-C', STORY, 'ls-files'], { encoding: 'utf8' })
    .split('\n').filter(Boolean)
    .map(f => [f, fs.readFileSync(path.join(STORY, f), 'utf8')] as const)

  writeScene(STORY, SCENE, 'sc.01-1', 'His arms had stopped arguing with the oars.\n\nSecond paragraph.')
  recordGenerated(SCENE, '---\nscene: sc.01-1\n---\n\nHe was very tired and could not go on much longer.\n\nSecond paragraph.', {})

  // Engine is 'none', so the pass gets as far as building the prompt and stops.
  const r = await runLearnStyle([SCENE])
  assert.equal(r.skipped, 'no-engine')
  assert.equal(r.pairsConsidered, 1, 'it did find the edit — it just had nothing to ask')

  for (const [f, before] of snapshot) {
    if (f === SCENE) continue // the test itself rewrote this one
    assert.equal(fs.readFileSync(path.join(STORY, f), 'utf8'), before, `${f} was touched by the learning pass`)
  }
  assert.equal(fs.existsSync(path.join(STORY, 'docs', 'style.md')), false, 'the contract itself is never written by this pass')
})

// ---- ratification (A7-7's deterministic half) ----------------------------

const layerPathFor = () => path.join(STORY, 'docs', 'style.md')

test('ratify appends the rule to the layer and drops it from the queue', () => {
  writeQueue([
    { id: 'p-keep', rule: 'Keep this one pending.', section: null, at: '', evidence: [] },
    { id: 'p-take', rule: 'Cut the adverb; let the verb carry it.', section: 'Diction', at: '', evidence: [{ scene: 'sc.01-1', wrote: 'a', kept: 'b' }] },
  ])
  fs.mkdirSync(path.join(STORY, 'docs'), { recursive: true })
  fs.writeFileSync(layerPathFor(), '# Style\n\nExisting rule.\n')

  const out = ratifyRule('p-take', 'ratify', 'story', layerPathFor)
  assert.equal(out.path, layerPathFor())

  const contract = fs.readFileSync(layerPathFor(), 'utf8')
  assert.match(contract, /Existing rule\./, 'the contract is appended to, never rewritten')
  assert.match(contract, /## Diction/)
  assert.match(contract, /Cut the adverb; let the verb carry it\./)
  assert.doesNotMatch(contract, /sc\.01-1/, 'evidence does not follow a rule into the contract')

  assert.deepEqual(readQueue().map(r => r.id), ['p-keep'])
})

test('a second rule in the same section joins it instead of opening a duplicate heading', () => {
  const start = '# Style\n\n## Rhythm\n\nDanger is short.\n\n## Diction\n\nNo anachronism.\n'
  const once = placeRule(start, { id: 'a', rule: 'Slow time is long.', section: 'Rhythm', at: '', evidence: [] })
  const twice = placeRule(once, { id: 'b', rule: 'Let the full stop be the beat.', section: 'Rhythm', at: '', evidence: [] })

  assert.equal(twice.match(/^## Rhythm$/gm)?.length, 1, 'one Rhythm heading, not three')
  const rhythm = twice.slice(twice.indexOf('## Rhythm'), twice.indexOf('## Diction'))
  assert.match(rhythm, /Danger is short\./)
  assert.match(rhythm, /Slow time is long\./)
  assert.match(rhythm, /Let the full stop be the beat\./)
  assert.match(twice, /## Diction\n\nNo anachronism\./, 'later sections are undisturbed')
})

test('a rule for a section the contract lacks opens that section at the end', () => {
  const out = placeRule('# Style\n\n## Rhythm\n\nDanger is short.\n', { id: 'a', rule: 'Cut the filter verb.', section: 'Sentences', at: '', evidence: [] })
  assert.match(out, /## Rhythm\n\nDanger is short\.\n\n## Sentences\n\nCut the filter verb\.\n$/)

  // A sectionless rule simply lands at the end, and an empty contract works.
  assert.match(placeRule('', { id: 'b', rule: 'Just a rule.', section: null, at: '', evidence: [] }), /Just a rule\./)
  assert.match(placeRule('# Style\n', { id: 'c', rule: 'Another.', section: null, at: '', evidence: [] }), /# Style\n\nAnother\.\n$/)
})

test('a section is closed by a same-or-higher heading, so sub-headings keep their rules', () => {
  const start = '## Rhythm\n\nDanger is short.\n\n### Dialogue\n\nBeats, not adverbs.\n\n## Diction\n\nNo anachronism.\n'
  const out = placeRule(start, { id: 'a', rule: 'Slow time is long.', section: 'Rhythm', at: '', evidence: [] })
  const rhythm = out.slice(out.indexOf('## Rhythm'), out.indexOf('## Diction'))
  assert.match(rhythm, /### Dialogue/, 'the sub-heading stays inside Rhythm')
  assert.ok(rhythm.indexOf('Beats, not adverbs.') < rhythm.indexOf('Slow time is long.'), 'the new rule lands at the section end')
})

test('dismiss removes the rule and touches no layer file', () => {
  writeQueue([{ id: 'p-no', rule: 'Wrong about the voice.', section: null, at: '', evidence: [] }])
  const before = fs.readFileSync(layerPathFor(), 'utf8')
  const out = ratifyRule('p-no', 'dismiss', 'story', layerPathFor)
  assert.equal(out.path, null)
  assert.equal(fs.readFileSync(layerPathFor(), 'utf8'), before)
  assert.deepEqual(readQueue(), [])
})

test('an unknown id is a 404, not a silent no-op', () => {
  assert.throws(() => ratifyRule('p-nope', 'ratify', 'story', layerPathFor), (e: unknown) => (e as { status?: number }).status === 404)
})

test('a ratified rule reaches the next drafting pass; a pending one never does', async () => {
  writeQueue([{ id: 'p-pending', rule: 'A PENDING RULE THAT MUST NOT BIND.', section: null, at: '', evidence: [] }])
  fs.writeFileSync(layerPathFor(), '# Style\n\nA RATIFIED RULE THAT MUST BIND.\n')
  const { styleContract } = await import('../src/style.ts')
  const contract = styleContract()
  assert.match(contract, /A RATIFIED RULE THAT MUST BIND\./)
  assert.doesNotMatch(contract, /MUST NOT BIND/, 'the queue is not part of the contract, by construction')
  assert.ok(fs.existsSync(queuePath()), 'the queue file exists and is simply never read into a prompt')
})
