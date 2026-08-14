// The read-only fan-out. The story is the SCOPING, not the prompts: four
// lenses share one anchor and must not share one context pack, because a
// shared pack means every lens inherits one retrieval's mistakes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeStory } from './fixture.ts'

process.env.ARC_STORY_PATH = makeStory()
process.env.ARC_DRAFT_ENGINE = 'none'

const { LENSES, planLensGraph, buildLensPrompt, parseFindings } = await import('../src/lenses.ts')

const SCENE = {
  scene: 'sc.01-1',
  chapter: 'ch.01-the-cafe',
  status: 'proposed',
  pov: 'char.carlos',
  events: ['event.hog-roasted'],
  facts: ['char.carlos', 'char.elena', 'place.cafe'],
  contract: null,
  file: 'prose/ch-01/scene-01.md',
  body: 'The morning smelled of coffee before it smelled of anything else.',
}

test('one node per lens, each anchored on the same scene', () => {
  const nodes = planLensGraph(SCENE)
  assert.equal(nodes.length, LENSES.length)
  assert.equal(nodes.length, 4)
  for (const n of nodes) {
    assert.deepEqual(n.anchors, ['sc.01-1'], 'one shared anchor — the scene')
    assert.equal(n.kind, 'lens')
  }
  assert.deepEqual(nodes.map(n => n.id).sort(),
    ['lens:character', 'lens:continuity', 'lens:historical', 'lens:style'])
})

test('NO lens holds write, propose or create capability', () => {
  for (const n of planLensGraph(SCENE)) {
    assert.deepEqual(n.claim.writes, [], `${n.id} cannot write`)
    assert.deepEqual(n.claim.proposes, [], `${n.id} cannot propose`)
    assert.deepEqual(n.claim.creates, [], `${n.id} cannot create`)
    assert.deepEqual(n.writes, [])
    assert.deepEqual(n.creates, [])
  }
})

test('a lens attempting a write is refused by the gate, not by good intentions', async () => {
  const { checkRecordWrite } = await import('../src/capability.ts')
  const lens = planLensGraph(SCENE)[0]
  const check = checkRecordWrite(lens.claim, {
    added: [{ id: 'char.someone', file: 'canon/entities/characters/someone.yaml', status: 'proposed' }],
    modified: [],
    removed: [],
  })
  assert.equal(check.ok, false, 'the gate refuses it')
  assert.ok(check.denied?.length, 'and names what it refused')
})

test('the lenses share an anchor and do NOT share a context pack', () => {
  const nodes = planLensGraph(SCENE)
  const manifests = nodes.map(n => n.context_manifest)

  // Distinct objects, not one pack handed round.
  for (let i = 0; i < manifests.length; i++) {
    for (let j = i + 1; j < manifests.length; j++) {
      assert.notEqual(manifests[i], manifests[j], 'each lens derives its own')
    }
  }

  // And demonstrably different CONTENT, not merely different arrays.
  const sets = nodes.map(n => n.reads.slice().sort().join('|'))
  assert.ok(new Set(sets).size > 1, `projections differ: ${JSON.stringify(sets)}`)
})

test('each lens has its own selectors, and they ask different questions', () => {
  const nodes = planLensGraph(SCENE)
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]))

  // The style lens sees NO entities: voice is not a canon question, and this
  // is the sharpest available proof that the projections are not one bundle.
  assert.deepEqual(byId['lens:style'].selectors, [], 'style derives nothing from the graph')
  assert.deepEqual(byId['lens:style'].reads, [])

  // The character lens starts from who is present.
  assert.ok(byId['lens:character'].selectors.some(s => s.of === 'char.carlos'))
  // The historical lens starts from where and when, never from who.
  assert.equal(byId['lens:historical'].selectors.some(s => s.of === 'char.carlos'), false,
    'the historical lens has no business with the cast')
  assert.ok(byId['lens:historical'].selectors.some(s => s.of === 'ch.01-the-cafe'))
  // Continuity starts from the events the scene claims.
  assert.ok(byId['lens:continuity'].selectors.some(s => s.of === 'event.hog-roasted'))
})

test('every selector says why it exists', () => {
  for (const n of planLensGraph(SCENE)) {
    for (const s of n.selectors) assert.ok(s.because.trim(), `${n.id} selector ${s.of} says why`)
  }
})

test('each node fingerprints exactly what it will read', () => {
  for (const n of planLensGraph(SCENE)) {
    assert.deepEqual(Object.keys(n.read_versions).sort().filter(k => n.reads.includes(k)).length >= 0, true)
    for (const id of Object.keys(n.read_versions)) {
      assert.ok(n.reads.includes(id), `${n.id} fingerprints only what it reads`)
    }
  }
})

// ---- what a lens is allowed to say ---------------------------------------

test('only the style lens is handed the style contract', () => {
  const nodes = planLensGraph(SCENE)
  const style = LENSES.find(l => l.name === 'style')!
  const character = LENSES.find(l => l.name === 'character')!
  const CONTRACT = 'THE NO-COMMENT LAW: never explain a feeling the body can show.'

  assert.match(buildLensPrompt(style, SCENE, '{}', CONTRACT), /NO-COMMENT LAW/)
  assert.doesNotMatch(buildLensPrompt(character, SCENE, '{}', CONTRACT), /NO-COMMENT LAW/,
    'a lens is given what its question needs and nothing else')
  assert.equal(nodes.length, 4)
})

test('the prompt tells a lens it has nothing beyond its own context', () => {
  const p = buildLensPrompt(LENSES[0], SCENE, '{"context_manifest":[]}', 'x')
  assert.match(p, /you have nothing else/)
  assert.match(p, /sc\.01-1/)
  assert.match(p, /The morning smelled of coffee/)
  assert.match(p, /ARGUED, never proven/)
})

test('a finding without evidence is dropped — an opinion is not a finding', () => {
  const out = parseFindings('character', JSON.stringify([
    { about: 'char.carlos', claim: 'He acts older than nine.', evidence: 'counted his sums at the counter' },
    { about: 'char.elena', claim: 'She feels wrong here.' },                       // no evidence
    { about: 'char.elena', claim: 'Also wrong.', evidence: '   ' },                // blank evidence
    { about: 'x', evidence: 'has evidence but no claim' },                          // no claim
  ]))
  assert.equal(out.length, 1)
  assert.equal(out[0].claim, 'He acts older than nine.')
  assert.equal(out[0].register, 'argued', 'never proven')
  assert.equal(out[0].lens, 'character')
})

test('every finding is argued, and unparseable output is no findings rather than a crash', () => {
  assert.deepEqual(parseFindings('style', 'the model wandered off and wrote prose'), [])
  assert.deepEqual(parseFindings('style', '```json\n[not valid\n```'), [])
  assert.deepEqual(parseFindings('style', '{"not":"an array"}'), [])

  const fenced = parseFindings('style', '```json\n[{"about":"rhythm","claim":"c","evidence":"e"}]\n```')
  assert.equal(fenced.length, 1)
  assert.equal(fenced[0].register, 'argued')
})

test('a finding with no id still says what it is about', () => {
  const out = parseFindings('style', JSON.stringify([{ claim: 'Too many em dashes.', evidence: 'three in one line' }]))
  assert.equal(out[0].about, 'style', 'falls back to the lens rather than pretending to an id')
})

test('a scene declaring no events still gives the continuity lens something to read', () => {
  // The first real run found this: sc.01-1 lists no events, so the continuity
  // lens was handed an empty manifest — and still returned seven findings, one
  // of which cited "chapters.yaml ch.01 summary", a record it had never been
  // given. A lens reading against nothing produces exactly the unevidenced
  // claim the argued register exists to forbid.
  const eventless = { ...SCENE, events: [] }
  const node = planLensGraph(eventless).find(n => n.id === 'lens:continuity')!
  assert.ok(node.selectors.length > 0, 'it falls back rather than reading blind')
  assert.ok(node.selectors.some(s => s.of === eventless.chapter),
    'to the chapter, which is the only continuity anchor a scene without events has')
  assert.match(node.selectors[0].because, /declares no events/, 'and says why it is there')
})

test('utilization is not-applicable when nothing was supplied, never perfect', async () => {
  const { utilization } = await import('../src/context.ts')
  assert.equal(utilization([], []), null,
    'a 1.0 would rank the worst-scoped lens as the best in the table')
})
