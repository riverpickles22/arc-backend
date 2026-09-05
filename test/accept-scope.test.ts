// A scene-scoped accept: the author read ONE scene's diff and ratified that
// (A64-3). Everything else in the draft stays pending, and the unscoped call
// is the same code path with no filter — the rest of the suite proves that
// half by continuing to pass unmodified.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { git, makeStory, writeScene } from './fixture.ts'

const STORY = makeStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

const { proseAccept, proseDraft } = await import('../src/story.ts')
const { HttpError } = await import('../src/http.ts')

const A = 'prose/ch-01/scene-01.md'
const B = 'prose/ch-01/scene-02.md'

const seed = () => {
  git(STORY, 'checkout', 'HEAD', '--', '.'); git(STORY, 'clean', '-fdq')
  writeScene(STORY, A, 'sc.01-1', 'The first scene, as the book has it.')
  writeScene(STORY, B, 'sc.01-2', 'The second scene, as the book has it.')
  git(STORY, 'add', '-A')
  if (git(STORY, 'status', '--porcelain').trim()) git(STORY, 'commit', '-qm', 'prose: two scenes')
}

const edit = (file: string, body: string) => {
  const abs = path.join(STORY, file)
  const raw = fs.readFileSync(abs, 'utf8')
  fs.writeFileSync(abs, raw.replace(/---\n\n[\s\S]*$/, `---\n\n${body}\n`))
}

test('accepting one scene leaves every other pending scene pending', () => {
  seed()
  edit(A, 'The first scene, revised.')
  edit(B, 'The second scene, revised.')
  assert.equal(proseDraft().changes.length, 2)

  const out = proseAccept(undefined, [A])
  assert.deepEqual(out.files, [A])

  // B is still waiting, and A is in the book.
  const after = proseDraft().changes
  assert.deepEqual(after.map(c => c.file), [B])
  assert.match(git(STORY, 'show', `HEAD:${A}`), /The first scene, revised\./)
  assert.match(git(STORY, 'show', `HEAD:${B}`), /The second scene, as the book has it\./)
})

test('the commit message names the scene it ratified, and the author\'s own wins', () => {
  seed()
  edit(A, 'Named by the pass.')
  proseAccept(undefined, [A])
  assert.match(git(STORY, 'log', '-1', '--format=%s'), /sc\.01-1/)

  seed()
  edit(A, 'Named by the author.')
  proseAccept('prose: the doorway, slower', [A])
  assert.equal(git(STORY, 'log', '-1', '--format=%s').trim(), 'prose: the doorway, slower')
})

test('a scope naming nothing pending is refused, and nothing is committed', () => {
  seed()
  edit(A, 'Only this one is pending.')
  const before = git(STORY, 'rev-parse', 'HEAD').trim()
  assert.throws(() => proseAccept(undefined, [B]), (e: unknown) =>
    e instanceof HttpError && e.status === 409 && e.message.includes(B))
  assert.equal(git(STORY, 'rev-parse', 'HEAD').trim(), before)
  assert.equal(proseDraft().changes.length, 1)
})

test('no scope still takes the whole draft', () => {
  seed()
  edit(A, 'Both go together.')
  edit(B, 'Both go together.')
  const out = proseAccept()
  assert.deepEqual(out.files.sort(), [A, B])
  assert.equal(proseDraft().changes.length, 0)
})

test('a scene the draft deletes can be accepted alone', () => {
  seed()
  fs.rmSync(path.join(STORY, B))
  edit(A, 'Untouched by this accept.')
  const out = proseAccept(undefined, [B])
  assert.deepEqual(out.files, [B])
  assert.throws(() => git(STORY, 'show', `HEAD:${B}`))
  assert.deepEqual(proseDraft().changes.map(c => c.file), [A])
})
