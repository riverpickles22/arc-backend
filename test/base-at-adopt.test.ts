// PUTTING A ROUTE INTO A SCENE, AND THE VERSION THE AUTHOR SAW (A72-3,
// criterion 10). Adopting writes the working tree and commits nothing, which
// is exactly why it needs the base: the scene the server reads when the
// request arrives is not the version the author was looking at when they
// decided, and the difference between the two is somebody's paragraph.
//
// The worked example, because adoption consults the canon graph for the
// route's own staleness and the minimal fixture story has no graph to export.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { git, makeExampleStory } from './fixture.ts'

const STORY = makeExampleStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

const { adoptAlternative, writeAlternative, clearAlternatives } = await import('../src/reroute.ts')
const { proseScenes } = await import('../src/story.ts')
const { baseOf } = await import('../src/base.ts')
const { laneHolder } = await import('../src/lane.ts')
const { HttpError } = await import('../src/http.ts')

const SCENE = 'sc.02-1'
const fileOf = (): string => proseScenes().find(s => s.scene === SCENE)!.file
const BASE = git(STORY, 'rev-parse', 'HEAD').trim()

const reset = (): void => {
  clearAlternatives(SCENE)
  git(STORY, 'reset', '-q', '--hard', BASE)
  git(STORY, 'clean', '-fdq')
}

const route = (id: string, body: string): void => writeAlternative({
  scene: SCENE, seed: 'late-entry', based_on: 'b', briefing: '', coverage: null, overlap: 0,
  id, created_at: '2026-10-04T00:00:00Z', body,
} as never)

test('adopting from an old view does not replace words typed in another', () => {
  reset()
  const file = fileOf()
  const abs = path.join(STORY, file)
  // The author opens the route panel. This is the destination as they see it.
  const seen = baseOf(file)
  route('alt-11110001', 'A wholly different way in tonight.')

  // In another view, they type in the destination scene.
  const theirs = fs.readFileSync(abs, 'utf8').trimEnd() + '\n\nA line typed while the panel was open.\n'
  fs.writeFileSync(abs, theirs)

  assert.throws(() => adoptAlternative(SCENE, 'alt-11110001', seen),
    (e: unknown) => e instanceof HttpError && e.status === 409 && /you have changed these words since/.test(e.message))
  assert.equal(fs.readFileSync(abs, 'utf8'), theirs,
    'adoption writes the tree, so a stale one must not write it')
  assert.equal(laneHolder(), null)

  // Read again, and the same route goes in deliberately.
  adoptAlternative(SCENE, 'alt-11110001', baseOf(file))
  assert.match(fs.readFileSync(abs, 'utf8'), /A wholly different way in tonight\./)
  reset()
})

test('the door requires the version; the in-process call keeps an escape hatch', async () => {
  reset()
  route('alt-22220001', 'Another way in.')

  // THE DOOR fails closed like every other decision: a request that does not
  // say which version it was about is refused before anything is written.
  const { createArcServer } = await import('../src/server.ts')
  const server = createArcServer()
  await new Promise<void>(resolve => server.listen(0, resolve))
  const at = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
  const before = fs.readFileSync(path.join(STORY, fileOf()), 'utf8')
  try {
    for (const body of [{ scene: SCENE, alt: 'alt-22220001' }, { scene: SCENE, alt: 'alt-22220001', base: '' }]) {
      const res = await fetch(`${at}/api/prose/reroute/adopt`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      assert.equal(res.status, 400, JSON.stringify(body))
      assert.match((await res.json() as { error: string }).error, /which version of the scene/)
    }
    assert.equal(fs.readFileSync(path.join(STORY, fileOf()), 'utf8'), before, 'and nothing was written')
  } finally {
    server.close()
  }

  // The FUNCTION keeps the parameter optional for a caller with no view to
  // have read — a terminal, a test. The viewer is not such a caller, and the
  // route above is why that distinction costs nothing.
  adoptAlternative(SCENE, 'alt-22220001')
  assert.match(fs.readFileSync(path.join(STORY, fileOf()), 'utf8'), /Another way in\./)
  reset()
})
