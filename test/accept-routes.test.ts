// The accept, end to end: what happens to a scene's field of routes when the
// author accepts the draft (A67-10, criterion 2 and Q13).
//
// The unit tests beside this one call `clearAlternatives` directly. This one
// goes through the HTTP accept, because the decision criterion 2 turns on —
// WHICH accepts clear a field, and which route is already spoken for — lives
// in the handler, not in the function it calls.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { git, makeExampleStory } from './fixture.ts'

const STORY = makeExampleStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

const { createArcServer } = await import('../src/server.ts')
const reroute = await import('../src/reroute.ts')
const { addRouteNote, clearAlternatives, listAlternatives, writeAlternative } = reroute
const { readDispositions } = await import('../src/evidence.ts')
const { sha16 } = await import('../src/records.ts')
const { proseScenes } = await import('../src/story.ts')

const server = createArcServer()
await new Promise<void>(resolve => server.listen(0, resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
test.after(() => server.close())

const post = (p: string, body: unknown) => fetch(base + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

const SCENE = 'sc.02-1'
const OTHER = 'sc.01-1'
const sceneOf = (id: string) => proseScenes().find(s => s.scene === id)!
const put = (scene: string, id: string, at: string, over: Record<string, unknown> = {}) => writeAlternative({
  scene, seed: 'late-entry', based_on: 'b', briefing: '', coverage: null, overlap: 0,
  run: 'run.0001', reads: [{ id: scene, version: sha16(sceneOf(scene).body) }],
  id, created_at: at, body: `Body ${id}.`, ...over,
} as never)
const dispositionsFor = (id: string) => readDispositions().filter(d => d.route === id)
const reset = () => {
  clearAlternatives(SCENE); clearAlternatives(OTHER)
  git(STORY, 'checkout', 'HEAD', '--', 'prose')
}

test('the accept supersedes the routes waiting beside the one it adopted, and never the adopted route itself', async () => {
  reset()
  put(SCENE, 'alt-1111aaaa', '2026-09-10T00:00:00Z', { body: 'A wholly different way in tonight.' })
  put(SCENE, 'alt-1111bbbb', '2026-09-11T00:00:00Z')
  addRouteNote(SCENE, 'alt-1111bbbb', 'nearly, but the coat is late', null)

  assert.equal((await post('/api/prose/reroute/adopt', { scene: SCENE, alt: 'alt-1111aaaa' })).status, 200)
  const accept = await post('/api/prose/accept', { message: 'a route taken' })
  assert.equal(accept.status, 200)

  // The one the author took: adopted, once. A `superseded` entry here would
  // put two readings of the same route on record and the later one would be
  // the lie.
  assert.deepEqual(dispositionsFor('alt-1111aaaa').map(d => d.disposition), ['adopted'])
  // The one waiting beside it: superseded, with the author's words kept.
  const [waiting] = dispositionsFor('alt-1111bbbb')
  assert.equal(waiting.disposition, 'superseded')
  assert.deepEqual(waiting.notes.map(n => n.body), ['nearly, but the coat is late'])
  // And the field is empty either way: both files are gone, each behind a
  // disposition of its own.
  assert.deepEqual(listAlternatives(SCENE), [])
  assert.deepEqual(fs.existsSync(path.join(STORY, '.arc', 'alternatives', SCENE))
    ? fs.readdirSync(path.join(STORY, '.arc', 'alternatives', SCENE)) : [], [])
  reset()
})

test('an accept that adopted no route clears nothing: the routes wait, stale by the change', async () => {
  reset()
  put(SCENE, 'alt-2222aaaa', '2026-09-10T00:00:00Z')
  const before = readDispositions().length

  // The author edits a different scene by hand and accepts that.
  const other = sceneOf(OTHER)
  fs.writeFileSync(path.join(STORY, other.file),
    fs.readFileSync(path.join(STORY, other.file), 'utf8') + '\nOne more line, typed by hand.\n')
  const accept = await post('/api/prose/accept', { message: 'a hand edit' })
  assert.equal(accept.status, 200)

  assert.equal(readDispositions().length, before, 'no route was disposed of by an accept that took none')
  assert.deepEqual(listAlternatives(SCENE).map(a => a.id), ['alt-2222aaaa'], 'the route is still waiting')
  reset()
})
