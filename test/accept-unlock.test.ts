// The accept ratifies the author's unlock (A64-14). The viewer's unlock
// deletes the lock file; the story's commit gate reads the STAGED lock set;
// so until the accept carried the removal, every accept of an unlocked scene
// was refused at the gate and reached the author as "internal error".
// This runs the real gate — the story's own pre-commit hook, pointed at
// arc-core — so what passes here passes in the book.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { git, makeStory, writeScene } from './fixture.ts'

const STORY = makeStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'
const CORE = path.resolve(process.env.ARC_CORE_PATH ?? '../arc-core')

// The real gate, as the story's hook.
const hooks = path.join(STORY, 'bin', 'hooks')
fs.mkdirSync(hooks, { recursive: true })
const py = fs.existsSync(path.join(CORE, '.venv', 'bin', 'python')) ? path.join(CORE, '.venv', 'bin', 'python') : 'python3'
fs.writeFileSync(path.join(hooks, 'pre-commit'), `#!/bin/sh\nexec "${py}" "${CORE}/tools/lock-gate.py" "${STORY}"\n`)
fs.chmodSync(path.join(hooks, 'pre-commit'), 0o755)
git(STORY, 'config', 'core.hooksPath', 'bin/hooks')

const { proseAcceptParagraph, proseAccept, proseDraft, releasedLocksFor } = await import('../src/story.ts')
const { HttpError } = await import('../src/http.ts')

const FILE = 'prose/ch-01/scene-01.md'
const LOCK = 'locks/lock-001.yaml'

const seed = () => {
  git(STORY, 'checkout', 'HEAD', '--', '.'); git(STORY, 'clean', '-fdq')
  writeScene(STORY, FILE, 'sc.01-1', 'Settled first paragraph.\n\nSettled second paragraph.')
  fs.mkdirSync(path.join(STORY, 'locks'), { recursive: true })
  fs.writeFileSync(path.join(STORY, LOCK), "id: lock.001\nanchor:\n  scene: sc.01-1\ncreated_at: '2026-08-27T00:00:00.000Z'\n")
  git(STORY, 'add', '-A')
  if (git(STORY, 'status', '--porcelain').trim()) git(STORY, 'commit', '-qm', 'prose: a settled scene')
}
const edit = () => {
  const abs = path.join(STORY, FILE)
  fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace('Settled second paragraph.', 'A revised second paragraph.'))
}

test('an unlock the author made in the viewer rides with the accept, and the gate lets it through', () => {
  seed()
  fs.unlinkSync(path.join(STORY, LOCK))   // what the viewer's unlock does: deletes the file, commits nothing
  edit()
  assert.deepEqual(releasedLocksFor(FILE), [LOCK], 'the released lock is found by the scene it settled')
  const before = git(STORY, 'rev-parse', 'HEAD').trim()
  proseAcceptParagraph(FILE, { side: 'draft', paragraph: 1 })
  assert.notEqual(git(STORY, 'rev-parse', 'HEAD').trim(), before, 'the gate let the ratification through')
  assert.throws(() => git(STORY, 'show', `HEAD:${LOCK}`), 'the lock left the book with the edit')
  assert.match(git(STORY, 'show', `HEAD:${FILE}`), /A revised second paragraph\./)
  assert.equal(proseDraft().changes.length, 0)
})

test('with the lock still in place the accept is refused, naming the lock — never an internal error', () => {
  seed()
  edit()
  assert.throws(() => proseAcceptParagraph(FILE, { side: 'draft', paragraph: 1 }),
    (e: unknown) => e instanceof HttpError && e.status === 423 && /lock\.001/.test(e.message))
  assert.deepEqual(releasedLocksFor(FILE), [], 'nothing was released')
})

test('a lock on another scene is left alone, and the whole accept carries a release too', () => {
  seed()
  writeScene(STORY, 'prose/ch-01/scene-02.md', 'sc.01-2', 'Another scene.')
  fs.writeFileSync(path.join(STORY, 'locks', 'lock-002.yaml'), "id: lock.002\nanchor:\n  scene: sc.01-2\ncreated_at: '2026-08-27T00:00:00.000Z'\n")
  git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'a second settled scene')
  fs.unlinkSync(path.join(STORY, LOCK))
  fs.unlinkSync(path.join(STORY, 'locks', 'lock-002.yaml'))
  edit()
  assert.deepEqual(releasedLocksFor(FILE), [LOCK], 'only the lock that settled THIS scene')
  proseAccept(undefined, [FILE])
  assert.throws(() => git(STORY, 'show', `HEAD:${LOCK}`))
  assert.doesNotThrow(() => git(STORY, 'show', 'HEAD:locks/lock-002.yaml'), 'the other scene\'s lock is still in the book — its release waits for its own accept')
})
