// The capability gate (work-graph.md §4). The property under test is the
// one the whole architecture rests on: a worker cannot reach what it was not
// granted, and the refusal tells it how to ask.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from 'js-yaml'
import {
  UNRESTRICTED,
  checkRecordWrite,
  checkPathWrite,
  checkRead,
  covered,
  diffRecords,
  grant,
  mintId,
  readOnly,
  recordsIn,
  slugify,
  typeOfId,
} from '../src/capability.ts'

const CARLOS = 'id: char.carlos\ntype: character\nname: Carlos\nstatus: canon\n'
const RELS = `relationships:
  - id: rel.a
    kind: family
    status: canon
  - id: rel.b
    kind: ally
    status: canon
`
const records = (yaml: string, p = 'canon/x.yaml') => recordsIn(load(yaml), p)
const delta = (before: string | null, after: string, p = 'canon/x.yaml') =>
  diffRecords(before === null ? [] : records(before, p), records(after, p))

// ---- selectors ----------------------------------------------------------

test('selectors match literally, with * as the only metacharacter', () => {
  assert.ok(covered(['*'], 'anything/at.all'))
  assert.ok(covered(['char.*'], 'char.carlos'))
  assert.ok(!covered(['char.*'], 'place.havana'))
  assert.ok(covered(['docs/*'], 'docs/entities/carlos.md'), '* spans separators')
  assert.ok(!covered(['char.carlos'], 'char.carlos-father'), 'exact selector is not a prefix')
})

test('dots in selectors are literal, not regex wildcards', () => {
  assert.ok(!covered(['char.carlos'], 'charxcarlos'))
})

test('typeOfId maps prefixes back to types', () => {
  assert.equal(typeOfId('char.carlos'), 'character')
  assert.equal(typeOfId('obj.photo'), 'object')
  assert.equal(typeOfId('nope.x'), undefined)
})

// ---- reading a canon file into records ----------------------------------

test('recordsIn reads a single-entity file, a collection, and story.yaml', () => {
  assert.deepEqual(records(CARLOS).map(r => r.id), ['char.carlos'])
  assert.deepEqual(records(RELS).map(r => r.id), ['rel.a', 'rel.b'])
  assert.deepEqual(records('title: T\n', 'canon/story.yaml').map(r => r.id), ['story'])
})

test('the delta is semantic: an untouched collection member is not a change', () => {
  const changed = RELS.replace('kind: ally', 'kind: enemy')
  const d = delta(RELS, changed)
  assert.deepEqual(d.modified.map(r => r.id), ['rel.b'])
  assert.equal(d.added.length + d.removed.length, 0)
})

test('reformatting a file with no semantic change is not a write at all', () => {
  const reflowed = 'id: char.carlos\ntype: "character"\nname:    Carlos\nstatus: canon\n'
  const d = delta(CARLOS, reflowed)
  assert.equal(d.added.length + d.modified.length + d.removed.length, 0)
})

// ---- the gate -----------------------------------------------------------

test('UNRESTRICTED passes everything — today\'s chat agent is unchanged', () => {
  assert.ok(checkRecordWrite(UNRESTRICTED, delta(null, CARLOS)).ok)
  assert.ok(checkRecordWrite(UNRESTRICTED, delta(RELS, RELS.replace('ally', 'enemy'))).ok)
  assert.ok(checkPathWrite(UNRESTRICTED, 'docs/vision.md').ok)
})

test('a worker granted one scene cannot reach an unrelated character', () => {
  const cap = grant({ reads: ['*'], writes: ['prose/ch-01/scene-02.md'] })
  const check = checkRecordWrite(cap, delta(CARLOS, CARLOS.replace('Carlos', 'Carlitos')))
  assert.equal(check.ok, false)
  assert.deepEqual(check.denied, ['char.carlos'])
})

test('changing one member of a collection needs authority over that member only', () => {
  const cap = grant({ writes: ['rel.b'] })
  assert.ok(checkRecordWrite(cap, delta(RELS, RELS.replace('kind: ally', 'kind: enemy'))).ok)

  const alsoA = RELS.replace('kind: family', 'kind: rival').replace('kind: ally', 'kind: enemy')
  const check = checkRecordWrite(cap, delta(RELS, alsoA))
  assert.equal(check.ok, false)
  assert.deepEqual(check.denied, ['rel.a'])
})

test('deletion is a write — a removed record needs authority', () => {
  const cap = grant({ writes: ['rel.b'] })
  const onlyB = RELS.split('  - id: rel.a')[0] + RELS.slice(RELS.indexOf('  - id: rel.b'))
  const check = checkRecordWrite(cap, delta(RELS, onlyB))
  assert.equal(check.ok, false)
  assert.deepEqual(check.denied, ['rel.a'])
})

test('PROPOSE covers a record only while it stays proposed', () => {
  const cap = grant({ proposes: ['char.rafael'] })
  const proposed = 'id: char.rafael\ntype: character\nname: Rafael\nstatus: proposed\n'
  assert.ok(checkRecordWrite(cap, delta(null, proposed)).ok)

  const promoted = proposed.replace('proposed', 'canon')
  assert.equal(checkRecordWrite(cap, delta(proposed, promoted)).ok, false, 'promotion to canon is the author\'s act')
})

test('a missing status reads as canon, so PROPOSE alone does not cover it', () => {
  const cap = grant({ proposes: ['char.rafael'] })
  assert.equal(checkRecordWrite(cap, delta(null, 'id: char.rafael\nname: Rafael\n')).ok, false)
})

test('read-only workers are refused every write, including docs', () => {
  const cap = readOnly(['*'])
  assert.equal(checkRecordWrite(cap, delta(null, CARLOS)).ok, false)
  assert.equal(checkPathWrite(cap, 'docs/vision.md').ok, false)
})

test('reads are checked against the path or any id the file holds', () => {
  assert.ok(checkRead(grant({ reads: ['char.*'] }), 'canon/entities/characters/carlos.yaml', ['char.carlos']).ok)
  assert.ok(checkRead(grant({ reads: ['canon/*'] }), 'canon/entities/characters/carlos.yaml', []).ok)
  assert.equal(checkRead(grant({ reads: ['char.*'] }), 'research/notes.md', []).ok, false)
})

// ---- the refusal has to be actionable -----------------------------------

test('SCOPE_EXCEEDED names what was attempted, what was granted, and how to expand', () => {
  const cap = grant({ reads: ['char.carlos'], writes: ['material.*'], creates: [{ type: 'character' }] })
  const msg = checkRecordWrite(cap, delta(null, 'id: char.rafael\ntype: character\nstatus: proposed\n')).message!
  assert.match(msg, /SCOPE_EXCEEDED/)
  assert.match(msg, /create char\.rafael/)
  assert.match(msg, /write {4}material\.\*/)
  assert.match(msg, /mint_id type:character/, 'a held CREATE grant points at minting, not at the planner')
})

test('without a CREATE grant the hint escalates to the planner instead', () => {
  const cap = grant({ writes: ['material.*'] })
  const msg = checkRecordWrite(cap, delta(null, 'id: char.rafael\ntype: character\nstatus: proposed\n')).message!
  assert.match(msg, /CREATE character/)
  assert.doesNotMatch(msg, /mint_id/)
})

test('every denial is reported at once, and granted ids are absent from the list', () => {
  // rel.a is edited (denied), rel.b is renamed to rel.c — so rel.b is removed
  // (granted) and rel.c is added (denied).
  const cap = grant({ writes: ['rel.b'] })
  const check = checkRecordWrite(cap, delta(RELS, RELS.replace('kind: family', 'kind: rival').replace('rel.b', 'rel.c')))
  assert.equal(check.ok, false)
  assert.deepEqual(check.denied!.sort(), ['rel.a', 'rel.c'])
})

// ---- minting ------------------------------------------------------------

test('slugify handles accents, punctuation, and spacing', () => {
  assert.equal(slugify('Inés'), 'ines')
  assert.equal(slugify('Carlos and Rafael'), 'carlos-and-rafael')
  assert.equal(slugify('  El Café!  '), 'el-cafe')
})

test('mintId allocates under the ID conventions and avoids collisions', () => {
  const taken = new Set(['char.rafael', 'char.rafael-2'])
  assert.equal(mintId('character', 'Rafael', new Set()), 'char.rafael')
  assert.equal(mintId('character', 'Rafael', taken), 'char.rafael-3')
  assert.equal(mintId('relationship', 'Carlos and Rafael', new Set()), 'rel.carlos-and-rafael')
})

test('mintId refuses an unknown type or an empty slug', () => {
  assert.throws(() => mintId('protagonist', 'Rafael', new Set()), /unknown type/)
  assert.throws(() => mintId('character', '!!!', new Set()), /no slug/)
})
