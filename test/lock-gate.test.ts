// The accept gate finally consults the locks (A40-3).
//
// Six verbs write prose into the book; until now only proseWrite asked
// whether the prose was settled. The properties pinned here: a lock refuses
// every accept that would change its paragraph, a refusal costs no words and
// records no evidence, a reject stays allowed because it restores what the
// lock protects, and a discard refuses only when the protected text lives
// nowhere but the draft it is about to destroy.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { git, makeStory } from './fixture.ts'

const story = makeStory()
process.env.ARC_STORY_PATH = story
process.env.ARC_DRAFT_ENGINE = 'none'
const { proseAccept, proseAcceptParagraph, proseRejectParagraph, proseAcceptSentence, proseDiscard } =
  await import('../src/story.ts')
const { readJudgments, EVIDENCE_REL } = await import('../src/evidence.ts')
const { HttpError } = await import('../src/http.ts')

const file = 'prose/ch-01/scene-01.md'
const abs = path.join(story, file)
const LOCKS = path.join(story, 'locks')

const reset = () => {
  git(story, 'checkout', 'HEAD', '--', '.')
  git(story, 'clean', '-fdq')
  fs.rmSync(LOCKS, { recursive: true, force: true })
  try { fs.rmSync(path.join(story, EVIDENCE_REL)) } catch { /* none */ }
}

/** main at [A, B-locked, C], committed, with lock.001 on ¶2. */
function lockedFixture() {
  reset()
  const before = fs.readFileSync(abs, 'utf8')
  const fm = before.slice(0, before.indexOf('---', 3) + 4)
  fs.writeFileSync(abs, fm + 'Paragraph A.\n\nThe settled paragraph. It has two sentences.\n\nParagraph C.\n')
  git(story, 'add', '--', file)
  if (git(story, 'status', '--porcelain', '--', file).trim()) {
    git(story, 'commit', '-qm', 'prose: lock-gate fixture', '--', file)
  }
  fs.mkdirSync(LOCKS, { recursive: true })
  fs.writeFileSync(path.join(LOCKS, 'lock-001.yaml'), [
    'id: lock.001', 'anchor:', '  scene: sc.01-1', '  paragraph: 1',
    '  quote: The settled paragraph. It has two sentences.', '',
  ].join('\n'))
  return fm
}

test('accepting a paragraph over locked prose is refused, costs no words, records nothing', () => {
  const fm = lockedFixture()
  fs.writeFileSync(abs, fm + 'Paragraph A.\n\nThe settled paragraph, rewritten by a draft.\n\nParagraph C.\n')
  const working = fs.readFileSync(abs, 'utf8')
  const head = git(story, 'rev-parse', 'HEAD').trim()

  assert.throws(() => proseAcceptParagraph(file, { side: 'draft', paragraph: 1 }),
    (e: unknown) => e instanceof HttpError && e.status === 423 && /lock\.001/.test(e.message),
    'refused with the lock named')
  assert.equal(fs.readFileSync(abs, 'utf8'), working, 'the author keeps every unaccepted word')
  assert.equal(git(story, 'rev-parse', 'HEAD').trim(), head, 'and nothing was committed')
  assert.deepEqual(readJudgments(), [], 'a decision that never landed is not evidence')
  reset()
})

test('an accept elsewhere in the same scene still goes through', () => {
  const fm = lockedFixture()
  fs.writeFileSync(abs, fm + 'Paragraph A, revised.\n\nThe settled paragraph. It has two sentences.\n\nParagraph C.\n')
  proseAcceptParagraph(file, { side: 'draft', paragraph: 0 })
  assert.match(git(story, 'show', `HEAD:${file}`), /Paragraph A, revised\./,
    'the lock fences its paragraph, not the scene')
  reset()
})

test('accepting a sentence out of a locked paragraph is refused the same way', () => {
  const fm = lockedFixture()
  fs.writeFileSync(abs, fm + 'Paragraph A.\n\nThe settled paragraph. It has two sentences. It grew a third.\n\nParagraph C.\n')
  assert.throws(() => proseAcceptSentence(file, { paragraph: 1, side: 'draft', sentence: 2 }),
    (e: unknown) => e instanceof HttpError && e.status === 423 && /lock\.001/.test(e.message))
  reset()
})

test('the whole-draft accept is refused before any file commits or any judgment lands', () => {
  const fm = lockedFixture()
  fs.writeFileSync(abs, fm + 'Paragraph A, also revised.\n\nThe settled paragraph, overwritten wholesale.\n\nParagraph C.\n')
  const head = git(story, 'rev-parse', 'HEAD').trim()
  assert.throws(() => proseAccept(), (e: unknown) => e instanceof HttpError && e.status === 423)
  assert.equal(git(story, 'rev-parse', 'HEAD').trim(), head, 'atomic: nothing committed')
  assert.deepEqual(readJudgments(), [], 'and nothing recorded')
  reset()
})

test('rejecting on locked prose is allowed — it restores exactly what the lock protects', () => {
  const fm = lockedFixture()
  fs.writeFileSync(abs, fm + 'Paragraph A.\n\nThe settled paragraph, rewritten by a draft.\n\nParagraph C.\n')
  proseRejectParagraph(file, { side: 'draft', paragraph: 1 })
  assert.match(fs.readFileSync(abs, 'utf8'), /The settled paragraph\. It has two sentences\./,
    "main's words — the locked words — are back")
  reset()
})

test('discard is refused only when the locked passage lives nowhere but the draft', () => {
  const fm = lockedFixture()
  // The locked text is in HEAD: rolling back RESTORES it. Allowed.
  fs.writeFileSync(abs, fm + 'Paragraph A.\n\nThe settled paragraph, mangled.\n\nParagraph C.\n')
  proseDiscard(file)
  assert.match(fs.readFileSync(abs, 'utf8'), /It has two sentences\./, 'the rollback restored the settled text')

  // Now the author locks a paragraph that exists only in the draft.
  fs.writeFileSync(abs, fm + 'Paragraph A.\n\nThe settled paragraph. It has two sentences.\n\nParagraph C.\n\nA new passage, locked before it was ever accepted.\n')
  fs.writeFileSync(path.join(LOCKS, 'lock-002.yaml'), [
    'id: lock.002', 'anchor:', '  scene: sc.01-1', '  paragraph: 3',
    '  quote: A new passage, locked before it was ever accepted.', '',
  ].join('\n'))
  const working = fs.readFileSync(abs, 'utf8')
  assert.throws(() => proseDiscard(file),
    (e: unknown) => e instanceof HttpError && e.status === 423 && /lock\.002/.test(e.message),
    'destroying locked prose is refused with the lock named')
  assert.equal(fs.readFileSync(abs, 'utf8'), working, 'and the draft is untouched')
  reset()
})
