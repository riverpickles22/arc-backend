// ASK AGAIN (A69-13): one route's job, re-issued in that route's own place.
//
// The two gestures sit next to each other on the page and do opposite
// things, so what this file holds is the difference between them: *ask
// again* REPLACES the route the author is reading, *another way through*
// ADDS one. A bug that swapped them would be invisible in any single run and
// obvious only in a count, which is what most of these assertions are.
//
// The engine is the fixture engine. A re-issue renders the same brief as the
// route it re-runs — same seed, same line, same notes — so when nothing in
// the record has moved it HITS the same recorded answer, and the test can
// watch the replacement happen without a model in the loop.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { SCENE, STORY, reset } from './fixture-scenarios.ts'

const { runReroute, listRoutes, listAlternatives, routeReceipt, addRouteNote, MAX_ROUTES } = await import('../src/reroute.ts')
const { readDispositions } = await import('../src/evidence.ts')
const { readWorkingReceipt } = await import('../src/run.ts')

/** The routes waiting on the example scene, as the PAGE reads them: with
 *  staleness decided and the record's fingerprints stripped off. */
const routes = () => listRoutes(SCENE).alternatives
/** The routes AS RECORDED, which is what the endpoint hands to a re-issue —
 *  `reads` is the only place the notes a route was given are named, and the
 *  page's copy does not carry it (A69-13 review). */
const recorded = () => listAlternatives(SCENE)
/** Every `superseded` line the evidence log holds for this scene. */
const superseded = () => readDispositions().filter(d => d.scene === SCENE && d.disposition === 'superseded')

/** One route on the scene, from the recorded answer. */
async function oneRoute(): Promise<string> {
  const out = await runReroute({ scene: SCENE, count: 1 })
  assert.equal(out.alternatives.length, 1, out.refused.map(r => r.reason).join(' · '))
  return out.alternatives[0].id
}

test('ask again replaces the route it re-ran; another way through adds one', async () => {
  reset()
  const first = await oneRoute()
  assert.deepEqual(routes().map(r => r.id), [first])

  // THE RE-RUN. Same scene, same job — and the count does not move.
  const again = await runReroute({ scene: SCENE, reissue: recorded()[0] })
  assert.equal(again.alternatives.length, 1)
  const replacement = again.alternatives[0].id
  assert.notEqual(replacement, first, 'it is a new route, not the old one rewritten in place')
  assert.deepEqual(routes().map(r => r.id), [replacement],
    'one way through before, one after — the scene did not gain a route')
  assert.ok(!fs.existsSync(path.join(STORY, '.arc', 'alternatives', SCENE, `${first}.md`)),
    'and the route it replaced is off disk')

  // THE OTHER GESTURE, unchanged: it is the only one that adds.
  const added = await runReroute({ scene: SCENE, count: 1 })
  assert.equal(added.alternatives.length, 1)
  assert.equal(routes().length, 2, 'another way through always adds one')
})

test('the route it replaced leaves with a superseded disposition, carrying the author\'s notes', async () => {
  reset()
  const first = await oneRoute()
  // The author's own words on the route. They are the reason a route never
  // leaves disk without its disposition (A67-10).
  addRouteNote(SCENE, first, 'the arrival lands too softly here')
  const before = superseded().length

  await runReroute({ scene: SCENE, reissue: recorded()[0] })
  const rows = superseded()
  assert.equal(rows.length, before + 1, 'exactly one route went')
  const row = rows.at(-1)!
  assert.equal(row.route, first)
  assert.match(row.because, /asked again/)
  assert.deepEqual(row.notes.map(n => n.body), ['the arrival lands too softly here'],
    'the author wrote it, so it goes into the record rather than away with the file')
  assert.ok(row.run, 'and the run that made the route it replaced is named')
})

test('the new receipt names the receipt it re-issued, and the route says it was asked again', async () => {
  reset()
  await oneRoute()
  const parent = routes()[0]
  const out = await runReroute({ scene: SCENE, reissue: parent })
  const child = out.alternatives[0]

  assert.equal(child.reissued, true, 'the route itself records that it was a second asking')
  assert.equal(readWorkingReceipt(child.run!)!.reissued_from, parent.run,
    'the receipt names the receipt it re-issued (§4)')
  const shown = routeReceipt(child)!
  assert.equal(shown.reissued, true)
  assert.equal(shown.reissued_from, parent.run, 'and the author can read it in the fold')

  // A route that was NOT a re-run says nothing about one, rather than
  // saying "none" about a receipt that never existed.
  const fresh = routeReceipt(routes().find(r => r.id !== child.id) ?? child)
  if (fresh && fresh.run !== child.run) {
    assert.equal(fresh.reissued, undefined)
    assert.equal(fresh.reissued_from, undefined)
  }
})

test('the re-issue is handed the same notes BY ID, as the record holds them now', async () => {
  reset()
  const { observeBriefs } = await import('../src/fixtures.ts')

  // TWO OPEN AUTHOR NOTES, so "the notes it was given" and "no notes at
  // all" are different things. Read through `listRoutes` this test passed
  // whether the filter worked or dropped every note, because the example
  // ships its one author note resolved (A69-13 review).
  const given = path.join(STORY, 'annotations', 'note-902.yaml')
  const later = path.join(STORY, 'annotations', 'note-901.yaml')
  // The route first, on the example as shipped, so the recorded answer is
  // found and there is something on disk to ask again for.
  await oneRoute()
  fs.writeFileSync(given, `id: note.902\nby: author\nstatus: open\nanchor:\n  scene: ${SCENE}\nbody: the keeper should notice the cold first\n`)
  fs.writeFileSync(later, `id: note.901\nby: author\nstatus: open\nanchor:\n  scene: ${SCENE}\nbody: written after the route, and not part of its job\n`)
  try {
    // A route that RECORDED note.902 among what it read. The brief is
    // rendered before the engine is consulted, so what the re-issue is
    // handed is observable whether or not an answer comes back.
    const base = recorded()[0] ?? null
    assert.ok(base, 'a route on disk to ask again for')
    const asked = { ...base!, reads: [...(base!.reads ?? []), { id: 'note.902', version: 'x' }] }

    const seen: string[] = []
    const stop = observeBriefs(b => seen.push(b.brief))
    await runReroute({ scene: SCENE, reissue: asked }).catch(() => {})
    stop()
    assert.ok(seen.length, 'the re-issue rendered a brief')
    assert.ok(seen[0].includes('the keeper should notice the cold first'),
      'THE NOTE THE ROUTE WAS GIVEN reaches the re-issue — dropping them all is not "the same notes"')
    assert.ok(!seen[0].includes('written after the route'),
      'and one written since the route is no part of the job being repeated')
  } finally {
    fs.rmSync(given, { force: true }); fs.rmSync(later, { force: true })
  }
})

test('a re-issue is given the route AS RECORDED, not as the page reads it', async () => {
  reset()
  await oneRoute()
  // The page's copy has its staleness decided and the record's fingerprints
  // stripped — and `reads` is the only place the notes a route was given
  // are named. An endpoint that hands the page's copy to a re-issue hands
  // it nothing to repeat, and every note is filtered out of the brief.
  assert.equal(routes()[0].reads, undefined, 'the page never sees what the record was fingerprinted at')
  assert.ok((recorded()[0].reads ?? []).length, 'the record does')

  // So the guard against that mistake: a route with no `reads` is asked as
  // the scene stands today rather than as a job with no notes at all.
  const { withStaleness } = await import('../src/reroute.ts')
  assert.equal(withStaleness({ ...recorded()[0], reads: undefined, run: undefined }).stale?.why,
    'written by an older arc')
})

test('a route that recorded nothing about what it read is asked as the scene stands today', async () => {
  reset()
  await oneRoute()
  const { withStaleness } = await import('../src/reroute.ts')
  // An older-arc route: no `reads`, so arc cannot say which notes it was
  // given. That is a different fact from "it was given none", and it is the
  // one `reissued_from` also refuses to guess at.
  const older = { ...routes()[0], reads: undefined, run: undefined }
  assert.equal(withStaleness(older).stale?.why, 'written by an older arc')
  const { observeBriefs } = await import('../src/fixtures.ts')
  const seen: string[] = []
  const stop = observeBriefs(b => seen.push(b.brief))
  await runReroute({ scene: SCENE, reissue: older }).catch(() => {})
  stop()
  assert.ok(seen.length, 'it is asked, rather than refused — this is the case ask again exists for')
})

test('only the newest version of a route may be asked again', async () => {
  reset()
  await oneRoute()
  const parent = routes()[0]
  await runReroute({ scene: SCENE, reissue: parent })
  // A superseded id is gone; the guard is for a version chain, which a
  // rewrite makes. Stand one up directly: the route file records `revises`.
  const head = routes()[0]
  const child = { ...head, id: 'alt-child01', revises: head.id }
  const dir = path.join(STORY, '.arc', 'alternatives', SCENE)
  fs.writeFileSync(path.join(dir, 'alt-child01.md'),
    fs.readFileSync(path.join(dir, `${head.id}.md`), 'utf8')
      .replace(`id: ${head.id}`, `id: alt-child01`)
      .replace('scene:', `revises: ${head.id}
scene:`))
  void child
  await assert.rejects(() => runReroute({ scene: SCENE, reissue: head }),
    (e: unknown) => /earlier version of that route/.test((e as Error).message),
    'superseding it would leave the version that replaced it pointing at nothing')
})

test('a seed arc no longer offers cannot be asked again as it was', async () => {
  reset()
  await oneRoute()
  const gone = { ...routes()[0], seed: 'a-seed-arc-retired' }
  await assert.rejects(() => runReroute({ scene: SCENE, reissue: gone }),
    (e: unknown) => /no longer offers/.test((e as Error).message),
    'answering with a different seed would call another question the same one')
})

test('a scene at the cap can still be asked again — the re-run takes a place already taken', async () => {
  reset()
  for (let i = 0; i < MAX_ROUTES; i++) {
    const out = await runReroute({ scene: SCENE, count: 1 })
    if (!out.alternatives.length) break
  }
  const atCap = routes().length
  assert.equal(atCap, MAX_ROUTES, 'the scene is full')

  // Another way through is refused: there is no room to add.
  await assert.rejects(() => runReroute({ scene: SCENE, count: 1 }),
    (e: unknown) => /already holds/.test((e as Error).message))

  // Ask again is not, because it replaces rather than joins.
  const again = await runReroute({ scene: SCENE, reissue: recorded()[0] })
  assert.equal(again.alternatives.length, 1, 'the author may always try the one they are reading again')
  assert.equal(routes().length, MAX_ROUTES, 'and the scene is still at four, not five')
})
