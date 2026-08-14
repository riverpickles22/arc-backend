// Changing what a run filed: the material edit path.
//
// Material DROPS rather than deleting (conventions §12 — intent history is
// story history). Notes, which the author owns outright, really delete; that
// half lives in notes.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeStory } from './fixture.ts'

const STORY = makeStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

const { updateMaterial, materialItems } = await import('../src/story.ts')

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

test('a story that already fails validation does not lock the author out of their notes', () => {
  // The fixture story has no canon/timeline.yaml, so validateStory() fails for
  // reasons that have nothing to do with material. Editing a thought must
  // still work: blaming this edit for a fault elsewhere would make the notes
  // unreachable exactly when the story most needs untangling.
  const out = updateMaterial('mat.hog-hunters', { body: 'Still editable on a broken story.' })
  assert.equal(out.body, 'Still editable on a broken story.')
  assert.match(fs.readFileSync(path.join(MATERIAL, 'hog-hunters.yaml'), 'utf8'), /Still editable/)
})
