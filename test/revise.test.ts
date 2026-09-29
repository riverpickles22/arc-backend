// The shape of a notes revision: how notes cluster, what a worker may write,
// what a reading of them parses to, and what the row's two rules texts say.
// The RUNNING of it — the conflict reading, the craft plan, the write — is
// work-notes.test.ts and the fixture engine (A69-9).
//
// The properties that matter are the ones that make writing safe: conflicts
// surfaced BEFORE anything is written, overlapping write sets serialised,
// staleness decided by fingerprint, and a worker that cannot reach canon
// however much a note implies it should.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ResolvedAnnotation } from 'arc-canon-graph'
import { makeStory, writeScene } from './fixture.ts'

const STORY = makeStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

writeScene(STORY, 'prose/ch-01/scene-02.md', 'sc.01-2', 'A second scene, so two clusters can be disjoint.')

const { clusterNotes, planRevisionGraph, scheduleWaves, parseConflicts } = await import('../src/revise.ts')
const { CONFLICT_RULES, REVISE_RULES, ROW_REVISE_SCENE_STAGED, MINIMAL_REVISION_GATES } = await import('../src/registry.ts')
const { checkPathWrite, checkRecordWrite } = await import('../src/capability.ts')

const note = (id: string, scene: string, body: string, over: Partial<ResolvedAnnotation> = {}): ResolvedAnnotation => ({
  id,
  anchor: { scene, paragraph: 0, quote: 'Original first paragraph.' },
  body,
  status: 'open',
  created_at: '2026-08-13',
  resolution: { state: 'resolved', paragraph: 0 },
  ...over,
} as ResolvedAnnotation)

// ---- clustering ----------------------------------------------------------

test('notes cluster by scene — the natural write-set boundary', () => {
  const clusters = clusterNotes([
    note('note.001', 'sc.01-1', 'Diego is furniture here.'),
    note('note.002', 'sc.01-1', 'The chin-scratch should land harder.'),
    note('note.003', 'sc.01-2', 'This opening is slack.'),
  ])
  assert.equal(clusters.length, 2)
  assert.deepEqual(clusters.map(c => c.scene), ['sc.01-1', 'sc.01-2'])
  assert.equal(clusters[0].notes.length, 2, 'two notes on one scene are one revision, not two')
  assert.ok(clusters[0].file.endsWith('scene-01.md'), 'the file is found by reading, not by guessing a path')
})

test('a note whose anchor is lost is excluded rather than guessed at', () => {
  const clusters = clusterNotes([
    note('note.gone', 'sc.01-1', 'about a passage that no longer exists',
      { resolution: { state: 'orphaned' } } as Partial<ResolvedAnnotation>),
    note('note.missing', 'sc.99-9', 'about a scene that never existed',
      { resolution: { state: 'no-scene' } } as Partial<ResolvedAnnotation>),
  ])
  assert.deepEqual(clusters, [], 'arc never guesses where a thought now belongs')
})

test('only open notes are worked', () => {
  const clusters = clusterNotes([
    note('note.done', 'sc.01-1', 'already handled', { status: 'resolved' }),
    note('note.dropped', 'sc.01-1', 'thrown away', { status: 'dropped' }),
  ])
  assert.deepEqual(clusters, [])
})

// ---- claims: prose only, and only its own ---------------------------------

test('a revision worker may write ITS OWN scene and nothing else', () => {
  const clusters = clusterNotes([
    note('note.001', 'sc.01-1', 'a'),
    note('note.003', 'sc.01-2', 'b'),
  ])
  const [a, b] = planRevisionGraph(clusters)

  assert.equal(checkPathWrite(a.claim, clusters[0].file).ok, true, 'its own scene')
  assert.equal(checkPathWrite(a.claim, clusters[1].file).ok, false, 'never the other node\'s scene')
  assert.equal(checkPathWrite(b.claim, clusters[0].file).ok, false)
})

test('a revision worker cannot touch canon, however much a note implies it', () => {
  const [node] = planRevisionGraph(clusterNotes([note('note.001', 'sc.01-1', 'give him a brother named Tomás')]))
  assert.deepEqual(node.claim.creates, [], 'it may create nothing')
  assert.deepEqual(node.claim.proposes, [], 'and propose nothing')

  const check = checkRecordWrite(node.claim, {
    added: [{ id: 'char.brother', file: 'canon/entities/characters/brother.yaml', status: 'proposed' }],
    modified: [], removed: [],
  })
  assert.equal(check.ok, false, 'the gate refuses a canon write')
  assert.equal(checkPathWrite(node.claim, 'canon/entities/characters/brother.yaml').ok, false)
})

test('every node fingerprints what it read, so staleness has something to compare', () => {
  for (const n of planRevisionGraph(clusterNotes([note('note.001', 'sc.01-1', 'x')]))) {
    assert.ok(n.reads.length, 'it declares what it read')
    assert.deepEqual(Object.keys(n.read_versions).every(k => n.reads.includes(k)), true)
  }
})

// ---- scheduling: overlap serialises, disjoint runs together ----------------

test('disjoint write sets share a wave; overlapping ones are serialised', () => {
  const disjoint = planRevisionGraph(clusterNotes([
    note('note.001', 'sc.01-1', 'a'),
    note('note.003', 'sc.01-2', 'b'),
  ]))
  assert.equal(scheduleWaves(disjoint).length, 1, 'two scenes, one wave — safe to run at once')
  assert.equal(scheduleWaves(disjoint)[0].length, 2)

  // Two nodes contending for the same file must never share a wave: one would
  // overwrite the other and the loser would never know.
  const contending = [
    { ...disjoint[0], id: 'a', writes: ['prose/ch-01/scene-01.md'] },
    { ...disjoint[0], id: 'b', writes: ['prose/ch-01/scene-01.md'] },
  ]
  const waves = scheduleWaves(contending)
  assert.equal(waves.length, 2, 'serialised')
  assert.deepEqual(waves.map(w => w.length), [1, 1])
})

test('a node overlapping only one of several still gets its own wave', () => {
  const base = planRevisionGraph(clusterNotes([note('note.001', 'sc.01-1', 'a')]))[0]
  const waves = scheduleWaves([
    { ...base, id: 'a', writes: ['x.md'] },
    { ...base, id: 'b', writes: ['y.md'] },
    { ...base, id: 'c', writes: ['x.md'] },
  ])
  assert.equal(waves.length, 2)
  assert.deepEqual(waves[0].map(n => n.id), ['a', 'b'])
  assert.deepEqual(waves[1].map(n => n.id), ['c'])
})

// ---- conflicts: surfaced before anything is written ------------------------

test('the conflict reading is told to surface tensions, never to resolve them', () => {
  assert.match(CONFLICT_RULES, /NOT resolving/)
  assert.match(CONFLICT_RULES, /Do not suggest which note should win/)
  assert.match(CONFLICT_RULES, /An empty array is the common answer/)
  // It is the row's FIRST stage, and it always runs: two notes that pull
  // against each other are the author's decision, and a pass that wrote
  // first would have made it for them.
  const stage = ROW_REVISE_SCENE_STAGED.stages[0]
  assert.equal(stage.id, 'conflict')
  assert.equal(stage.when, 'always')
  assert.equal(stage.answer, 'conflicts')
  assert.equal(stage.rules, CONFLICT_RULES)
})

// A note about the whole scene has no passage to quote — often because it is
// about what the scene does NOT say. The ASSEMBLER's notes layer is the one
// place notes are rendered for any pass now (A69-9), so that is where the
// scope is named rather than quoted as an empty string; slice.test.ts holds
// it. What this file holds is that the row reads that layer and no other.
test('both stages read the author\'s notes from the slice, and nothing else does', () => {
  const [conflict, , write] = ROW_REVISE_SCENE_STAGED.stages
  assert.deepEqual([...conflict.slice.layers], ['notes'],
    'the reading is shown the notes and nothing of the story')
  assert.ok(write.slice.layers.includes('notes'), 'and the write is shown them in their place')
})

test('a conflict needs two notes and a stated tension, or it is not one', () => {
  const out = parseConflicts(JSON.stringify([
    { between: ['note.001', 'note.007'], tension: 'One asks for more suspicion, the other for less.' },
    { between: ['note.001'], tension: 'only one note' },
    { between: ['note.002', 'note.003'] },
    { between: ['note.004', 'note.005'], tension: '   ' },
  ]))
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].between, ['note.001', 'note.007'])
  assert.deepEqual(parseConflicts('the model wrote prose instead'), [])
})

test('an answer that could not be read is not "no conflicts" — the difference licenses a write', async () => {
  const { readConflicts } = await import('../src/revise.ts')
  // Looked, and found nothing. The common answer, and a good one.
  assert.deepEqual(readConflicts('[]'), [])
  assert.deepEqual(readConflicts('```json\n[]\n```'), [])
  // Did not look. Each of these read as an empty list before, and an empty
  // list is what lets the revision proceed (§5, P2 fails closed).
  assert.equal(readConflicts(''), null, 'nothing at all')
  assert.equal(readConflicts('I am sorry, I cannot help with that.'), null, 'an apology')
  assert.equal(readConflicts('[{"between": ["note.001", "note.007"], "tension": "cut off'), null, 'a truncation')
  // And the array is found wherever it sits: a model that wraps it in an
  // object still looked, and answering tolerantly is the house rule.
  assert.deepEqual(readConflicts('{"conflicts": []}'), [], 'wrapped, but an answer')
  assert.equal(readConflicts(JSON.stringify([{ between: ['note.1'] }, { tension: 'x' }])), null,
    'entries that are all unreadable: nothing was understood')
  // One readable tension among malformed ones still stops the write, which
  // is the safe direction.
  assert.equal(readConflicts(JSON.stringify([
    { between: ['note.1'] },
    { between: ['note.2', 'note.3'], tension: 'a real one' },
  ]))?.length, 1)
})

test('the conflict reading refuses an answer it could not read, and never calls it quiet', async () => {
  const { runRowGates } = await import('../src/gates.ts')
  const { gateCtx } = await import('../src/reroute.ts')
  const ctx = gateCtx({ sceneName: '', sceneBody: '', sceneLocks: [], lockedTexts: [], literals: [], andCap: null, wordCap: null, destination: [], known: [] })
  const row = { gates: [], answer: 'conflicts' } as never
  const quiet = runRowGates(row, ctx, '[]')
  assert.equal(quiet.ok, true, 'an empty array is an answer')
  const lost = runRowGates(row, ctx, 'I could not check those notes.')
  assert.equal(lost.ok, false)
  assert.equal(lost.ok ? false : lost.unreadable, true)
  assert.match(lost.ok ? '' : lost.reason, /could not read that check of your notes, so nothing was written/)
})

test('a ratified rule binds what arc writes, never the prose the author already has', async () => {
  const { runRowGates } = await import('../src/gates.ts')
  const { gateCtx } = await import('../src/reroute.ts')
  // The author's own scene breaks the author's own cap — their book, their
  // call. A minimal revision is told to hand such a paragraph back word for
  // word, and was then refused for doing it (A69-9 review).
  const long = `A sentence that ${'runs on and '.repeat(9)}stops.`
  const asked = 'The paragraph a note pointed at, rewritten.'
  const before = `${long}\n\n${asked}`
  const base = {
    sceneName: 'sc.01-1', sceneBody: before, sceneLocks: [], lockedTexts: [],
    literals: [], andCap: null, wordCap: 20, destination: [], known: [],
  }
  const row = { gates: ['sentence-length'], answer: 'body-only' } as never

  const returned = `${long}\n\nSomething new and short.`
  assert.equal(runRowGates(row, gateCtx(base), returned).ok, false,
    'without the exemption the author\'s own paragraph refuses the answer')
  const kind = runRowGates(row, { ...gateCtx(base), exemptUnchanged: true }, returned)
  assert.equal(kind.ok, true, 'and with it, prose the pass returned is not prose the pass wrote')

  // What the pass DID write is still measured.
  const wrote = `${asked}\n\nA new sentence that ${'runs on and '.repeat(9)}stops.`
  const caught = runRowGates(row, { ...gateCtx({ ...base, sceneBody: before }), exemptUnchanged: true }, wrote)
  assert.equal(caught.ok, false, 'a long sentence the pass wrote is refused as it always was')
  assert.match(caught.ok ? '' : caught.reason, /where the contract stops at 20/)
})

test('the row declares what "minimal" will be checked against, and says what is not checked yet', () => {
  assert.deepEqual([...MINIMAL_REVISION_GATES], [
    'locks', 'lock-order', 'validator', 'withhold-literals', 'blast-radius', 'and-chain', 'sentence-length',
  ])
  // blast-radius is DESIGNED, SLICE 3. It is on the row now so every receipt
  // says this is not yet checked — "minimal" is the claim the row makes
  // loudest, and a gate the author cannot see is one they cannot ask about.
  assert.ok(MINIMAL_REVISION_GATES.includes('blast-radius'))
  assert.equal(ROW_REVISE_SCENE_STAGED.gates, MINIMAL_REVISION_GATES)
  // And no leans-on: a minimal revision answers instructions and argues
  // nothing, so there is no briefing to carry the block.
  assert.ok(!MINIMAL_REVISION_GATES.includes('leaned-on'))
  assert.equal(ROW_REVISE_SCENE_STAGED.answer, 'body-only')
})

// ---- what the worker is told ----------------------------------------------

test('the revision rules bind the contract, forbid inventing canon, and keep the register', () => {
  assert.match(REVISE_RULES, /THE CONTRACT BELOW IS BINDING/, 'the author\'s own rules are the authority')
  assert.match(REVISE_RULES, /Never invent a fact about the world/)
  assert.match(REVISE_RULES, /CHANGE AS LITTLE AS THE NOTES REQUIRE/)
  assert.match(REVISE_RULES, /YOU HAVE NO TOOLS/, 'a sealed pass')
  assert.match(REVISE_RULES, /return unchanged, word for word/, 'and "minimal" is said, not implied')
  assert.doesNotMatch(REVISE_RULES, /ONE ATTEMPT, NOT A/, 'this is not the clean pass')
  assert.doesNotMatch(REVISE_RULES, /=== BRIEFING ===/, 'and it argues nothing')
})

test('every revision carries the notes that caused it', () => {
  const clusters = clusterNotes([
    note('note.001', 'sc.01-1', 'a'),
    note('note.002', 'sc.01-1', 'b'),
  ])
  assert.deepEqual(clusters[0].notes.map(n => n.id), ['note.001', 'note.002'],
    'provenance starts at the cluster and rides to the receipt')
})
