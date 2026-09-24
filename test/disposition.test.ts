// A route's disposition is recorded, never a file removal (A67-10;
// agent-workflows §4, "The evidence log", invariant 1).
//
// A route leaves disk in exactly three ways — adopted, cancelled,
// superseded — and every one of them writes an entry first, with the
// author's own notes on the route copied in, because those are words they
// wrote and deleting them with the file would lose them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { git, makeExampleStory } from './fixture.ts'

const STORY = makeExampleStory()
const sceneFile = path.join(STORY, 'prose', 'ch-02', 'scene-01.md')
fs.writeFileSync(sceneFile, fs.readFileSync(sceneFile, 'utf8').replace(
  'events: [event.the-wreck]\n---',
  'events: [event.the-wreck]\ncontract:\n  purpose: p\n  must_establish:\n    - The wreck is known before it is seen.\n---'))
git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'a contract')
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

const reroute = await import('../src/reroute.ts')
const { addRouteNote, adoptAlternative, clearAlternatives, dropAlternative, listAlternatives, writeAlternative, KEEP_ALTERNATIVES } = reroute
const { readDispositions, readJudgments, EVIDENCE_REL } = await import('../src/evidence.ts')
const { sha16 } = await import('../src/records.ts')
const { proseScenes } = await import('../src/story.ts')

const SCENE = 'sc.02-1'
const reads = () => [{ id: SCENE, version: sha16(proseScenes().find(s => s.scene === SCENE)!.body) }]
const put = (id: string, at: string, over: Record<string, unknown> = {}) => writeAlternative({
  scene: SCENE, seed: 'late-entry', based_on: 'b', briefing: '', coverage: null, overlap: 0,
  run: 'run.0001', reads: reads(), id, created_at: at, body: `Body ${id}.`, ...over,
} as never)
const dispositionsFor = (id: string) => readDispositions().filter(d => d.route === id)
const routeFile = (id: string) => path.join(STORY, '.arc', 'alternatives', SCENE, `${id}.md`)

test('cancelling records the judgement, with the author\'s notes on it, before the file goes', () => {
  clearAlternatives(SCENE)
  put('alt-aaaa0001', '2026-09-10T00:00:00Z')
  addRouteNote(SCENE, 'alt-aaaa0001', 'the coat arrives too late here', 1)
  addRouteNote(SCENE, 'alt-aaaa0001', 'colder throughout', null)
  assert.ok(fs.existsSync(routeFile('alt-aaaa0001')))

  dropAlternative(SCENE, 'alt-aaaa0001')

  assert.ok(!fs.existsSync(routeFile('alt-aaaa0001')), 'the file is gone')
  const [d] = dispositionsFor('alt-aaaa0001')
  assert.ok(d, 'and the decision is on the record')
  assert.equal(d.disposition, 'cancelled')
  assert.equal(d.scene, SCENE)
  assert.equal(d.run, 'run.0001')
  assert.match(d.because, /the author cancelled it/)
  assert.deepEqual(d.notes.map(n => [n.paragraph, n.body]),
    [[1, 'the coat arrives too late here'], [null, 'colder throughout']],
    'the author\'s own words survive the file')
  assert.ok(d.at, 'stamped')
})

test('the accept of a scene that carried an adopted route supersedes every route waiting on it, notes and all', () => {
  clearAlternatives(SCENE)
  put('alt-bbbb0001', '2026-09-10T00:00:00Z')
  put('alt-bbbb0002', '2026-09-11T00:00:00Z')
  addRouteNote(SCENE, 'alt-bbbb0002', 'this one nearly works', null)

  const cleared = clearAlternatives(SCENE)

  assert.equal(cleared, 2)
  assert.deepEqual(listAlternatives(SCENE), [], 'the field is clear')
  for (const id of ['alt-bbbb0001', 'alt-bbbb0002']) {
    const [d] = dispositionsFor(id)
    assert.equal(d.disposition, 'superseded')
    assert.match(d.because, /adopted and accepted/)
  }
  assert.deepEqual(dispositionsFor('alt-bbbb0002')[0].notes.map(n => n.body), ['this one nearly works'])
})

test('pruning is never silent: every route the cap removes writes its own superseded entry', () => {
  clearAlternatives(SCENE)
  // One more than the cap keeps: the oldest head goes when the next lands.
  for (let i = 0; i <= KEEP_ALTERNATIVES; i++) put(`alt-cccc000${i}`, `2026-09-0${i + 1}T00:00:00Z`)
  const pruned = dispositionsFor('alt-cccc0000')
  assert.equal(pruned.length, 1, 'the oldest route was removed by the prune')
  assert.equal(pruned[0].disposition, 'superseded')
  assert.match(pruned[0].because, /pruned: this scene keeps its newest/)
  assert.ok(!fs.existsSync(routeFile('alt-cccc0000')))
  assert.equal(listAlternatives(SCENE).length, KEEP_ALTERNATIVES)
  clearAlternatives(SCENE)
})

test('adopting records the decision too, and the disposition log is never read as prose evidence', () => {
  clearAlternatives(SCENE)
  put('alt-dddd0001', '2026-09-12T00:00:00Z', { body: 'A wholly different way in tonight.' })
  addRouteNote(SCENE, 'alt-dddd0001', 'take this one', null)
  const before = readJudgments().length

  adoptAlternative(SCENE, 'alt-dddd0001')

  const [d] = dispositionsFor('alt-dddd0001')
  assert.equal(d.disposition, 'adopted')
  assert.match(d.because, /taken into prose\/ch-02\/scene-01\.md/)
  assert.deepEqual(d.notes.map(n => n.body), ['take this one'])
  // The learning pass mines PAIRS; a disposition is decision history and
  // must never be read as one.
  assert.equal(readJudgments().length, before, 'no judgment was written by a disposition')
  assert.ok(fs.existsSync(path.join(STORY, EVIDENCE_REL)), 'and it lives in the tracked record, not under .arc/')
  git(STORY, 'checkout', 'HEAD', '--', 'prose')
  clearAlternatives(SCENE)
})

test('a stale route is never written over newer work: the adopt refuses and says what moved', () => {
  clearAlternatives(SCENE)
  put('alt-eeee0001', '2026-09-12T00:00:00Z', { reads: [{ id: SCENE, version: 'aaaaaaaaaaaaaaaa' }] })
  assert.throws(() => adoptAlternative(SCENE, 'alt-eeee0001'), (e: unknown) => {
    const err = e as { status?: number; message: string }
    assert.equal(err.status, 409)
    assert.match(err.message, /this scene has changed since that route was written/)
    assert.match(err.message, /run it again from where the scene stands now, or cancel it\.$/)
    return true
  })
  assert.ok(fs.existsSync(routeFile('alt-eeee0001')), 'and the route is still there to re-run or cancel')
  assert.deepEqual(dispositionsFor('alt-eeee0001'), [], 'staleness is never logged as a decision')
  clearAlternatives(SCENE)
})

test('no route leaves disk without a disposition: every removal path writes one', () => {
  clearAlternatives(SCENE)
  const before = readDispositions().length
  put('alt-ffff0001', '2026-09-12T00:00:00Z')
  put('alt-ffff0002', '2026-09-13T00:00:00Z')
  dropAlternative(SCENE, 'alt-ffff0001')
  clearAlternatives(SCENE)
  const after = readDispositions().slice(before)
  assert.deepEqual(after.map(d => [d.route, d.disposition]),
    [['alt-ffff0001', 'cancelled'], ['alt-ffff0002', 'superseded']])
  assert.deepEqual(fs.existsSync(path.join(STORY, '.arc', 'alternatives', SCENE))
    ? fs.readdirSync(path.join(STORY, '.arc', 'alternatives', SCENE)) : [], [])
})

test('a note the route read and the author has since answered makes it stale — gone is changed', () => {
  clearAlternatives(SCENE)
  put('alt-9999aaaa', '2026-09-12T00:00:00Z', {
    reads: [...reads(), { id: 'note-0009', version: 'aaaaaaaaaaaaaaaa' }],
  })
  const [alt] = reroute.listRoutes(SCENE).alternatives
  assert.deepEqual(alt.stale, { changed: ['note-0009'], why: 'the record moved' },
    'an id the route named and the record no longer holds is a changed fingerprint, not an unmeasured one')
  clearAlternatives(SCENE)
})

test('the canon pack and the sibling scenes are measured at the write path, where invariant 1 binds', () => {
  clearAlternatives(SCENE)
  // Listing is the cheap map: it does not read canon, so a pack fingerprint
  // is carried unjudged and the route reads as governed.
  put('alt-9999bbbb', '2026-09-12T00:00:00Z', {
    reads: [...reads(), { id: `pack:${SCENE}`, version: 'aaaaaaaaaaaaaaaa' }],
  })
  assert.equal(reroute.listRoutes(SCENE).alternatives[0].stale, undefined)

  // The adopt is the write path, and there every id the manifest can name is
  // recomputed — so the route never enters the book over a moved record.
  assert.throws(() => adoptAlternative(SCENE, 'alt-9999bbbb'), (e: unknown) => {
    const err = e as { status?: number; message: string }
    assert.equal(err.status, 409)
    assert.match(err.message, /what that route was written from has changed/)
    return true
  })
  assert.ok(fs.existsSync(routeFile('alt-9999bbbb')), 'and it is still there to re-run or cancel')
  clearAlternatives(SCENE)
})

test('a disposition that cannot be written keeps the route on disk: the notes are never lost to a failed append', () => {
  clearAlternatives(SCENE)
  put('alt-9999cccc', '2026-09-12T00:00:00Z')
  addRouteNote(SCENE, 'alt-9999cccc', 'the words that must not go with the file', null)
  const log = path.join(STORY, EVIDENCE_REL)
  const before = readDispositions().length
  const mode = fs.statSync(log).mode
  fs.chmodSync(log, 0o444)
  try {
    assert.throws(() => dropAlternative(SCENE, 'alt-9999cccc'), (e: unknown) => {
      const err = e as { status?: number; message: string }
      assert.equal(err.status, 500)
      assert.match(err.message, /left the route where it is — nothing was lost/)
      return true
    })
    assert.ok(fs.existsSync(routeFile('alt-9999cccc')), 'the route kept its file, and its notes with it')
    assert.equal(readDispositions().length, before, 'and nothing was recorded')
  } finally {
    fs.chmodSync(log, mode)
  }
  clearAlternatives(SCENE)
})
