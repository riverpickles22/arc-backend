// The sibling ladder (A69-7): one definition of "the chapter's other scenes"
// for every row that hands them over — by distance, lowered farthest first.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { copyExampleStory } from './fixture.ts'

const STORY = copyExampleStory()
process.env.ARC_STORY_PATH = STORY

const { renderRung, rungFor, siblingLadder, siblingsOf } = await import('../src/ladder.ts')
type Scene = import('arc-canon-graph').ProseScene

const sc = (n: number, body = `Scene ${n} body.`, contract?: { purpose?: string; reader_after?: string }): Scene => ({
  scene: `sc.03-${n}`, chapter: 'ch.03', status: 'proposed', pov: null, events: [], facts: [],
  contract: contract ? { ...contract } as Scene['contract'] : null,
  file: `prose/ch-03/scene-0${n}.md`, body,
})
const chapter = [1, 2, 3, 4, 5].map(n => sc(n, `Scene ${n} body.`, { purpose: `Purpose ${n}. And more.`, reader_after: `After ${n}` }))

test('rungs go by distance: either side in full, the next at its contract, the rest as a line', () => {
  assert.deepEqual([0, 1, 2, 3, 9].map(rungFor), ['full', 'full', 'contract', 'summary', 'summary'])
  const ladder = siblingLadder({ chapter: 'ch.03', sceneId: 'sc.03-3' }, chapter)
  assert.deepEqual(ladder.rungs.map(r => `${r.scene}:${r.rung}`),
    ['sc.03-2:full', 'sc.03-4:full', 'sc.03-1:contract', 'sc.03-5:contract'], 'nearest first, never itself')
  assert.equal(ladder.note(), 'sc.03-2 at full; sc.03-4 at full; sc.03-1 at contract; sc.03-5 at contract')
})

test('a scene not yet written sits after the chapter\'s last, so the last scene is the near one', () => {
  assert.deepEqual(siblingsOf({ chapter: 'ch.03' }, chapter).map(x => `${x.scene.scene}:${x.distance}`),
    ['sc.03-5:1', 'sc.03-4:2', 'sc.03-3:3', 'sc.03-2:4', 'sc.03-1:5'])
  assert.deepEqual(siblingsOf({ chapter: 'ch.03', sceneId: 'sc.03-6' }, chapter).map(x => x.distance), [1, 2, 3, 4, 5])
  assert.deepEqual(siblingsOf({ chapter: 'ch.09' }, chapter), [], 'another chapter has no siblings here')
})

test('lowering takes the farthest sibling down one rung, and says when nothing is left to lower', () => {
  const ladder = siblingLadder({ chapter: 'ch.03', sceneId: 'sc.03-3' }, chapter)
  const rungs = () => ladder.rungs.map(r => r.rung).join(',')
  assert.equal(rungs(), 'full,full,contract,contract')
  assert.equal(ladder.lower(), true); assert.equal(rungs(), 'full,full,contract,summary', 'the farthest first')
  assert.equal(ladder.lower(), true); assert.equal(rungs(), 'full,full,summary,summary')
  assert.equal(ladder.lower(), true); assert.equal(rungs(), 'full,contract,summary,summary', 'then the near ones, later scene first')
  assert.equal(ladder.lower(), true); assert.equal(rungs(), 'full,summary,summary,summary', 'each taken to the bottom before the next')
  assert.equal(ladder.lower(), true); assert.equal(rungs(), 'contract,summary,summary,summary', 'the scene before is the last to lose its prose')
  assert.equal(ladder.lower(), true); assert.equal(rungs(), 'summary,summary,summary,summary')
  assert.equal(ladder.lower(), false, 'and nothing is left to lower')
})

test('each rung renders what it says: prose, the contract with its last locked paragraph, or one line', () => {
  const s = sc(2, 'First paragraph.\n\nSecond paragraph.', { purpose: 'Show the watch. Then rest.', reader_after: 'Knows the stair.' })
  assert.equal(renderRung(s, 'full'), 'sc.03-2 (full) — prose/ch-03/scene-02.md\nFirst paragraph.\n\nSecond paragraph.')
  assert.equal(renderRung(s, 'contract'), 'sc.03-2 (contract) — prose/ch-03/scene-02.md\n  purpose: Show the watch. Then rest.\n  reader_after: Knows the stair.')
  assert.equal(renderRung(s, 'summary'), 'sc.03-2 (summary): Show the watch.')
  assert.equal(renderRung(sc(4, 'Body.'), 'summary'), 'sc.03-4 (summary): no contract recorded, so no summary line')
  assert.equal(renderRung(sc(4, 'Body.'), 'contract'), 'sc.03-4 (contract) — prose/ch-03/scene-04.md\n  no contract recorded')
})

test('order is file order within the chapter, so an inserted scene with a lettered id sits where it sits', () => {
  // Ids are permanent; a scene written between 2 and 3 later is sc.03-2b,
  // and by the number in its id it would rank as scene zero.
  const inserted: Scene = { ...sc(2, 'Between.'), scene: 'sc.03-2b', file: 'prose/ch-03/scene-02b.md' }
  const withInsert = [chapter[0], chapter[1], inserted, chapter[2], chapter[3], chapter[4]]
  assert.deepEqual(siblingsOf({ chapter: 'ch.03', sceneId: 'sc.03-3' }, withInsert).map(x => `${x.scene.scene}:${x.distance}`),
    ['sc.03-2b:1', 'sc.03-4:1', 'sc.03-2:2', 'sc.03-5:2', 'sc.03-1:3'],
    'the scene immediately before is the inserted one, at full')
})

test('the route pass reads the chapter\'s other scenes through the same ladder', async () => {
  const fs = await import('node:fs')
  const { packAndSiblings } = await import('../src/reroute.ts')
  const { proseScenes } = await import('../src/story.ts')
  const file = path.join(STORY, 'prose', 'ch-01', 'scene-02.md')
  fs.writeFileSync(file, '---\nscene: sc.01-2\nchapter: ch.01-ninety-one-stairs\nstatus: proposed\npov: char.ines\nfacts: [char.ines]\ncontract:\n  purpose: The morning after. Nothing more.\n---\n\nThe morning came grey and she counted the stairs down.\n')
  try {
    const first = proseScenes().find(s => s.scene === 'sc.01-1')!
    const { siblings } = packAndSiblings(first)
    assert.match(siblings, /^sc\.01-2 \(full\) — prose\/ch-01\/scene-02\.md\n/, 'the scene beside it, on the full rung, in the ladder\'s own rendering')
    assert.ok(!siblings.includes('=== prose/'), 'not the old every-scene-in-full block')
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('on the example, a locked paragraph reaches the contract rung verbatim', async () => {
  const { proseScenes } = await import('../src/story.ts')
  const { locksOn } = await import('../src/locks.ts')
  const scene = proseScenes().find(s => s.scene === 'sc.01-1')!
  const locked = locksOn(scene.scene, scene.body).filter(l => l.scope === 'paragraph')
  assert.ok(locked.length, 'the example ships a locked paragraph')
  const text = renderRung(scene, 'contract')
  assert.match(text, /last locked paragraph \(¶\d+, verbatim\):\n/)
  assert.ok(text.includes(String(locked[0].anchor.quote ?? '').slice(0, 30)))
  void path
})
