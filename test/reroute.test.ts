// The reroute pass: another way to the same destination. The engine never
// runs here — the properties under test hold whatever a model answers: the
// prose never enters the prompt, only author authority binds, the gates are
// deterministic, and the refusals name their reason.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { git, makeStory, writeScene } from './fixture.ts'

const story = makeStory()
process.env.ARC_STORY_PATH = story
process.env.ARC_DRAFT_ENGINE = 'none'
const {
  authority, sceneKeypoints, buildDestination, buildKnownRoute, inferredRoute, buildReroutePrompt, flattenPrompt,
  parseCoverageTail, lexicalOverlap, lockOrderViolation, wordSurvival, stripSceneTouchstones, mergeCoverage, andCapFromContract, andChainViolations, wordCapFromContract, longSentenceViolations, runReroute, SEEDS,
} = await import('../src/reroute.ts')
const { HttpError } = await import('../src/http.ts')

const reset = () => { git(story, 'checkout', 'HEAD', '--', '.'); git(story, 'clean', '-fdq') }

const SCENE = {
  scene: 'sc.01-1', chapter: 'ch.01', status: 'proposed', pov: 'char.carlos', events: ['event.the-lie'], facts: [],
  contract: { purpose: 'Carlos learns Manuel lied, without anyone saying so.', must_establish: ['Carlos realizes Manuel lied.', 'The photograph changes hands.'], must_withhold: ['"Trinidad"'], motifs: ['salt'] },
  file: 'prose/ch-01/scene-01.md',
  body: 'The zinc counter sweated under his palms while Manuel talked about the weather.\n\nA photograph lay between the glasses, face down, and neither of them touched it.\n\nWhen the lie came it came easily, the way a coin comes out of a pocket.',
}
const ann = (over: Record<string, unknown>) => ({
  id: 'note.1', anchor: { scene: 'sc.01-1', paragraph: 0, quote: 'q' }, body: 'the point', kind: 'keypoint',
  resolution: { state: 'resolved', paragraph: 0 }, ...over,
}) as unknown as import('arc-canon-graph').ResolvedAnnotation

// ---- authority: by is provenance, confirmation is a second fact ----------

test('only author authority binds: by author, or arc confirmed by the author', () => {
  assert.equal(authority({}), 'author')
  assert.equal(authority({ by: 'author' }), 'author')
  assert.equal(authority({ by: 'agent' }), 'agent')
  assert.equal(authority({ by: 'agent', confirmed_by: 'author' }), 'author')
})

test('scene key points split by authority, in paragraph order, resolved only', () => {
  const kps = sceneKeypoints('sc.01-1', [
    ann({ id: 'note.3', body: 'the lie lands', resolution: { state: 'resolved', paragraph: 2 } }),
    ann({ id: 'note.1', body: 'the counter', resolution: { state: 'drifted', paragraph: 0 } }),
    ann({ id: 'note.2', body: "arc's guess", by: 'agent', resolution: { state: 'resolved', paragraph: 1 } }),
    ann({ id: 'note.4', body: 'gone', resolution: { state: 'orphaned', paragraph: null } }),
    ann({ id: 'note.5', body: 'a note, not a beat', kind: 'note', resolution: { state: 'resolved', paragraph: 1 } }),
    ann({ id: 'note.6', body: 'elsewhere', anchor: { scene: 'sc.01-2', paragraph: 0 }, resolution: { state: 'resolved', paragraph: 0 } }),
  ])
  assert.deepEqual(kps.author.map(b => [b.paragraph, b.body]), [[0, 'the counter'], [2, 'the lie lands']])
  assert.deepEqual(kps.agent.map(b => b.body), ["arc's guess"])
})

// ---- destination and route: three objects, two binding -------------------

test('the destination is the contract plus the author beats, never arc\'s own', () => {
  const d = buildDestination(SCENE.contract, [{ paragraph: 2, body: 'the lie lands' }, { paragraph: 0, body: 'Carlos realizes Manuel lied.' }])
  assert.deepEqual(d, ['Carlos realizes Manuel lied.', 'The photograph changes hands.', 'the lie lands'])
  assert.deepEqual(buildDestination(null, []), [])
  assert.deepEqual(buildDestination({ purpose: 'only a purpose' }, []), [])
})

test('the known route names beat order, opening, closing and locks — and nothing it would have to interpret', () => {
  const r = buildKnownRoute([{ paragraph: 0, body: 'the counter' }, { paragraph: 2, body: 'the lie lands' }], [{ paragraph: 1, text: 'A photograph lay between the glasses.' }])
  assert.match(r, /¶1 — the counter/)
  assert.match(r, /opens on: the counter \(¶1\)/)
  assert.match(r, /closes on: the lie lands \(¶3\)/)
  assert.match(r, /Locked passages sit at ¶2/)
  assert.doesNotMatch(r, /event\./)
  const bare = buildKnownRoute([], [])
  assert.match(bare, /contract alone is the destination/)
  assert.equal(inferredRoute([]), '')
  assert.match(inferredRoute([{ paragraph: 1, body: "arc's guess" }]), /context only — it binds nothing/)
})

test('the prompt never carries the current prose, and keeps the three objects apart', () => {
  const p = buildReroutePrompt({
    scene: SCENE, pack: 'PACK', style: 'STYLE', siblings: '', notes: [],
    destination: ['Carlos realizes Manuel lied.', 'The photograph changes hands.'],
    knownRoute: buildKnownRoute([{ paragraph: 0, body: 'the counter' }], []),
    inferred: inferredRoute([{ paragraph: 1, body: "arc's guess" }]),
    locked: [], seed: SEEDS[0], guidance: 'colder',
  })
  const flat = flattenPrompt(p)
  for (const sentence of ['zinc counter sweated', 'face down, and neither', 'the way a coin comes out']) {
    assert.doesNotMatch(flat, new RegExp(sentence), `the prose leaked: ${sentence}`)
  }
  assert.match(p.stable, /REROUTE pass/); assert.match(p.stable, /STYLE CONTRACT \(binding\) ===\nSTYLE/)
  assert.match(p.volatile, /THE DESTINATION[\s\S]*1\. Carlos realizes Manuel lied\.\n2\. The photograph changes hands\./)
  assert.match(p.volatile, /THE KNOWN CURRENT ROUTE[\s\S]*¶1 — the counter/)
  assert.match(p.volatile, /ARC'S OWN READING[\s\S]*binds nothing[\s\S]*arc's guess/)
  // arc's reading is never in the binding sections
  const destinationBlock = p.volatile.slice(p.volatile.indexOf('THE DESTINATION'), p.volatile.indexOf('THE KNOWN CURRENT ROUTE'))
  assert.doesNotMatch(destinationBlock, /arc's guess/)
  assert.match(p.volatile, /Trinidad/)           // the contract block, withheld literal included as the contract states it
  assert.doesNotMatch(p.volatile, /reader_before|reader_after/)
  assert.match(p.user, /LATE ENTRY/); assert.match(p.user, /GUIDANCE \(binding; it overrides the seed\): colder/)
  assert.doesNotMatch(flat, /event\.the-lie/)   // bound events are the pack's business, not the route's
})

test('two seeds make two different user turns over identical system blocks', () => {
  const mk = (seed: typeof SEEDS[number]) => buildReroutePrompt({
    scene: SCENE, pack: 'PACK', style: 'STYLE', siblings: '', notes: [], destination: ['x'], knownRoute: 'r', inferred: '', locked: [], seed,
  })
  const a = mk(SEEDS[0]); const b = mk(SEEDS[1])
  assert.equal(a.stable, b.stable); assert.equal(a.volatile, b.volatile); assert.notEqual(a.user, b.user)
})

test('locked paragraphs are the one form in which current prose reaches the prompt, verbatim and in order', () => {
  const p = buildReroutePrompt({
    scene: SCENE, pack: 'P', style: 'S', siblings: '', notes: [], destination: ['x'], knownRoute: 'r', inferred: '',
    locked: [{ paragraph: 1, text: 'A photograph lay between the glasses, face down, and neither of them touched it.' }], seed: SEEDS[1],
  })
  assert.match(p.volatile, /LOCKED PARAGRAPHS \(reproduce VERBATIM, in this order\)[\s\S]*\[¶2 in the current scene\]\nA photograph lay between/)
  assert.doesNotMatch(flattenPrompt(p), /zinc counter/)
})

// ---- touchstones: the contract may not smuggle the current route in -------

test('touchstones drawn from the target scene are withheld from the prompt; the others stay', () => {
  const style = [
    '=== STYLE LAYER 2 — THIS BOOK (docs/style.md) ===',
    '## 5. Naming', 'Plain words.', '',
    '## 6. Touchstones',
    '**Vegetation speed — from ch-01/scene-01:**',
    '<!-- arc:touchstone-anchor {"scene": "sc.01-1", "paragraph": 2, "quote": "It drank."} -->',
    '> It drank. Its coat split. A thread of root went down.',
    '',
    '**The seed unchosen — from ch-00/scene-01,',
    'draft of 2026-08-27, ratified by the author\'s reaction:**',
    '> Nothing had chosen it. The boot did not know what it carried.',
    '',
    '**A body on empty — from ch-01/scene-01, same draft:**',
    '> His breath ran loud ahead of him in the dark of the wood.',
    '',
    '**Wrong version (annotated):**',
    '> The vine, symbol of empire, crept.',
    '',
    '## 7. Pre-draft checklist', '1. Smell first.',
  ].join('\n')
  const out = stripSceneTouchstones(style, { scene: 'sc.01-1', file: 'prose/ch-01/scene-01.md' })
  assert.doesNotMatch(out, /It drank\. Its coat split/)
  assert.match(out, /withheld from this pass — it is the current route/)
  assert.match(out, /Nothing had chosen it/)          // another scene's touchstone stays, wrapped label and all
  assert.doesNotMatch(out, /His breath ran loud/)     // ', same draft:' after the file still names this scene
  assert.match(out, /symbol of empire/)               // the annotated wrong version stays
  assert.match(out, /## 7\. Pre-draft checklist\n1\. Smell first\./)
  // by anchor scene alone, when the label names no file
  const byAnchor = stripSceneTouchstones(style.replace('— from ch-01/scene-01', ''), { scene: 'sc.01-1', file: 'prose/ch-01/scene-01.md' })
  assert.doesNotMatch(byAnchor, /It drank\. Its coat split/)
  // nothing of this scene: untouched, same string
  assert.equal(stripSceneTouchstones(style, { scene: 'sc.09-9', file: 'prose/ch-09/scene-09.md' }), style)
})

// ---- the coverage tail: read, never guessed --------------------------------

test('the coverage tail is parsed from the fence and stripped from the briefing; absent means null', () => {
  const tail = 'Beat one lands in ¶2.\n\n```json\n{"coverage": [{"item": "Carlos realizes Manuel lied.", "paragraph": 2}, {"item": "The photograph changes hands.", "paragraph": null}, {"item": "", "paragraph": 1}, "junk"]}\n```\n'
  const r = parseCoverageTail(tail)
  assert.equal(r.briefing, 'Beat one lands in ¶2.')
  assert.deepEqual(r.coverage, [{ item: 'Carlos realizes Manuel lied.', paragraph: 2 }, { item: 'The photograph changes hands.', paragraph: null }])
  assert.deepEqual(parseCoverageTail('No tail at all.'), { briefing: 'No tail at all.', coverage: null })
  assert.equal(parseCoverageTail('Prose then ```json\nnot json\n```').coverage, null)
  assert.deepEqual(parseCoverageTail('Bare {"coverage":[{"item":"x","paragraph":0}]}').coverage, [{ item: 'x', paragraph: null }])
})

test('every required beat gets a coverage row; a paraphrased row still matches; an unnamed beat is not reported', () => {
  const destination = ['The seed falls from the boot tread unnoticed and germinates among countless native seeds.', 'The vine stops spreading. It has taken what it will take.', 'By May 1957 the patch is dead and still.']
  const rows = [
    { item: 'The seed falls from the boot tread unnoticed and germinates among the native seeds', paragraph: 3 },   // paraphrase
    { item: 'A beat the pass volunteered on its own', paragraph: 8 },
  ]
  const m = mergeCoverage(destination, rows)!
  assert.deepEqual(m.map(r => [r.item.slice(0, 12), r.paragraph]), [['The seed fal', 3], ['The vine sto', null], ['By May 1957 ', null], ['A beat the p', 8]])
  assert.equal(mergeCoverage(destination, null), null)
})

// ---- the gates: proven, and honest about what they prove -------------------

const CURRENT = [
  'The zinc counter sweated under his palms while Manuel talked about the weather and the price of things.',
  'A photograph lay between the glasses, face down, and neither of them touched it for a long while.',
  'When the lie came it came easily, the way a coin comes out of a pocket that has held it a long time.',
  'No.',
].join('\n\n')

test('lexical overlap: a paraphrase-heavy copy is refused, a different route passes, short paragraphs and locks are not counted', () => {
  const copy = [
    'The zinc counter sweated under his palms while Manuel talked about the weather and the cost of things.',
    'A photograph lay between the glasses, face down, and neither of them touched it for a long time.',
    'When the lie came it came easily, the way a coin comes out of a pocket that has held it for years.',
  ].join('\n\n')
  const c = lexicalOverlap(copy, CURRENT, [])
  assert.equal(c.counted, 3); assert.ok((c.share ?? 0) > 0.4, `share ${c.share}`)
  const fresh = [
    'Manuel was already talking when Carlos came in, and the talk was of rain.',
    'Nothing lay on the counter but two glasses and the ring one of them had left.',
    'The photograph came out of Manuel\'s pocket last, as if he had only just remembered it.',
    'Carlos knew then, and said nothing, and the knowing sat down beside him like a third man.',
  ].join('\n\n')
  const f = lexicalOverlap(fresh, CURRENT, [])
  assert.equal(f.counted, 4); assert.equal(f.overlapping, 0); assert.equal(f.share, 0)
  // the locked paragraph is reproduced verbatim and must not count as reuse
  const withLock = fresh + '\n\nA photograph lay between the glasses, face down, and neither of them touched it for a long while.'
  const l = lexicalOverlap(withLock, CURRENT, ['A photograph lay between the glasses, face down, and neither of them touched it for a long while.'])
  assert.equal(l.counted, 4); assert.equal(l.overlapping, 0)
  // "No." on either side never counts; too few countable paragraphs → the gate cannot judge
  const tiny = 'No.\n\nYes.\n\nThe zinc counter sweated under his palms while Manuel talked about the weather and the price of things.'
  assert.equal(lexicalOverlap(tiny, CURRENT, []).share, null)
})

test('survival counts the words actually reused, in order — names in common are not a descendant', () => {
  const current = 'The light held. Below it the sea did what the sea does, and Ines counted the stairs down because counting was the only arithmetic left to her.'
  assert.ok(wordSurvival('Ines was already on the stairs when the sea changed its mind about the morning.', current) < 0.4)
  assert.ok(wordSurvival('The light held. Below it the sea did what the sea does, and Ines counted the steps down because counting was the only arithmetic left.', current) > 0.8)
  assert.equal(wordSurvival('', current), 0)
})

test('the and-cap is read from the contract, and sentences over it are named — locked paragraphs never counted', () => {
  assert.equal(andCapFromContract('## 3. Rhythm\n- **A chain stops at three.** Even one process…'), 3)
  assert.equal(andCapFromContract('- **A chain stops at 4.**'), 4)
  assert.equal(andCapFromContract('no such rule here'), null)
  const stream = 'The stream ran shallow over stone and he had come onto it out of the dark without seeing it, and now he lay along its bank with his face in it and drank the way the boat had taken a wave over the gunwale, all at once and more than it could hold.'
  const fine = 'It flowered and fruited and dropped and grew again. He drank. The bank took him on all fours.'
  const v = andChainViolations(`${fine}\n\n${stream}`, 3)
  assert.equal(v.length, 1); assert.equal(v[0].ands, 4); assert.match(v[0].sentence, /^The stream ran shallow/)
  assert.deepEqual(andChainViolations(fine, 3), [])
  assert.deepEqual(andChainViolations(stream, 3, [stream]), [])   // a locked paragraph is the author's
  assert.equal(andChainViolations(stream, 4).length, 0)
})

test('the word cap is read from the contract, and run-ons are named however they are joined', () => {
  assert.equal(wordCapFromContract('- **A sentence stops at 55 words.** However it is joined.'), 55)
  assert.equal(wordCapFromContract('no such rule'), null)
  const long = 'He listened for it anyway, at every stop the ground forced on him, with his head turned back toward the sea and his mouth open so his own breath would not be in the way, and each time the wood gave him only itself, water dripping from leaf to leaf, something small moving off through the litter, the surf worn down to a rumor.'
  const v = longSentenceViolations(`Short. Another short one.\n\n${long}`, 55)
  assert.equal(v.length, 1); assert.equal(v[0].words, 64)
  assert.deepEqual(longSentenceViolations(long, 64), [])
  assert.deepEqual(longSentenceViolations(long, 55, [long]), [])
})

test('locked paragraphs must keep their relative order', () => {
  const a = 'First locked paragraph stands here as it was written.'; const b = 'Second locked paragraph stands here as it was written.'
  assert.equal(lockOrderViolation(`x\n\n${a}\n\ny\n\n${b}`, [a, b]), false)
  assert.equal(lockOrderViolation(`${b}\n\nx\n\n${a}`, [a, b]), true)
  assert.equal(lockOrderViolation(`only ${a} survives here`, [a, b]), false)   // a missing lock is lockViolations' finding
})

// ---- refusals: proven, before anything is spent -----------------------------

test('an unknown scene, a scene without a destination, and a bad count are refused with the reason', async () => {
  await assert.rejects(runReroute({ scene: 'sc.09-9' }), (e: unknown) => e instanceof HttpError && e.status === 400 && /no scene/.test(e.message))
  await assert.rejects(runReroute({ scene: 'sc.01-1' }), (e: unknown) => e instanceof HttpError && e.status === 400 && /write one first/.test(e.message))
  await assert.rejects(runReroute({ scene: 'sc.01-1', count: 7 }), (e: unknown) => e instanceof HttpError && e.status === 400 && /count/.test(e.message))
})

test('a whole-scene lock refuses the run and names the lock; without a lock the missing engine is the refusal', async () => {
  writeScene(story, 'prose/ch-01/scene-02.md', 'sc.01-2', 'He came ashore by night.\n\nThe boot treads kept their mud.',
    'contract:\n  purpose: Put him on the shore.\n  must_establish:\n    - He arrives by night.\n')
  fs.mkdirSync(path.join(story, 'locks'), { recursive: true })
  fs.writeFileSync(path.join(story, 'locks', 'lock-001.yaml'), 'id: lock.001\nanchor:\n  scene: sc.01-2\ncreated_at: "2026-08-27T00:00:00Z"\n')
  try {
    await assert.rejects(runReroute({ scene: 'sc.01-2' }),
      (e: unknown) => e instanceof HttpError && e.status === 423 && /lock\.001/.test(e.message) && /settled it whole/.test(e.message))
    fs.rmSync(path.join(story, 'locks', 'lock-001.yaml'))
    await assert.rejects(runReroute({ scene: 'sc.01-2' }),
      (e: unknown) => e instanceof HttpError && e.status === 400 && /no engine/.test(e.message))
  } finally { reset() }
})
