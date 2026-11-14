// U7 · update record (A74-1): the pure half, the four gates on hand-built
// inputs, and the whole pass end to end on a STUB `claude` — no key, no
// subscription. What is under test is everything around the model: what the
// brief carries, which proposals survive which gate, what is filed and how,
// and that nothing the contract withholds is ever filed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { installStubCli, makeExampleStory, git } from './fixture.ts'

const STORY = makeExampleStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'claude-cli'

const SCENE_FILE = 'prose/ch-01/scene-01.md'
// The author's accepted edit: the log paragraph gains a barometer.
{
  const abs = path.join(STORY, SCENE_FILE)
  fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace('Then the log.', 'Then the log, and the barometer beside it.'))
  git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'prose: accept sc.01-1')
}

const ANSWER = [
  // lands: stated, filed
  { class: 'stated', subject: 'new', type: 'object', field: 'name', value: 'The barometer', evidence: ['¶5'], note: 'The glass beside the log.' },
  // dropped by evidence-resolves: ¶1 is context, not part of the change
  { class: 'stated', subject: 'new', type: 'object', field: 'name', value: 'The stairs', evidence: ['¶1'], note: 'Ninety-one of them.' },
  // refused as a duplicate: Wren is in the record
  { class: 'stated', subject: 'new', type: 'character', field: 'name', value: 'wren', kind: 'dog', evidence: ['¶5'], note: 'Ines\'s dog.' },
  // dropped by the validator: a place with no kind arc can file
  { class: 'implied', subject: 'new', type: 'place', field: 'name', value: 'The sill', evidence: ['¶5'], note: 'Where the log lies.' },
  // the contract withholds "her sister": never filed, however it is cited
  { class: 'implied', subject: 'new', type: 'character', field: 'name', value: 'her sister', kind: 'human', evidence: ['¶5'], note: 'Someone Ines left.' },
  // dropped: a change to a record that already exists stays the author's edit
  { class: 'stated', subject: 'char.ines', type: 'character', field: 'wants', value: 'to leave', evidence: ['¶5'] },
  // filed, as a retraction: names a record, removes nothing
  { class: 'retracted', subject: 'obj.keepers-log', type: 'object', field: 'name', value: 'The Whitcombe light log', evidence: ['¶5'], note: 'The change no longer shows the log as a record.' },
]

process.env.PATH = `${installStubCli({
  name: 'record',
  before: "if (process.env.STUB_FAIL === '1') { process.stderr.write('stub refused'); process.exit(3) }",
  answer: `process.env.STUB_ANSWER ?? ${JSON.stringify('```json\n' + JSON.stringify(ANSWER) + '\n```')}`,
})}${path.delimiter}${process.env.PATH}`

const { episodesSettled } = await import('../src/episodes.ts')
const { runUpdateRecord, acceptedDiff, narrativeNotes } = await import('../src/update-record.ts')
const { readProposals, evidenceId, proposalKey, buildCandidate, provenConflict, withEdge, recordKeys } = await import('../src/proposals.ts')
const { continuityConflict } = await import('../src/continuity.ts')
const { runRowGates } = await import('../src/gates.ts')
const { ROW_UPDATE_RECORD_SCENE } = await import('../src/registry.ts')
const { validateStory } = await import('../src/canon.ts')
const { proposalOrigins, retractionOrigins, recordProposalOrigin } = await import('../src/ledger.ts')
const { readWorkingReceipt } = await import('../src/run.ts')
const { gateCtx } = await import('../src/gate-ctx.ts')

// ---- the pure half -------------------------------------------------------

test('proposals are read tolerantly, and an unreadable answer is not an empty one', () => {
  assert.equal(readProposals('no array here'), null)
  const empty = readProposals('```json\n[]\n```')
  assert.deepEqual(empty, { proposals: [], malformed: 0 })
  const r = readProposals(JSON.stringify([{ class: 'stated', subject: 'new', type: 'Object', field: 'name', value: ' X ', evidence: ['p3'] }, { class: 'maybe' }, 'junk']))!
  assert.equal(r.proposals.length, 1); assert.equal(r.malformed, 2)
  assert.equal(r.proposals[0].type, 'object'); assert.equal(r.proposals[0].value, 'X')
})

test('evidence ids have one spelling; a quote is not an id', () => {
  assert.equal(evidenceId('¶3'), '¶3'); assert.equal(evidenceId('p3'), '¶3'); assert.equal(evidenceId('paragraph 3'), '¶3')
  assert.equal(evidenceId('-¶2'), '-¶2')
  assert.equal(evidenceId('She counted the stairs.'), null)
})

test('the key is the same for a new subject however it is spelled, and differs by type', () => {
  const k = (value: string, type = 'object') => proposalKey({ subject: 'new', type, field: 'name', value })
  assert.equal(k('The  Keeper\'s Log'), k("the keeper's log"))
  assert.notEqual(k('Wren', 'character'), k('Wren', 'place'))
  assert.notEqual(proposalKey({ subject: 'char.ines', type: 'character', field: 'wants', value: 'a' }), proposalKey({ subject: 'char.ines', type: 'character', field: 'wants', value: 'b' }))
})

test('a candidate is built from the proposal alone, and refuses to guess what a schema requires', () => {
  const ctx = { scene: 'sc.01-1', era: 'era.keeping', taken: new Set<string>() }
  const base = { class: 'stated' as const, subject: 'new', field: 'name', evidence: ['¶1'] }
  const ok = buildCandidate({ ...base, type: 'object', value: 'The shears' }, ctx)
  assert.ok(ok.ok); if (ok.ok) { assert.equal(ok.id, 'obj.the-shears'); assert.equal(ok.record.status, 'proposed'); assert.match(ok.article.text, /^---\ncanon: obj\.the-shears\n---/) }
  assert.equal(buildCandidate({ ...base, type: 'place', value: 'The sill' }, ctx).ok, false, 'a place needs a kind')
  assert.equal(buildCandidate({ ...base, type: 'character', value: 'Mara', kind: 'human' }, { ...ctx, era: null }).ok, false, 'and a person an era')
  assert.equal(buildCandidate({ ...base, type: 'event', value: 'The wreck' }, ctx).ok, false)
  assert.equal(buildCandidate({ ...base, subject: 'char.ines', type: 'character', value: 'x' }, ctx).ok, false, 'an existing record stays the author\'s edit')
})

test('a contradiction is shown only where the record shows it', () => {
  const entities = [{ id: 'char.wren', type: 'character', name: 'Wren' }]
  const p = { class: 'stated' as const, subject: 'new', type: 'place', field: 'name', value: 'wren', evidence: [] }
  assert.match(provenConflict(p, entities)!, /already the name of a character/)
  assert.doesNotMatch(provenConflict(p, entities)!, /char\./, 'a name, never an id')
  assert.equal(provenConflict({ ...p, type: 'character' }, entities), null, 'the same kind of thing is a duplicate, not a contradiction')
})

test('the accepted diff numbers paragraphs as the book holds them, and only changed ones are citable', () => {
  const d = acceptedDiff('one\n\ntwo\n\nthree', 'one\n\ntwo changed\n\nthree\n\nfour')
  assert.deepEqual([...d.citable].sort(), ['¶2', '¶4'])
  assert.match(d.text, /\[¶1 · unchanged — context, not citable\]/)
  assert.match(d.text, /\[¶2 · changed\]\ntwo changed\n\(it read, before: two\)/)
  const gone = acceptedDiff('one\n\ntwo', 'one')
  assert.deepEqual([...gone.citable], ['-¶2'])
})

// ---- changes to what the record holds (A74-12) -----------------------------

const HELD = [
  { id: 'char.ines', type: 'character' }, { id: 'char.wren', type: 'character' }, { id: 'char.mara', type: 'character' },
  { id: 'obj.log', type: 'object' }, { id: 'place.light', type: 'place' }, { id: 'place.town', type: 'place' },
]
const bctx = () => ({ scene: 'sc.01-1', era: 'era.keeping', taken: new Set<string>(['rel.ines-wren']), entities: HELD, sceneSpan: { start: '1910-11', end: '1910-11' } })
const rel = { class: 'stated' as const, subject: 'char.ines', type: 'relationship', field: 'ally', value: 'char.wren', evidence: ['¶1'] }

test('a relationship that shifts is built as a NEW proposed edge naming both ends', () => {
  const c = buildCandidate(rel, bctx())
  assert.ok(c.ok); if (!c.ok) return
  assert.equal(c.id, 'rel.ines-wren-ally'); assert.equal(c.file, 'canon/relationships.yaml'); assert.equal(c.collection, 'relationships')
  assert.deepEqual([c.record.status, c.record.from, c.record.to, c.record.directed], ['proposed', 'char.ines', 'char.wren', false])
  assert.equal('span' in c.record, false, 'a date the prose did not give is not invented')
  assert.equal(buildCandidate({ ...rel, field: 'mentor', when: '1910-11' }, bctx()).ok && (buildCandidate({ ...rel, field: 'mentor', when: '1910-11' }, bctx()) as { record: { directed: boolean } }).record.directed, true)
  for (const bad of [{ field: 'sibling-ish' }, { value: 'char.nobody' }, { subject: 'char.nobody' }, { value: 'char.ines' }]) {
    assert.equal(buildCandidate({ ...rel, ...bad }, bctx()).ok, false, JSON.stringify(bad))
  }
  assert.equal(buildCandidate(rel, { ...bctx(), entities: undefined }).ok, false, 'an id arc cannot check is not filed')
})

test('an event among held things is built with its place, time and roles; an object can change hands', () => {
  const ev = { class: 'stated' as const, subject: 'obj.log', type: 'event', field: 'event', value: 'The log goes to Wren', evidence: ['¶1'], where: 'place.light', transfer: { to: 'char.wren', from: 'char.ines' } }
  const c = buildCandidate(ev, bctx())
  assert.ok(c.ok); if (!c.ok) return
  assert.equal(c.file, 'canon/events/story/the-log-goes-to-wren.yaml')
  assert.deepEqual(c.record.when, { era: 'era.keeping', date: '1910-11', precision: 'month' })
  assert.deepEqual(c.record.participants, [{ entity: 'obj.log', role: 'passed' }, { entity: 'char.wren', role: 'receives' }, { entity: 'char.ines', role: 'gives' }])
  assert.equal(buildCandidate({ ...ev, subject: 'char.ines' }, bctx()).ok, false, 'only an object changes hands')
  assert.equal(buildCandidate({ ...ev, where: 'char.wren' }, bctx()).ok, false, 'where is a place')
  assert.equal(buildCandidate({ ...ev, transfer: { to: 'char.ghost' } }, bctx()).ok, false)
  assert.equal(buildCandidate(ev, { ...bctx(), era: null }).ok, false, 'no era, no place in time')
  assert.equal(buildCandidate({ ...ev, subject: 'new' }, bctx()).ok, false, 'an event is filed against a record that is there')
})

test('a scalar edit of a record that exists, and a state snapshot, still have no record of their own', () => {
  for (const field of ['wants', 'location', 'condition', 'possessions']) {
    const c = buildCandidate({ class: 'stated', subject: 'char.ines', type: 'character', field, value: 'x', evidence: ['¶1'] }, bctx())
    assert.ok(!c.ok && c.why.startsWith('it would change'), field)
  }
})

test('an edge joins the END of relationships.yaml: every byte that was there is still there', () => {
  const was = fs.readFileSync(path.join(STORY, 'canon/relationships.yaml'), 'utf8')
  const c = buildCandidate(rel, bctx()); assert.ok(c.ok); if (!c.ok) return
  const now = withEdge(was, c.record)
  assert.ok(now.startsWith(was)); assert.match(now.slice(was.length), /^\n  - id: rel\.ines-wren-ally\n    type: relationship\n/)
  assert.equal(withEdge(withEdge(was.trimEnd(), c.record), { ...c.record, id: 'rel.two' }).split('- id: rel.').length, was.split('- id: rel.').length + 2)
  assert.equal(withEdge('relationships: []\n', c.record), 'relationships:\n  - id: rel.ines-wren-ally\n    type: relationship\n    kind: ally\n    status: proposed\n    from: char.ines\n    to: char.wren\n    directed: false\n    summary: Read from the accepted prose of sc.01-1.\n')
})

test('the duplicate key for a held record is id · field · value: an undirected edge answers from both ends', () => {
  const keys = new Set(recordKeys({
    relationships: [{ from: 'char.ines', to: 'char.wren', kind: 'ally', directed: false }, { from: 'char.ines', to: 'place.light', kind: 'controls', directed: true }],
    events: { 'event.x': { title: 'The wreck', participants: [{ entity: 'char.ines' }] } },
  }))
  const k = (subject: string, type: string, field: string, value: string) => proposalKey({ subject, type, field, value })
  assert.ok(keys.has(k('char.wren', 'relationship', 'ally', 'char.ines')))
  assert.ok(keys.has(k('char.ines', 'relationship', 'ally', 'char.wren')))
  assert.ok(!keys.has(k('place.light', 'relationship', 'controls', 'char.ines')), 'a directed edge does not')
  assert.ok(!keys.has(k('char.ines', 'relationship', 'enemy', 'char.wren')), 'a different kind is the shift, not a duplicate')
  assert.ok(keys.has(k('char.ines', 'event', 'whatever the model wrote', 'the  WRECK')))
})

// ---- what the record can prove (arc-core's own checks, asked of a candidate) ----

const world = () => ({
  timeline: { eras: [{ id: 'era.keeping', span: { start: '1908-01-01', end: '1910-12-31' } }] },
  entities: {
    'char.ines': { id: 'char.ines', type: 'character', name: 'Ines', states: [{ at: { era: 'era.keeping', date: '1910' }, location: 'place.light', possessions: ['obj.log'] }] },
    'char.wren': { id: 'char.wren', type: 'character', name: 'Wren', states: [{ at: { era: 'era.keeping', date: '1910' }, location: 'place.light' }] },
    'obj.log': { id: 'obj.log', type: 'object', name: 'Log', states: [] },
    'place.light': { id: 'place.light', type: 'place', name: 'Light' },
    'place.town': { id: 'place.town', type: 'place', name: 'Town' },
  },
  events: {
    'event.supper': { id: 'event.supper', title: 'Supper', when: { era: 'era.keeping', date: '1910-11-02' }, where: 'place.light', participants: [{ entity: 'char.ines', role: 'host' }] },
  },
  relationships: [],
}) as unknown as Parameters<typeof continuityConflict>[0]
const built = (p: Record<string, unknown>, span: { start?: string; end?: string } = { start: '1910-11-02', end: '1910-11-02' }) => {
  const prop = { class: 'stated' as const, subject: 'char.ines', type: 'event', field: 'event', value: 'The market', evidence: ['¶1'], ...p }
  const c = buildCandidate(prop as Parameters<typeof buildCandidate>[0], { ...bctx(), taken: new Set(), sceneSpan: span })
  assert.ok(c.ok, JSON.stringify(c)); return { c: c as Extract<typeof c, { ok: true }>, prop: prop as Parameters<typeof continuityConflict>[2] }
}

test('a person in two places at one time is shown from the record', () => {
  const { c, prop } = built({ where: 'place.town' })
  assert.match(continuityConflict(world(), c, prop)!, /char\.ines is at place\.light .* and place\.town .* in overlapping time/)
  const ok = built({ where: 'place.light' })
  assert.equal(continuityConflict(world(), ok.c, ok.prop), null, 'the same place is no contradiction')
  const later = built({ where: 'place.town', when: '1910-11-09' })
  assert.equal(continuityConflict(world(), later.c, later.prop), null, 'another day is no contradiction')
  const vague = built({ where: 'place.town', when: '1910' })
  assert.equal(continuityConflict(world(), vague.c, vague.prop), null, 'a year the scene does not bear out is dropped, and with it any claim that needs a date')
})

test('an object in two hands is shown; naming who gave it up removes the contradiction', () => {
  const to = built({ subject: 'obj.log', value: 'The log goes to Wren', transfer: { to: 'char.wren' } })
  assert.match(continuityConflict(world(), to.c, to.prop)!, /obj\.log held by char\.ines .* and char\.wren .* no transfer recorded/)
  const given = built({ subject: 'obj.log', value: 'The log goes to Wren', transfer: { to: 'char.wren', from: 'char.ines' } })
  assert.equal(continuityConflict(world(), given.c, given.prop), null)
  const undated = built({ subject: 'obj.log', value: 'The log goes to Wren', transfer: { to: 'char.wren' } }, { start: '1910-11' })
  assert.equal(continuityConflict(world(), undated.c, undated.prop), null, 'no date, no moment to hold it at: no claim')
  const doc = world(); const before = JSON.stringify(doc); continuityConflict(doc, to.c, to.prop)
  assert.equal(JSON.stringify(doc), before, 'the question changes nothing it was asked about')
})

// ---- review fixes (A74-12) ----------------------------------------------------

test('an edge stands only while its id is IN the file every edge lives in; a crash before the append is unfinished', async () => {
  const { unfinishedOrigins } = await import('../src/ledger.ts')
  const relPath = path.join(STORY, 'canon/relationships.yaml')
  const original = fs.readFileSync(relPath, 'utf8')
  const origin = (run: string) => ({ origin: 'update-record' as const, file: 'canon/relationships.yaml', scene: 'sc.01-1', run, canon: 'rel.probe-edge', type: 'relationship', class: 'implied' as const, key: 'probe-key' })
  try {
    recordProposalOrigin(origin('run.edge1'))
    assert.ok(!proposalOrigins().some(o => o.canon === 'rel.probe-edge'), 'the origin names nothing: the file exists, the edge is not in it')
    assert.deepEqual(unfinishedOrigins(() => false, () => false).filter(o => o.canon === 'rel.probe-edge').map(o => o.run), ['run.edge1'], 'a crash between origin and append is reported unfinished')
    fs.writeFileSync(relPath, withEdge(original, { id: 'rel.probe-edge', type: 'relationship', kind: 'friend', status: 'proposed', from: 'char.ines', to: 'char.wren', directed: false, summary: 'x' })!)
    assert.ok(proposalOrigins().some(o => o.canon === 'rel.probe-edge'), 'in the file, it stands')
    assert.ok(!unfinishedOrigins(() => false, () => false).some(o => o.canon === 'rel.probe-edge'))
    fs.writeFileSync(relPath, original)   // the author deleted it by hand
    assert.ok(!proposalOrigins().some(o => o.canon === 'rel.probe-edge'), 'a hand-deleted edge stops blocking')
    const { refusedKeys } = await import('../src/update-record.ts')
    assert.ok(!refusedKeys([]).has('probe-key'), 'and can be proposed again')
    assert.ok(unfinishedOrigins((run, canon) => run === 'run.edge1' && canon === 'rel.probe-edge', () => false).length === 0, 'one the receipt lists as filed is deleted, not unfinished')
  } finally { fs.writeFileSync(relPath, original) }
})

test('the kind is lower-cased, so "Ally" cannot slip past the duplicate gate or a never', () => {
  const r = readProposals(JSON.stringify([{ class: 'stated', subject: 'char.ines', type: 'Relationship', field: ' Ally ', value: 'char.wren', evidence: ['¶2'] }]))!
  assert.equal(r.proposals[0].field, 'ally')
  const k = (field: string) => proposalKey({ subject: 'char.ines', type: 'relationship', field, value: 'char.wren' })
  assert.equal(k('Ally'), k('ally'))
  const held = new Set([k('ally')])
  assert.equal(outcome(run([{ ...r.proposals[0] }], { refused: held })).dropped[0].gate, 'duplicate')
})

test('a double-booked object already in the book is not blamed on a hand-over of another', () => {
  const doc = world() as unknown as { entities: Record<string, { states: { at: unknown; possessions?: string[] }[] }> }
  doc.entities['obj.z'] = { id: 'obj.z', type: 'object', states: [] } as never
  doc.entities['char.ines'].states[0].possessions = ['obj.log', 'obj.z']
  doc.entities['char.wren'].states[0].possessions = ['obj.z']   // Z is in two hands before this proposal
  const given = built({ subject: 'obj.log', value: 'The log goes to Wren', transfer: { to: 'char.wren', from: 'char.ines' } })
  assert.equal(continuityConflict(doc as never, given.c, given.prop), null)
  const taken = built({ subject: 'obj.log', value: 'The log goes to Wren', transfer: { to: 'char.wren' } })
  assert.match(continuityConflict(doc as never, taken.c, taken.prop)!, /obj\.log/, 'its own contradiction is still shown')
})

test('a date is kept only inside the scene, and an open-ended span is not a moment', async () => {
  const { datedBy } = await import('../src/proposals.ts')
  const one = { start: '1910-11', end: '1910-11' }
  assert.deepEqual(datedBy(undefined, one), { date: '1910-11', trimmed: false })
  assert.deepEqual(datedBy('1910-11-02', one), { date: '1910-11-02', trimmed: false })
  assert.deepEqual(datedBy('1910', one), { date: null, trimmed: true }, 'wider than the scene')
  assert.deepEqual(datedBy('1911-01-14', one), { date: null, trimmed: true })
  assert.deepEqual(datedBy('1910-11-02', { start: '1910-11' }), { date: null, trimmed: true }, 'no end, no bound to check against')
  assert.deepEqual(datedBy(undefined, { start: '1910-11' }), { date: null, trimmed: false }, 'a span with a start and no end is not one moment')
  assert.deepEqual(datedBy(undefined, { start: '1910-11', end: '1910-12' }), { date: null, trimmed: false })
  const c = buildCandidate({ ...rel, when: '1999' }, bctx())
  assert.ok(c.ok && c.trimmed?.includes('date-outside-scene') && !('span' in c.record))
})

test('the edge joins the list at the list\'s own indentation, and is refused where the list cannot be read safely', () => {
  const record = { id: 'rel.a-b', type: 'relationship', kind: 'friend' }
  const four = 'relationships:\n    - id: rel.old\n      type: relationship\n'
  const grown = withEdge(four, record)!
  assert.ok(grown.startsWith(four)); assert.match(grown.slice(four.length), /\n    - id: rel\.a-b\n      type: relationship\n/)
  assert.match(withEdge('# c\nrelationships:\n- id: rel.old\n  type: relationship\n# end\n', record)!, /\n- id: rel\.a-b\n  type: relationship\n/, 'a list flush with its key stays flush')
  assert.equal(withEdge('relationships: []\n', record), 'relationships:\n  - id: rel.a-b\n    type: relationship\n    kind: friend\n', 'the empty list holds no record: that one line becomes a block list')
  assert.equal(withEdge('relationships: [ {id: rel.old} ]\n', record), null, 'a flow list with items')
  assert.equal(withEdge('story: x\n', record), null, 'no relationships key')
  assert.equal(withEdge('relationships:\n  - id: rel.old\nextra: 1\n', record), null, 'something follows the list')
  const refused = buildCandidate(rel, { ...bctx(), relationshipsText: 'relationships: [ {id: rel.old} ]\n' })
  assert.ok(!refused.ok && refused.why.includes('cannot safely add to'))
})

test('a note that lifts the scene\'s words leaves the record and is counted; a title that does is refused', () => {
  const copies = (t: string) => t.includes('lifted')
  const c = buildCandidate({ ...rel, note: 'a lifted sentence' }, { ...bctx(), copiesScene: copies })
  assert.ok(c.ok && c.record.summary === 'Read from the accepted prose of sc.01-1.' && c.trimmed?.includes('note-copied'))
  const clean = buildCandidate({ ...rel, note: 'her own words' }, { ...bctx(), copiesScene: copies })
  assert.ok(clean.ok && clean.record.summary === 'her own words' && !clean.trimmed)
  const ev = { class: 'stated' as const, subject: 'char.ines', type: 'event', field: 'event', value: 'a lifted title', evidence: ['¶1'] }
  assert.ok(!buildCandidate(ev, { ...bctx(), copiesScene: copies }).ok)
  const obj = { class: 'stated' as const, subject: 'new', type: 'object', field: 'name', value: 'The shears', note: 'lifted here', evidence: ['¶1'] }
  const o = buildCandidate(obj, { ...bctx(), copiesScene: copies })
  assert.ok(o.ok && o.article!.text.includes('Named in sc.01-1.') && !o.article!.text.includes('lifted'))
})

test('the contradiction record names where the contradiction came from', () => {
  const r = run([P()], { conflict: () => ({ message: 'x', by: "arc-core's continuity checks (CanonGraph.checks)" }) })
  assert.match(r.gates.find(g => g.gate === 'contradiction')!.bar_from!, /continuity checks/)
  const none = run([P()])
  assert.match(none.gates.find(g => g.gate === 'contradiction')!.bar_from!, /own names and arc-core's continuity checks/)
})

// ---- the gates, on hand-built inputs ---------------------------------------

const hand = (over: Partial<NonNullable<ReturnType<typeof gateCtx>['proposals']>> = {}) => ({
  ...gateCtx({ sceneName: 'sc.01-1', sceneBody: 'x', sceneLocks: [], lockedTexts: [], literals: ['her sister'], andCap: null, wordCap: null, destination: [] }),
  proposals: {
    evidence: new Set(['¶2']),
    validate: () => ({ ok: true, output: '' }),
    refused: new Set<string>(),
    keyOf: proposalKey,
    conflict: () => null,
    ...over,
  },
})
const P = (over: object = {}) => ({ class: 'stated', subject: 'new', type: 'object', field: 'name', value: 'The lantern', evidence: ['¶2'], ...over })
const run = (ps: object[], over = {}) => runRowGates(ROW_UPDATE_RECORD_SCENE, hand(over), JSON.stringify(ps))
const outcome = (r: ReturnType<typeof run>) => {
  assert.ok(r.ok, r.ok ? '' : r.reason)
  return JSON.parse(r.body) as { proposals: { value: string; proven_conflict?: string }[]; dropped: { gate: string; why: string }[] }
}

test('every gate holds on a proposal that deserves it, and the receipt names each', () => {
  const r = run([P()])
  const o = outcome(r)
  assert.equal(o.proposals.length, 1)
  assert.deepEqual(r.gates.map(g => g.gate), ['shape', 'withhold-literals', 'validator', 'evidence-resolves', 'duplicate', 'contradiction'])
  assert.ok(r.gates.every(g => g.verdict === 'held'))
})

test('validator: a candidate that does not validate is dropped, the rest stand', () => {
  const o = outcome(run([P({ value: 'Bad' }), P({ value: 'Good' })], { validate: (p: { value: string }) => p.value === 'Bad' ? { ok: false, output: 'x', sentence: 'it does not fit' } : { ok: true, output: '' } }))
  assert.deepEqual(o.proposals.map(p => p.value), ['Good'])
  assert.deepEqual(o.dropped.map(d => [d.gate, d.why]), [['validator', 'it does not fit']])
})

test('evidence-resolves: an id outside the accepted change, or no id at all, drops that proposal', () => {
  const o = outcome(run([P({ evidence: ['¶9'] }), P({ evidence: [] }), P({ evidence: ['She counted.'] }), P({ evidence: ['p2'] })]))
  assert.equal(o.proposals.length, 1)
  assert.deepEqual(o.dropped.map(d => d.gate), ['evidence-resolves', 'evidence-resolves', 'evidence-resolves'])
})

test('duplicate: a key the book holds refuses, and so does a second proposal for the same thing in one answer', () => {
  const held = new Set([proposalKey({ subject: 'new', type: 'object', field: 'name', value: 'The lantern' })])
  assert.equal(outcome(run([P()], { refused: held })).dropped[0].gate, 'duplicate')
  const o = outcome(run([P(), P({ value: 'the  LANTERN' })]))
  assert.equal(o.proposals.length, 1); assert.equal(o.dropped[0].gate, 'duplicate')
})

test('contradiction: shown where code can show it, filed WITH it, never dropped', () => {
  const o = outcome(run([P()], { conflict: () => 'The lantern is already obj.x' }))
  assert.equal(o.proposals.length, 1); assert.equal(o.proposals[0].proven_conflict, 'The lantern is already obj.x')
})

test('withhold-literals: what the contract keeps silent is never proposed', () => {
  const o = outcome(run([P({ value: 'her sister' }), P({ note: 'she left her sister behind' })]))
  assert.equal(o.proposals.length, 0); assert.deepEqual(o.dropped.map(d => d.gate), ['withhold-literals', 'withhold-literals'])
})

test('an answer that cannot be read ends unreadable; a gate with nothing to measure against could not judge, which is not a gate that found nothing', () => {
  const r = runRowGates(ROW_UPDATE_RECORD_SCENE, hand(), 'I have no proposals')
  assert.ok(!r.ok && r.unreadable)
  const bare = { ...hand(), proposals: undefined }
  const out = runRowGates(ROW_UPDATE_RECORD_SCENE, bare, JSON.stringify([P()]))
  assert.ok(!out.ok, 'the run fails honestly instead of landing with "nothing to add"')
  assert.ok(out.gates.some(g => g.verdict === 'could not judge'))
})

test('contradiction: the receipt record carries how many were shown and what they are', () => {
  const r = run([P(), P({ value: 'Other' })], { conflict: (p: { value: string }) => p.value === 'Other' ? 'Other is already place.x' : null })
  const g = r.gates.find(x => x.gate === 'contradiction')!
  assert.equal(g.measured, 1); assert.deepEqual(g.measured_against, ['Other is already place.x'])
})

test('narrative notes of what the scene binds reach the brief as the suppression slot', () => {
  const canon = { entities: { 'char.wren': { narrative_notes: 'Wren must not be given\n interiority.' } }, events: { 'event.x': { narrative_notes: 'Keep the count.' } } }
  const text = narrativeNotes(canon, { facts: ['char.wren', 'rel.none'], events: ['event.x'] })
  assert.equal(text, 'char.wren: Wren must not be given interiority.\nevent.x: Keep the count.')
})

test('the origin ledger: a tombstone kills an origin for good, and a retraction is never read as arc-filed', () => {
  const file = 'canon/entities/objects/tomb.yaml'
  recordProposalOrigin({ origin: 'update-record', scene: 'sc.01-1', run: 'run.tomb', canon: 'obj.tomb', file, class: 'stated', key: 'k' })
  fs.writeFileSync(path.join(STORY, file), 'id: obj.tomb\n')
  assert.ok(proposalOrigins().some(o => o.canon === 'obj.tomb'), 'alive while its file stands')
  recordProposalOrigin({ origin: 'update-record', scene: 'sc.01-1', run: 'run.tomb', canon: 'obj.tomb', file, reverted: true })
  assert.ok(!proposalOrigins().some(o => o.canon === 'obj.tomb'), 'a tombstone wins over the path existing')
  fs.rmSync(path.join(STORY, file))
}
)

// ---- the whole pass, on the stub ---------------------------------------------

const exists = (rel: string) => fs.existsSync(path.join(STORY, rel))

test('an accept yields typed proposals with no key configured; what is filed validates', async () => {
  delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN
  const logPath = path.join(STORY, 'docs/style.evidence.jsonl')
  const logBefore = fs.existsSync(logPath) ? fs.readFileSync(logPath) : null
  const res = await runUpdateRecord('sc.01-1')
  // filing a proposal writes nothing to the evidence log (A74-2): only the author's decision does
  assert.deepEqual(fs.existsSync(logPath) ? fs.readFileSync(logPath) : null, logBefore, 'the log is byte-for-byte what it was')
  assert.deepEqual([res.proposed, res.dropped, res.refused], [2, 4, 1], JSON.stringify(res))
  assert.deepEqual(res.filed.map(f => [f.id, f.class]).sort(), [['obj.keepers-log', 'retracted'], ['obj.the-barometer', 'stated']])
  // the proposal is a canon file with status: proposed, plus the article the validator wants
  const rec = fs.readFileSync(path.join(STORY, 'canon/entities/objects/the-barometer.yaml'), 'utf8')
  assert.match(rec, /^status: proposed$/m)
  assert.doesNotMatch(rec, /capture/i)
  assert.ok(exists('docs/entities/objects/the-barometer.md'))
  // nothing withheld, nothing duplicated, nothing invented, nothing editing a record that exists
  for (const f of ['her-sister', 'the-stairs', 'the-sill', 'wren-2']) assert.ok(!fs.existsSync(path.join(STORY, 'canon/entities/characters', `${f}.yaml`)) && !exists(`canon/entities/places/${f}.yaml`) && !exists(`canon/entities/objects/${f}.yaml`), f)
  assert.ok(validateStory().ok, validateStory().output)
  // the retraction removed nothing
  assert.match(fs.readFileSync(path.join(STORY, 'canon/entities/objects/keepers-log.yaml'), 'utf8'), /^status: proposed$/m)
  // nothing is committed: the proposal is a working-tree file
  assert.match(git(STORY, 'status', '--porcelain', 'canon'), /the-barometer\.yaml/)
  // origin is in the ledger, before the file, with the class and the range
  const origins = proposalOrigins().filter(o => o.run === res.run)
  assert.deepEqual(origins.map(o => o.class), ['stated'], 'a retraction is not an origin arc filed')
  assert.deepEqual(retractionOrigins().filter(o => o.run === res.run).map(o => o.canon), ['obj.keepers-log'])
  const mine = origins.find(o => o.canon === 'obj.the-barometer')!
  assert.deepEqual(mine.evidence, ['¶5']); assert.equal(mine.scene, 'sc.01-1'); assert.ok(mine.range!.from && mine.range!.to); assert.match(mine.key!, /^[0-9a-f]{16}$/)
  // the working receipt exists, names the gates and the records
  const receipt = readWorkingReceipt(res.run)!
  assert.equal(receipt.ending, 'landed')
  assert.deepEqual(receipt.result.records.sort(), ['obj.keepers-log', 'obj.the-barometer'])
  assert.ok(fs.existsSync(path.join(STORY, '.arc', 'runs', res.run, 'receipt.yaml')))
  assert.deepEqual(receipt.gates!.filter(g => g.verdict === 'held').map(g => g.gate).slice(0, 2), ['shape', 'withhold-literals'])
  assert.equal(receipt.cell!.job, 'update-record')
  // the follow-up card measures what U7 would have changed in existing records
  assert.equal(receipt.evidence!.dropped.find(d => d.reason === 'existing-record')?.count, 1)
})

test('asked again, the same answer is refused as duplicates: nothing is filed twice', async () => {
  const res = await runUpdateRecord('sc.01-1', undefined, undefined, { rerun: true })
  assert.equal(res.proposed, 0, 'the proposed barometer and the retraction are both already waiting')
  assert.ok(res.refused >= 3, JSON.stringify(res))
})

test('a change to what the record holds is filed beside it: every file that existed is byte-equal, a relationship file only grows at its end', async () => {
  const { createHash } = await import('node:crypto')
  const snapshot = (): Map<string, string> => {
    const out = new Map<string, string>()
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(path.join(STORY, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name)
        if (e.isDirectory()) walk(rel)
        else out.set(rel, createHash('sha256').update(fs.readFileSync(path.join(STORY, rel))).digest('hex'))
      }
    }
    walk('canon'); walk('docs'); walk('prose')
    return out
  }
  const relBefore = fs.readFileSync(path.join(STORY, 'canon/relationships.yaml'), 'utf8')
  const before = snapshot()
  process.env.STUB_ANSWER = '```json\n' + JSON.stringify([
    { class: 'implied', subject: 'char.ines', type: 'relationship', field: 'Guardian', value: 'char.wren', evidence: ['¶5'], when: '1999-01-01', note: 'Wren took it in one long stride that skipped it altogether.' },
    { class: 'stated', subject: 'obj.keepers-log', type: 'event', field: 'event', value: 'Wren takes the log', evidence: ['¶5'], transfer: { to: 'char.wren' }, where: 'place.whitcombe-light' },
    { class: 'stated', subject: 'char.ines', type: 'character', field: 'condition', value: 'tired', evidence: ['¶5'] },
    { class: 'stated', subject: 'char.ines', type: 'character', field: 'location', value: 'place.whitcombe-light', evidence: ['¶5'] },
    { class: 'implied', subject: 'char.ines', type: 'relationship', field: 'guardian', value: 'char.wren', evidence: ['¶5'] },
  ]) + '\n```'
  try {
    const res = await runUpdateRecord('sc.01-1', undefined, undefined, { rerun: true })
    assert.deepEqual([res.proposed, res.dropped, res.refused], [2, 2, 1], JSON.stringify(res))
    const after = snapshot()
    const touched = [...after].filter(([f, h]) => before.get(f) !== h).map(([f]) => f)
    assert.deepEqual(touched, ['canon/relationships.yaml', ...touched.filter(f => f.startsWith('canon/events/'))].sort(), 'the only existing file that changed is the one every edge lives in')
    assert.ok(fs.readFileSync(path.join(STORY, 'canon/relationships.yaml'), 'utf8').startsWith(relBefore), 'and it only grew at its end')
    for (const f of before.keys()) if (f !== 'canon/relationships.yaml') assert.equal(after.get(f), before.get(f), `${f} is byte-equal`)
    assert.ok(validateStory().ok, validateStory().output)
    assert.deepEqual(res.filed.map(f => [f.id, f.type, f.about]).sort(), [['event.wren-takes-the-log', 'event', 'obj.keepers-log'], ['rel.ines-wren-guardian', 'relationship', 'char.ines']])
    assert.match(res.filed.find(f => f.type === 'event')!.proven_conflict ?? '', /no transfer recorded/)
    const receipt = readWorkingReceipt(res.run)!
    assert.equal(receipt.evidence!.dropped.find(d => d.reason === 'existing-record')?.count, 2, 'the scalar edits are counted')
    assert.equal(receipt.gates!.find(g => g.gate === 'contradiction')!.measured, 1)
    assert.match(receipt.gates!.find(g => g.gate === 'contradiction')!.bar_from!, /continuity checks/, 'the receipt says where the contradiction came from')
    assert.deepEqual(receipt.result.records.sort(), ['event.wren-takes-the-log', 'rel.ines-wren-guardian'])
    // a date the scene does not bear out and a note that copies the scene are left out of the record, and counted
    assert.equal(receipt.evidence!.dropped.find(d => d.reason === 'date-outside-scene')?.count, 1)
    assert.equal(receipt.evidence!.dropped.find(d => d.reason === 'note-copied')?.count, 1)
    const edge = fs.readFileSync(path.join(STORY, 'canon/relationships.yaml'), 'utf8').split('- id: rel.ines-wren-guardian')[1]
    assert.doesNotMatch(edge, /span:|one long stride/)
    // asked again, the same two are duplicates of what is now waiting
    const again = await runUpdateRecord('sc.01-1', undefined, undefined, { rerun: true })
    assert.equal(again.proposed, 0)
  } finally { delete process.env.STUB_ANSWER }
})

// ---- the route -----------------------------------------------------------------

const { createArcServer } = await import('../src/server.ts')
const server = createArcServer()
await new Promise<void>(resolve => server.listen(0, resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
test.after(() => server.close())
const post = (p: string, body: unknown) =>
  fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('POST /api/record/update: validation, the counts and a run id; an unreadable answer files nothing', async () => {
  // an accept nobody has read yet: the earlier tests read every one before it
  { const abs = path.join(STORY, SCENE_FILE); fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace('Then the log', 'Then the log, once more')); git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'prose: accept again', '-m', 'Arc-Lane: accept') }
  assert.equal((await post('/api/record/update', {})).status, 400)
  assert.equal((await post('/api/record/update', { scene: 'sc.99-9' })).status, 404)
  assert.equal((await post('/api/record/update', { scene: 'sc.01-1', from: 'not-a-commit' })).status, 400)
  const tracked = () => git(STORY, 'status', '--porcelain').split('\n').filter(l => !l.includes('.arc/')).join('\n')   // .arc/ is the novel's ignored workspace
  const before = tracked()
  process.env.STUB_ANSWER = 'I could not decide'
  try {
    const res = await post('/api/record/update', { scene: 'sc.01-1' })
    assert.equal(res.status, 200)
    const body = await res.json() as { run: string; proposed: number; reply: string }
    assert.ok(body.run); assert.equal(body.proposed, 0); assert.match(body.reply, /could not read|shape/)
    assert.equal(tracked(), before, 'and nothing was written')
    assert.equal(readWorkingReceipt(body.run)!.ending, 'unreadable')
  } finally { delete process.env.STUB_ANSWER }
})

test('on the sdk engine the pass refuses in one sentence, and writes nothing', async () => {
  const before = git(STORY, 'status', '--porcelain')
  process.env.ARC_DRAFT_ENGINE = 'sdk'
  process.env.ANTHROPIC_API_KEY = 'a-key-that-must-never-be-used'   // the SDK is chosen only with one (A78-1)
  try {
    const res = await post('/api/record/update', { scene: 'sc.01-1' })
    assert.equal(res.status, 400)
    assert.match((await res.json() as { error: string }).error, /cannot show what that reading was given/)
    assert.equal(git(STORY, 'status', '--porcelain'), before)
  } finally { process.env.ARC_DRAFT_ENGINE = 'claude-cli'; delete process.env.ANTHROPIC_API_KEY }
})

// ---- through an accept ----------------------------------------------------------

test('an accept answers at once, and the proposals appear after the response, with their origin (the episode, A74-3)', async () => {
  const abs = path.join(STORY, SCENE_FILE)
  fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace('The wind did what it did.', 'The wind did what it did, and rattled the storm lantern.'))
  const bases = (await (await fetch(`${base}/api/prose`)).json() as { bases: Record<string, string> }).bases
  process.env.STUB_ANSWER = '```json\n' + JSON.stringify([
    { class: 'stated', subject: 'new', type: 'object', field: 'name', value: 'The storm lantern', evidence: ['¶7'], note: 'It rattles in the wind.', conflicts_with: 'obj.keepers-log' },
  ]) + '\n```'
  try {
    const res = await post('/api/prose/accept', { message: 'prose: accept the wind', files: [SCENE_FILE], bases })
    assert.equal(res.status, 200)
    const body = await res.json() as { hash: string; capture?: unknown }
    assert.equal(body.capture, undefined, 'the response does not carry the read')
    await new Promise(r => setTimeout(r, 50)); await episodesSettled()
    assert.match(fs.readFileSync(path.join(STORY, 'canon/entities/objects/the-storm-lantern.yaml'), 'utf8'), /^status: proposed$/m)
    const o = proposalOrigins().find(x => x.canon === 'obj.the-storm-lantern')!
    assert.ok(o, 'its origin is in the ledger')
    assert.equal(o.argued_conflict, 'obj.keepers-log')
    assert.equal(o.range!.to, git(STORY, 'rev-parse', body.hash).trim())
    // and it was not committed: the proposal waits for the author
    assert.match(git(STORY, 'status', '--porcelain', 'canon'), /the-storm-lantern\.yaml/)
  } finally { delete process.env.STUB_ANSWER }
})

test('what the author said never to is refused under a fresh id (A74-2)', async () => {
  const { refusedKeys } = await import('../src/update-record.ts')
  const { appendProposalDecision } = await import('../src/evidence.ts')
  const key = proposalKey({ subject: 'new', type: 'object', field: 'name', value: 'The lantern hook' })
  assert.ok(!refusedKeys([]).has(key))
  appendProposalDecision({ id: 'obj.lantern-hook', class: 'stated', key, scene: 'sc.01-1', run: 'run.0100', verdict: 'never' })
  assert.ok(refusedKeys([]).has(key))
})
