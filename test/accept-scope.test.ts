// A scene-scoped accept: the author read ONE scene's diff and ratified that
// (A64-3). Everything else in the draft stays pending.
//
// And there is no other kind (A72-1). An accept NAMES the scenes it ratifies;
// the call that named nothing used to stage the whole prose directory, a
// whole-book decision no author ever read. Every name is checked before any
// of them is accepted, so one bad path in a list leaves the book as it was.
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

test('several named scenes go together, and all of them are checked first', () => {
  seed()
  edit(A, 'Both go together.')
  edit(B, 'Both go together.')
  const out = proseAccept(undefined, [A, B])
  assert.deepEqual(out.files.sort(), [A, B])
  assert.equal(proseDraft().changes.length, 0)
})

test('an accept that names no scene is refused, and nothing is committed', () => {
  seed()
  edit(A, 'Pending, and nobody has read it.')
  const head = git(STORY, 'rev-parse', 'HEAD').trim()
  for (const scope of [undefined, [], null]) {
    assert.throws(() => proseAccept(undefined, scope as unknown as string[]),
      (e: unknown) => e instanceof HttpError && e.status === 400 && /names the scenes/.test(e.message),
      `scope ${JSON.stringify(scope)} must refuse`)
  }
  assert.equal(git(STORY, 'rev-parse', 'HEAD').trim(), head)
  assert.deepEqual(proseDraft().changes.map(c => c.file), [A])
})

test('a path that is not a scene is refused before any mutation', () => {
  seed()
  edit(A, 'Still pending afterwards.')
  const head = git(STORY, 'rev-parse', 'HEAD').trim()
  const refusals: [unknown, RegExp][] = [
    ['prose', /not a prose file/],                       // the directory, unslashed
    ['prose/', /not a scene file/],                      // the directory itself is not a scene
    ['prose/ch-01', /not a scene file/],                 // a chapter is not a scene
    ['canon/story.yaml', /not a prose file/],            // outside prose entirely
    ['prose/../canon/story.yaml', /not a plain scene/],  // an escape by spelling
    ['prose/ch-01/../ch-01/scene-01.md', /not a plain scene/],
    ['../prose/ch-01/scene-01.md', /not a prose file/],
    ['/etc/passwd', /not a prose file/],
    ['', /named by its path/],
    [42, /named by its path/],
  ]
  for (const [bad, message] of refusals) {
    assert.throws(() => proseAccept(undefined, [bad] as string[]),
      (e: unknown) => e instanceof HttpError && e.status === 400 && message.test(e.message),
      `${JSON.stringify(bad)} must refuse with ${message}`)
  }
  // And a scene named twice: one decision, one name.
  assert.throws(() => proseAccept(undefined, [A, A]),
    (e: unknown) => e instanceof HttpError && e.status === 400 && /twice/.test(e.message))
  // A valid scene beside an invalid one takes nothing: the list is checked
  // before any of it is accepted.
  assert.throws(() => proseAccept(undefined, [A, 'prose/ch-01']),
    (e: unknown) => e instanceof HttpError && e.status === 400)

  assert.equal(git(STORY, 'rev-parse', 'HEAD').trim(), head)
  assert.deepEqual(proseDraft().changes.map(c => c.file), [A])
})

test('a symlink planted in prose/ cannot carry an accept out of the story', () => {
  seed()
  edit(A, 'Pending.')
  const link = path.join(STORY, 'prose', 'elsewhere')
  fs.symlinkSync(path.dirname(STORY), link)
  try {
    assert.throws(() => proseAccept(undefined, ['prose/elsewhere/scene-01.md']),
      (e: unknown) => e instanceof HttpError && e.status === 400 && /escapes prose\//.test(e.message))
  } finally {
    fs.rmSync(link)
  }
})

test('the accept commits the named scene only, and leaves staged work alone', () => {
  seed()
  edit(A, 'The scene the author read.')
  edit(B, 'A scene they have not.')
  // Something unrelated, already staged by the author's own hand.
  fs.appendFileSync(path.join(STORY, 'canon/story.yaml'), '# a line the author staged\n')
  git(STORY, 'add', '--', 'canon/story.yaml')

  const out = proseAccept(undefined, [A])
  assert.deepEqual(out.files, [A])

  // The commit carries A and nothing else of theirs.
  const committed = git(STORY, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean)
  assert.ok(committed.includes(A), committed.join(' '))
  assert.ok(!committed.includes(B), 'a scene the author did not name is not in the commit')
  assert.ok(!committed.some(f => f.startsWith('canon/')), 'and neither is their staged canon edit')
  // Still staged, not lost.
  assert.match(git(STORY, 'status', '--porcelain', '--', 'canon/story.yaml'), /^M /)
  git(STORY, 'reset', '-q', 'HEAD', '--', 'canon'); git(STORY, 'checkout', 'HEAD', '--', 'canon')
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
