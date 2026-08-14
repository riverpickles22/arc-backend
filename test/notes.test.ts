// Notes. The property under test is the one the first design got wrong:
// writing a thought down must not be able to fail for an interesting reason.
// No model, no engine, no pipeline — a note is a file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeStory } from './fixture.ts'

const STORY = makeStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'   // deliberately: filing must work anyway

const { addNote, listNotes, readNote, updateNote, deleteNote, markWorked } = await import('../src/notes.ts')
const { workNote } = await import('../src/work.ts')

const NOTES = path.join(STORY, 'notes')

test('filing a note works with no engine configured at all', () => {
  const note = addNote('the hunters come back in the Special Period', new Date('2026-08-13T10:00:00Z'))
  assert.equal(note.text, 'the hunters come back in the Special Period')
  assert.equal(note.created, '2026-08-13T10:00:00.000Z')
  assert.equal(note.id, 'note.2026-08-13T10-00-00-000Z')
  assert.deepEqual(note.worked, [])
  assert.ok(fs.existsSync(path.join(NOTES, note.file)), 'and it is on disk immediately')
})

test('a note is markdown with frontmatter — readable by a person with an editor', () => {
  const note = addNote('a radio that stops being mentioned', new Date('2026-08-13T11:00:00Z'))
  const raw = fs.readFileSync(path.join(NOTES, note.file), 'utf8')
  assert.match(raw, /^---\nid: note\./)
  assert.match(raw, /created: 2026-08-13T11:00:00\.000Z/)
  assert.match(raw, /worked: \[\]/)
  assert.match(raw, /\n\na radio that stops being mentioned\n$/)
})

test('an empty note is refused and writes nothing', () => {
  const before = listNotes().length
  for (const empty of ['', '   ', '\n\t ']) {
    assert.throws(() => addNote(empty), (e: unknown) => (e as { status?: number }).status === 400)
  }
  assert.equal(listNotes().length, before)
})

test('notes come back newest first, with their text intact', () => {
  const notes = listNotes()
  assert.equal(notes[0].created, '2026-08-13T11:00:00.000Z', 'newest first')
  assert.equal(notes[0].text, 'a radio that stops being mentioned')
})

test('multi-paragraph notes survive the round trip', () => {
  const body = 'first thought\n\nsecond thought, after a blank line\n\n- and a list item'
  const note = addNote(body, new Date('2026-08-13T12:00:00Z'))
  assert.equal(readNote(note.file).text, body)
})

test('a note can be revised, keeping its id and its stamp', () => {
  const note = addNote('half a thought', new Date('2026-08-13T13:00:00Z'))
  const revised = updateNote(note.file, 'the whole thought, written out properly')
  assert.equal(revised.text, 'the whole thought, written out properly')
  assert.equal(revised.id, note.id, 'the id is what makes it findable later')
  assert.equal(revised.created, note.created)
  assert.match(fs.readFileSync(path.join(NOTES, note.file), 'utf8'), /written out properly/)

  assert.throws(() => updateNote(note.file, '  '), (e: unknown) => {
    const err = e as { status?: number; message?: string }
    return err.status === 400 && /delete it instead/.test(err.message ?? '')
  })
})

test('a note can be deleted, and its name is a handle rather than a path', () => {
  const note = addNote('throwaway', new Date('2026-08-13T14:00:00Z'))
  deleteNote(note.file)
  assert.equal(fs.existsSync(path.join(NOTES, note.file)), false)

  for (const bad of ['../../secrets.md', 'nested/x.md', '..', 'x.txt', '']) {
    assert.throws(() => deleteNote(bad), (e: unknown) => (e as { status?: number }).status === 400, `should refuse ${bad}`)
  }
  assert.throws(() => deleteNote('2000-01-01T00-00-00-000Z.md'), (e: unknown) => (e as { status?: number }).status === 404)
})

test('worked runs are recorded on the note, and never recorded twice', () => {
  const note = addNote('something to work in', new Date('2026-08-13T15:00:00Z'))
  markWorked(note.file, 'run.0007')
  markWorked(note.file, 'run.0007')
  markWorked(note.file, 'run.0008')
  assert.deepEqual(readNote(note.file).worked, ['run.0007', 'run.0008'])
})

test('working a note needs an engine; filing one never did', async () => {
  const note = addNote('a thought to interpret', new Date('2026-08-13T16:00:00Z'))
  await assert.rejects(workNote(note.file), (e: unknown) => {
    const err = e as { status?: number; message?: string }
    return err.status === 503 && /note is untouched/.test(err.message ?? '')
  })
  assert.equal(readNote(note.file).text, 'a thought to interpret', 'and it really is untouched')
})

test('dumps written under the old design are migrated, losing nothing', () => {
  const legacy = path.join(STORY, '.arc', 'dumps')
  fs.mkdirSync(legacy, { recursive: true })
  fs.writeFileSync(path.join(legacy, '2026-08-01T09-00-00-000Z.md'),
    '2026-08-01T09:00:00.000Z\n\nan older thought\n\nwith two paragraphs\n')

  const notes = listNotes()
  const moved = notes.find(n => n.file === '2026-08-01T09-00-00-000Z.md')
  assert.ok(moved, 'the old dump is now a note')
  assert.equal(moved!.text, 'an older thought\n\nwith two paragraphs')
  assert.equal(moved!.created, '2026-08-01T09:00:00.000Z', 'its original stamp is kept')
  assert.equal(fs.existsSync(path.join(legacy, '2026-08-01T09-00-00-000Z.md')), false, 'and it is not left behind in two places')
})

test('notes/ does not disturb the story validator', async () => {
  const { validateStory } = await import('../src/canon.ts')
  const before = validateStory().output
  addNote('a note that must not affect validation', new Date('2026-08-13T17:00:00Z'))
  assert.equal(validateStory().output, before, 'the notebook is not canon and is not checked')
})
