// The redraft pass: a rebuild whose refusals are deterministic and whose
// opinions are argued. The engine never runs here — the properties under
// test are the ones that hold whatever a model answers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { git, makeStory, writeScene } from './fixture.ts'

const story = makeStory()
process.env.ARC_STORY_PATH = story
process.env.ARC_DRAFT_ENGINE = 'none'
const { contractBlock, literalWithholds, withholdViolations, spliceRange, splitBriefing, buildRedraftPrompt } =
  await import('../src/redraft.ts')
const { runRedraft } = await import('../src/redraft.ts')
const { HttpError } = await import('../src/http.ts')

const reset = () => { git(story, 'checkout', 'HEAD', '--', '.'); git(story, 'clean', '-fdq') }

// ---- the contract block: what reaches the prompt, and what never does ----

test('the contract block carries the binding fields and withholds the reader model', () => {
  const block = contractBlock({
    purpose: 'Introduce the hollow tree without explaining it.',
    reader_before: 'Knows nothing.',
    reader_after: 'Senses something foreign is consuming something native.',
    must_establish: ['The seed arrives accidentally.'],
    must_withhold: ["The settler's identity."],
    motifs: ['the hollowing'],
    constraints: 'Omniscient, at the speed of vegetation.',
  })
  assert.match(block, /Introduce the hollow tree/)
  assert.match(block, /seed arrives accidentally/)
  assert.match(block, /settler's identity/)
  assert.match(block, /the hollowing/)
  assert.match(block, /speed of vegetation/)
  // The one deliberate absence: telling a drafting pass the effect to produce
  // invites writing toward the stated effect — the no-comment law's failure.
  assert.doesNotMatch(block, /Senses something foreign/)
  assert.doesNotMatch(block, /Knows nothing/)
  assert.equal(contractBlock(null), '(this scene declares no contract)')
})

// ---- the proven withhold: quoted literals only ---------------------------

test('only quoted withholds are decidable; described ones stay argued', () => {
  const items = ['The settler\'s identity.', '"Havana"', "'María'", 'What became of the hog.']
  assert.deepEqual(literalWithholds(items), ['Havana', 'María'])
  assert.deepEqual(withholdViolations(['Havana', 'María'], 'The lights of Havana rose over the water.'), ['Havana'])
  assert.deepEqual(withholdViolations(['Havana'], 'The city was a glow on the clouds.'), [])
  assert.deepEqual(literalWithholds(undefined), [])
})

// ---- the splice: surroundings preserved by construction -------------------

test('a passage redraft can only ever touch its own range', () => {
  const paras = ['A.', 'B.', 'C.', 'D.']
  const out = spliceRange(paras, 1, 2, 'B rebuilt.\n\nAnd a new paragraph it grew.\n\nC rebuilt.')
  assert.deepEqual(out, ['A.', 'B rebuilt.', 'And a new paragraph it grew.', 'C rebuilt.', 'D.'])
  assert.deepEqual(spliceRange(paras, 0, 0, 'A alone, rebuilt.'), ['A alone, rebuilt.', 'B.', 'C.', 'D.'])
  // The original array is never mutated — the caller still holds the before.
  assert.deepEqual(paras, ['A.', 'B.', 'C.', 'D.'])
})

test('the briefing splits off the prose, and a missing marker is all prose', () => {
  const two = splitBriefing('The prose.\n\nMore prose.\n=== BRIEFING ===\nChecklist: held.')
  assert.equal(two.body, 'The prose.\n\nMore prose.')
  assert.equal(two.briefing, 'Checklist: held.')
  const one = splitBriefing('Only prose, no marker anywhere.')
  assert.equal(one.body, 'Only prose, no marker anywhere.')
  assert.equal(one.briefing, '', 'never the other way round — prose must not vanish into a briefing')
})

// ---- the prompt: rebuild licence, seams, and what rides along ------------

const sceneFixture = {
  scene: 'sc.01-1', chapter: 'ch.01', status: 'proposed', pov: null,
  events: ['event.landing'], facts: [], contract: null,
  file: 'prose/ch-01/scene-01.md', body: 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.',
}

test('a whole-scene prompt licenses the rebuild and shows the attempt', () => {
  const p = buildRedraftPrompt({
    scene: sceneFixture, pack: '(pack)', style: '(style)', siblings: '', notes: [], lockNotice: '',
  })
  assert.match(p, /ONE ATTEMPT, NOT A FLOOR/)
  assert.match(p, /THE SCENE AS IT STANDS/)
  assert.match(p, /First paragraph\./)
  assert.match(p, /=== BRIEFING ===/, 'the argued half is asked for by name')
  assert.doesNotMatch(p, /Change as little/, 'this is not revise')
})

test('a passage prompt shows the seams and forbids answering with them', () => {
  const p = buildRedraftPrompt({
    scene: sceneFixture, pack: '(pack)', style: '(style)', siblings: '', notes: [], lockNotice: '',
    range: { from: 1, to: 1, passage: 'Second paragraph.', above: 'First paragraph.', below: 'Third paragraph.' },
  })
  assert.match(p, /THE PASSAGE TO REDRAFT \(¶2–¶2/)
  assert.match(p, /ABOVE ends the ground/)
  assert.match(p, /BELOW is where your passage must land/)
  assert.match(p, /never the seams/)
})

test('at the scene edges the prompt says open or close, not a missing seam', () => {
  const p = buildRedraftPrompt({
    scene: sceneFixture, pack: '(pack)', style: '(style)', siblings: '', notes: [], lockNotice: '',
    range: { from: 0, to: 0, passage: 'First paragraph.', above: null, below: 'Second paragraph.' },
  })
  assert.match(p, /OPENS the scene/)
})

// ---- refusals, before any engine is reached ------------------------------

test('an unknown scene and a bad range are refused with the reason', async () => {
  reset()
  await assert.rejects(() => runRedraft({ scene: 'sc.99-9' }), (e: unknown) => e instanceof HttpError && e.status === 400)
  await assert.rejects(
    () => runRedraft({ scene: 'sc.01-1', paragraphs: [0, 99] }),
    (e: unknown) => (e as { message: string }).message.includes('existing range'))
  reset()
})

test('a passage redraft over a locked paragraph is refused with the lock named', async () => {
  reset()
  writeScene(story, 'prose/ch-01/scene-01.md', 'sc.01-1', 'Original first paragraph.\n\nSecond paragraph.')
  git(story, 'add', '-A')
  if (git(story, 'status', '--porcelain').trim()) git(story, 'commit', '-qm', 'prose: redraft lock fixture')
  fs.mkdirSync(path.join(story, 'locks'), { recursive: true })
  fs.writeFileSync(path.join(story, 'locks', 'lock-001.yaml'), [
    'id: lock.001',
    'anchor:',
    '  scene: sc.01-1',
    '  paragraph: 0',
    '  quote: Original first paragraph.',
    '',
  ].join('\n'))

  await assert.rejects(
    () => runRedraft({ scene: 'sc.01-1', paragraphs: [0, 1] }),
    (e: unknown) => e instanceof HttpError && e.status === 423 && /lock\.001/.test(e.message))

  fs.rmSync(path.join(story, 'locks'), { recursive: true, force: true })
  reset()
})
