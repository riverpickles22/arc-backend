// The evidence log: what the author decided about arc's prose.
//
// The properties that matter are the ones a style rule later rests on — that
// a refusal survives at all, that taking arc's words verbatim is not filed as
// an edit, and that a rewritten sentence is one pair rather than two orphaned
// halves. Plus the contract shared with capture: nothing here may fail a
// decision that has already been made.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { AlignedSentence } from 'arc-canon-graph'
import { git, makeStory } from './fixture.ts'

const story = makeStory()
process.env.ARC_STORY_PATH = story
const { proseAcceptParagraph, proseRejectParagraph, proseAcceptSentence, proseRejectSentence, proseDiscard, proseAccept } =
  await import('../src/story.ts')
const { readJudgments, counterpartOf, EVIDENCE_REL, recordJudgment } = await import('../src/evidence.ts')
const { recordGenerated } = await import('../src/ledger.ts')

const reset = () => { git(story, 'checkout', 'HEAD', '--', '.'); git(story, 'clean', '-fdq') }
const wipe = () => { try { fs.rmSync(path.join(story, EVIDENCE_REL)) } catch { /* none yet */ } }
const file = 'prose/ch-01/scene-01.md'
const abs = path.join(story, file)
const fmOf = () => { const t = fs.readFileSync(abs, 'utf8'); return t.slice(0, t.indexOf('---', 3) + 4) }

/** main at [A,B], committed, with arc credited for having written it. */
function draftOver(draftBody: string, arcBody?: string) {
  reset(); wipe()
  const fm = fmOf()
  fs.writeFileSync(abs, fm + 'Paragraph A.\n\nParagraph B.\n')
  git(story, 'add', '--', file)
  if (git(story, 'status', '--porcelain', '--', file).trim()) {
    git(story, 'commit', '-qm', 'prose: evidence fixture', '--', file)
  }
  fs.writeFileSync(abs, fm + draftBody)
  if (arcBody !== undefined) recordGenerated(file, fm + arcBody, { engine: 'test', scene: 'sc.01-1', origin: 'revise' })
  return fm
}

// ---- counterpartOf: a rewrite is one pair, not two halves ---------------

const sent = (kind: 'same' | 'del' | 'ins', text: string, side: 'main' | 'draft', index: number): AlignedSentence =>
  ({ kind, text, side, index })

test('a rewritten sentence finds its other half from either side', () => {
  // alignSentences has no `replace`: a rewrite is a del then an ins, judged
  // through two calls that know nothing of each other.
  const aligned = [
    sent('same', 'He shipped the oars. ', 'draft', 0),
    sent('del', 'The swell ran heavy.', 'main', 1),
    sent('ins', 'The swell ran black.', 'draft', 1),
  ]
  assert.equal(counterpartOf(aligned, 'main', 1)?.text, 'The swell ran black.')
  assert.equal(counterpartOf(aligned, 'draft', 1)?.text, 'The swell ran heavy.')
})

test('a cut has no other half, and neither does a bare addition', () => {
  const cut = [sent('same', 'Kept. ', 'draft', 0), sent('del', 'Gone.', 'main', 1)]
  assert.equal(counterpartOf(cut, 'main', 1), null)
  const added = [sent('same', 'Kept. ', 'draft', 0), sent('ins', 'New.', 'draft', 1)]
  assert.equal(counterpartOf(added, 'draft', 1), null)
  assert.equal(counterpartOf(added, 'draft', 9), null, 'a target that does not resolve is null, never a guess')
})

// ---- every judgment is recorded ----------------------------------------

test('a refusal is recorded — the one decision git never sees', () => {
  draftOver('Paragraph A rewritten by arc.\n\nParagraph B.\n', 'Paragraph A rewritten by arc.\n\nParagraph B.\n')
  proseRejectParagraph(file, { side: 'draft', paragraph: 0 })

  const j = readJudgments().at(-1)!
  assert.equal(j.verdict, 'rejected')
  assert.equal(j.arcWrote, 'Paragraph A rewritten by arc.')
  assert.equal(j.authorKept, 'Paragraph A.', 'and what stands instead')
  assert.equal(j.granularity, 'paragraph')
  assert.equal(j.origin, 'revise', 'read from the ledger, not guessed')
  reset(); wipe()
})

test('taking arc\'s paragraph untouched is an approval, not a pair', () => {
  const arc = 'Paragraph A, as arc wrote it.\n\nParagraph B.\n'
  draftOver(arc, arc)
  proseAcceptParagraph(file, { side: 'draft', paragraph: 0 })

  const j = readJudgments().at(-1)!
  assert.equal(j.verdict, 'approved', 'arc got this one right — real, but not an edit')
  assert.equal(j.arcWrote, j.authorKept)
  reset(); wipe()
})

test('editing arc\'s paragraph before accepting it is the pair worth having', () => {
  draftOver('The author\'s own tightening.\n\nParagraph B.\n', 'A long and rather overwritten opening by arc.\n\nParagraph B.\n')
  proseAcceptParagraph(file, { side: 'draft', paragraph: 0 })

  const j = readJudgments().at(-1)!
  assert.equal(j.verdict, 'accepted')
  assert.equal(j.arcWrote, 'A long and rather overwritten opening by arc.')
  assert.equal(j.authorKept, 'The author\'s own tightening.')
  reset(); wipe()
})

test('a sentence refusal records the sentence arc offered and the one that stands', () => {
  // Real sentence boundaries: the shared rule reads "Paragraph A." as an
  // initial and refuses to break there, which is the rule working.
  reset(); wipe()
  const fm = fmOf()
  fs.writeFileSync(abs, fm + 'The lamp was lit. The swell ran heavy.\n\nParagraph B.\n')
  git(story, 'add', '--', file)
  if (git(story, 'status', '--porcelain', '--', file).trim()) {
    git(story, 'commit', '-qm', 'prose: a two-sentence fixture', '--', file)
  }
  const draft = fm + 'The lamp was lit. The swell ran black.\n\nParagraph B.\n'
  fs.writeFileSync(abs, draft)
  recordGenerated(file, draft, { engine: 'test', scene: 'sc.01-1', origin: 'revise' })

  proseRejectSentence(file, { paragraph: 0, side: 'draft', sentence: 1 })

  const j = readJudgments().at(-1)!
  assert.equal(j.granularity, 'sentence')
  assert.equal(j.verdict, 'rejected')
  assert.equal(j.arcWrote, 'The swell ran black.', "the sentence arc offered")
  assert.equal(j.authorKept, 'The swell ran heavy.', 'and the one that stands instead — the pair, put back together across two calls')
  reset(); wipe()
})

test('discarding a scene records it before the ledger forgets it', () => {
  const fm = draftOver('Everything arc wrote, thrown away.\n\nParagraph B.\n', 'Everything arc wrote, thrown away.\n\nParagraph B.\n')
  assert.ok(fm)
  proseDiscard(file)

  const j = readJudgments().at(-1)!
  assert.equal(j.verdict, 'discarded')
  assert.match(j.arcWrote, /thrown away/, "the discarded prose survives in the record it would otherwise take with it")
  assert.equal(j.authorKept, '')
  reset(); wipe()
})

test('accepting arc\'s sentence records an approval of that sentence', () => {
  reset(); wipe()
  const fm = fmOf()
  fs.writeFileSync(abs, fm + 'The lamp was lit. The swell ran heavy.\n\nParagraph B.\n')
  git(story, 'add', '--', file)
  if (git(story, 'status', '--porcelain', '--', file).trim()) {
    git(story, 'commit', '-qm', 'prose: a two-sentence fixture for accept', '--', file)
  }
  const draft = fm + 'The lamp was lit. The swell ran black.\n\nParagraph B.\n'
  fs.writeFileSync(abs, draft)
  recordGenerated(file, draft, { engine: 'test', scene: 'sc.01-1', origin: 'revise' })

  proseAcceptSentence(file, { paragraph: 0, side: 'draft', sentence: 1 })

  const j = readJudgments().at(-1)!
  assert.equal(j.granularity, 'sentence')
  assert.equal(j.verdict, 'approved')
  assert.equal(j.arcWrote, 'The swell ran black.')
  assert.equal(j.authorKept, j.arcWrote, 'arc\'s sentence is what stands')
  reset(); wipe()
})

// ---- the log is record, and rides in the commit -------------------------

test('an accept commits the evidence alongside the prose', () => {
  draftOver('Paragraph A, revised.\n\nParagraph B.\n', 'Paragraph A, revised.\n\nParagraph B.\n')
  proseAcceptParagraph(file, { side: 'draft', paragraph: 0 })

  const inHead = git(story, 'show', `HEAD:${EVIDENCE_REL}`)
  assert.match(inHead, /"verdict"/, 'the judgment is in the book, not only on the disk')
  reset(); wipe()
})

test('the whole-draft accept records one entry per scene and pins its baseline', () => {
  reset(); wipe()
  const before = git(story, 'rev-parse', 'HEAD').trim()
  const fm = fmOf()
  fs.writeFileSync(abs, fm + 'A whole draft, accepted at once.\n\nParagraph B.\n')
  proseAccept('prose: accept the lot')

  const j = readJudgments().filter(x => x.file === file).at(-1)!
  assert.equal(j.granularity, 'scene')
  assert.equal(j.baseline, before, 'the boundary is the commit the work started from, not HEAD^')
  reset(); wipe()
})

// ---- and it can never cost a decision ----------------------------------

test('a broken evidence log costs a proposal, never a decision', () => {
  draftOver('Paragraph A, revised again.\n\nParagraph B.\n', 'Paragraph A, revised again.\n\nParagraph B.\n')
  // A directory where the log should be: every write fails, every read is empty.
  const p = path.join(story, EVIDENCE_REL)
  try { fs.rmSync(p) } catch { /* none yet */ }
  fs.mkdirSync(p, { recursive: true })

  assert.doesNotThrow(() => recordJudgment({
    file, scene: 'sc.01-1', granularity: 'paragraph', verdict: 'rejected',
    arcWrote: 'x', authorKept: 'y', origin: 'revise', baseline: null,
  }))
  assert.deepEqual(readJudgments(), [])
  assert.doesNotThrow(() => proseRejectParagraph(file, { side: 'draft', paragraph: 0 }),
    'the author still gets to refuse a paragraph')

  fs.rmSync(p, { recursive: true, force: true })
  reset(); wipe()
})
