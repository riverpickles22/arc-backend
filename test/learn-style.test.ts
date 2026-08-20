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
  independentExamples, refusalPairs, runLearnStyle, MIN_CHANGED_WORDS, MAX_PROPOSALS_PER_RUN, QUEUE_SUPPRESS_AT,
} = await import('../src/learn-style.ts')
const { parseQueue, renderQueue, ruleId, readQueue, writeQueue, ratifyRule, queuePath, placeRule, appendToQueue, readDismissed } =
  await import('../src/style-queue.ts')
const { recordGenerated, generatedFor } = await import('../src/ledger.ts')
const { readJudgments } = await import('../src/evidence.ts')
const { proseAccept } = await import('../src/story.ts')

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
  assert.deepEqual(out[0], { rule: 'Cut the adverb.', section: 'Diction', layer: null, edits: [1, 2] })
  assert.throws(() => parseProposals('no array here'), /JSON array/)
})

test('evidence is materialized from arc\'s own diff table — model text can never become a quote', () => {
  // Two paragraphs, so the proposal clears the independence bar on its own
  // merits. The property under test is where the QUOTES come from.
  const pairs = editPairs(
    'He was very tired indeed.\n\nThe coast was extremely far away.',
    'His arms had quit arguing.\n\nThe coast stayed where it was.',
    'sc.01-1')
  const proposals = parseProposals(JSON.stringify([
    // A model trying to supply its own quote: the extra field is simply not read.
    { rule: 'Show fatigue in the body.', section: 'Diction', edits: [1, 2], quote: 'A QUOTE ARC NEVER WROTE' },
  ]))
  const out = materialize(proposals, pairs, '2026-08-13T00:00:00Z')
  assert.equal(out.length, 1)
  assert.equal(out[0].evidence[0].wrote, 'He was very tired indeed.')
  assert.equal(out[0].evidence[0].kept, 'His arms had quit arguing.')
  assert.equal(JSON.stringify(out).includes('ARC NEVER WROTE'), false)
})

test('one example is never a rule, however many times the same paragraph is worked', () => {
  const oneParagraph = editPairs('He was very tired indeed.', 'His arms had quit arguing.', 'sc.01-1')
  assert.equal(
    materialize([{ rule: 'From a single edit.', section: null, layer: null, edits: [1] }], oneParagraph, 'now').length,
    0, 'a lone edit argues nothing')

  // The same paragraph cited twice is still one place in the manuscript.
  const twice = [...oneParagraph, { ...oneParagraph[0], n: 2 }]
  assert.equal(independentExamples(twice), 1, 'two passes at one paragraph is one example')
  assert.equal(
    materialize([{ rule: 'From one paragraph, twice.', section: null, layer: null, edits: [1, 2] }], twice, 'now').length,
    0, 'and one example is still not a rule')
})

test('a proposal citing no real edit number is dropped, and the cap holds', () => {
  const pairs = editPairs('a b c d e f g\n\no p q r s t u', 'h i j k l m n\n\nv w x y z aa bb', 'sc.01-1')
  assert.equal(materialize([{ rule: 'Groundless.', section: null, layer: null, edits: [99] }], pairs, 'now').length, 0)
  assert.equal(materialize([{ rule: 'Groundless.', section: null, layer: null, edits: [] }], pairs, 'now').length, 0)

  const many = Array.from({ length: 8 }, (_, i) => ({ rule: `Rule ${i}.`, section: null, layer: null, edits: [1, 2] }))
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

// ---- learning from the author's own revisions (A27) ----------------------
// The other half of the loop: no arc draft anywhere — the author rewrote
// their own accepted prose, and the diff against HEAD^ is the signal.

test('a revision pair carries its source; the default stays draft', () => {
  const had = 'He was very tired after the long night.\n\nSecond paragraph.'
  const revised = 'His arms had stopped arguing with the oars.\n\nSecond paragraph.'
  const rev = editPairs(had, revised, 'sc.02-1', 'revision')
  assert.equal(rev.length, 1)
  assert.equal(rev[0].source, 'revision')
  assert.equal(editPairs(had, revised, 'sc.02-1')[0].source, 'draft')
})

test('the prompt frames revisions as the author against themself', () => {
  const pairs = [
    ...editPairs('Arc wrote something quite bad here.', 'The author kept something better instead.', 'sc.01-1'),
    ...editPairs('The author had written this sentence once.', 'The author then rewrote the whole thing differently.', 'sc.02-1', 'revision'),
  ].map((p, i) => ({ ...p, n: i + 1 }))
  const prompt = buildLearnPrompt({ pairs, style: '(none)', pending: [] })
  assert.match(prompt, /ARC WROTE: Arc wrote something quite bad here\./)
  assert.match(prompt, /AUTHOR HAD: The author had written this sentence once\./)
  assert.match(prompt, /REVISED TO: The author then rewrote/)
})

test('a rule is revision-sourced only when every cited edit is', () => {
  const pairs = [
    ...editPairs('Draft paragraph arc wrote at first.\n\nA second draft paragraph arc wrote.',
      'Draft paragraph the author kept instead.\n\nA second paragraph the author kept.', 'sc.01-1'),
    ...editPairs('Revision the author had accepted before.\n\nAnother the author had accepted.',
      'Revision the author rewrote by their own hand.\n\nAnother they rewrote themselves.', 'sc.02-1', 'revision'),
  ].map((p, i) => ({ ...p, n: i + 1 }))
  const [pure] = materialize([{ rule: 'From the revisions alone.', section: null, layer: null, edits: [3, 4] }], pairs, 'now')
  const [mixed] = materialize([{ rule: 'From both kinds of edit.', section: null, layer: null, edits: [1, 3] }], pairs, 'now')
  assert.equal(pure.source, 'revision')
  assert.equal(mixed.source, 'draft')
})

test('the author layer has to be earned across scenes, not asserted', () => {
  const oneScene = editPairs(
    'A paragraph arc wrote.\n\nAnother paragraph arc wrote.',
    'What the author put instead.\n\nWhat they put here instead.', 'sc.01-1')
  const [refiled] = materialize(
    [{ rule: 'Claims to be about the writer.', section: null, layer: 'author', edits: [1, 2] }], oneScene, 'now')
  assert.equal(refiled.layer, 'story', 'two paragraphs of one scene argue about this book')

  const twoScenes = [
    ...editPairs('A paragraph arc wrote.', 'What the author put instead.', 'sc.01-1'),
    ...editPairs('A paragraph arc wrote elsewhere.', 'What the author put there.', 'sc.02-1'),
  ].map((p, i) => ({ ...p, n: i + 1 }))
  const [earned] = materialize(
    [{ rule: 'Holds across the book.', section: null, layer: 'author', edits: [1, 2] }], twoScenes, 'now')
  assert.equal(earned.layer, 'author')

  // And arc recommending nothing is a story rule, never a promotion.
  const [quiet] = materialize(
    [{ rule: 'No recommendation given.', section: null, layer: null, edits: [1, 2] }], twoScenes, 'now')
  assert.equal(quiet.layer, 'story')
})

test('source survives the queue file, and its evidence reads as the author against themself', () => {
  writeQueue([])
  const rule = {
    id: ruleId('Cut throat-clearing openings.'), rule: 'Cut throat-clearing openings.', section: 'Sentences',
    at: 'now', evidence: [{ scene: 'sc.02-1', wrote: 'It was then that he saw it.', kept: 'He saw it.' }],
    source: 'revision' as const,
  }
  writeQueue([rule])
  const text = fs.readFileSync(queuePath(), 'utf8')
  assert.match(text, /you had: "It was then that he saw it\."/)
  assert.match(text, /you revised to: "He saw it\."/)
  assert.doesNotMatch(text, /arc wrote:/, 'revision evidence never claims arc wrote the sentence')
  assert.equal(readQueue()[0].source, 'revision')
  // an entry without the field (written before it existed) still parses, as draft
  const legacy = [{ ...rule, id: 'p-legacy' }].map(r => { const { source, ...rest } = r; void source; return rest })
  writeQueue(legacy as never)
  assert.equal(readQueue()[0].source, undefined)
})

test('a hand revision to accepted prose reaches the model gate; new hand-written prose never does', async () => {
  writeQueue([])
  // A fresh scene accepted, then revised by hand and accepted again — both
  // accepts through the verb the app actually calls, because the boundary the
  // pass reads is recorded at the accept. Committing round it with raw git
  // would test a path no author can reach.
  const rel = 'prose/ch-02/scene-01.md'
  writeScene(STORY, rel, 'sc.02-1', 'It was then that he saw the coast, at long last, finally.\n\nStable paragraph.')
  proseAccept('prose: accept sc.02-1')
  writeScene(STORY, rel, 'sc.02-1', 'He saw the coast.\n\nStable paragraph.')
  proseAccept('prose: accept revision')
  const r = await runLearnStyle([rel])
  assert.equal(r.skipped, 'no-engine', 'revision pairs were mined — only the engine was missing')
  assert.ok(r.pairsConsidered >= 1, 'the hand revision produced at least one significant pair')
  // a scene born in this commit has no before, argues nothing, costs nothing
  const fresh = 'prose/ch-03/scene-01.md'
  writeScene(STORY, fresh, 'sc.03-1', 'Entirely new prose the author wrote themselves.')
  proseAccept('prose: accept new scene')
  const r2 = await runLearnStyle([fresh])
  assert.equal(r2.skipped, 'no-edits')
  assert.equal(r2.pairsConsidered, 0)
})

test('the layer recommendation survives the queue, and decides nothing', () => {
  writeQueue([])
  const withLayer = {
    id: ruleId('A habit across books.'), rule: 'A habit across books.', section: 'Sentences',
    at: '2026-08-20T00:00:00Z', source: 'revision' as const, layer: 'author' as const,
    evidence: [{ scene: 'sc.01-1', wrote: 'x', kept: 'y' }],
  }
  // No source and no layer: 'draft' is the absent default, and a queue
  // written before either field existed must round-trip untouched.
  const without = {
    id: ruleId('A rule with no recommendation.'), rule: 'A rule with no recommendation.', section: null,
    at: '2026-08-20T00:00:00Z',
    evidence: [{ scene: 'sc.01-1', wrote: 'x', kept: 'y' }],
  }
  writeQueue([withLayer, without])
  // Identity both ways: a queue written without a layer must not grow one.
  assert.deepEqual(readQueue(), [withLayer, without])

  // And the recommendation is not the decision. arc says author; the click
  // says story; the story file is what gets written.
  const layers: Record<string, string> = {}
  ratifyRule(withLayer.id, 'ratify', 'story', l => {
    layers[l] = path.join(STORY, l === 'author' ? 'author-style.md' : 'docs/style.md')
    return layers[l]
  })
  assert.ok(fs.existsSync(path.join(STORY, 'docs/style.md')), "the author's click chose the file")
  assert.equal(fs.existsSync(path.join(STORY, 'author-style.md')), false,
    "arc's recommendation did not write anywhere on its own")
  writeQueue([])
})

test('a refusal reads as a refusal in the queue, not as something the author kept', () => {
  writeQueue([])
  const refused = {
    id: ruleId('Do not open on the weather.'), rule: 'Do not open on the weather.', section: null,
    at: '2026-08-20T00:00:00Z', source: 'refusal' as const, layer: 'story' as const,
    evidence: [{ scene: 'sc.01-1', wrote: 'The wind had turned in the night.', kept: 'The lamp had been lit for an hour.' }],
  }
  writeQueue([refused])
  const rendered = fs.readFileSync(queuePath(), 'utf8')
  assert.match(rendered, /you refused it, keeping/, 'the author declined this — saying "you kept" would claim the opposite')
  assert.deepEqual(readQueue(), [refused], 'and it round-trips')
  writeQueue([])
})

test('a refusal argues once, and only when it is about the writing', async () => {
  const { recordJudgment } = await import('../src/evidence.ts')
  const rel = 'prose/ch-04/scene-01.md'
  const judgment = (arcWrote: string, authorKept: string, paragraph: number) => ({
    file: rel, scene: 'sc.04-1', granularity: 'paragraph' as const, paragraph,
    verdict: 'rejected' as const, arcWrote, authorKept, origin: 'revise', baseline: null,
  })
  recordJudgment(judgment('He gazed out, wondering nervously what would come.', 'He watched the road.', 0))
  recordJudgment(judgment('She had always known, somehow, that it would end here.', 'She knew the place.', 1))
  // Nothing on arc's side is the author editing themselves, not a refusal of arc.
  recordJudgment(judgment('', 'Their own words entirely.', 2))
  // And a refusal that changed nothing argues nothing.
  recordJudgment(judgment('Identical text.', 'Identical text.', 3))

  const pairs = refusalPairs([rel], '')
  assert.equal(pairs.length, 2, 'only the two that pit arc against the author')
  assert.equal(pairs[0].source, 'refusal')
  assert.deepEqual(pairs.map(p => p.paragraph), [0, 1], 'each carries where it happened')
  assert.equal(refusalPairs(['prose/elsewhere.md'], '').length, 0, 'and only for the files asked about')

  // The watermark is what stops a refusal arguing again at every later accept.
  const after = readJudgments().filter(j => j.file === rel).at(-1)!.at
  assert.equal(refusalPairs([rel], after).length, 0)
})

test('the prompt shows a refusal as a refusal', () => {
  const pairs = [{
    n: 1, scene: 'sc.01-1', paragraph: 0, source: 'refusal' as const,
    wrote: 'The wind had turned in the night.', kept: 'The lamp had been lit for an hour.', changed: 8,
  }]
  const prompt = buildLearnPrompt({ pairs, style: '(contract)', pending: [] })
  assert.match(prompt, /ARC WROTE: The wind had turned/)
  assert.match(prompt, /AUTHOR REFUSED, KEEPING: The lamp had been lit/)
  assert.match(prompt, /TWO OR MORE INDEPENDENT/, 'and the bar is stated, not implied')
  assert.equal(/or\s+when one edit shows it unmistakably/.test(prompt), false,
    'the single-edit escape hatch is gone')
})

test('a rule with more evidence than the card shows is not punished for it', () => {
  // Four paragraphs cited; the card shows three. The bar is counted on what
  // was cited, before the trim — gating on the trimmed list would fail a rule
  // for being TOO well evidenced, which is exactly backwards.
  const pairs = editPairs(
    'One as arc wrote it.\n\nTwo as arc wrote it.\n\nThree as arc wrote it.\n\nFour as arc wrote it.',
    'One as the author has it.\n\nTwo as the author has it.\n\nThree as the author has it.\n\nFour as the author has it.',
    'sc.01-1')
  assert.equal(pairs.length, 4)
  const [out] = materialize([{ rule: 'Well evidenced.', section: null, layer: null, edits: [1, 2, 3, 4] }], pairs, 'now')
  assert.ok(out, 'four independent examples clear a bar of two')
  assert.equal(out.evidence.length, 3, 'and the card still shows three')
})

test('a ratified rule joins a numbered section instead of opening a second one', () => {
  // The real contract's headings, verbatim. An exact-title match found none
  // of them, so every ratification into this book appended a duplicate.
  const contract = [
    '# The Feral Dogs of Cuba — Prose Style Guide',
    '',
    '## 3. Rhythm',
    '',
    '- **Em dashes are a last resort.**',
    '',
    '## 4. Diction',
    '',
    '- Plain words.',
    '',
  ].join('\n')
  const rule = {
    id: 'p-1', rule: 'Two in a paragraph is a smell.', section: '3. Rhythm',
    at: 'now', evidence: [],
  }
  const out = placeRule(contract, rule)
  assert.equal(out.match(/^## 3\. Rhythm/gm)?.length, 1, 'one Rhythm section, not two')
  assert.equal(out.match(/^## /gm)?.length, 2, 'and no new heading anywhere')
  const rhythm = out.slice(out.indexOf('## 3. Rhythm'), out.indexOf('## 4. Diction'))
  assert.match(rhythm, /Two in a paragraph is a smell\./, 'the rule landed inside it')
  assert.match(rhythm, /Em dashes are a last resort/, 'beside what was already there')

  // Bare and numbered names each other: the number is ordering, not identity.
  assert.match(placeRule(contract, { ...rule, section: 'Rhythm' }), /## 3\. Rhythm/)
  assert.equal(placeRule(contract, { ...rule, section: 'Rhythm' }).match(/^## /gm)?.length, 2)
})

test('a dismissed rule does not come back', () => {
  writeQueue([])
  const rule = {
    id: ruleId('Never open on the weather.'), rule: 'Never open on the weather.',
    section: null, at: 'now', evidence: [{ scene: 'sc.01-1', wrote: 'x', kept: 'y' }],
  }
  appendToQueue([rule])
  assert.equal(readQueue().length, 1)

  ratifyRule(rule.id, 'dismiss', 'story', () => path.join(STORY, 'docs/style.md'))
  assert.equal(readQueue().length, 0, 'it leaves the queue')
  assert.ok(readDismissed().some(d => d.id === rule.id), 'and is remembered')

  // The next pass argues the identical rule: ruleId is a hash of the text, so
  // it arrives with the same id it was refused under.
  const { added } = appendToQueue([{ ...rule, at: 'later' }])
  assert.deepEqual(added, [], 'and is not filed again')
  assert.equal(readQueue().length, 0, 'the author is not asked twice')

  // The text is kept, not only the hash — someone reading the file should be
  // able to see what they turned down.
  assert.match(fs.readFileSync(path.join(STORY, 'docs/style.dismissed.md'), 'utf8'), /Never open on the weather\./)

  fs.rmSync(path.join(STORY, 'docs/style.dismissed.md'))
  writeQueue([])
})
