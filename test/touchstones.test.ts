// Touchstones: calibration passages with computed standing.
//
// The property that matters most: a touchstone binds harder than a rule, so
// its staleness must be a state the machine reports, never a note a human
// remembers to write — this book's own §6 carries the hand-written proof of
// the failure mode.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { git, makeStory, writeScene } from './fixture.ts'

const story = makeStory()
process.env.ARC_STORY_PATH = story
// Never let a unit test find the real claude CLI and spend tokens.
process.env.ARC_DRAFT_ENGINE = 'none'
const { parseContractTouchstones, touchstoneStates, proposeTouchstoneRefresh, nearestParagraph } =
  await import('../src/touchstones.ts')
const { readTouchstones, writeTouchstones, appendTouchstones, ratifyTouchstone, placeTouchstone, touchstoneId, readQueue, writeQueue, readDismissed, queuePath, MAX_TOUCHSTONES_PER_RUN } =
  await import('../src/style-queue.ts')

const contractPath = path.join(story, 'docs', 'style.md')
const wipe = () => {
  for (const f of ['docs/style.md', 'docs/style.proposed.md', 'docs/style.dismissed.md']) {
    try { fs.rmSync(path.join(story, f)) } catch { /* absent is fine */ }
  }
  git(story, 'checkout', 'HEAD', '--', '.'); git(story, 'clean', '-fdq')
}

/** The real contract's §6 shape, verbatim conventions: numbered heading,
 *  bold labels with a "— from" clause, blockquotes, and the annotated
 *  wrong-version example that is NOT a touchstone of the manuscript. */
const CONTRACT = `# A Style Guide

## 3. Rhythm

- Danger is short.

## 6. Touchstones

Calibration passages from the drafted manuscript.

**Slow time (sea, smell-first opening) — from ch-01/scene-01:**

> Original first paragraph.

**A wrong version, annotated — do not write this:**

> He gazed at the city, thinking about everything it meant.

## 7. Pre-draft checklist

1. Does it open on smell?
`

test('the contract parser reads labels, passages, and knows what is not a touchstone', () => {
  const out = parseContractTouchstones(CONTRACT)
  assert.equal(out.length, 2)
  assert.equal(out[0].quality, 'Slow time (sea, smell-first opening)')
  assert.equal(out[0].fileish, 'ch-01/scene-01')
  assert.equal(out[0].passage, 'Original first paragraph.')
  assert.equal(out[1].fileish, '', 'the wrong-version example names no scene')
})

test('a touchstone whose passage still stands reports resolved; a superseded one, orphaned', () => {
  wipe()
  fs.mkdirSync(path.dirname(contractPath), { recursive: true })
  fs.writeFileSync(contractPath, CONTRACT)
  // The fixture scene's first paragraph IS "Original first paragraph." — current.
  const states = touchstoneStates()
  assert.equal(states.length, 1, 'the wrong-version example is never resolved')
  assert.equal(states[0].state, 'resolved')

  // The author rewrites the paragraph out from under the contract.
  writeScene(story, 'prose/ch-01/scene-01.md', 'sc.01-1', 'A completely different opening now.\n\nSecond paragraph.')
  assert.equal(touchstoneStates()[0].state, 'orphaned', 'staleness is computed, not remembered')
  wipe()
})

test('the refresh proposes the nearest living descendant, copied from the file', () => {
  wipe()
  fs.mkdirSync(path.dirname(contractPath), { recursive: true })
  fs.writeFileSync(contractPath, CONTRACT)
  // A light rewrite: clearly the same passage's descendant.
  writeScene(story, 'prose/ch-01/scene-01.md', 'sc.01-1', 'Original first paragraph, tightened.\n\nSecond paragraph.')

  const r = proposeTouchstoneRefresh()
  assert.equal(r.added.length, 1)
  assert.equal(r.added[0].passage, 'Original first paragraph, tightened.', 'the passage comes from the scene file')
  assert.equal(r.added[0].quality, 'Slow time (sea, smell-first opening)', 'the quality label survives')
  assert.equal(r.added[0].scene, 'sc.01-1')

  // Idempotent: the same proposal collapses into the queue.
  assert.equal(proposeTouchstoneRefresh().added.length, 0)
  wipe()
})

test('a current touchstone is left alone, and a vanished passage is skipped with a reason', () => {
  wipe()
  fs.mkdirSync(path.dirname(contractPath), { recursive: true })
  fs.writeFileSync(contractPath, CONTRACT)
  // Current: nothing proposed.
  const current = proposeTouchstoneRefresh()
  assert.equal(current.added.length, 0)
  assert.equal(current.current, 1)

  // Rewritten beyond recognition: no guess, a named skip.
  writeScene(story, 'prose/ch-01/scene-01.md', 'sc.01-1', 'Entirely new material sharing not one word.\n\nMore of the same elsewhere.')
  const r = proposeTouchstoneRefresh()
  assert.equal(r.added.length, 0)
  assert.equal(r.skipped.length, 1)
  assert.match(r.skipped[0], /descendant/)
  wipe()
})

test('nearestParagraph refuses when too little of the passage survives', () => {
  assert.equal(nearestParagraph('the sea had smelled of salt and iodine', ['wholly unrelated words entirely']), null)
  const hit = nearestParagraph('the sea had smelled of salt and iodine', ['the sea had smelled of salt and tar', 'another paragraph'])
  assert.equal(hit?.index, 0)
})

test('touchstones and rules share the queue file without erasing each other', () => {
  wipe()
  const rule = { id: 'p-abc12345', rule: 'A rule.', section: null, at: 'now', evidence: [{ scene: 'sc.01-1', wrote: 'a', kept: 'b' }] }
  const t = { id: touchstoneId({ scene: 'sc.01-1', paragraph: 0, passage: 'A passage.' }), quality: 'Slow time', scene: 'sc.01-1', file: 'prose/ch-01/scene-01.md', paragraph: 0, passage: 'A passage.', at: 'now' }
  writeQueue([rule])
  appendTouchstones([t])
  assert.equal(readQueue().length, 1, 'the rule survived the touchstone write')
  assert.equal(readTouchstones().length, 1)
  // And the other direction: a rule save keeps the touchstone.
  writeQueue([rule])
  assert.equal(readTouchstones().length, 1, 'the touchstone survived the rule write')
  const text = fs.readFileSync(queuePath(), 'utf8')
  assert.match(text, /arc:proposed/)
  assert.match(text, /arc:touchstone/)
  wipe()
})

test('ratifying a touchstone lands it in §6 with its anchor, and it resolves from there', () => {
  wipe()
  fs.mkdirSync(path.dirname(contractPath), { recursive: true })
  fs.writeFileSync(contractPath, CONTRACT)
  const t = {
    id: touchstoneId({ scene: 'sc.01-1', paragraph: 1, passage: 'Second paragraph.' }),
    quality: 'Danger (rhythm drop)', scene: 'sc.01-1', file: 'prose/ch-01/scene-01.md', paragraph: 1,
    passage: 'Second paragraph.', at: 'now',
  }
  writeTouchstones([t])
  const out = ratifyTouchstone(t.id, 'ratify', contractPath)
  assert.equal(out.path, contractPath)
  assert.equal(readTouchstones().length, 0, 'it left the queue')

  const contract = fs.readFileSync(contractPath, 'utf8')
  const six = contract.slice(contract.indexOf('## 6. Touchstones'), contract.indexOf('## 7.'))
  assert.match(six, /\*\*Danger \(rhythm drop\) — from ch-01\/scene-01:\*\*/, 'the label reads like the hand-written ones')
  assert.match(six, /arc:touchstone-anchor/, 'and carries the anchor that makes staleness computable')
  assert.match(six, /> Second paragraph\./)

  const states = touchstoneStates()
  const danger = states.find(x => x.quality.startsWith('Danger'))
  assert.equal(danger?.state, 'resolved', 'the ratified touchstone resolves through its own anchor')
  wipe()
})

test('a dismissed touchstone stays dismissed; a revised passage reopens the question', () => {
  wipe()
  const t = { id: touchstoneId({ scene: 'sc.01-1', paragraph: 0, passage: 'A passage.' }), quality: 'Slow time', scene: 'sc.01-1', file: '', paragraph: 0, passage: 'A passage.', at: 'now' }
  appendTouchstones([t])
  ratifyTouchstone(t.id, 'dismiss', contractPath)
  assert.ok(readDismissed().some(d => d.id === t.id))
  assert.equal(appendTouchstones([t]).added.length, 0, 'the same passage is not asked about twice')

  const revised = { ...t, passage: 'A passage, revised.', id: touchstoneId({ scene: 'sc.01-1', paragraph: 0, passage: 'A passage, revised.' }) }
  assert.equal(appendTouchstones([revised]).added.length, 1, 'improving the prose reopens the question')
  wipe()
})

test('the touchstone budget holds independently of the rule budget', () => {
  wipe()
  const many = Array.from({ length: 6 }, (_, i) => ({
    id: touchstoneId({ scene: 'sc.01-1', paragraph: i, passage: `Passage ${i}.` }),
    quality: `Quality ${i}`, scene: 'sc.01-1', file: '', paragraph: i, passage: `Passage ${i}.`, at: 'now',
  }))
  assert.equal(appendTouchstones(many).added.length, MAX_TOUCHSTONES_PER_RUN)
  assert.equal(readQueue().length, 0, 'no rule was consumed or created by touchstone traffic')
  wipe()
})

test('placeTouchstone lands at the end of a numbered Touchstones section', () => {
  const t = { id: 't-x', quality: 'Q', scene: 'sc.01-1', file: 'prose/ch-01/scene-01.md', paragraph: 0, passage: 'P.', at: '' }
  const out = placeTouchstone(CONTRACT, t)
  const six = out.slice(out.indexOf('## 6.'), out.indexOf('## 7.'))
  assert.match(six, /\*\*Q — from ch-01\/scene-01:\*\*/)
  assert.ok(six.indexOf('wrong version') < six.indexOf('**Q — from'), 'after everything already there')
  assert.equal(out.match(/^## /gm)?.length, 3, 'no new section was opened')
})

// ---- the bootstrap's deterministic half ---------------------------------

test('history pairs read successive accepted states, labelled as ratified movement', async () => {
  const { historyPairs, runBootstrapStyle } = await import('../src/bootstrap-style.ts')
  wipe()
  // Three accepted states of one scene: two transitions, one significant each.
  writeScene(story, 'prose/ch-01/scene-01.md', 'sc.01-1', 'It was then that he finally saw the coast at last.\n\nStable paragraph.')
  git(story, 'add', '-A'); git(story, 'commit', '-qm', 'prose: state one')
  writeScene(story, 'prose/ch-01/scene-01.md', 'sc.01-1', 'He saw the coast.\n\nStable paragraph.')
  git(story, 'add', '-A'); git(story, 'commit', '-qm', 'prose: state two')

  const pairs = historyPairs()
  assert.ok(pairs.length >= 1)
  const hit = pairs.find(p => p.kept === 'He saw the coast.')!
  assert.equal(hit.source, 'history', 'never claimed as a hand edit')
  assert.equal(hit.wrote, 'It was then that he finally saw the coast at last.')
  assert.equal(hit.scene, 'sc.01-1')

  // With no engine, the pass stops after the free half and says why.
  const r = await runBootstrapStyle()
  assert.equal(r.skipped, 'no-engine')
  assert.ok(r.pairsConsidered >= 1, 'the pairs were mined before the engine was missed')
  wipe()
})

test('the annotation context is context, and empty when there are no notes', async () => {
  const { annotationContext } = await import('../src/bootstrap-style.ts')
  const ctx = annotationContext()
  // The fixture story has no annotations directory.
  assert.equal(ctx, '')
})
