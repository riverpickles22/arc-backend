// THE BASE AT THE DRAFT WRITE PATH (A72-4). Invariant 1 at the door it names.
//
// A route has carried what it read since slice 1. A draft carried nothing, so
// a draft written against a note the author has since answered looked exactly
// like one written a second ago — and worse, the write path took whatever was
// on disk at the landing, and the failure paths put back the bytes the pass
// had read at LAUNCH. A pass that ran for two minutes could cost the author
// the paragraph they typed while it ran, without a word.
//
// Pinned here: one enumeration records and compares, and it covers what the
// record SAYS about a thing and not only the words in it — a note's status and
// anchor, a scene's frontmatter and contract; a proposal minted under an older
// rule is labelled, never called moved; a pass's answer never lands over a
// destination that moved, and what it wrote is kept beside the book instead of
// being thrown away; a failure puts back only what arc can still see it wrote;
// and the two bars stay apart — a moved read warns, a moved base refuses.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { git, makeStory, writeScene } from './fixture.ts'

const STORY = makeStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

const { proseDraft, proseScenes } = await import('../src/story.ts')
const { recordGenerated } = await import('../src/ledger.ts')
const { READ_MAP, noteVersion, readManifest, readsFrom, staleAgainst } = await import('../src/reads.ts')
const { fingerprintsNow } = await import('../src/reroute.ts')
const { createAnnotation, updateAnnotation } = await import('../src/annotations.ts')
const { destinationAt, keepCandidate, candidatePath, landOrKeep, moved, restoreIfOurs } = await import('../src/landing.ts')

const FILE = 'prose/ch-01/scene-01.md'
const SCENE = 'sc.01-1'
const abs = path.join(STORY, FILE)
const BASE = git(STORY, 'rev-parse', 'HEAD').trim()

const seed = (): void => {
  git(STORY, 'reset', '-q', '--hard', BASE)
  git(STORY, 'clean', '-fdq')
  fs.rmSync(path.join(STORY, 'annotations'), { recursive: true, force: true })
  fs.rmSync(path.join(STORY, '.arc'), { recursive: true, force: true })
  writeScene(STORY, FILE, SCENE, 'The scene as the book has it.')
  git(STORY, 'add', '-A')
  if (git(STORY, 'status', '--porcelain').trim()) git(STORY, 'commit', '-qm', 'prose: one scene')
}

/** A draft arc wrote, with everything it read recorded — what every writing
 *  row now does at its landing. */
const drafted = (body: string, run = 'run.0001'): void => {
  const raw = fs.readFileSync(abs, 'utf8')
  const next = raw.replace(/---\n\n[\s\S]*$/, `---\n\n${body}\n`)
  fs.writeFileSync(abs, next)
  recordGenerated(FILE, next, {
    engine: 'test', scene: SCENE, origin: 'revise', run,
    // The cheap map here: this fixture story has no canon to export, and the
    // ids these cases move — the scene, its notes — are all in it. The write
    // path's full map (the canon pack, the siblings) is exercised where a
    // real row runs.
    reads: readsFrom(fingerprintsNow(SCENE)), v: READ_MAP,
  })
}

const staleOf = (file = FILE): { changed: string[]; why: string } | undefined =>
  proseDraft().changes.find(c => c.file === file)?.stale

// ---- one enumeration, and what it covers ----------------------------------

test('a note whose STATUS moved is a note the pass would no longer be handed', () => {
  seed()
  const note = createAnnotation({ scene: SCENE, body: 'slower here' })
  drafted('What arc wrote from that note.')
  assert.equal(staleOf(), undefined, 'nothing has moved yet')

  // Not one letter of the note changes — only what the record says about it.
  updateAnnotation(note.id, { status: 'resolved' })
  const stale = staleOf()
  assert.ok(stale, 'a resolved note is not the note the pass was handed')
  assert.equal(stale!.why, 'the record moved')
  assert.deepEqual(stale!.changed, [note.id])
})

test('a note whose ANCHOR moved is one too, with its body untouched', () => {
  seed()
  const a = createAnnotation({ scene: SCENE, body: 'the same words', paragraph: 0, quote: 'The scene' })
  const b = createAnnotation({ scene: SCENE, body: 'the same words', paragraph: 0, quote: 'as the book' })
  assert.notEqual(noteVersion(a), noteVersion(b), 'the same body in two places is two instructions')
})

test('a scene whose FRONTMATTER moved has moved, body or no body', () => {
  seed()
  drafted('What arc wrote.')
  assert.equal(staleOf(), undefined)

  // The assignment changes and the prose does not: a different contract is a
  // different scene to write, which a map over the body alone cannot see.
  const raw = fs.readFileSync(abs, 'utf8')
  fs.writeFileSync(abs, raw.replace('status: proposed', 'status: drafted'))
  const stale = staleOf()
  assert.ok(stale)
  assert.deepEqual(stale!.changed, [SCENE])
})

test('the recording and the comparing are the same rule', () => {
  seed()
  const scene = proseScenes().find(s => s.scene === SCENE)!
  const recorded = readManifest({
    style: 'a contract', scene, pack: 'a pack', notes: [], locks: [], siblings: '',
  }).find(r => r.id === SCENE)!
  const compared = fingerprintsNow(SCENE).at.get(SCENE)
  assert.equal(recorded.version, compared,
    'a manifest built by one rule and compared by another agrees with nothing')
})

test('a proposal minted under an older enumeration is labelled, not called moved', () => {
  seed()
  const now = fingerprintsNow(SCENE)
  // Everything about it is current except the rule that produced its versions.
  const old = { reads: readsFrom(now), run: 'run.0009', v: 1 }
  const stale = staleAgainst(old, now)
  assert.ok(stale)
  assert.equal(stale!.why, 'written by an older arc', 'arc cannot compare, and says so')
  assert.deepEqual(stale!.changed, [], 'it does not blame the author\'s record')
  // And the same proposal under the current rule is simply current.
  assert.equal(staleAgainst({ ...old, v: READ_MAP }, now), null)
})

test('a pass whose own version has moved is labelled the same way', () => {
  seed()
  const now = fingerprintsNow(SCENE)
  const p = { reads: readsFrom(now), run: 'run.0010', v: READ_MAP, job: 'job-as-it-was' }
  assert.equal(staleAgainst(p, now, 'job-as-it-was'), null)
  const stale = staleAgainst(p, now, 'job-as-it-is-now')
  assert.equal(stale?.why, 'written by an older arc')
})

test('a scene the author typed themselves is never labelled as arc\'s', () => {
  seed()
  const raw = fs.readFileSync(abs, 'utf8')
  fs.writeFileSync(abs, raw.replace(/---\n\n[\s\S]*$/, '---\n\nTyped by hand, by the author.\n'))
  const change = proseDraft().changes.find(c => c.file === FILE)
  assert.ok(change, 'it is a pending change')
  assert.equal(change!.origin, undefined, 'with no origin')
  assert.equal(change!.stale, undefined, 'and nothing to be stale against')
})

// ---- the landing ----------------------------------------------------------

test('a destination that moved while the pass ran does not take its answer', () => {
  seed()
  const dest = destinationAt(FILE)
  assert.equal(moved(dest), false)

  // The author types while the pass is out.
  const theirs = fs.readFileSync(abs, 'utf8').replace(/---\n\n[\s\S]*$/, '---\n\nTyped while the pass was out.\n')
  fs.writeFileSync(abs, theirs)
  assert.equal(moved(dest), true)

  let wrote = false
  const landing = landOrKeep(dest, 'run.0002', 'WHAT ARC WROTE', () => { wrote = true; return { ok: true, output: '' } })
  assert.equal(landing.ok, false)
  assert.equal(landing.ok === false && landing.why, 'moved')
  assert.equal(wrote, false, 'the write was never reached')
  assert.equal(fs.readFileSync(abs, 'utf8'), theirs, 'and their words are still theirs')

  // What the pass wrote is kept beside the book, not in it.
  assert.equal(landing.ok === false && landing.kept, candidatePath('run.0002'))
  assert.equal(fs.readFileSync(candidatePath('run.0002'), 'utf8'), 'WHAT ARC WROTE')
  assert.ok(!proseDraft().changes.some(c => c.file.includes('candidates')), 'and is not the live draft')
})

test('a destination that did not move takes it, once', () => {
  seed()
  const dest = destinationAt(FILE)
  let calls = 0
  const landing = landOrKeep(dest, 'run.0003', 'ARC', () => { calls++; return { ok: true, output: '' } })
  assert.equal(landing.ok, true)
  assert.equal(calls, 1)
})

test('a validator refusal is a refusal, not a moved destination', () => {
  seed()
  const dest = destinationAt(FILE)
  const landing = landOrKeep(dest, 'run.0004', 'ARC', () => ({ ok: false, output: 'the validator said no' }))
  assert.equal(landing.ok === false && landing.why, 'refused')
  assert.ok(!fs.existsSync(candidatePath('run.0004')), 'a refused answer is not a candidate to come back to')
})

test('an absent destination is a state: a target taken while the pass ran is not written over', () => {
  seed()
  const fresh = 'prose/ch-01/scene-09.md'
  const dest = destinationAt(fresh)
  assert.equal(dest.bytes, null, 'there is no such file yet')
  assert.equal(moved(dest), false)

  // Something else puts a scene there while the pass is out.
  writeScene(STORY, fresh, 'sc.01-9', 'Written by somebody else first.')
  assert.equal(moved(dest), true)
  const landing = landOrKeep(dest, 'run.0005', 'ARC WOULD HAVE WRITTEN THIS', () => ({ ok: true, output: '' }))
  assert.equal(landing.ok, false)
  assert.match(fs.readFileSync(path.join(STORY, fresh), 'utf8'), /Written by somebody else first\./)
})

// ---- putting things back --------------------------------------------------

test('a failure puts back only what arc can still see it wrote', () => {
  seed()
  const dest = destinationAt(FILE)
  const ours = fs.readFileSync(abs, 'utf8').replace(/---\n\n[\s\S]*$/, '---\n\nWhat the pass wrote.\n')
  fs.writeFileSync(abs, ours)

  // The ordinary case: the file still holds what the pass wrote, so it goes
  // back to the author's own text.
  assert.equal(restoreIfOurs(dest, ours), true)
  assert.equal(fs.readFileSync(abs, 'utf8'), dest.bytes)

  // And the case that used to cost a paragraph: somebody wrote after the
  // pass did, and the pass then failed.
  fs.writeFileSync(abs, ours)
  const theirs = ours.replace('What the pass wrote.', 'What they typed over it.')
  fs.writeFileSync(abs, theirs)
  assert.equal(restoreIfOurs(dest, ours), false, 'not arc\'s to roll back')
  assert.equal(fs.readFileSync(abs, 'utf8'), theirs)
})

test('a new scene a failed pass created is removed; one somebody else wrote is not', () => {
  seed()
  const fresh = 'prose/ch-01/scene-08.md'
  const dest = destinationAt(fresh)
  fs.writeFileSync(path.join(STORY, fresh), 'ARC WROTE THIS')
  assert.equal(restoreIfOurs(dest, 'ARC WROTE THIS'), true)
  assert.equal(fs.existsSync(path.join(STORY, fresh)), false, 'a draft that never landed leaves nothing')

  fs.writeFileSync(path.join(STORY, fresh), 'SOMEBODY ELSE WROTE THIS')
  assert.equal(restoreIfOurs(dest, 'ARC WROTE THIS'), false)
  assert.equal(fs.readFileSync(path.join(STORY, fresh), 'utf8'), 'SOMEBODY ELSE WROTE THIS')
})

test('a kept candidate is readable after a restart — it is a file, not a memory', () => {
  seed()
  keepCandidate('run.0007', FILE, 'THE WORDS THAT COULD NOT LAND')
  assert.equal(fs.readFileSync(candidatePath('run.0007'), 'utf8'), 'THE WORDS THAT COULD NOT LAND')
  const index = fs.readFileSync(path.join(STORY, '.arc', 'candidates', 'index.jsonl'), 'utf8')
  assert.match(index, /run\.0007/)
  assert.match(index, new RegExp(FILE.replace(/[/.]/g, '\\$&')))
})

// ---- the two bars stay apart ----------------------------------------------

test('a stale draft still accepts; it is the base that refuses', async () => {
  seed()
  const note = createAnnotation({ scene: SCENE, body: 'a note the pass was handed' })
  drafted('What arc wrote from that note.')
  updateAnnotation(note.id, { status: 'resolved' })

  const change = proseDraft().changes.find(c => c.file === FILE)!
  assert.equal(change.stale?.why, 'the record moved', 'a warning')

  // And it accepts, because accepting destroys nothing the author wrote.
  const { proseAccept } = await import('../src/story.ts')
  const out = proseAccept(undefined, [FILE], { [FILE]: change.base })
  assert.deepEqual(out.files, [FILE])
  assert.match(git(STORY, 'show', `HEAD:${FILE}`), /What arc wrote from that note\./)
})

test('a draft that has not been decided about never expires', () => {
  seed()
  drafted('Pending, and nobody has decided.')
  // Nothing here has a clock. The one thing that could remove it is the
  // author deciding, and they have not (the epic's Q12 answer: no window for
  // anything the author has not decided about).
  const before = proseDraft().changes.length
  assert.equal(before, 1)
  assert.equal(proseDraft().changes.length, before, 'still there, and will be')
})
