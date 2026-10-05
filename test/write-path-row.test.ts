// A REAL ROW, WITH THE GROUND MOVING UNDER IT (A72-4, criterion 8).
//
// The unit tests beside this one exercise `landOrKeep`, `trialValidate` and
// `restoreIfOurs` directly. This one drives a writing row end to end on the
// fixture engine and moves things while it runs — which is the only way to
// know the row actually calls them, in the right order, and says the right
// thing afterwards. `how_to_test` step 1 is this file.
//
// The fixture engine answers a brief it has seen, so "the pass ran and
// produced words" is observed here rather than assumed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
// Sets the story and the engine before anything under src/ loads.
import { SCENE, STORY, reset } from './fixture-scenarios.ts'

const { runRedraft } = await import('../src/redraft.ts')
const { proseDraft, proseScenes } = await import('../src/story.ts')
const { candidatePath } = await import('../src/landing.ts')
const { laneHolder } = await import('../src/lane.ts')
const { readWorkingReceipt } = await import('../src/run.ts')
const { listRuns } = await import('../src/runs.ts')
const { HttpError } = await import('../src/http.ts')

const fileOf = (): string => proseScenes().find(s => s.scene === SCENE)!.file
const absOf = (): string => path.join(STORY, fileOf())
const changeFor = (): { stale?: { changed: string[]; why: string }; origin?: string } | undefined =>
  proseDraft().changes.find(c => c.file === fileOf())

/** The newest run's ending, as the record has it. */
const lastEnding = (): string | undefined => {
  const runs = listRuns()
  return runs.length ? runs[runs.length - 1].state : undefined
}

test('a redraft whose destination moved while it ran keeps its words beside the book', async () => {
  reset()
  const abs = absOf()

  // The pass is out. The author types in the scene it is rewriting — which is
  // a thing that takes a minute in real life and one line here.
  //
  // The fixture engine answers synchronously, so the edit goes in through the
  // one hook a pass has while it is running: the destination is read at
  // LAUNCH, and anything that changes the file before the landing is the case
  // this card is about. `runRedraft` reads it at launch, so writing here —
  // before the call — is not it. Instead the scene is changed AFTER the pass
  // has taken its snapshot, which the validator hook below does.
  let theirs = ''
  const original = fs.readFileSync(abs, 'utf8')

  // A watcher that fires once, the first time the pass writes its trial: by
  // then the snapshot is taken and the model has answered.
  const realWrite = fs.writeFileSync
  let armed = true
  ;(fs as unknown as { writeFileSync: typeof fs.writeFileSync }).writeFileSync =
    ((p: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, opts?: unknown) => {
      const out = (realWrite as unknown as (a: unknown, b: unknown, c?: unknown) => void)(p, data, opts)
      if (armed && String(p) === abs) {
        armed = false
        theirs = original.trimEnd() + '\n\nTyped while the pass was out.\n'
        ;(realWrite as unknown as (a: unknown, b: unknown) => void)(abs, theirs)
      }
      return out
    }) as typeof fs.writeFileSync

  let refusal: unknown = null
  try {
    await runRedraft({ scene: SCENE })
  } catch (e) {
    refusal = e
  } finally {
    ;(fs as unknown as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = realWrite
  }

  assert.ok(refusal instanceof HttpError, 'the pass refused to land')
  assert.equal((refusal as HttpError).status, 409)
  assert.match((refusal as HttpError).message, /you changed/i)
  assert.match((refusal as HttpError).message, /kept beside the scene/)
  assert.match((refusal as HttpError).message, /ask again/)

  // Their words stand.
  assert.equal(fs.readFileSync(abs, 'utf8'), theirs, 'the author\'s paragraph survived the pass')
  assert.equal(laneHolder(), null)

  // And what the pass wrote is a file beside the book, not the live draft.
  const runs = listRuns()
  const run = runs[runs.length - 1]
  const kept = candidatePath(run.id)
  assert.ok(fs.existsSync(kept), 'the candidate is kept where the author can read it')
  assert.notEqual(fs.readFileSync(kept, 'utf8'), theirs, 'and it is not what is live')
  assert.equal(changeFor()?.origin, undefined,
    'the live pending change is the author\'s own hand, not arc\'s')

  // The record says what happened, and says it once.
  assert.equal(lastEnding(), 'failed', 'an unfinished run is a failed state, not a done one')
  const receipt = readWorkingReceipt(run.id)
  assert.equal(receipt?.ending, 'unfinished',
    'the receipt keeps the first ending — the destination moved, not "could not run"')
  reset()
})

test('a landed draft is not stale against its own output, and is stale when the record moves', async () => {
  reset()
  await runRedraft({ scene: SCENE })
  const after = changeFor()
  assert.equal(after?.origin, 'redraft', 'the pass landed, with its provenance')
  // THE DRAFT'S OWN OUTPUT IS NOT A CHANGE TO ITS RECORD. The pass rewrote
  // the scene it read, so a read set left at the launch version would make
  // every landed draft stale against itself — a warning about nothing, which
  // teaches the author to ignore the ones that mean something.
  assert.equal(after?.stale, undefined, 'nothing has moved under it yet')

  // Now something the pass actually read moves, and not a word of the prose
  // with it: the scene's own frontmatter is part of the assignment.
  const abs = absOf()
  fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace('status: proposed', 'status: drafted'))
  const stale = changeFor()?.stale
  assert.ok(stale, 'a changed assignment is a changed assignment')
  assert.equal(stale!.why, 'the record moved')
  assert.ok(stale!.changed.includes(SCENE))
  reset()
})

test('a landed draft carries its provenance, and the provenance is durable', async () => {
  reset()
  await runRedraft({ scene: SCENE })
  const index = fs.readFileSync(path.join(STORY, '.arc', 'drafts.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)
  const entry = index[index.length - 1]
  assert.equal(entry.origin, 'redraft')
  assert.ok(Array.isArray(entry.reads) && (entry.reads as unknown[]).length, 'what it read')
  assert.equal(entry.v, 2, 'under which enumeration')
  assert.ok(typeof entry.job === 'string' && entry.job, 'and by which version of the pass')
  // It is a file: a restart reads the same thing.
  assert.equal(changeFor()?.origin, 'redraft')
  reset()
})

test('a trial write does not take the author\'s words with it', async () => {
  reset()
  const abs = absOf()
  const before = fs.readFileSync(abs, 'utf8')
  await runRedraft({ scene: SCENE })
  // The pass landed, so the file is arc's words — but nothing of the trial is
  // left behind, and the scene still parses as the scene it was.
  const now = fs.readFileSync(abs, 'utf8')
  assert.notEqual(now, before, 'the pass wrote')
  assert.match(now, /^---\n/, 'and what it left is a scene, not a trial')
  assert.equal(laneHolder(), null)
  reset()
})
