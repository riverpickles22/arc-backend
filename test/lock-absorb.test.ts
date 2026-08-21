// The parent absorbs its children, and gives them back (A40-2).
//
// The disposition under test is conventions §12's: dropped beats deletion,
// because intent history is story history. A paragraph lock is a decision
// the author made about a specific passage; a broader lock does its work for
// a while, and lifting the broad one must hand every narrow decision back
// exactly as it was.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { git, makeStory, writeScene } from './fixture.ts'

const story = makeStory()
process.env.ARC_STORY_PATH = story
process.env.ARC_DRAFT_ENGINE = 'none'
const { createLock, removeLock, locks, locksOn } = await import('../src/locks.ts')
const { proseAcceptParagraph } = await import('../src/story.ts')
const { HttpError } = await import('../src/http.ts')

const LOCKS = path.join(story, 'locks')
const file = 'prose/ch-01/scene-01.md'
const abs = path.join(story, file)

const reset = () => {
  git(story, 'checkout', 'HEAD', '--', '.')
  git(story, 'clean', '-fdq')
  fs.rmSync(LOCKS, { recursive: true, force: true })
}

function threeParas(): string {
  const before = fs.readFileSync(abs, 'utf8')
  const fm = before.slice(0, before.indexOf('---', 3) + 4)
  fs.writeFileSync(abs, fm + 'Paragraph A.\n\nParagraph B.\n\nParagraph C.\n')
  git(story, 'add', '--', file)
  if (git(story, 'status', '--porcelain', '--', file).trim()) {
    git(story, 'commit', '-qm', 'prose: absorption fixture', '--', file)
  }
  return fm
}

test('a section lock absorbs the paragraph locks beneath it, and the list shows one entry', () => {
  reset(); threeParas()
  const p1 = createLock({ scene: 'sc.01-1', paragraph: 0, quote: 'Paragraph A.' })
  const p2 = createLock({ scene: 'sc.01-1', paragraph: 1, quote: 'Paragraph B.' })
  const bytesBefore = fs.readFileSync(path.join(LOCKS, `${p1.id.replace('.', '-')}.yaml`))

  const section = createLock({ scene: 'sc.01-1' })
  assert.deepEqual(locks().map(l => l.id), [section.id],
    'the parent is one entry doing the work of many')
  const absorbedRaw = fs.readFileSync(path.join(LOCKS, `${p1.id.replace('.', '-')}.yaml`), 'utf8')
  assert.match(absorbedRaw, new RegExp(`absorbed_by: ${section.id.replace('.', '\\.')}`))

  // Beyond the link, the record survives byte for byte.
  const restoredEquivalent = absorbedRaw.replace(/absorbed_by: .*\n/, '')
  assert.equal(restoredEquivalent, bytesBefore.toString(), 'only the link was written')

  removeLock(section.id)
  assert.equal(fs.readFileSync(path.join(LOCKS, `${p1.id.replace('.', '-')}.yaml`)).toString(), bytesBefore.toString(),
    'lifting the parent restores the original bytes')
  assert.deepEqual(locks().map(l => l.id).sort(), [p1.id, p2.id].sort(), 'both children enforce again')
  reset()
})

test('absorption nests honestly: a chapter absorbs both layers and lifting restores both', () => {
  reset(); threeParas()
  const para = createLock({ scene: 'sc.01-1', paragraph: 0, quote: 'Paragraph A.' })
  const section = createLock({ scene: 'sc.01-1' })          // absorbs the paragraph lock
  const chapter = createLock({ chapter: 'ch.01' })          // absorbs the section lock

  assert.deepEqual(locks().map(l => l.id), [chapter.id], 'the chapter is the one entry standing')
  const paraRaw = fs.readFileSync(path.join(LOCKS, `${para.id.replace('.', '-')}.yaml`), 'utf8')
  assert.match(paraRaw, new RegExp(`absorbed_by: ${section.id.replace('.', '\\.')}`),
    'the paragraph keeps ITS parent — an already-absorbed lock is not re-parented')

  removeLock(chapter.id)
  assert.deepEqual(locks().map(l => l.id), [section.id],
    'lifting the chapter restores the section layer — and the paragraph stays under it')
  removeLock(section.id)
  assert.deepEqual(locks().map(l => l.id), [para.id], 'each layer unwinds to exactly what it was')
  reset()
})

test('an absorbed lock enforces nothing; the parent enforces everything', () => {
  const fm = threeParas()
  fs.rmSync(LOCKS, { recursive: true, force: true })
  const para = createLock({ scene: 'sc.01-1', paragraph: 2, quote: 'Paragraph C.' })
  const section = createLock({ scene: 'sc.01-1' })

  const active = locksOn('sc.01-1', 'Paragraph A.\n\nParagraph B.\n\nParagraph C.')
  assert.deepEqual(active.map(l => l.id), [section.id], 'only the parent binds')

  fs.writeFileSync(abs, fm + 'Paragraph A, revised.\n\nParagraph B.\n\nParagraph C.\n')
  assert.throws(() => proseAcceptParagraph(file, { side: 'draft', paragraph: 0 }),
    (e: unknown) => e instanceof HttpError && e.status === 423 && /this section is locked/.test(e.message),
    'the section refuses what no paragraph lock covered')
  assert.ok(para.id, 'and the narrow decision still exists, waiting')
  reset()
})

test('a parent deleted by hand leaves no lock in limbo — the children enforce again', () => {
  reset(); threeParas()
  const para = createLock({ scene: 'sc.01-1', paragraph: 0, quote: 'Paragraph A.' })
  const section = createLock({ scene: 'sc.01-1' })
  // The author (or a stray rm) deletes the parent FILE, not through removeLock.
  fs.rmSync(path.join(LOCKS, `${section.id.replace('.', '-')}.yaml`))

  assert.deepEqual(locks().map(l => l.id), [para.id],
    'a lock absorbed by nothing enforces again — the lock doing its work is gone')
  const active = locksOn('sc.01-1', 'Paragraph A.\n\nParagraph B.\n\nParagraph C.')
  assert.deepEqual(active.map(l => l.id), [para.id])
  reset()
})

test('the Feral Dogs prologue: locked as a chapter, unlocked with every paragraph lock intact', () => {
  // The real records, byte-compared — copied into the fixture so the test
  // never writes into the author's repo. Skips honestly when the private
  // story is not checked out (CI).
  const real = path.join(process.env.HOME!, 'workspace', 'arc', 'feral-dogs-of-cuba')
  if (!fs.existsSync(path.join(real, 'locks'))) return

  reset()
  const sceneSrc = fs.readFileSync(path.join(real, 'prose/ch-00/scene-01.md'), 'utf8')
  writeScene(story, 'prose/ch-00/scene-01.md', 'sc.00-1', 'placeholder')
  fs.writeFileSync(path.join(story, 'prose/ch-00/scene-01.md'),
    sceneSrc.replace(/^---[\s\S]*?---\n/, '---\nscene: sc.00-1\nchapter: ch.00-prologue\nstatus: proposed\nfacts: []\nevents: []\n---\n'))
  fs.mkdirSync(LOCKS, { recursive: true })
  const originals = new Map<string, Buffer>()
  for (const name of fs.readdirSync(path.join(real, 'locks'))) {
    const bytes = fs.readFileSync(path.join(real, 'locks', name))
    originals.set(name, bytes)
    fs.writeFileSync(path.join(LOCKS, name), bytes)
  }
  const before = locks().map(l => l.id).sort()
  assert.ok(before.length >= 6, `the prologue carries its paragraph locks (${before.length})`)

  const chapter = createLock({ chapter: 'ch.00-prologue' })
  assert.deepEqual(locks().map(l => l.id), [chapter.id], 'the chapter absorbs them all')

  removeLock(chapter.id)
  assert.deepEqual(locks().map(l => l.id).sort(), before, 'every lock enforces again')
  for (const [name, bytes] of originals) {
    assert.equal(fs.readFileSync(path.join(LOCKS, name)).toString(), bytes.toString(),
      `${name} survives byte for byte`)
  }
  reset()
})
