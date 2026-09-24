// The request: a gesture the author made, resolved by code to a cell and
// then to the row that admits it (A67-8; agent-workflows §4, "The request").
//
// Two refusals, both in the author's words and both before any token: a cell
// the rows do not list (invariant 10), and a depth word the rows do not
// carry — never silently mapped to standard.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
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

const { resolveRequest, resolveDepth } = await import('../src/request.ts')
const { ROW_EXPLORE_SCENE, ROW_EXPLORE_ROUTE } = await import('../src/registry.ts')
const { createArcServer } = await import('../src/server.ts')

const gesture = (over: Record<string, unknown> = {}) => ({
  said: 'another way through sc.02-1', job: 'explore' as const, scope: 'scene' as const,
  mode: 'one-shot' as const, subject: 'sc.02-1', ...over,
})

test('the route button on a scene resolves to U4, and rewrite-from-notes on a route to U5', () => {
  const u4 = resolveRequest(gesture())
  assert.equal(u4.row, ROW_EXPLORE_SCENE)
  assert.equal(u4.cell, 'explore · scene · one-shot')
  assert.equal(u4.gesture, 'another way through sc.02-1', 'the gesture as the author made it')
  assert.equal(u4.subject, 'sc.02-1')

  const u5 = resolveRequest(gesture({ said: 'rewrite this route from my notes on it', scope: 'route', subject: 'alt-1' }))
  assert.equal(u5.row, ROW_EXPLORE_ROUTE)
  assert.equal(u5.cell, 'explore · route · one-shot')
})

test('a cell the rows do not list is refused at intake, in the author\'s words', () => {
  for (const bad of [
    gesture({ job: 'draft' }),                    // no draft row until slice 2
    gesture({ scope: 'chapter' }),                // no chapter row
    gesture({ mode: 'batch' }),                   // no batch row
  ]) {
    assert.throws(() => resolveRequest(bad), (e: unknown) => {
      const err = e as { status?: number; message: string }
      assert.equal(err.status, 400)
      assert.match(err.message, /^arc cannot /)
      assert.match(err.message, /nothing was written/)
      assert.doesNotMatch(err.message, /row|registry|cell|undefined/i, 'no machine word')
      return true
    })
  }
})

test('a depth word the rows do not carry is refused, never silently mapped to standard', () => {
  assert.equal(resolveDepth(undefined), undefined, 'saying nothing about depth says nothing')
  assert.equal(resolveDepth('quickly'), 'quick')
  assert.equal(resolveDepth('thoroughly'), 'full')
  assert.equal(resolveDepth('Standard'), 'standard')
  assert.throws(() => resolveDepth('exhaustively'), (e: unknown) => {
    const err = e as { status?: number; message: string }
    assert.equal(err.status, 400)
    assert.match(err.message, /arc does not know how to work "exhaustively"/)
    assert.match(err.message, /quickly, or take a standard pass, or go through thoroughly/)
    return true
  })

  // A blank field says nothing about depth, and the row's own stands.
  assert.equal(resolveDepth(''), undefined)
  assert.equal(resolveDepth('   '), undefined)
  assert.equal(resolveRequest(gesture({ depth: '' })).row, ROW_EXPLORE_SCENE)

  // A depth the rows do not carry is refused too — U4 is standard only.
  assert.throws(() => resolveRequest(gesture({ depth: 'quickly' })), (e: unknown) => {
    const err = e as { message: string }
    assert.match(err.message, /arc cannot explore a scene, quick yet/)
    assert.match(err.message, /It can take a standard pass at that\. Ask again without the word\./)
    return true
  })
  // ...and the same gesture with no word resolves.
  assert.equal(resolveRequest(gesture()).row, ROW_EXPLORE_SCENE)
})

test('the advice names what THIS cell can do, never a row at another mode', () => {
  // The refused cell is iterative, which has no row at all: dropping the
  // depth word would not help, and the refusal must not say it would.
  assert.throws(() => resolveRequest(gesture({ mode: 'iterative', depth: 'quickly' })), (e: unknown) => {
    const err = e as { message: string }
    assert.doesNotMatch(err.message, /Ask again without the word/, 'that keystroke would fail too')
    assert.match(err.message, /Ask for something it can do/)
    return true
  })
})

test('over HTTP: the route refuses an unknown depth before anything is spent, and records the gesture when it resolves', async () => {
  const server = createArcServer()
  await new Promise<void>(resolve => server.listen(0, resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const bad = await fetch(`${base}/api/prose/reroute`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scene: 'sc.02-1', depth: 'exhaustively', dry: true }),
    })
    assert.equal(bad.status, 400)
    assert.match((await bad.json() as { error: string }).error, /does not know how to work "exhaustively"/)

    // A dry run resolves the request and renders the brief, with no engine.
    const ok = await fetch(`${base}/api/prose/reroute`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scene: 'sc.02-1', count: 1, dry: true }),
    })
    assert.equal(ok.status, 200)
    assert.equal((await ok.json() as { briefs: string[] }).briefs.length, 1)
  } finally {
    server.close()
  }
})
