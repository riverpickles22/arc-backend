// Locks (A29): the write path refuses to touch settled prose. The refusal
// is the feature, so the tests pin it from both sides — a locked paragraph
// cannot change, and everything around it still can.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeStory, writeScene } from './fixture.ts'

const STORY = makeStory()
process.env.ARC_STORY_PATH = STORY

const { locks, locksOn, createLock, removeLock, assertUnlocked } = await import('../src/locks.ts')
const { proseWrite } = await import('../src/story.ts')
const { lockViolations, resolveLocks } = await import('arc-canon-graph/annotations.ts')

const SCENE_FILE = 'prose/ch-01/scene-01.md'
const P1 = 'Original first paragraph.'
const P2 = 'Second paragraph.'

// ---- the pure guard ------------------------------------------------------

const mkLock = (paragraph: number, quote: string) =>
  resolveLocks([{ id: 'lock.900', anchor: { scene: 'sc.90-1', paragraph, quote } }],
    () => `${P1}\n\n${P2}`)

test('a change to the locked paragraph is a violation naming the lock', () => {
  const [l] = mkLock(0, P1)
  const hits = lockViolations(`${P1}\n\n${P2}`, `A reworded first paragraph.\n\n${P2}`, [l])
  assert.equal(hits.length, 1)
  assert.equal(hits[0].lock.id, 'lock.900')
  assert.equal(hits[0].paragraph, 0)
})

test('editing the neighbour of a locked paragraph is not a violation', () => {
  const [l] = mkLock(0, P1)
  assert.deepEqual(lockViolations(`${P1}\n\n${P2}`, `${P1}\n\nA completely new second paragraph.`, [l]), [])
})

test('a lock follows its prose: enforced at the drifted position', () => {
  const body = `A brand-new opening paragraph.\n\n${P1}\n\n${P2}`
  const [l] = resolveLocks([{ id: 'lock.901', anchor: { scene: 'sc.90-1', paragraph: 0, quote: P1 } }],
    () => body)
  assert.equal(l.resolution.state, 'drifted')
  const hits = lockViolations(body, `A brand-new opening paragraph.\n\nRewritten locked text.\n\n${P2}`, [l])
  assert.equal(hits.length, 1, 'the lock moved down a paragraph and still binds')
})

test('an orphaned lock blocks nothing', () => {
  const body = `Entirely different prose now.\n\n${P2}`
  const [l] = resolveLocks([{ id: 'lock.902', anchor: { scene: 'sc.90-1', paragraph: 0, quote: P1 } }],
    () => body)
  assert.equal(l.resolution.state, 'orphaned')
  assert.deepEqual(lockViolations(body, 'Anything at all.', [l]), [])
})

// ---- the choke point -----------------------------------------------------

test('proseWrite refuses a body that changes a locked paragraph, with a 423', () => {
  const lock = createLock({ scene: 'sc.01-1', paragraph: 0, quote: P1 })
  assert.equal(lock.resolution.state, 'resolved')
  assert.throws(
    () => proseWrite(SCENE_FILE, `A silently reworded opening.\n\n${P2}`),
    (e: unknown) => {
      const err = e as { status?: number; message?: string }
      return err.status === 423 && /lock\.001/.test(err.message ?? '') && /paragraph 1/.test(err.message ?? '')
    },
    'the refusal carries the lock id and the paragraph',
  )
})

test('the neighbour still accepts writes while the lock stands', () => {
  const out = proseWrite(SCENE_FILE, `${P1}\n\nA new second paragraph, written around the lock.`)
  assert.match(out.body, /written around the lock/)
  assert.match(out.body, /Original first paragraph\./, 'the locked paragraph is untouched')
})

test('unlocking restores writability', () => {
  removeLock('lock.001')
  const out = proseWrite(SCENE_FILE, `A freely reworded opening.\n\nA new second paragraph, written around the lock.`)
  assert.match(out.body, /freely reworded/)
  assert.equal(locks().length, 0)
})

test('assertUnlocked names the writer in its refusal', () => {
  writeScene(STORY, SCENE_FILE, 'sc.01-1', `${P1}\n\n${P2}`)
  createLock({ scene: 'sc.01-1', paragraph: 0, quote: P1 })
  assert.throws(
    () => assertUnlocked('sc.01-1', `${P1}\n\n${P2}`, 'Changed opening.', 'the revision worker'),
    /the revision worker must leave it verbatim/,
  )
  // and the resolved read agrees with the write path
  assert.equal(locksOn('sc.01-1', `${P1}\n\n${P2}`)[0].resolution.state, 'resolved')
})
