// Anchors are intent; context is derived.
//
// The property under test is the one slice 1 got wrong: what the author MEANT
// and what a worker NEEDS are different sets, and conflating them makes intake
// a hidden retrieval system whose mistakes every downstream node inherits.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeStory } from './fixture.ts'

process.env.ARC_STORY_PATH = makeStory()
process.env.ARC_DRAFT_ENGINE = 'none'

const {
  deriveSelectors, resolveContext, expandContext, renderContext, utilization, citedIn,
  ContextRefused, DEFAULT_POLICY,
} = await import('../src/context.ts')
const { parseEnvelope } = await import('../src/intent.ts')

/** A small graph, so the derivation is tested as arithmetic rather than
 *  against whatever a story happens to contain. */
const CANON = {
  story: { title: 'Test Story' },
  entities: {
    'char.carlos': { id: 'char.carlos', name: 'Carlos' },
    'char.elena': { id: 'char.elena', name: 'Elena' },
    'char.diego': { id: 'char.diego', name: 'Diego' },
    'place.cafe': { id: 'place.cafe', name: 'Café La Paloma' },
  },
  events: {
    'event.hog': { id: 'event.hog', involves: ['char.carlos'] },
  },
  relationships: [
    { from: 'char.elena', to: 'char.carlos', kind: 'family' },
    { from: 'char.carlos', to: 'char.diego', kind: 'companion-animal' },
  ],
  chapters: [{ id: 'ch.01' }],
}

const envelope = (over: Record<string, unknown> = {}) => parseEnvelope(JSON.stringify({
  operations: ['capture'],
  anchors: ['char.carlos'],
  scope_roots: { temporal: ['ch.01'], location: [], surface: ['material'] },
  inferred_scope: 'local',
  authority: 'exploratory',
  ambiguity: 'low',
  requested_outcome: 'file it',
  open_questions: [],
  ...over,
}))

test('the envelope keeps scope roots apart from anchors, and marks them inferred', () => {
  const e = envelope()
  assert.deepEqual(e.anchors, ['char.carlos'], 'what the author meant')
  assert.deepEqual(e.scope_roots.temporal, ['ch.01'], 'where arc guesses to start')
  assert.deepEqual(e.scope_roots.surface, ['material'])
  assert.equal('scope_roots' in e && 'anchors' in e, true, 'two fields, never one list')
})

test('a wrong scope root cannot change what the instruction is recorded as meaning', () => {
  const right = envelope()
  const wrong = envelope({ scope_roots: { temporal: ['ch.99-nonsense'], location: ['place.nowhere'], surface: [] } })
  assert.deepEqual(right.anchors, wrong.anchors, 'the meaning is identical')
  assert.deepEqual(right.requested_outcome, wrong.requested_outcome)
})

test('a missing scope_roots block is empty, not absent — an old envelope still parses', () => {
  const e = parseEnvelope(JSON.stringify({ operations: ['capture'], anchors: ['char.carlos'] }))
  assert.deepEqual(e.scope_roots, { temporal: [], location: [], surface: [] })
})

// ---- selectors: intent in, permission out --------------------------------

test('selectors come from anchors and scope roots, and say which is which', () => {
  const sels = deriveSelectors(envelope())
  const anchor = sels.find(s => s.kind === 'anchor')
  assert.equal(anchor?.of, 'char.carlos')
  assert.match(anchor!.because, /the author named it/)

  const surface = sels.find(s => s.kind === 'surface')
  assert.match(surface!.because, /inferred/, 'arc\'s guess is labelled as one, never as the author\'s')

  assert.ok(sels.some(s => s.kind === 'neighbours' && s.of === 'char.carlos'),
    'a node may walk one hop from what the author named — that is derivation, not intent')
})

test('no anchors means no anchor selectors — an empty list is a valid answer', () => {
  const sels = deriveSelectors(envelope({ anchors: [] }))
  assert.equal(sels.some(s => s.kind === 'anchor'), false)
})

// ---- the manifest: every item says why it is here -------------------------

test('every manifest entry carries the reason and the selector that produced it', () => {
  const manifest = resolveContext(deriveSelectors(envelope()), DEFAULT_POLICY, CANON)
  assert.ok(manifest.length > 0, 'the fixture story has something to find')
  for (const item of manifest) {
    assert.ok(item.because.trim(), `${item.id} says why it is here`)
    assert.ok(item.via.trim(), `${item.id} names the selector that produced it`)
  }
})

test('an anchor is primary and says so; a neighbour names the path that reached it', () => {
  const manifest = resolveContext(deriveSelectors(envelope()), DEFAULT_POLICY, CANON)
  const carlos = manifest.find(m => m.id === 'char.carlos')
  if (carlos) {
    assert.match(carlos.because, /named/)
    assert.match(carlos.via, /^anchor:/)
  }
  for (const m of manifest.filter(x => x.via.startsWith('neighbours:'))) {
    assert.match(m.because, /char\.carlos/, 'a neighbour names what it is a neighbour of')
  }
})

test('nothing is manifested that does not exist — a wrong root adds nothing', () => {
  const manifest = resolveContext(deriveSelectors(envelope({
    scope_roots: { temporal: ['ch.99-nonsense'], location: ['place.nowhere'], surface: [] },
  })), DEFAULT_POLICY, CANON)
  assert.equal(manifest.some(m => m.id === 'place.nowhere'), false)
  assert.equal(manifest.some(m => m.id === 'ch.99-nonsense'), false)
})

test('two nodes sharing an anchor derive their own manifests rather than sharing one', () => {
  const a = resolveContext(deriveSelectors(envelope()), DEFAULT_POLICY, CANON)
  const b = resolveContext(deriveSelectors(envelope({ scope_roots: { temporal: [], location: [], surface: [] } })), DEFAULT_POLICY, CANON)
  assert.notEqual(a, b, 'not the same object — a shared pack means shared mistakes')
  // Same anchor, different roots: the second must not carry the first's extras.
  const onlyInA = a.filter(x => !b.some(y => y.id === x.id))
  assert.ok(a.length >= b.length, 'narrower selectors never yield more context')
  for (const item of onlyInA) assert.match(item.via, /surface:|neighbours:/)
})

// ---- limits: refused, never silently trimmed ------------------------------

test('exceeding the primary limit is refused, and the refusal says nothing was dropped', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    kind: 'anchor' as const, of: `char.carlos`, because: `dup ${i}`,
  }))
  // Dedup means one id, so force it with a tiny policy instead.
  assert.throws(
    () => resolveContext(deriveSelectors(envelope()), { max_primary_refs: 0, max_supporting_refs: 0, expand_on_demand: true }, CANON),
    (e: unknown) => {
      assert.ok(e instanceof ContextRefused)
      assert.match((e as Error).message, /nothing was silently dropped/)
      return true
    },
  )
  assert.equal(many.length, 40)
})

test('a limit that fits is not a refusal', () => {
  assert.doesNotThrow(() => resolveContext(deriveSelectors(envelope()), DEFAULT_POLICY, CANON))
})

// ---- expansion: declare narrow, widen on the record -----------------------

test('a node may ask for more, and what it gained carries the reason', () => {
  const manifest = resolveContext(deriveSelectors(envelope()), DEFAULT_POLICY, CANON)
  assert.equal(manifest.some(m => m.id === 'place.cafe'), false, 'not reachable from the selectors')
  const wider = expandContext(manifest, ['place.cafe'], 'the worker needed where it happens')
  const added = wider.find(m => m.id === 'place.cafe')
  assert.ok(added, 'the id arrived')
  assert.equal(added!.because, 'the worker needed where it happens')
  assert.equal(added!.via, 'expansion', 'and is distinguishable from what the selectors gave')
  assert.equal(wider.length, manifest.length + 1)
})

test('expansion never duplicates what is already there', () => {
  const manifest = resolveContext(deriveSelectors(envelope()), DEFAULT_POLICY, CANON)
  if (!manifest.length) return
  const same = expandContext(manifest, [manifest[0].id], 'asked again')
  assert.equal(same.length, manifest.length)
})

test('a policy that forbids widening refuses it rather than quietly obliging', () => {
  const manifest = resolveContext(deriveSelectors(envelope()), DEFAULT_POLICY, CANON)
  assert.throws(
    () => expandContext(manifest, ['place.cafe'], 'x', { ...DEFAULT_POLICY, expand_on_demand: false }),
    (e: unknown) => e instanceof ContextRefused,
  )
})

// ---- what the worker sees, and what it used -------------------------------

test('the rendered context shows the model why it was given every fact', () => {
  const manifest = resolveContext(deriveSelectors(envelope()), DEFAULT_POLICY, CANON)
  const text = renderContext(manifest, CANON)
  assert.match(text, /context_manifest/)
  assert.match(text, /included_because/)
  assert.match(text, /via_selector/)
  assert.match(text, /Nothing else was retrieved/)
})

test('utilization is measured from what the worker referred to, not what it claimed', () => {
  const manifest = [
    { id: 'char.carlos', because: 'named', via: 'anchor:char.carlos' },
    { id: 'char.elena', because: 'family', via: 'neighbours:char.carlos' },
    { id: 'place.cafe', because: 'family', via: 'neighbours:char.carlos' },
    { id: 'char.diego', because: 'family', via: 'neighbours:char.carlos' },
  ]
  const reply = 'I filed this against char.carlos and mentioned char.elena.'
  const cited = citedIn(manifest, reply)
  assert.deepEqual(cited.sort(), ['char.carlos', 'char.elena'])
  assert.equal(utilization(manifest, cited), 0.5, 'half of what it was handed went unused')

  assert.equal(utilization([], []), 1, 'nothing supplied is not a failure to use it')
  assert.equal(utilization(manifest, ['char.nobody']), 0, 'a citation outside the manifest counts for nothing')
})
