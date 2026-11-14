// SLICE 3, END TO END (A72-12): the sequences no single card's tests cover,
// because each of them crosses two or three cards.
//
// Deterministic by construction — no model, no subscription quota, no
// network: every pass's answer here is the ledger entry a pass would have
// written, and every decision is the author's own verb. What is proven is
// the SEQUENCE: a note that resolves and stays resolved when the decision
// that resolved it is put back; a reading that does not attach to words the
// author has replaced; a restart between generation and review, between
// partial decisions, and after a commit whose bookkeeping never finished.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { git, makeStory, writeScene } from './fixture.ts'

const STORY = makeStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

const { proseAccept, proseAcceptParagraph, proseRejectParagraph, proseAcceptSentence, proseDiscard, proseDraft } = await import('../src/story.ts')
const { baseOf } = await import('../src/base.ts')
const { annotations, answeredNow, closeAnsweredNotes, createAnnotation, settleAnsweredNotes, updateAnnotation } = await import('../src/annotations.ts')
const { recordGenerated } = await import('../src/ledger.ts')
const { attribute, readNoteResolutions } = await import('../src/note-lifecycle.ts')
const { paragraphsOf } = await import('../src/blast-radius.ts')
const { decisionHistory, previewPutBack, putBack } = await import('../src/put-back.ts')
const { readJudgments, EVIDENCE_REL } = await import('../src/evidence.ts')
const { runInspect } = await import('../src/inspect.ts')
const { ROWS, rowKey } = await import('../src/registry.ts')

const FILE = 'prose/ch-01/scene-01.md'
const abs = path.join(STORY, FILE)
const SCENE = 'sc.01-1'
const P1 = 'Original first paragraph.', P2 = 'Second paragraph, as written.', P3 = 'Third paragraph, left alone.'
const basesOf = (files: string[]) => Object.fromEntries(files.map(f => [f, baseOf(f)]))
const status = (id: string) => annotations().find(n => n.id === id)?.status
const lastDecision = () => readJudgments().at(-1)!.decision!
const httpStatus = (e: unknown) => (e as { status?: number }).status

const reset = (body = `${P1}\n\n${P2}\n\n${P3}`) => {
  git(STORY, 'checkout', 'HEAD', '--', '.'); git(STORY, 'clean', '-fdq')
  for (const d of ['.arc', 'annotations', 'locks', 'docs']) fs.rmSync(path.join(STORY, d), { recursive: true, force: true })
  writeScene(STORY, FILE, SCENE, body)
  git(STORY, 'add', '-A'); if (git(STORY, 'status', '--porcelain').trim()) git(STORY, 'commit', '-qm', 'seed')
}

/** A pass lands, exactly as `work-notes.ts` records it: the prose, the notes
 *  it was handed, and what each of them is owed. */
const landed = (edits: Record<number, string>, handed: string[]): void => {
  const raw = fs.readFileSync(abs, 'utf8')
  const fm = raw.match(/^---\n[\s\S]*?\n---\n/)![0]
  const before = paragraphsOf(raw.slice(fm.length))
  const after = before.map((p, i) => edits[i] ?? p)
  const notes = annotations().filter(n => handed.includes(n.id))
  const next = fm + '\n' + after.join('\n\n') + '\n'
  fs.writeFileSync(abs, next)
  recordGenerated(FILE, next, { origin: 'revise', scene: SCENE, notes: handed, attribution: attribute(before, after, notes) })
}
const commitNotes = () => { git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'notes') }

// ---- 4 + 5 · the note lifecycle meets putting it back ---------------------------

test('a note resolved by an accept stays resolved when that accept is put back — a decision reversed is not a thought reopened', () => {
  reset()
  const n = createAnnotation({ scene: SCENE, paragraph: 0, quote: 'Original first', body: 'slower' })
  commitNotes()
  landed({ 0: 'A slower first paragraph.' }, [n.id])
  proseAcceptParagraph(FILE, { side: 'draft', paragraph: 0 }, baseOf(FILE))
  assert.deepEqual(closeAnsweredNotes([FILE]), [n.id])
  const d = lastDecision()
  assert.equal(readNoteResolutions().at(-1)?.decision, d, 'which decision resolved it is on record')

  const p = previewPutBack(d).preview
  assert.deepEqual(p.remains.notes, [n.id], 'the preview names the note as something that stays')
  putBack(d, p.token)
  assert.equal(status(n.id), 'resolved', 'arc never reopens a thought the author closed')
  assert.match(git(STORY, 'show', `HEAD:${FILE}`), /Original first paragraph\./, 'and the words are back')
  // and the note's own history is intact: the resolution line is not rewritten
  assert.equal(readNoteResolutions().filter(r => r.note === n.id).length, 1)
})

test('two notes, one accepted and one discarded, then the accept put back: the second note never resolves', () => {
  reset()
  const a = createAnnotation({ scene: SCENE, paragraph: 0, quote: 'Original first', body: 'slower' })
  const b = createAnnotation({ scene: SCENE, paragraph: 1, quote: 'Second', body: 'cut it' })
  commitNotes()
  landed({ 0: 'A slower first paragraph.', 1: 'Second, cut.' }, [a.id, b.id])
  proseRejectParagraph(FILE, { side: 'draft', paragraph: 1 }, baseOf(FILE))
  proseAcceptParagraph(FILE, { side: 'draft', paragraph: 0 }, baseOf(FILE))
  assert.deepEqual(closeAnsweredNotes([FILE]), [a.id])
  assert.equal(status(b.id), 'open')
  const p = previewPutBack(lastDecision()).preview
  putBack(p.decision, p.token)
  assert.equal(status(a.id), 'resolved'); assert.equal(status(b.id), 'open')
  assert.deepEqual(proseDraft().changes, [], 'and nothing is left pending')
})

// ---- the restarts §11 asks for -------------------------------------------------

test('a restart between generation and review loses nothing: the draft, its provenance and its badges are read off disk', async () => {
  reset()
  const n = createAnnotation({ scene: SCENE, paragraph: 0, quote: 'Original first', body: 'slower' })
  commitNotes()
  landed({ 0: 'A slower first paragraph.' }, [n.id])

  // A REAL RESTART, not a second call: fresh module instances, so nothing
  // this process already holds can answer. A memo added to any of these
  // later would break here and nowhere else.
  const stamp = `?restart=${Date.now()}`
  const fresh = {
    story: await import(`../src/story.ts${stamp}`),
    notes: await import(`../src/annotations.ts${stamp}`),
  } as unknown as { story: typeof import('../src/story.ts'); notes: typeof import('../src/annotations.ts') }

  const change = fresh.story.proseDraft().changes.find(c => c.file === FILE)!
  assert.equal(change.origin, 'revise')
  assert.deepEqual(change.answers, [n.id])
  assert.deepEqual(fresh.notes.answeredNow(change)?.map(x => [x.id, x.state]), [[n.id, 'waiting']])
  assert.ok(change.base, 'and the diff can still be decided about')
})

test('a restart between partial decisions: the second accept still knows what the first left', () => {
  reset()
  const n = createAnnotation({ scene: SCENE, paragraph: 0, quote: 'Original first', body: 'slower' })
  commitNotes()
  landed({ 0: 'A slower first sentence. A slower second sentence.' }, [n.id])
  proseAcceptSentence(FILE, { paragraph: 0, side: 'draft', sentence: 0 }, baseOf(FILE))
  assert.deepEqual(closeAnsweredNotes([FILE]), [], 'the note waits for the rest of its change')
  // restart: the evidence log and the ledger are the only memory
  assert.equal(readJudgments().filter(j => j.file === FILE).length, 1)
  const change = proseDraft().changes.find(c => c.file === FILE)!
  assert.deepEqual(answeredNow(change)?.map(x => x.state), ['waiting'])
  proseAcceptSentence(FILE, { paragraph: 0, side: 'draft', sentence: 1 }, baseOf(FILE))
  proseAcceptSentence(FILE, { paragraph: 0, side: 'main', sentence: 0 }, baseOf(FILE))
  assert.deepEqual(closeAnsweredNotes([FILE]), [n.id], 'and the whole change is in')
})

test('a restart after a commit whose bookkeeping never ran: the sweep closes what the book already answered, once', () => {
  reset()
  const n = createAnnotation({ scene: SCENE, paragraph: 0, quote: 'Original first', body: 'slower' })
  commitNotes()
  landed({ 0: 'A slower first paragraph.' }, [n.id])
  proseAccept(undefined, [FILE], basesOf([FILE]))   // the route would close the note next; the process died
  assert.equal(status(n.id), 'open')
  assert.deepEqual(settleAnsweredNotes(), [n.id], 'startup settles it')
  assert.deepEqual(settleAnsweredNotes(), [], 'and never twice')
})

// ---- 8 · a reading never attaches to words the author replaced ------------------

test('a late reading does not attach to a replacement proposal, and never blocks the accept', async () => {
  reset()
  landed({ 0: 'A slower first paragraph.' }, [])
  const readAbout = baseOf(FILE)
  // the author replaces the pending words while the reading is out
  fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace('A slower first paragraph.', 'My own first paragraph.'))
  // the late answer is about a diff that no longer exists: refused, not attached
  await assert.rejects(runInspect(SCENE, readAbout), (e: unknown) => httpStatus(e) === 409)
  // and the accept is exactly as available as it was
  const out = proseAccept(undefined, [FILE], basesOf([FILE]))
  assert.deepEqual(out.files, [FILE])
  assert.match(git(STORY, 'show', `HEAD:${FILE}`), /My own first paragraph\./)
})

// ---- 7 · concurrent and failed decisions ----------------------------------------

test('two stale decisions about one revision cannot both land, and unrelated staged work survives a refusal', () => {
  reset()
  const OTHER = 'prose/ch-01/scene-02.md'
  writeScene(STORY, OTHER, 'sc.01-2', 'Another scene, staged by hand.')
  git(STORY, 'add', '--', OTHER)
  landed({ 0: 'A slower first paragraph.', 2: 'Third, also changed.' }, [])

  const readByBoth = basesOf([FILE])
  proseAcceptParagraph(FILE, { side: 'draft', paragraph: 0 }, readByBoth[FILE])
  // the second view still holds the base it read: the scene has moved
  assert.throws(() => proseAcceptParagraph(FILE, { side: 'draft', paragraph: 2 }, readByBoth[FILE]),
    (e: unknown) => httpStatus(e) === 409)
  assert.ok(proseDraft().changes.some(c => c.file === FILE), 'the second paragraph is still pending, undecided')
  assert.match(git(STORY, 'status', '--porcelain', '--', OTHER), /^A /, 'and the hand-staged scene is untouched')
  // reading again, the same decision lands
  proseAcceptParagraph(FILE, { side: 'draft', paragraph: 2 }, baseOf(FILE))
  assert.deepEqual(proseDraft().changes.filter(c => c.file === FILE), [])
})

test('a foreign lock refuses every decision in the author\'s words, leaves no verdict, and the next valid request works', () => {
  reset()
  const n = createAnnotation({ scene: SCENE, paragraph: 0, quote: 'Original first', body: 'slower' })
  commitNotes()
  landed({ 0: 'A slower first paragraph.' }, [n.id])
  const evidence = path.join(STORY, EVIDENCE_REL)
  const before = fs.existsSync(evidence) ? fs.readFileSync(evidence, 'utf8').length : 0
  const lock = path.join(git(STORY, 'rev-parse', '--absolute-git-dir').trim(), 'index.lock')
  fs.writeFileSync(lock, '')
  try {
    assert.throws(() => proseAccept(undefined, [FILE], basesOf([FILE])), (e: unknown) => {
      assert.equal(httpStatus(e), 409)
      assert.match((e as Error).message, /Something else is writing to this story right now/)
      assert.doesNotMatch((e as Error).message, /\bgit\b|index\.lock/, 'and not in the machine\'s words')
      return true
    })
  } finally { fs.rmSync(lock, { force: true }) }
  assert.equal(fs.existsSync(evidence) ? fs.readFileSync(evidence, 'utf8').length : 0, before, 'no verdict was recorded')
  assert.equal(status(n.id), 'open', 'and no note was closed')
  proseAccept(undefined, [FILE], basesOf([FILE]))
  assert.deepEqual(closeAnsweredNotes([FILE]), [n.id], 'the next valid request works')
})

// ---- 4 · the surface takes generated output only from a governed run ------------

test('the legacy seam ratchet is exactly four, and U9 and U12 are on rows', () => {
  const keys = ROWS.map(rowKey)
  assert.ok(keys.includes('inspect.scene.one-shot'), 'U9 has its row (A72-10)')
  assert.ok(keys.includes('learn.manuscript.triggered'), 'U12 has its row (A74-6)')
  // COUNTED HERE, not read off another file: the epic's exit bar is a claim
  // about the code, so it is checked against the code. `engine.ts` holds the
  // definition, not a launch.
  const src = path.join(import.meta.dirname, '..', 'src')
  const bare = fs.readdirSync(src).filter(f => f.endsWith('.ts'))
    .filter(f => f !== 'engine.ts')
    .filter(f => fs.readFileSync(path.join(src, f), 'utf8')
      .split('\n').some(l => /\brunCliPrompt\s*\(/.test(l) && !/^\s*(\/\/|\*)/.test(l)))
  assert.deepEqual(bare.sort(), ['intent.ts', 'judge.ts', 'lenses.ts', 'material.ts'],
    'four passes still launch without a row — the five lenses\' shared call, intake, the material worker and the judgment')
  assert.equal(bare.length, 4, 'the ratchet, counted in src (slice 3 claimed six; U12 took its row in A74-6, the bootstrap in A74-7)')
  assert.ok(keys.includes('learn.manuscript.one-shot'), 'the bootstrap has its row (A74-7)')
  assert.ok(!bare.includes('bootstrap-style.ts'), 'the bootstrap took its row, and its bare call went with it')
  assert.ok(!bare.includes('learn-style.ts'), 'learn-style took U12\'s row, and its bare call went with it')
  assert.ok(!bare.includes('analyze.ts'), 'analyze took U9\'s row, and its bare call went with it')
})

test('the decisions history tells every kind of decision apart, and a reversal is one of them', () => {
  reset()
  landed({ 0: 'A slower first paragraph.', 1: 'Second, cut.' }, [])
  proseRejectParagraph(FILE, { side: 'draft', paragraph: 1 }, baseOf(FILE))
  proseAcceptParagraph(FILE, { side: 'draft', paragraph: 0 }, baseOf(FILE))
  const taken = lastDecision()
  const p = previewPutBack(taken).preview
  putBack(taken, p.token)
  // SORTED, not ordered: `decisionHistory` sorts by the moment alone, and
  // three records inside one second can tie. What this test is about is
  // that the three KINDS are told apart, not which millisecond won.
  const h = decisionHistory(SCENE)
  assert.deepEqual(h.map(x => x.state).sort(), ['not reversible', 'reversal', 'reversed'],
    'the put-back, the accept it reversed, and the rejection that put nothing in')
  assert.equal(h.find(x => x.state === 'not reversible')!.verdict, 'rejected')
  assert.equal(h.find(x => x.state === 'reversal')!.verdict, 'put back')
})

test('a discard leaves every handed note open and the book where it was', () => {
  reset()
  const a = createAnnotation({ scene: SCENE, paragraph: 0, quote: 'Original first', body: 'slower' })
  const s = createAnnotation({ scene: SCENE, body: 'the whole thing drags' })
  commitNotes()
  landed({ 0: 'A slower first paragraph.', 2: 'Third, quicker.' }, [a.id, s.id])
  const head = git(STORY, 'show', `HEAD:${FILE}`)
  proseDiscard(FILE, baseOf(FILE))
  assert.deepEqual(closeAnsweredNotes([FILE]), [])
  assert.equal(status(a.id), 'open'); assert.equal(status(s.id), 'open')
  assert.equal(git(STORY, 'show', `HEAD:${FILE}`), head)
  assert.equal(fs.readFileSync(abs, 'utf8'), head, 'and the working tree is the book again')
})

test('a note edited while its draft waited is a new instruction, through every door', () => {
  reset()
  const n = createAnnotation({ scene: SCENE, paragraph: 0, quote: 'Original first', body: 'slower' })
  commitNotes()
  landed({ 0: 'A slower first paragraph.' }, [n.id])
  updateAnnotation(n.id, { body: 'no — faster, and shorter' })
  const change = proseDraft().changes.find(c => c.file === FILE)!
  assert.deepEqual(answeredNow(change), [], 'the rail stops claiming the draft answers it')
  proseAcceptParagraph(FILE, { side: 'draft', paragraph: 0 }, baseOf(FILE))
  assert.deepEqual(closeAnsweredNotes([FILE]), [])
  assert.equal(settleAnsweredNotes().includes(n.id), false, 'and the sweep does not close it either')
  assert.equal(status(n.id), 'open')
})
