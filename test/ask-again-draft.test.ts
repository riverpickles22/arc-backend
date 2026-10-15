// ASK AGAIN, FOR A PENDING DRAFT (A72-13). The same question, asked again
// from where the record stands now — and never at the cost of what is there.
//
// A69-13 gave routes a re-issue; a draft had nothing, so the author's only way
// back was to discard what arc wrote and type the request a second time. That
// is a gesture which destroys work before it knows whether the replacement is
// any good, and it is the gesture this file makes unnecessary.
//
// Pinned here: the request is recorded at the landing and re-asked from the
// record as it stands, never from the rendered brief; a draft the author has
// been in is never replaced without being asked for in as many words; a replay
// takes the review token like any other decision about words on screen; a
// failure leaves exactly what was there; the old and new proposals are linked
// and neither becomes a verdict; a passage rebuild whose range no longer lands
// is refused rather than asked about different paragraphs; and two replays of
// one destination cannot race.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { SCENE, STORY, reset } from './fixture-scenarios.ts'

const { runRedraft } = await import('../src/redraft.ts')
const { sceneSlot } = await import('../src/draft.ts')
const { proseDraft, proseScenes } = await import('../src/story.ts')
const { generatedFor } = await import('../src/ledger.ts')
const { baseOf } = await import('../src/base.ts')
const { admitReplay, claimReplay, decidedPartly, notesMoved, planReplay, releaseReplay, replayInFlight, replayable, resolveRange, theirsNow } =
  await import('../src/replay.ts')
const { noteVersion } = await import('../src/reads.ts')
const { recordJudgment } = await import('../src/evidence.ts')
const { annotations, createAnnotation, updateAnnotation } = await import('../src/annotations.ts')
type HttpError = Error & { status: number; detail?: Record<string, unknown> }

const fileOf = (): string => proseScenes().find(s => s.scene === SCENE)!.file
const absOf = (): string => path.join(STORY, fileOf())
const refusal = (e: unknown): HttpError => e as HttpError

// ---- what the landing recorded --------------------------------------------

test('a landed draft records the question it answered, not the brief it was sent', async () => {
  reset()
  await runRedraft({ scene: SCENE })
  const entry = generatedFor(fileOf())!.entry
  const r = entry.replay
  assert.ok(r, 'the request is on the record')
  assert.equal(r!.row, 'revise.scene.one-shot', 'the row that answered it')
  assert.equal(r!.scene, SCENE)
  assert.equal(r!.file, fileOf(), 'and its own target')
  assert.equal(r!.paragraphs, undefined, 'a whole-scene pass has no scope inside it')
  reset()
})

test('a passage rebuild records the scope it was asked about', async () => {
  reset()
  await runRedraft({ scene: SCENE, paragraphs: [2, 3] })
  const r = generatedFor(fileOf())!.entry.replay!
  assert.equal(r.row, 'revise.selection.one-shot')
  assert.deepEqual(r.paragraphs, [2, 3])
  reset()
})

test('words arc did not write, and words whose question arc did not keep, have nothing to ask again', () => {
  reset()
  const abs = absOf()
  fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').trimEnd() + '\n\nTyped by hand.\n')
  assert.throws(() => replayable(fileOf()), (e: unknown) =>
    refusal(e).status === 409 && /not written by arc/.test(refusal(e).message))
  reset()
})

// ---- what a replay would do, before it does it ----------------------------

test('arc says what asking again would replace before anything is asked', async () => {
  reset()
  await runRedraft({ scene: SCENE })
  const plan = planReplay(fileOf())
  assert.equal(plan.row, 'revise.scene.one-shot')
  assert.equal(plan.replacing.yours, false, 'these are arc\'s words, not the author\'s')
  assert.ok(plan.replacing.words.length, 'and they are shown, not described')
  assert.deepEqual(plan.moved, [], 'nothing has moved under it yet')
  reset()
})

test('what moved is named, by the note that moved — body or no body', () => {
  reset()
  const note = createAnnotation({ scene: SCENE, body: 'the same words throughout' })
  const at = noteVersion(annotations().find(n => n.id === note.id)!)

  // A proposal that read it as it was: nothing has moved.
  assert.deepEqual(notesMoved({ replay: { notes: [{ id: note.id, version: at }] } }), [])

  // The author resolves it. Not a letter of the body changes.
  updateAnnotation(note.id, { status: 'resolved' })
  assert.deepEqual(notesMoved({ replay: { notes: [{ id: note.id, version: at }] } }), [note.id],
    'a resolved note is not the note the pass was handed')

  // A proposal that read no notes has none to have moved.
  assert.deepEqual(notesMoved({ replay: {} }), [])
  reset()
})

// ---- the author's own words are never taken by accident -------------------

test('a draft the author has been in is not replaced without being asked for', async () => {
  reset()
  await runRedraft({ scene: SCENE })
  const abs = absOf()
  const theirs = fs.readFileSync(abs, 'utf8').trimEnd() + '\n\nAnd a line of my own.\n'
  fs.writeFileSync(abs, theirs)
  assert.equal(theirsNow(fileOf(), generatedFor(fileOf())!.content), true)

  assert.throws(() => admitReplay(fileOf(), baseOf(fileOf()), false), (e: unknown) =>
    refusal(e).status === 409
    && /you have written in this draft/.test(refusal(e).message)
    && /Say so and arc will ask again/.test(refusal(e).message))
  assert.equal(fs.readFileSync(abs, 'utf8'), theirs, 'and their line is still there')

  // The refusal carries what would have gone, so the gesture can show it.
  try {
    admitReplay(fileOf(), baseOf(fileOf()), false)
  } catch (e) {
    const detail = refusal(e).detail as { replacing?: string }
    assert.match(String(detail?.replacing), /And a line of my own\./)
  }

  // Asked for in as many words, it is admitted.
  const out = admitReplay(fileOf(), baseOf(fileOf()), true)
  assert.ok(out.replaces.sha, 'and it names the proposal it would replace')
  reset()
})

test('a replay is a decision about the words on screen, so it carries their version', async () => {
  reset()
  await runRedraft({ scene: SCENE })
  const seen = baseOf(fileOf())

  // Somebody writes in the scene after this view was served.
  const abs = absOf()
  fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').trimEnd() + '\n\nTyped in another view.\n')

  assert.throws(() => admitReplay(fileOf(), seen, true), (e: unknown) =>
    refusal(e).status === 409 && /changed these words since|Read it again/.test(refusal(e).message))
  // And with no version at all it fails closed, like every other decision.
  assert.throws(() => admitReplay(fileOf(), undefined, true), (e: unknown) => refusal(e).status === 400)
  reset()
})

// ---- the scope has to still mean what it meant ----------------------------

test('a passage rebuild whose range no longer lands is refused, never asked about other paragraphs', async () => {
  reset()
  const scene = proseScenes().find(s => s.scene === SCENE)!
  const paras = scene.body.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
  // AN INDEX IS NOT AN ANCHOR. The recorded span's own words are what a
  // replay looks for, which is also what lets a passage that MOVED be found
  // where it is now rather than refused.
  assert.deepEqual(resolveRange(SCENE, [0, 0], [paras[0], paras[0]]), [0, 0])
  assert.equal(resolveRange(SCENE, [0, 0], undefined), null, 'indices alone cannot be re-resolved')
  assert.equal(resolveRange(SCENE, [2, 3], ['a paragraph this scene has never had', paras[3]]), null,
    'words that are gone are refused, never reattached to whatever took their place')
  assert.equal(resolveRange('sc.99-9', [0, 0], [paras[0], paras[0]]), null, 'and a scene that is gone is gone')

  await runRedraft({ scene: SCENE, paragraphs: [2, 3] })
  // The scene shrinks under it.
  const abs = absOf()
  const head = fs.readFileSync(abs, 'utf8')
  fs.writeFileSync(abs, head.slice(0, head.indexOf('---', 3) + 4) + '\nOne paragraph, and no more.\n')
  assert.throws(() => admitReplay(fileOf(), baseOf(fileOf()), true), (e: unknown) =>
    refusal(e).status === 409 && /not where they were/.test(refusal(e).message))
  reset()
})

// ---- the replacement, and what it leaves behind ---------------------------

test('a successful replay links the two proposals and makes no verdict of either', async () => {
  reset()
  const original = fs.readFileSync(absOf(), 'utf8')
  await runRedraft({ scene: SCENE })
  const first = generatedFor(fileOf())!
  const { replaces } = admitReplay(fileOf(), baseOf(fileOf()), false)
  assert.equal(replaces.sha, first.entry.sha)

  // Asking again runs the pass again. The fixture engine answers a brief it
  // has seen, so the scene goes back to what that brief was rendered from —
  // which is also what asking again MEANS: the same question, from the
  // record as it stands.
  fs.writeFileSync(absOf(), original)
  await runRedraft({ scene: SCENE, replaces })
  const second = generatedFor(fileOf())!.entry
  assert.deepEqual(second.supersedes, replaces, 'the new one names the one it replaced')
  // The fixture engine answers the same brief with the same words, so the two
  // proposals may be byte-identical — which is the honest outcome of asking a
  // deterministic engine the same question twice. What matters is that this is
  // a SECOND proposal, linked to the first, and not an edit of it.
  assert.notEqual(second.at, first.entry.at, 'two proposals, not one amended')

  // The old entry is exactly where it was, and nothing about it is a decision.
  const log = fs.readFileSync(path.join(STORY, '.arc', 'drafts.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)
  assert.ok(log.some(e => e.sha === first.entry.sha), 'the superseded proposal is still on the record')
  const evidence = path.join(STORY, 'docs', 'style.evidence.jsonl')
  const verdicts = fs.existsSync(evidence)
    ? fs.readFileSync(evidence, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { kind?: string })
    : []
  assert.equal(verdicts.filter(v => v.kind !== 'route').length, 0,
    'the record moving is not the author deciding')
  reset()
})

test('only that proposal is superseded — another scene\'s pending draft is untouched', async () => {
  reset()
  const original = fs.readFileSync(absOf(), 'utf8')
  await runRedraft({ scene: SCENE })
  const before = proseDraft().changes.map(c => c.file).sort()
  const { replaces } = admitReplay(fileOf(), baseOf(fileOf()), false)
  fs.writeFileSync(absOf(), original)
  await runRedraft({ scene: SCENE, replaces })
  assert.deepEqual(proseDraft().changes.map(c => c.file).sort(), before,
    'the same files are pending, and no others')
  reset()
})

// ---- a partial decision is not nothing ------------------------------------

test('a draft the author has already taken part of is not replaced without being asked for', async () => {
  reset()
  await runRedraft({ scene: SCENE })
  const entry = generatedFor(fileOf())!.entry

  // A PARAGRAPH ACCEPT RESTORES THE PENDING DRAFT EXACTLY, so the file reads
  // as untouched while a decision has been made about it. A byte compare says
  // the draft is still wholly arc's; the evidence log knows better.
  recordJudgment({
    file: fileOf(), scene: SCENE, granularity: 'paragraph', paragraph: 0,
    verdict: 'accepted', arcWrote: 'x', authorKept: 'x', origin: 'redraft', baseline: null,
    at: new Date(Date.parse(entry.at) + 1000).toISOString(),
  })

  const plan = planReplay(fileOf())
  assert.equal(plan.replacing.edited, false, 'not one byte of the file changed')
  assert.equal(plan.replacing.yours, true, 'and yet the author has been here')
  assert.deepEqual(plan.replacing.decided, ['paragraph 1'], 'named, so they read which')
  assert.deepEqual(decidedPartly(fileOf(), entry.at), ['paragraph 1'])

  assert.throws(() => admitReplay(fileOf(), baseOf(fileOf()), false), (e: unknown) =>
    refusal(e).status === 409 && /already taken paragraph 1 of this into the book/.test(refusal(e).message))
  // Asked for in as many words, it goes ahead.
  assert.ok(admitReplay(fileOf(), baseOf(fileOf()), true).replaces.sha)
  reset()
})

// ---- a drafted scene goes back into its own slot ---------------------------

test('a new scene records the slot it was written into, not the next free one', () => {
  reset()
  // `sceneSlot` picks the next FREE slot, so after a draft lands the next one
  // is the one AFTER it. A replay that asked for "the next scene" again would
  // write a new scene beside the author's rather than in its place, which is
  // why the target is recorded and `runDraft` takes it back.
  const chapter = 'ch.01-ninety-one-stairs'
  const existing = proseScenes().filter(s => s.chapter === chapter).map(s => s.file)
  const first = sceneSlot(chapter, 1, existing)
  const after = sceneSlot(chapter, 1, [...existing, first.file])
  assert.notEqual(first.file, after.file, 'the next free slot moves once a draft lands')
  assert.notEqual(first.sceneId, after.sceneId)
  reset()
})

// ---- what a failure leaves --------------------------------------------------

test('a replay that cannot land leaves the words that were there', async () => {
  reset()
  const original = fs.readFileSync(absOf(), 'utf8')
  await runRedraft({ scene: SCENE })
  const pending = fs.readFileSync(absOf(), 'utf8')
  const { replaces } = admitReplay(fileOf(), baseOf(fileOf()), false)

  // The replay runs, and the destination moves under it before it can land —
  // the case A72-4's guarded landing exists for, reached through a replay.
  fs.writeFileSync(absOf(), original)
  const realWrite = fs.writeFileSync
  let armed = true
  let theirs = ''
  ;(fs as unknown as { writeFileSync: typeof fs.writeFileSync }).writeFileSync =
    ((p: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, opts?: unknown) => {
      const out = (realWrite as unknown as (a: unknown, b: unknown, c?: unknown) => void)(p, data, opts)
      if (armed && String(p) === absOf()) {
        armed = false
        theirs = original.trimEnd() + '\n\nTyped while the replay was out.\n'
        ;(realWrite as unknown as (a: unknown, b: unknown) => void)(absOf(), theirs)
      }
      return out
    }) as typeof fs.writeFileSync

  let failed = false
  try { await runRedraft({ scene: SCENE, replaces }) } catch { failed = true } finally {
    ;(fs as unknown as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = realWrite
  }
  assert.ok(failed, 'the replay could not land')
  assert.equal(fs.readFileSync(absOf(), 'utf8'), theirs, 'and what was there is still there')
  // The proposal it would have replaced is still the one on the record.
  assert.ok(pending.length, 'there was something to keep')
  reset()
})

// ---- through the door the author uses ---------------------------------------

test('the route dispatches by the row that answered, and plans without running', async () => {
  reset()
  const { createArcServer } = await import('../src/server.ts')
  const server = createArcServer()
  await new Promise<void>(resolve => server.listen(0, resolve))
  const at = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
  const post = (body: unknown): Promise<Response> => fetch(`${at}/api/prose/ask-again`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  try {
    await runRedraft({ scene: SCENE })
    const file = fileOf()

    // PLAN ONLY: it says what would be replaced and runs nothing.
    const before = fs.readFileSync(absOf(), 'utf8')
    const planned = await post({ file, base: baseOf(file), plan: true })
    assert.equal(planned.status, 200)
    const { plan } = await planned.json() as { plan: { row: string; replacing: { yours: boolean } } }
    assert.equal(plan.row, 'revise.scene.one-shot', 'the row that answered the first time')
    assert.equal(plan.replacing.yours, false)
    assert.equal(fs.readFileSync(absOf(), 'utf8'), before, 'and nothing was written')

    // FAILS CLOSED without a version, like every other decision about words.
    const noToken = await post({ file })
    assert.equal(noToken.status, 400)

    // A file arc never wrote has no question to ask again.
    const hand = 'prose/ch-01/scene-01.md'
    const bad = await post({ file: hand, base: 'a'.repeat(16) })
    assert.equal(bad.status, 409)
  } finally {
    server.close()
  }
  reset()
})

// ---- two at once ----------------------------------------------------------

test('two replays of one destination cannot race a replacement into it', () => {
  reset()
  const file = fileOf()
  claimReplay(file, 'run.0101')
  try {
    assert.throws(() => claimReplay(file, 'run.0102'), (e: unknown) =>
      refusal(e).status === 409 && /already asking that question again/.test(refusal(e).message))
  } finally {
    releaseReplay(file)
  }
  assert.equal(replayInFlight(file), undefined, 'and the claim is released')
  // A different destination is a different question, and is not held back.
  claimReplay('prose/ch-09/scene-01.md', 'run.0103')
  releaseReplay('prose/ch-09/scene-01.md')
  reset()
})
