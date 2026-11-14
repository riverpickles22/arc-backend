// The generation ledger: what arc wrote, before the author touched it.
// Git only sees the accepted version, so without this the learning signal
// — the difference between generated and kept — is gone forever.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeStory } from './fixture.ts'

const story = makeStory()
process.env.ARC_STORY_PATH = story
const { recordGenerated, generatedFor, clearGenerated } = await import('../src/ledger.ts')

test('what arc wrote survives the author editing the file', () => {
  const rel = 'prose/ch-02/scene-01.md'
  recordGenerated(rel, 'The generated version.', { engine: 'claude-cli', scene: 'sc.02-1' })
  // the author edits the working tree — the ledger is untouched
  fs.mkdirSync(path.join(story, 'prose/ch-02'), { recursive: true })
  fs.writeFileSync(path.join(story, rel), 'The version the author kept.')
  const got = generatedFor(rel)
  assert.equal(got?.content, 'The generated version.')
  assert.equal(got?.entry.engine, 'claude-cli')
  assert.equal(got?.entry.scene, 'sc.02-1')
})

test('the newest generation for a path wins — regenerating replaces the signal', () => {
  const rel = 'prose/ch-03/scene-01.md'
  recordGenerated(rel, 'first attempt')
  recordGenerated(rel, 'second attempt')
  assert.equal(generatedFor(rel)?.content, 'second attempt')
})

test('a path arc never wrote has no entry — a hand-written scene is not mined', () => {
  assert.equal(generatedFor('prose/ch-99/scene-01.md'), null)
})

test('clearing forgets one path and leaves the others', () => {
  recordGenerated('prose/ch-04/scene-01.md', 'keep me')
  recordGenerated('prose/ch-05/scene-01.md', 'drop me')
  clearGenerated(['prose/ch-05/scene-01.md'])
  assert.equal(generatedFor('prose/ch-05/scene-01.md'), null)
  assert.equal(generatedFor('prose/ch-04/scene-01.md')?.content, 'keep me')
})

test('the ledger lives under .arc/ — working state, never the record', () => {
  assert.ok(fs.existsSync(path.join(story, '.arc', 'drafts.jsonl')))
  assert.ok(fs.existsSync(path.join(story, '.arc', 'generated')))
})

// ---- proposal origins (A74-2) ------------------------------------------------
test('an origin is read back while its canon file stands; the orphan is named, not served', async () => {
  const { recordProposalOrigin, readProposalOrigins, unfinishedOrigins } = await import('../src/ledger.ts')
  const { proposalKey, entityKeys } = await import('../src/proposals.ts')
  const mk = (canon: string, run: string, extra: object = {}) => ({
    origin: 'update-record' as const, file: `canon/entities/objects/${canon}.yaml`, scene: 'sc.02-1', run, canon: `obj.${canon}`,
    type: 'object', class: 'stated' as const, key: proposalKey({ subject: 'new', type: 'object', field: 'name', value: canon }),
    range: { from: 'a1', to: 'a1' }, evidence: ['¶2'], ...extra,
  })
  fs.mkdirSync(path.join(story, 'canon/entities/objects'), { recursive: true })
  fs.writeFileSync(path.join(story, 'canon/entities/objects/kept.yaml'), 'id: obj.kept\n')
  recordProposalOrigin(mk('kept', 'run.0001'))
  recordProposalOrigin(mk('crashed', 'run.0001'))                       // no file: the crash between the writes
  recordProposalOrigin(mk('taken-back', 'run.0001'))
  recordProposalOrigin(mk('taken-back', 'run.0001', { reverted: true })) // tombstone: taken back on purpose
  const served = readProposalOrigins().map(e => e.canon)
  assert.ok(served.includes('obj.kept'))
  assert.ok(!served.includes('obj.crashed') && !served.includes('obj.taken-back'))
  assert.deepEqual(unfinishedOrigins(() => false, () => false).map(e => e.canon), ['obj.crashed'], 'only the unexplained one is unfinished')
  const kept = readProposalOrigins().find(e => e.canon === 'obj.kept')!
  assert.deepEqual([kept.class, kept.scene, kept.run, kept.range, kept.evidence], ['stated', 'sc.02-1', 'run.0001', { from: 'a1', to: 'a1' }, ['¶2']])

  // the key: a new subject is its type and normalised name; an existing one is id · field · value
  const k = (subject: string, value: string, field = 'name') => proposalKey({ subject, type: 'character', field, value })
  assert.equal(k('new', 'Wren'), k('new', '  wREN '), 'case and whitespace do not make a second person')
  assert.notEqual(k('new', 'Wren'), proposalKey({ subject: 'new', type: 'place', field: 'name', value: 'Wren' }))
  assert.notEqual(k('char.a', 'x', 'wants'), k('char.a', 'x', 'fears'))
  assert.equal(k('new', 'Wren'), entityKeys({ type: 'character', name: 'wren' })[0], 'a never on a new person matches under a fresh id')
})
