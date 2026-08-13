// Reading back and changing what capture filed: the material edit path, and
// the raw dumps. The distinction under test is the one that looks like an
// inconsistency and is not — material DROPS, raw dumps DELETE — so both halves
// are pinned here together.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeStory } from './fixture.ts'

const STORY = makeStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

const { updateMaterial, materialItems } = await import('../src/story.ts')
const { saveRaw, listDumps, deleteDump } = await import('../src/dump.ts')

const MATERIAL = path.join(STORY, 'material')
const write = (name: string, body: string) => {
  fs.mkdirSync(MATERIAL, { recursive: true })
  fs.writeFileSync(path.join(MATERIAL, name), body)
}

write('hog-hunters.yaml', [
  'id: mat.hog-hunters',
  'type: obligation',
  'status: unplaced',
  'body: The hunters come back for the boy.',
  'purpose: The prologue has to pay.',
  '',
].join('\n'))

// A hand-written item whose filename does NOT encode its id — the case that
// breaks any lookup which trusts the filename.
write('loose-note.yaml', [
  'id: mat.a-differently-named-thing',
  'type: motif-idea',
  'status: unplaced',
  'body: A radio that stops being mentioned.',
  '',
].join('\n'))

// ---- editing a filed thought --------------------------------------------

test('editing the body rewrites only that field, leaving the rest of the record alone', () => {
  const out = updateMaterial('mat.hog-hunters', { body: 'The hunters come back for the DOG.' })
  assert.equal(out.body, 'The hunters come back for the DOG.')
  assert.equal(out.type, 'obligation', 'type is structural and untouched')
  assert.equal(out.id, 'mat.hog-hunters')
  assert.equal(out.purpose, 'The prologue has to pay.', 'an unmentioned field is left as it was')

  const onDisk = fs.readFileSync(path.join(MATERIAL, 'hog-hunters.yaml'), 'utf8')
  assert.match(onDisk, /come back for the DOG/)
  assert.match(onDisk, /type: obligation/)
})

test('an item is found by the id inside the file, not by its filename', () => {
  const out = updateMaterial('mat.a-differently-named-thing', { body: 'A radio that goes quiet.' })
  assert.equal(out.body, 'A radio that goes quiet.')
  assert.match(fs.readFileSync(path.join(MATERIAL, 'loose-note.yaml'), 'utf8'), /goes quiet/)
})

test('dropping keeps the file and the id — it is not a deletion', () => {
  updateMaterial('mat.hog-hunters', { status: 'dropped' })
  assert.ok(fs.existsSync(path.join(MATERIAL, 'hog-hunters.yaml')), 'the record survives being dropped')

  const dropped = materialItems().find(i => i.id === 'mat.hog-hunters')
  assert.equal(dropped?.status, 'dropped')
  assert.equal(dropped?.body, 'The hunters come back for the DOG.', 'and keeps everything it knew')

  // and it comes back
  assert.equal(updateMaterial('mat.hog-hunters', { status: 'unplaced' }).status, 'unplaced')
})

test('purpose can be cleared, and an empty body is refused rather than silently deleting', () => {
  assert.equal(updateMaterial('mat.hog-hunters', { purpose: '   ' }).purpose, undefined)
  assert.throws(() => updateMaterial('mat.hog-hunters', { body: '   ' }), (e: unknown) => {
    const err = e as { status?: number; message?: string }
    return err.status === 400 && /drop it instead/.test(err.message ?? '')
  })
})

test('an unknown id is a 404 and an unknown status is a 400', () => {
  assert.throws(() => updateMaterial('mat.never-existed', { body: 'x' }), (e: unknown) => (e as { status?: number }).status === 404)
  assert.throws(() => updateMaterial('mat.hog-hunters', { status: 'deleted' }), (e: unknown) => (e as { status?: number }).status === 400)
})

// ---- the raw dumps -------------------------------------------------------

test('dumps are listed newest first, with the timestamp split from the text', () => {
  saveRaw('the first thing I thought of', '2026-08-10T09:00:00.000Z')
  saveRaw('a later thought\n\nwith its own blank line in it', '2026-08-12T09:00:00.000Z')

  const dumps = listDumps()
  assert.equal(dumps.length, 2)
  assert.equal(dumps[0].at, '2026-08-12T09:00:00.000Z', 'newest first')
  assert.equal(dumps[0].text, 'a later thought\n\nwith its own blank line in it',
    'a dump containing blank lines survives the split intact')
  assert.equal(dumps[1].text, 'the first thing I thought of')
})

test('a dump is deleted outright — unlike material, which is dropped', () => {
  const before = listDumps()
  deleteDump(before[0].file)
  const after = listDumps()
  assert.equal(after.length, before.length - 1)
  assert.equal(after.some(d => d.file === before[0].file), false)
  assert.equal(fs.existsSync(path.join(STORY, '.arc', 'dumps', before[0].file)), false, 'really gone')
})

test('deleting a dump touches no material item', () => {
  const before = materialItems().map(i => i.id).sort()
  saveRaw('something to throw away', '2026-08-13T09:00:00.000Z')
  deleteDump(listDumps()[0].file)
  assert.deepEqual(materialItems().map(i => i.id).sort(), before, 'the filed thoughts are untouched')
})

test('deletion takes a name, never a path — traversal cannot be expressed', () => {
  for (const bad of ['../../secrets.md', 'nested/thing.md', '..', 'notes.txt', '']) {
    assert.throws(() => deleteDump(bad), (e: unknown) => (e as { status?: number }).status === 400, `should refuse: ${bad}`)
  }
  assert.throws(() => deleteDump('2000-01-01T00-00-00-000Z.md'), (e: unknown) => (e as { status?: number }).status === 404)
})

test('no dumps at all is an empty list, not an error', () => {
  for (const d of listDumps()) deleteDump(d.file)
  assert.deepEqual(listDumps(), [])
  fs.rmSync(path.join(STORY, '.arc', 'dumps'), { recursive: true, force: true })
  assert.deepEqual(listDumps(), [], 'and the directory need not exist')
})

test('a story that already fails validation does not lock the author out of their notes', () => {
  // The fixture story has no canon/timeline.yaml, so validateStory() fails for
  // reasons that have nothing to do with material. Editing a thought must
  // still work: blaming this edit for a fault elsewhere would make the notes
  // unreachable exactly when the story most needs untangling.
  const out = updateMaterial('mat.hog-hunters', { body: 'Still editable on a broken story.' })
  assert.equal(out.body, 'Still editable on a broken story.')
  assert.match(fs.readFileSync(path.join(MATERIAL, 'hog-hunters.yaml'), 'utf8'), /Still editable/)
})
