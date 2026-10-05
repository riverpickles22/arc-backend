// THE BASE AT THE DECISION (A72-3). Every decision says which versions it was
// made about, and one made about words that have moved since is refused.
//
// The case that matters most is the one a HEAD-shaped check cannot see: the
// author reads a diff in one view, types in the scene in another, and decides
// from the first. HEAD never moved. Their newer words are the casualty, and
// the old check would have had nothing to say.
//
// Pinned here: both sides of the diff are covered; an unrelated scene's accept
// does not stale this one; a missing or malformed token fails closed; every
// grain refuses — scene, paragraph, sentence, and the reject, discard and
// adopt verbs with them; a refusal preserves the file, the index, the evidence
// log and the notes; after reading again the author may accept deliberately;
// absent and newly-present scenes are states, not gaps; a fresh token does not
// override a lock; and the decision the author DID make is on record with what
// it was about and what it made true.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { git, makeStory, writeScene } from './fixture.ts'

const STORY = makeStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

const {
  proseAccept, proseAcceptParagraph, proseAcceptSentence, proseDiscard, proseDraft,
  proseRejectParagraph, proseRejectSentence, proseWrite,
} = await import('../src/story.ts')
const { baseOf, forgetReviews, versionsOf } = await import('../src/base.ts')
const { readJudgments, EVIDENCE_REL } = await import('../src/evidence.ts')
const { laneHolder } = await import('../src/lane.ts')
const { HttpError } = await import('../src/http.ts')

const A = 'prose/ch-01/scene-01.md'
const B = 'prose/ch-01/scene-02.md'
const basesOf = (files: string[]): Record<string, string> => Object.fromEntries(files.map(f => [f, baseOf(f)]))
const BASE = git(STORY, 'rev-parse', 'HEAD').trim()

const fmOf = (file: string): string => {
  const raw = fs.readFileSync(path.join(STORY, file), 'utf8')
  return raw.slice(0, raw.indexOf('---', 3) + 4)
}
const put = (file: string, body: string): void => {
  fs.writeFileSync(path.join(STORY, file), fmOf(file) + '\n' + body + '\n')
}

const seed = (): void => {
  git(STORY, 'reset', '-q', '--hard', BASE)
  git(STORY, 'clean', '-fdq')
  writeScene(STORY, A, 'sc.01-1', 'One.\n\nTwo. And a second sentence.\n\nThree.')
  writeScene(STORY, B, 'sc.01-2', 'The second scene, as the book has it.')
  git(STORY, 'add', '-A')
  if (git(STORY, 'status', '--porcelain').trim()) git(STORY, 'commit', '-qm', 'prose: two scenes')
}

/** The author reads a diff: a pending change, and the token they are served. */
const reading = (file: string, pending: string): string => {
  put(file, pending)
  return proseDraft().changes.find(c => c.file === file)!.base
}

const stale = (e: unknown): boolean => e instanceof HttpError && e.status === 409
const closed = (e: unknown): boolean => e instanceof HttpError && e.status === 400

// ---- the case HEAD cannot see ---------------------------------------------

test('a decision read in one view is refused after the scene is typed in another', () => {
  seed()
  const read = reading(A, 'One, as arc proposed it.\n\nTwo. And a second sentence.\n\nThree.')
  const headBefore = git(STORY, 'rev-parse', 'HEAD').trim()

  // The other view. HEAD does not move; only the author's own pending words.
  put(A, 'One, as the author typed it a minute ago.\n\nTwo. And a second sentence.\n\nThree.')
  const theirs = fs.readFileSync(path.join(STORY, A), 'utf8')

  assert.throws(() => proseAccept(undefined, [A], { [A]: read }), (e: unknown) =>
    stale(e) && /you have changed these words since/.test((e as HttpError).message))
  assert.equal(git(STORY, 'rev-parse', 'HEAD').trim(), headBefore, 'nothing committed')
  assert.equal(fs.readFileSync(path.join(STORY, A), 'utf8'), theirs, 'and their words are still theirs')
  assert.deepEqual(readJudgments(), [], 'a refused decision records no verdict')
  assert.equal(git(STORY, 'diff', '--cached', '--name-only').trim(), '')
  assert.equal(laneHolder(), null)
})

test('the refusal carries what was read and what is there now', () => {
  seed()
  const read = reading(A, 'What arc proposed.\n\nTwo. And a second sentence.\n\nThree.')
  put(A, 'What the author typed instead.\n\nTwo. And a second sentence.\n\nThree.')

  try {
    proseAccept(undefined, [A], { [A]: read })
    assert.fail('should have refused')
  } catch (e) {
    const detail = (e as HttpError).detail as { conflict?: { file: string; moved: string; reviewed: { pending: string | null } | null; current: { pending: string | null } } }
    const c = detail?.conflict
    assert.ok(c, 'a refusal says what it was about')
    assert.equal(c!.file, A)
    assert.match(c!.reviewed!.pending!, /What arc proposed\./, 'the words the author read')
    assert.match(c!.current.pending!, /What the author typed instead\./, 'and the words that are there now')
  }
})

test('the book moving under a decision refuses it too', () => {
  seed()
  const read = reading(A, 'Pending, read against the book as it was.')
  // Another decision lands on this same scene — the accepted side moves.
  proseAccept(undefined, [A], basesOf([A]))
  put(A, 'Pending again, from the stale view.')
  assert.throws(() => proseAccept(undefined, [A], { [A]: read }),
    (e: unknown) => stale(e) && /the book .*(has changed|and the pending words have changed)/.test((e as HttpError).message))
})

test('an unrelated scene being accepted does not stale this one', () => {
  seed()
  const read = reading(A, 'Pending in the scene the author is reading.')
  put(B, 'Pending in a scene they are not.')
  proseAccept(undefined, [B], basesOf([B]))
  // The token is over THIS file, not over the repository.
  const out = proseAccept(undefined, [A], { [A]: read })
  assert.deepEqual(out.files, [A])
})

// ---- failing closed --------------------------------------------------------

test('a decision that names no version, or a malformed one, is refused and writes nothing', () => {
  seed()
  reading(A, 'Pending, and about to be decided badly.')
  const head = git(STORY, 'rev-parse', 'HEAD').trim()
  for (const bad of [undefined, null, '', 'not-a-token', 42, 'A'.repeat(16), 'abc']) {
    assert.throws(() => proseAccept(undefined, [A], { [A]: bad }), closed, `${JSON.stringify(bad)} must fail closed`)
  }
  assert.throws(() => proseAccept(undefined, [A], undefined), closed, 'and so must no map at all')
  assert.equal(git(STORY, 'rev-parse', 'HEAD').trim(), head)
  assert.deepEqual(readJudgments(), [])
  assert.equal(laneHolder(), null)
})

test('one stale scene in a request of two leaves both of them alone', () => {
  seed()
  const readA = reading(A, 'The first, read.')
  const readB = reading(B, 'The second, read.')
  put(B, 'The second, typed over since.')
  const head = git(STORY, 'rev-parse', 'HEAD').trim()

  assert.throws(() => proseAccept(undefined, [A, B], { [A]: readA, [B]: readB }), stale)
  assert.equal(git(STORY, 'rev-parse', 'HEAD').trim(), head, 'nothing committed')
  assert.deepEqual(proseDraft().changes.map(c => c.file).sort(), [A, B], 'both still pending')
  assert.deepEqual(readJudgments(), [])
})

// ---- every grain, and every verb ------------------------------------------

test('the paragraph and sentence grains refuse a moved base before resolving an index', () => {
  seed()
  const read = reading(A, 'One, rewritten.\n\nTwo. And a second sentence.\n\nThree.')
  // An insertion above shifts every index below it — exactly the case where
  // acting on a stale index would judge a different paragraph.
  put(A, 'A paragraph that was not there.\n\nOne, rewritten.\n\nTwo. And a second sentence.\n\nThree.')
  const theirs = fs.readFileSync(path.join(STORY, A), 'utf8')

  assert.throws(() => proseAcceptParagraph(A, { file: A, side: 'draft', paragraph: 0 }, read), stale)
  assert.throws(() => proseRejectParagraph(A, { file: A, side: 'draft', paragraph: 0 }, read), stale)
  assert.throws(() => proseAcceptSentence(A, { file: A, paragraph: 1, side: 'draft', sentence: 1 }, read), stale)
  assert.throws(() => proseRejectSentence(A, { file: A, paragraph: 1, side: 'draft', sentence: 1 }, read), stale)
  assert.equal(fs.readFileSync(path.join(STORY, A), 'utf8'), theirs, 'and not one of them wrote')
  assert.deepEqual(readJudgments(), [])
})

test('throwing a change away is refused from a view that has not seen it', () => {
  seed()
  const read = reading(A, 'Arc wrote this.')
  put(A, 'And then the author typed over it.')
  const theirs = fs.readFileSync(path.join(STORY, A), 'utf8')
  assert.throws(() => proseDiscard(A, read), stale)
  assert.equal(fs.readFileSync(path.join(STORY, A), 'utf8'), theirs, 'the newer words survive the old tab')
})

test('a save from a stale view is refused, and the body compare still has its say', () => {
  seed()
  const read = baseOf(A)
  put(A, 'Typed in the other view.')
  assert.throws(() => proseWrite(A, 'From the old view.\n', undefined, read), stale)
  // Without a token, the body baseline is the compare that remains — the two
  // are different inputs to the same question and neither replaces the other.
  assert.throws(() => proseWrite(A, 'From the old view.\n', 'a body that is not on disk'),
    (e: unknown) => e instanceof HttpError && e.status === 409)
})

// ---- absent and newly present ----------------------------------------------

test('a scene that was not in the book, and one that no longer is, are states', () => {
  seed()
  // ADDED: no accepted side at all when the author read it.
  writeScene(STORY, 'prose/ch-01/scene-03.md', 'sc.01-3', 'A scene arc wrote into a new file.')
  const added = 'prose/ch-01/scene-03.md'
  const read = proseDraft().changes.find(c => c.file === added)!.base
  assert.equal(versionsOf(added).accepted.present, false, 'the book has no such scene yet')
  proseAccept(undefined, [added], { [added]: read })
  assert.match(git(STORY, 'show', `HEAD:${added}`), /A scene arc wrote into a new file\./)

  // DELETED: a pending side that is gone.
  fs.rmSync(path.join(STORY, added))
  const readDeleted = proseDraft().changes.find(c => c.file === added)!.base
  assert.equal(versionsOf(added).pending.present, false)
  // It comes back under the author's hand before they decide: the version
  // they read is no longer what is there.
  writeScene(STORY, added, 'sc.01-3', 'Put back by hand.')
  assert.throws(() => proseAccept(undefined, [added], { [added]: readDeleted }),
    (e: unknown) => stale(e) && /the pending words are gone|you have changed/.test((e as HttpError).message))
})

test('changed frontmatter alone fails the comparison', () => {
  seed()
  const read = reading(A, 'A pending change the author read.')
  // Not a word of the prose moves — only what the scene says about itself,
  // which is as much a part of what gets committed as the body is.
  const raw = fs.readFileSync(path.join(STORY, A), 'utf8')
  fs.writeFileSync(path.join(STORY, A), raw.replace('status: proposed', 'status: drafted'))
  assert.match(fs.readFileSync(path.join(STORY, A), 'utf8'), /A pending change the author read\./)
  assert.throws(() => proseAccept(undefined, [A], { [A]: read }), stale)
})

// ---- reading again, and deciding ------------------------------------------

test('after reading again the author may accept the words they typed themselves', () => {
  seed()
  const read = reading(A, 'What arc proposed.')
  put(A, 'What the author would rather have.')
  assert.throws(() => proseAccept(undefined, [A], { [A]: read }), stale)

  // They read again. The comparison is against what they just reviewed — not
  // permanently against arc's original generation.
  const again = proseDraft().changes.find(c => c.file === A)!.base
  const out = proseAccept(undefined, [A], { [A]: again })
  assert.deepEqual(out.files, [A])
  assert.match(git(STORY, 'show', `HEAD:${A}`), /What the author would rather have\./)
})

test('a fresh base does not open a lock', () => {
  seed()
  const locks = path.join(STORY, 'locks')
  fs.mkdirSync(locks, { recursive: true })
  fs.writeFileSync(path.join(locks, 'lock-900.yaml'),
    ['id: lock.900', 'anchor:', '  scene: sc.01-1', '  paragraph: 1', '  quote: Two. And a second sentence.',
      "created_at: '2026-10-04'", ''].join('\n'))
  const read = reading(A, 'One.\n\nTwo, rewritten over the lock.\n\nThree.')
  assert.throws(() => proseAccept(undefined, [A], { [A]: read }),
    (e: unknown) => e instanceof HttpError && e.status === 423, 'the lock answers, not the base')
})

// ---- the decision record ---------------------------------------------------

test('an accept leaves a record of what it was about and what it made true', () => {
  seed()
  const read = reading(A, 'The words that went into the book.')
  proseAccept(undefined, [A], { [A]: read })

  const j = readJudgments().at(-1)!
  assert.match(j.decision!, /^dec\.\d{14}\.[0-9a-f]{8}$/, 'a stable identity, minted once')
  assert.equal(j.base, read, 'the versions it was decided about')
  assert.equal(j.granularity, 'scene')
  assert.equal(j.file, A)
  assert.ok(j.after, 'and the version it makes true')
  assert.notEqual(j.after, j.base)
  // `after` is what the file actually became: the same token the next reading
  // of this scene is served.
  assert.equal(j.after, baseOf(A))
})

test('two decisions are two records, and a reload can tell them apart', () => {
  seed()
  const first = reading(A, 'The first decision.')
  proseAccept(undefined, [A], { [A]: first })
  const second = reading(A, 'The second decision.')
  proseAccept(undefined, [A], { [A]: second })

  const them = readJudgments().filter(j => j.file === A)
  assert.equal(them.length, 2)
  assert.notEqual(them[0].decision, them[1].decision)
  assert.equal(them[0].base, first)
  assert.equal(them[1].base, second)
  assert.ok(them[0].after && them[1].after && them[0].after !== them[1].after,
    'each names the version it made true, and they are different versions')
  // And the log is what says so — no commit subject was read to learn it.
  assert.ok(fs.readFileSync(path.join(STORY, EVIDENCE_REL), 'utf8').includes(them[0].decision!))
})

test('a token older than what arc remembers still refuses, and says it plainly', () => {
  seed()
  const read = reading(A, 'Read a long time ago.')
  put(A, 'And changed since.')
  forgetReviews()   // the bounded memory has moved on
  assert.throws(() => proseAccept(undefined, [A], { [A]: read }), (e: unknown) =>
    stale(e) && /changed since that was read/.test((e as HttpError).message))
})
