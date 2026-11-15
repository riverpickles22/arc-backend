// The three steps of the evaluation's compare, each on its own (A81-9): the
// page and its key, the author's judgments file, and the tally — and the one
// function the drafting request is derived through.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import './fixture-scenarios.ts'   // the worked example as the story, exported and ready
import type { EvalCase, Judgments, Pair } from '../src/eval.ts'

const { writePage, layJudgments, tallyJudgments, draftEvalBrief, EvalError } = await import('../src/eval.ts')
const { draftRequest, sceneSlot, proseFiles } = await import('../src/draft.ts')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-eval-steps-'))
test.after(() => fs.rmSync(dir, { recursive: true, force: true }))

const rec = (label: string, c: string, answer: string): EvalCase =>
  ({ label, case: c, chapter: c, answer, answer_fingerprint: `fp-${label}-${c}` } as unknown as EvalCase)
/** Two cases; `before` is behind X in the first and behind Y in the second. */
const pairs: Pair[] = [
  { case: 'ch.01', X: { label: 'before', recorded: rec('before', 'ch.01', 'B one.') }, Y: { label: 'after', recorded: rec('after', 'ch.01', 'A one.') } },
  { case: 'ch.02', X: { label: 'after', recorded: rec('after', 'ch.02', 'A two.') }, Y: { label: 'before', recorded: rec('before', 'ch.02', 'B two.') } },
]
const score = (voice: number | null, usefulness: number | null, effort: number | null) => ({ voice, usefulness, effort })

test('step 1 — the page shows each pair as X and Y, and only the key says which is which', () => {
  const f = { a: 'after', b: 'before', pageFile: path.join(dir, 'p', 'page.md'), keyFile: path.join(dir, 'p', 'page.key.json'), judgeFile: path.join(dir, 'p', 'page.judgments.json') }
  writePage(pairs, f)
  const page = fs.readFileSync(f.pageFile, 'utf8')
  assert.ok(page.indexOf('### X\n\nB one.') < page.indexOf('### Y\n\nA one.'))
  assert.ok(page.includes('## ch.02') && page.includes('### X\n\nA two.'))
  for (const section of page.split('## ').slice(1)) assert.doesNotMatch(section, /\b(before|after)\b/)
  assert.deepEqual(JSON.parse(fs.readFileSync(f.keyFile, 'utf8')), { 'ch.01': { X: 'before', Y: 'after' }, 'ch.02': { X: 'after', Y: 'before' } })
  assert.ok(!fs.existsSync(f.judgeFile), 'the page step does not touch the judgments')
})

test('step 2 — the judgments file is laid out once, keeps what the author started, and names what was recorded again', () => {
  const file = path.join(dir, 'j', 'judgments.json')
  const first = layJudgments(pairs, file)
  assert.deepEqual([first.unreadable, first.stale], [false, []])
  assert.deepEqual(first.held.cases['ch.01'], { X: score(null, null, null), Y: score(null, null, null), of: { X: 'fp-before-ch.01', Y: 'fp-after-ch.01' } })

  const mine = JSON.parse(fs.readFileSync(file, 'utf8')) as Judgments & { note?: string }
  mine.cases['ch.01'].X = score(3, null, null); mine.note = 'mine'
  fs.writeFileSync(file, JSON.stringify(mine))
  const written = fs.readFileSync(file, 'utf8')
  // ch.01 is started and its answers are the same: nothing to do, so the
  // file is not rewritten at all.
  assert.deepEqual(layJudgments(pairs, file).stale, [])
  assert.equal(fs.readFileSync(file, 'utf8'), written)

  // ch.01's X answer is recorded again: started, so kept and named stale.
  // ch.02 is untouched, so it is laid out against the new recording.
  const again = pairs.map(p => ({ ...p, X: { ...p.X, recorded: { ...p.X.recorded, answer_fingerprint: 'fp-new' } } }))
  const second = layJudgments(again, file)
  assert.deepEqual(second.stale, ['ch.01'])
  assert.deepEqual(second.held.cases['ch.01'].X, score(3, null, null))
  assert.equal(second.held.cases['ch.02'].of.X, 'fp-new')
  assert.equal((JSON.parse(fs.readFileSync(file, 'utf8')) as { note?: string }).note, 'mine')

  fs.writeFileSync(file, 'not json')
  assert.equal(layJudgments(pairs, file).unreadable, true)
  assert.equal(fs.readFileSync(file, 'utf8'), 'not json')
})

test('step 3 — the tally is pure: full scores only, by label whichever side they sat on', () => {
  const held: Judgments = {
    how: '', cases: {
      'ch.01': { X: score(2, 2, 2), Y: score(4, 5, 3), of: { X: '', Y: '' } },   // before 6, after 12
      'ch.02': { X: score(3, 3, 3), Y: score(3, 3, 3), of: { X: '', Y: '' } },   // level
    },
  }
  const t = tallyJudgments(pairs, held, [], ['after', 'before'])
  assert.deepEqual(t.judged, ['ch.01', 'ch.02'])
  assert.deepEqual(t.means, { after: { voice: 3.5, usefulness: 4, effort: 3 }, before: { voice: 2.5, usefulness: 2.5, effort: 2.5 } })
  assert.deepEqual([t.won, t.ties], [{ after: 1, before: 0 }, 1])

  held.cases['ch.02'].Y = score(3, 9, null)   // out of range and missing: started, not scored
  const part = tallyJudgments(pairs, held, [], ['after', 'before'])
  assert.deepEqual([part.judged, part.partly], [['ch.01'], ['ch.02']])
  assert.deepEqual(tallyJudgments(pairs, held, ['ch.01'], ['after', 'before']).judged, [], 'a stale case is not counted')
  const none = tallyJudgments(pairs, null, [], ['after', 'before'])
  assert.deepEqual([none.judged, none.partly, none.means], [[], [], {}], 'an unreadable file counts nothing')
})

test('the drafting request is derived in one place: row, stages, slot and the chapter\'s scenes', () => {
  const chapter = 'ch.01-ninety-one-stairs'
  const r = draftRequest(chapter)
  assert.equal(r.request.gesture, `draft the next scene of ${chapter}`)
  assert.deepEqual([r.stage.id, r.planStage.id], ['write', 'craft-plan'])
  const t = r.target()
  assert.deepEqual({ file: t.file, sceneId: t.sceneId }, sceneSlot(chapter, r.chapter.order, proseFiles()), 'the next free slot, from what is on disk')
  assert.ok(t.chapterScenes.every(s => s.chapter === chapter))
  // A replay goes back to its own slot, never the next free one.
  const into = { file: 'prose/ch-01/scene-01.md', sceneId: 'sc.01-1' }
  assert.deepEqual((({ file, sceneId }) => ({ file, sceneId }))(r.target(into)), into)
  assert.throws(() => draftRequest('ch.99-nothing'), (e: Error & { status?: number }) => e.status === 400 && /no chapter ch\.99-nothing/.test(e.message))
  // The recorder turns that refusal into its own, with the chapters the story has.
  assert.throws(() => draftEvalBrief('ch.99-nothing'), (e: Error) => e instanceof EvalError && /^this story has no chapter ch\.99-nothing\. Its chapters: .*ch\.01-ninety-one-stairs/.test(e.message))

  // Both callers read it; neither resolves the request or picks a slot itself.
  const src = path.join(import.meta.dirname, '..', 'src')
  const recorder = fs.readFileSync(path.join(src, 'eval.ts'), 'utf8')
  assert.match(recorder, /draftRequest\(chapterId\)/)
  assert.doesNotMatch(recorder, /resolveRequest\(|sceneSlot\(/, 'eval.ts derives nothing of the request itself')
  const draft = fs.readFileSync(path.join(src, 'draft.ts'), 'utf8')
  assert.match(draft, /= draftRequest\(chapterId\)\n/, 'runDraft reads the request from draftRequest')
  assert.match(draft, /= target\(into\)\n/, 'and its slot from the request\'s own target')
  assert.equal(draft.match(/resolveRequest\(\{/g)?.length, 1, 'the request is resolved once, inside draftRequest')
  assert.equal(draft.match(/sceneSlot\(chapterId, chapter\.order/g)?.length, 1, 'and the slot is picked once, inside its target')
})

test('under the sdk engine the draft is refused before prose/ is read', async () => {
  // The refusal needs nothing from prose/, so it must not walk it first: with
  // prose/ made unreadable, the author still hears the sentence about their
  // engine, not a file error.
  const { runDraft } = await import('../src/draft.ts')
  const { STORY } = await import('./fixture-scenarios.ts')
  const prose = path.join(STORY, 'prose'), aside = path.join(STORY, 'prose.aside')
  const engine = process.env.ARC_DRAFT_ENGINE, key = process.env.ANTHROPIC_API_KEY
  fs.renameSync(prose, aside); fs.writeFileSync(prose, 'not a directory')
  process.env.ARC_DRAFT_ENGINE = 'sdk'; process.env.ANTHROPIC_API_KEY = 'k'
  try {
    await assert.rejects(() => runDraft('ch.01-ninety-one-stairs'), (e: Error & { status?: number }) => e.status === 400 && /cannot draft on the engine/.test(e.message))
  } finally {
    process.env.ARC_DRAFT_ENGINE = engine
    if (key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = key
    fs.rmSync(prose); fs.renameSync(aside, prose)
  }
})
