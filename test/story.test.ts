// The git draft layer — the code most able to lose an author's work.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { git, makeStory, writeScene } from './fixture.ts'

const story = makeStory()
process.env.ARC_STORY_PATH = story
const { proseAccept, proseAcceptParagraph, proseDiscard, proseDraft, proseScenes, proseWrite } = await import('../src/story.ts')
const { HttpError } = await import('../src/http.ts')

function reset(): void {
  git(story, 'checkout', 'HEAD', '--', '.')
  git(story, 'clean', '-fdq')
}

test('clean tree reports no changes and real history', () => {
  reset()
  const d = proseDraft()
  assert.equal(d.git, true)
  assert.equal(d.changes.length, 0)
  assert.equal(d.history[0].subject, 'prose: first scene')
})

test('modified/added/deleted statuses, with main bodies', () => {
  reset()
  writeScene(story, 'prose/ch-01/scene-01.md', 'sc.01-1', 'Revised first paragraph.\n\nSecond paragraph.')
  writeScene(story, 'prose/ch-01/scene-02.md', 'sc.01-2', 'A new scene.')
  const d = proseDraft()
  const byFile = new Map(d.changes.map(c => [c.file, c]))
  assert.equal(byFile.get('prose/ch-01/scene-01.md')?.status, 'modified')
  assert.match(byFile.get('prose/ch-01/scene-01.md')?.main?.body ?? '', /Original first paragraph/)
  assert.equal(byFile.get('prose/ch-01/scene-02.md')?.status, 'added')
  assert.equal(byFile.get('prose/ch-01/scene-02.md')?.main, null)

  reset()
  fs.rmSync(path.join(story, 'prose/ch-01/scene-01.md'))
  const d2 = proseDraft()
  assert.equal(d2.changes[0]?.status, 'deleted')
  assert.match(d2.changes[0]?.main?.body ?? '', /Original first paragraph/)
})

test('accept commits prose only — a dirty canon file stays dirty', () => {
  reset()
  writeScene(story, 'prose/ch-01/scene-01.md', 'sc.01-1', 'Accepted revision.')
  fs.appendFileSync(path.join(story, 'canon/story.yaml'), 'logline: dirty\n')

  const result = proseAccept()
  assert.match(result.hash, /^[0-9a-f]{7,}$/)
  assert.deepEqual(result.files, ['prose/ch-01/scene-01.md'])
  assert.equal(proseDraft().changes.length, 0)
  assert.match(git(story, 'log', '-1', '--pretty=%s'), /accept draft \(1 scene\)/)
  // The canon edit must not have been swept into the commit.
  assert.match(git(story, 'status', '--porcelain'), /^ M canon\/story\.yaml/m)

  git(story, 'checkout', 'HEAD', '--', 'canon')
})

test('accept with a custom message uses it', () => {
  writeScene(story, 'prose/ch-01/scene-01.md', 'sc.01-1', 'Another revision.')
  proseAccept('prose: my own words')
  assert.equal(git(story, 'log', '-1', '--pretty=%s').trim(), 'prose: my own words')
})

test('accept with no changes is a 409', () => {
  reset()
  assert.throws(() => proseAccept(), (e: unknown) => e instanceof HttpError && e.status === 409)
})

test('discard reverts a modified file and deletes an added one', () => {
  reset()
  writeScene(story, 'prose/ch-01/scene-01.md', 'sc.01-1', 'Doomed edit.')
  proseDiscard('prose/ch-01/scene-01.md')
  assert.match(fs.readFileSync(path.join(story, 'prose/ch-01/scene-01.md'), 'utf8'), /Original first paragraph|Accepted|Another/)
  assert.equal(proseDraft().changes.length, 0)

  writeScene(story, 'prose/ch-01/scene-03.md', 'sc.01-3', 'Scrap.')
  proseDiscard('prose/ch-01/scene-03.md')
  assert.equal(fs.existsSync(path.join(story, 'prose/ch-01/scene-03.md')), false)
})

test('discard rejects traversal and unknown files', () => {
  reset()
  assert.throws(() => proseDiscard('../etc/passwd'), (e: unknown) => e instanceof HttpError && e.status === 400)
  assert.throws(() => proseDiscard('canon/story.yaml'), (e: unknown) => e instanceof HttpError && e.status === 400)
  assert.throws(() => proseDiscard('prose/../canon/story.yaml'), (e: unknown) => e instanceof HttpError && e.status === 400)
  assert.throws(() => proseDiscard('prose/ch-01/scene-01.md'), (e: unknown) => e instanceof HttpError && e.status === 404)
})

test('a scene in a brand-new chapter directory reports as added (not swallowed as `?? dir/`)', () => {
  reset()
  writeScene(story, 'prose/ch-09/scene-01.md', 'sc.09-1', 'First scene of a new chapter.')
  const d = proseDraft()
  const change = d.changes.find(c => c.file === 'prose/ch-09/scene-01.md')
  assert.ok(change, 'the new-directory scene must appear in the draft changes')
  assert.equal(change.status, 'added')
  fs.rmSync(path.join(story, 'prose/ch-09'), { recursive: true })
})

test('proseWrite replaces the body and leaves the frontmatter byte-identical', () => {
  const file = 'prose/ch-01/scene-01.md'
  const before = fs.readFileSync(path.join(story, file), 'utf8')
  const fm = before.slice(0, before.indexOf('---', 3) + 4)
  proseWrite(file, 'A wholly new body.\n')
  const after = fs.readFileSync(path.join(story, file), 'utf8')
  assert.ok(after.startsWith(fm), 'frontmatter untouched')
  assert.match(after, /A wholly new body\./)
  assert.doesNotMatch(after, /Original first paragraph/)
})

test('proseWrite refuses when the file moved underneath the edit', () => {
  const file = 'prose/ch-01/scene-01.md'
  assert.throws(() => proseWrite(file, 'x', 'a baseline that is not what is on disk'), HttpError)
})

test('proseWrite accepts a baseline that matches, ignoring trailing whitespace', () => {
  const file = 'prose/ch-01/scene-01.md'
  const current = proseScenes().find(s => s.file === file)!.body
  proseWrite(file, 'Second edit.\n', current.trimEnd() + '\n\n')
  assert.match(fs.readFileSync(path.join(story, file), 'utf8'), /Second edit\./)
})

test('proseWrite guards the path and the extension', () => {
  assert.throws(() => proseWrite('canon/story.yaml', 'x'), HttpError)
  assert.throws(() => proseWrite('prose/../canon/story.yaml', 'x'), HttpError)
  assert.throws(() => proseWrite('prose/ch-01/nope.md', 'x'), HttpError)
})

test('accepting one paragraph commits it and leaves the rest pending', () => {
  reset()
  const file = 'prose/ch-01/scene-01.md'
  const abs = path.join(story, file)
  const before = fs.readFileSync(abs, 'utf8')
  const fm = before.slice(0, before.indexOf('---', 3) + 4)
  fs.writeFileSync(abs, fm + 'FIRST changed.\n\nSECOND changed.\n')

  proseAcceptParagraph(file, 0)

  // HEAD took paragraph 0 only
  const head = git(story, 'show', `HEAD:${file}`)
  assert.match(head, /FIRST changed\./)
  assert.doesNotMatch(head, /SECOND changed\./)
  // the working tree still holds everything the author wrote
  const wt = fs.readFileSync(abs, 'utf8')
  assert.match(wt, /FIRST changed\./)
  assert.match(wt, /SECOND changed\./)
  // and the remaining diff is exactly the paragraph not yet accepted
  assert.equal(proseDraft().changes.filter(c => c.file === file).length, 1)
})

test('accepting the last pending paragraph leaves the scene matching main', () => {
  reset()
  const file = 'prose/ch-01/scene-01.md'
  const abs = path.join(story, file)
  const before = fs.readFileSync(abs, 'utf8')
  const fm = before.slice(0, before.indexOf('---', 3) + 4)
  fs.writeFileSync(abs, fm + 'Only one paragraph, changed.\n')
  proseAcceptParagraph(file, 0)
  assert.equal(proseDraft().changes.filter(c => c.file === file).length, 0)
})

test('a paragraph accept is refused on an added scene, and on a bad index', () => {
  reset()
  writeScene(story, 'prose/ch-01/scene-09.md', 'sc.01-9', 'Brand new.')
  assert.throws(() => proseAcceptParagraph('prose/ch-01/scene-09.md', 0), HttpError)
  const file = 'prose/ch-01/scene-01.md'
  const abs = path.join(story, file)
  fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8') + '\n\nAn extra line.\n')
  assert.throws(() => proseAcceptParagraph(file, 99), HttpError)
  reset()
})
