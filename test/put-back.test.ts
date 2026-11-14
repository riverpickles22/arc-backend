// PUT IT BACK (A72-8): one recorded accept, reversed, after showing what
// putting it back touches. Every grain, added and deleted scenes, later work
// kept, later work on the same paragraph refused, pending prose refused, a
// lock after the preview refused, a double confirm answered once, a failed
// commit leaving everything as it was, and the readers that must now tell a
// standing decision from a reversed one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { git, makeStory, writeScene } from './fixture.ts'

const STORY = makeStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

const { proseAccept, proseAcceptParagraph, proseAcceptSentence, proseDraft } = await import('../src/story.ts')
const { baseOf } = await import('../src/base.ts')
const { readJudgments, readPutBacks, EVIDENCE_REL } = await import('../src/evidence.ts')
const { decisionHistory, previewPutBack, putBack, inverseOf, standingJudgments } = await import('../src/put-back.ts')
const { createLock } = await import('../src/locks.ts')
const { createAnnotation, annotations, closeAnsweredNotes } = await import('../src/annotations.ts')
const { recordGenerated } = await import('../src/ledger.ts')
const { attribute } = await import('../src/note-lifecycle.ts')
const { paragraphsOf } = await import('../src/blast-radius.ts')
const { decidedPartly } = await import('../src/replay.ts')

const FILE = 'prose/ch-01/scene-01.md'
const abs = path.join(STORY, FILE)
const P1 = 'Original first paragraph.', P2 = 'Second paragraph, as written.', P3 = 'Third paragraph, left alone.'
const basesOf = (files: string[]) => Object.fromEntries(files.map(f => [f, baseOf(f)]))
const lastDecision = () => readJudgments().at(-1)!.decision!
const head = (file = FILE): string | null => { try { return git(STORY, 'show', `HEAD:${file}`) } catch { return null } }
const status = (e: unknown) => (e as { status?: number }).status

const reset = (body = `${P1}\n\n${P2}\n\n${P3}`) => {
  git(STORY, 'checkout', 'HEAD', '--', '.'); git(STORY, 'clean', '-fdq')
  fs.rmSync(path.join(STORY, '.arc'), { recursive: true, force: true })
  for (const d of ['annotations', 'locks', 'docs']) fs.rmSync(path.join(STORY, d), { recursive: true, force: true })
  fs.rmSync(path.join(STORY, 'prose', 'ch-01', 'scene-02.md'), { force: true })
  writeScene(STORY, FILE, 'sc.01-1', body)
  git(STORY, 'add', '-A'); if (git(STORY, 'status', '--porcelain').trim()) git(STORY, 'commit', '-qm', 'seed')
}
const edit = (from: string, to: string, file = FILE) => {
  const p = path.join(STORY, file)
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(from, to))
}

// ---- every grain, byte for byte -------------------------------------------------------

test('a whole-scene accept, put back, leaves the scene byte-equal to before — both decisions on record', () => {
  reset()
  const before = head()!
  edit(P1, 'A slower first paragraph.')
  proseAccept(undefined, [FILE], basesOf([FILE]))
  const d = lastDecision()
  assert.notEqual(head(), before)

  const p = previewPutBack(d).preview
  assert.equal(p.file, FILE); assert.deepEqual(p.touched, { changed: 1, added: 0, removed: 0 })
  assert.match(p.restored!, /Original first paragraph/)
  assert.ok(p.token.length === 16)
  const r = putBack(d, p.token)
  assert.equal(r.already, false); assert.equal(r.reverses, d)
  assert.equal(head(), before, 'byte for byte')
  assert.equal(fs.readFileSync(abs, 'utf8'), before, 'and the working tree agrees')
  assert.equal(proseDraft().changes.length, 0)

  const h = decisionHistory('sc.01-1')
  assert.deepEqual(h.map(x => x.state), ['reversal', 'reversed'])
  assert.equal(h[1].reversedBy, r.reversal); assert.equal(h[0].reverses, d)
  // the original record is untouched
  const original = readJudgments().find(j => j.decision === d)!
  assert.equal(original.verdict, 'approved', 'the author\'s own hand, taken whole — the record is exactly as the accept wrote it')
  // and the commit carried the file and the record, nothing else
  const committed = git(STORY, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean)
  assert.deepEqual(committed.sort(), [EVIDENCE_REL, FILE].sort())
})

test('a paragraph accept, put back, keeps a later unrelated accept in the same scene', () => {
  reset()
  edit(P1, 'A slower first paragraph.'); edit(P2, 'Second, cut.')
  proseAcceptParagraph(FILE, { side: 'draft', paragraph: 0 }, baseOf(FILE))
  const first = lastDecision()
  proseAcceptParagraph(FILE, { side: 'draft', paragraph: 1 }, baseOf(FILE))
  const second = lastDecision()

  const p = previewPutBack(first).preview
  assert.deepEqual(p.remains.laterDecisions, [second], 'the later decision is named, and stands')
  putBack(first, p.token)
  const now = head()!
  assert.match(now, /Original first paragraph\./, 'the first decision is undone')
  assert.match(now, /Second, cut\./, 'the second is kept')
  assert.doesNotMatch(now, /A slower first paragraph/)
  assert.deepEqual(decisionHistory('sc.01-1').map(x => x.state), ['reversal', 'standing', 'reversed'])
})

test('a sentence accept, put back', () => {
  reset()
  edit(P1, `${P1} A sentence the pass added.`)
  proseAcceptSentence(FILE, { paragraph: 0, side: 'draft', sentence: 1 }, baseOf(FILE))
  const d = lastDecision()
  assert.match(head()!, /A sentence the pass added/)
  const p = previewPutBack(d).preview
  assert.equal(p.granularity, 'sentence')
  putBack(d, p.token)
  assert.doesNotMatch(head()!, /A sentence the pass added/)
  assert.match(head()!, /Original first paragraph\./)
})

test('an added scene, put back, goes away; edited since, it refuses', () => {
  reset()
  const NEW = 'prose/ch-01/scene-02.md'
  writeScene(STORY, NEW, 'sc.01-2', 'A whole new scene.')
  proseAccept(undefined, [NEW], basesOf([NEW]))
  const d = lastDecision()
  assert.ok(head(NEW))
  const p = previewPutBack(d).preview
  assert.equal(p.restored, null, 'the scene would go away')
  putBack(d, p.token)
  assert.equal(head(NEW), null); assert.ok(!fs.existsSync(path.join(STORY, NEW)))

  // again, but with later work on it
  writeScene(STORY, NEW, 'sc.01-2', 'A whole new scene.')
  proseAccept(undefined, [NEW], basesOf([NEW]))
  const d2 = lastDecision()
  edit('A whole new scene.', 'A whole new scene, grown since.', NEW)
  proseAccept(undefined, [NEW], basesOf([NEW]))
  assert.throws(() => previewPutBack(d2), (e: unknown) => status(e) === 409 && /edited since/.test(String((e as Error).message)))
  assert.ok(head(NEW), 'and nothing was touched')
})

test('a deleted scene, put back, comes back byte for byte', () => {
  reset()
  const before = head()!
  fs.rmSync(abs)
  proseAccept(undefined, [FILE], basesOf([FILE]))
  const d = lastDecision()
  assert.equal(head(), null)
  const p = previewPutBack(d).preview
  assert.equal(p.now, null); assert.match(p.restored!, /Original first/)
  putBack(d, p.token)
  assert.equal(head(), before)
})

// ---- what refuses, and writes nothing ----------------------------------------------------

test('a later edit on the same paragraph is an overlap: refused, nothing written', () => {
  reset()
  edit(P1, 'A slower first paragraph.')
  proseAccept(undefined, [FILE], basesOf([FILE]))
  const first = lastDecision()
  edit('A slower first paragraph.', 'A slower first paragraph, then slower still.')
  proseAccept(undefined, [FILE], basesOf([FILE]))
  const now = head()
  assert.throws(() => previewPutBack(first), (e: unknown) => status(e) === 409 && /edited since this decision/.test(String((e as Error).message)))
  assert.equal(head(), now)
})

test('pending prose on the scene refuses; a pending change on another scene is left alone', () => {
  reset()
  edit(P1, 'A slower first paragraph.')
  proseAccept(undefined, [FILE], basesOf([FILE]))
  const d = lastDecision()
  edit(P3, 'Third, being typed right now.')
  assert.throws(() => previewPutBack(d), (e: unknown) => status(e) === 409 && /unaccepted edits/.test(String((e as Error).message)))
  assert.match(fs.readFileSync(abs, 'utf8'), /being typed right now/, 'their words are still there')
  git(STORY, 'checkout', 'HEAD', '--', FILE)
  // another scene pending: untouched by the put-back
  const OTHER = 'prose/ch-01/scene-02.md'
  writeScene(STORY, OTHER, 'sc.01-2', 'Another scene, pending.')
  const p = previewPutBack(d).preview
  putBack(d, p.token)
  assert.ok(fs.existsSync(path.join(STORY, OTHER)) && head(OTHER) === null, 'still pending, still uncommitted')
})

test('a lock added after the preview refuses the confirm as a lock does everywhere — 423 — with nothing written', () => {
  reset()
  edit(P1, 'A slower first paragraph.')
  proseAccept(undefined, [FILE], basesOf([FILE]))
  const d = lastDecision()
  const p = previewPutBack(d).preview
  createLock({ scene: 'sc.01-1', paragraph: 0, quote: 'A slower first' })
  git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'lock')
  const was = head()
  // the lock answers before the token does: rule 2, every write path, 423
  assert.throws(() => putBack(d, p.token), (e: unknown) => status(e) === 423)
  assert.throws(() => previewPutBack(d), (e: unknown) => status(e) === 423)
  assert.equal(head(), was)
  assert.equal(readPutBacks().length, 0)
})

test('the scene moving after the preview — another decision landing — refuses the confirm until a new preview is read', () => {
  reset()
  edit(P1, 'A slower first paragraph.')
  proseAccept(undefined, [FILE], basesOf([FILE]))
  const d = lastDecision()
  const stale = previewPutBack(d).preview
  edit(P3, 'Third, also pending.')
  proseAccept(undefined, [FILE], basesOf([FILE]))   // the scene moved: a later decision landed
  const was = head()
  assert.throws(() => putBack(d, stale.token), (e: unknown) => status(e) === 409 && /changed since you looked/.test(String((e as Error).message)))
  assert.equal(head(), was); assert.equal(readPutBacks().length, 0)
  const fresh = previewPutBack(d).preview
  assert.notEqual(fresh.token, stale.token)
  putBack(d, fresh.token)
  assert.match(head()!, /Original first paragraph\./); assert.match(head()!, /Third, also pending\./)
})

test('a decision that cannot be proved, or that put nothing in, is readable and not reversible', () => {
  reset()
  edit(P1, 'A slower first paragraph.')
  proseAccept(undefined, [FILE], basesOf([FILE]))
  // a record from before decisions carried an id
  const legacy = { at: new Date().toISOString(), file: FILE, scene: 'sc.01-1', granularity: 'scene', paragraph: null, verdict: 'accepted', arcWrote: '', authorKept: '', origin: 'hand', baseline: null }
  fs.appendFileSync(path.join(STORY, EVIDENCE_REL), JSON.stringify(legacy) + '\n')
  const h = decisionHistory('sc.01-1')
  assert.equal(h[0].state, 'not reversible'); assert.equal(h[0].decision, undefined)
  assert.equal(h[1].state, 'standing')
  assert.throws(() => previewPutBack('dec.never.minted'), (e: unknown) => status(e) === 404)
})

// ---- once, and only once -------------------------------------------------------------------

test('confirming twice — a double click, a lost response, a restart — appends nothing and answers with the reversal on record', () => {
  reset()
  edit(P1, 'A slower first paragraph.')
  proseAccept(undefined, [FILE], basesOf([FILE]))
  const d = lastDecision()
  const p = previewPutBack(d).preview
  const putBacksBefore = git(STORY, 'log', '--oneline').split('\n').filter(l => /put back/.test(l)).length
  const first = putBack(d, p.token)
  const again = putBack(d, p.token)
  assert.equal(again.already, true); assert.equal(again.reversal, first.reversal); assert.equal(again.hash, first.hash)
  const stale = putBack(d, 'a-token-from-before')
  assert.equal(stale.already, true, 'even with a token that no longer matches: the record answers first')
  assert.equal(readPutBacks().length, 1)
  assert.equal(git(STORY, 'log', '--oneline').split('\n').filter(l => /put back/.test(l)).length, putBacksBefore + 1)
  assert.throws(() => previewPutBack(d), (e: unknown) => status(e) === 409 && /already been put back/.test(String((e as Error).message)))
})

test('a failed commit leaves the scene, the record and the index exactly as they were', () => {
  reset()
  edit(P1, 'A slower first paragraph.')
  proseAccept(undefined, [FILE], basesOf([FILE]))
  const d = lastDecision()
  const p = previewPutBack(d).preview
  const was = fs.readFileSync(abs, 'utf8'); const log = fs.readFileSync(path.join(STORY, EVIDENCE_REL), 'utf8')
  // something else holds the index: the lane refuses before anything is written
  const lock = path.join(git(STORY, 'rev-parse', '--absolute-git-dir').trim(), 'index.lock')
  fs.writeFileSync(lock, '')
  try {
    assert.throws(() => putBack(d, p.token), (e: unknown) => status(e) === 409)
  } finally { fs.rmSync(lock, { force: true }) }
  assert.equal(fs.readFileSync(abs, 'utf8'), was)
  assert.equal(fs.readFileSync(path.join(STORY, EVIDENCE_REL), 'utf8'), log)
  assert.equal(readPutBacks().length, 0)
})

test('unrelated staged work is neither committed nor unstaged by a put-back', () => {
  reset()
  edit(P1, 'A slower first paragraph.')
  proseAccept(undefined, [FILE], basesOf([FILE]))
  const d = lastDecision()
  const OTHER = 'prose/ch-01/scene-02.md'
  writeScene(STORY, OTHER, 'sc.01-2', 'Staged by hand, not decided.')
  git(STORY, 'add', '--', OTHER)
  const p = previewPutBack(d).preview
  putBack(d, p.token)
  const committed = git(STORY, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean)
  assert.ok(!committed.includes(OTHER), 'not swept into the put-back')
  assert.match(git(STORY, 'status', '--porcelain', '--', OTHER), /^A /, 'and still staged')
})

// ---- what remains, and the readers ---------------------------------------------------------

test('the notes that accept resolved stay resolved and are named; standing readers drop the reversed accept, history keeps it', () => {
  reset()
  const a = createAnnotation({ scene: 'sc.01-1', paragraph: 0, quote: 'Original first', body: 'slower' })
  git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'note')
  const raw = fs.readFileSync(abs, 'utf8'); const fm = raw.match(/^---\n[\s\S]*?\n---\n/)![0]
  const before = paragraphsOf(raw.slice(fm.length)); const after = ['A slower first paragraph.', P2, P3]
  const handed = annotations().filter(n => n.id === a.id)
  fs.writeFileSync(abs, fm + '\n' + after.join('\n\n') + '\n')
  recordGenerated(FILE, fs.readFileSync(abs, 'utf8'), { origin: 'revise', scene: 'sc.01-1', notes: [a.id], attribution: attribute(before, after, handed) })
  const entryAt = new Date(Date.now() - 1000).toISOString()
  proseAccept(undefined, [FILE], basesOf([FILE]))
  assert.deepEqual(closeAnsweredNotes([FILE]), [a.id])
  const d = lastDecision()

  const p = previewPutBack(d).preview
  assert.deepEqual(p.remains.notes, [a.id], 'named: it stays resolved, reopen by hand')
  assert.deepEqual(p.remains.unknown, ['no pass is linked to this decision, so arc cannot say which receipt it came from'])
  putBack(d, p.token)
  assert.equal(annotations().find(n => n.id === a.id)?.status, 'resolved', 'never silently reopened')
  assert.ok(!standingJudgments().some(j => j.decision === d), 'a standing reader no longer counts it')
  assert.ok(readJudgments().some(j => j.decision === d), 'history does')
  assert.deepEqual(decidedPartly(FILE, entryAt), [], 'a replay does not ask about replacing a decision that was put back')
})

test('a record with no commit behind it — a crash between the record and the commit — is not a reversal: the put-back still runs, once', () => {
  reset()
  edit(P1, 'A slower first paragraph.')
  proseAccept(undefined, [FILE], basesOf([FILE]))
  const d = lastDecision()
  const orphan = { at: new Date().toISOString(), kind: 'put-back', decision: 'dec.orphan.00000000', reverses: d, file: FILE, scene: 'sc.01-1', granularity: 'scene', base: 'x', after: 'y', touched: { changed: 1, added: 0, removed: 0 } }
  fs.appendFileSync(path.join(STORY, EVIDENCE_REL), JSON.stringify(orphan) + '\n')
  assert.equal(decisionHistory('sc.01-1')[0].state, 'standing', 'the book still holds the accept, so it stands')
  assert.ok(standingJudgments().some(j => j.decision === d))
  const p = previewPutBack(d).preview
  const r = putBack(d, p.token)
  assert.equal(r.already, false, 'the orphan line was never a reversal')
  assert.match(head()!, /Original first paragraph\./)
  assert.equal(putBack(d, p.token).reversal, r.reversal, 'and now the record answers')
})

test('a locked scene the inverse would remove refuses with 423, like every write path', () => {
  reset()
  const NEW = 'prose/ch-01/scene-02.md'
  writeScene(STORY, NEW, 'sc.01-2', 'A whole new scene.')
  proseAccept(undefined, [NEW], basesOf([NEW]))
  const d = lastDecision()
  createLock({ scene: 'sc.01-2' })
  git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'lock')
  assert.throws(() => previewPutBack(d), (e: unknown) => status(e) === 423)
  assert.ok(head(NEW))
})

test('the inverse, pure: a paragraph inserted into the seam a deletion came from makes its return a guess, and refuses', () => {
  const fm = '---\nscene: sc\n---\n'
  const before = fm + 'A.\n\nB.\n\nC.\n\nD.\n', after = fm + 'A.\n\nD.\n'
  assert.throws(() => inverseOf(before, after, fm + 'A.\n\nE.\n\nD.\n'), (e: unknown) => status(e) === 409)
  // the neighbours edited, the seam intact: fine, in order
  const { result } = inverseOf(before, after, fm + 'A, edited.\n\nD, edited.\n')
  assert.equal(result, fm + 'A, edited.\n\nB.\n\nC.\n\nD, edited.\n')
  // and the file's own whitespace around the body is kept as it is
  const spaced = inverseOf(fm + '\nA.\n\nB.\n', fm + '\nA, slower.\n\nB.\n', fm + '\nA, slower.\n\nB, later.\n')
  assert.equal(spaced.result, fm + '\nA.\n\nB, later.\n')
})

test('the inverse, pure: later paragraphs elsewhere are kept; the accept\'s own insertion goes, its deletion returns', () => {
  const fm = '---\nscene: sc\n---\n'
  const before = fm + 'One.\n\nTwo.\n\nThree.\n'
  const after = fm + 'One, slower.\n\nThree.\n\nFour, new.\n'          // rewrote ¶1, deleted ¶2, added ¶4
  const now = fm + 'One, slower.\n\nThree, edited later.\n\nFour, new.\n'  // ¶3 edited since
  const { result, touched } = inverseOf(before, after, now)
  assert.equal(result, fm + 'One.\n\nTwo.\n\nThree, edited later.\n')
  assert.deepEqual(touched, { changed: 1, added: 1, removed: 1 })
})
