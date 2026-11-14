// A key with no CLI is no engine (A78-1): every route that gates on "is there
// an engine" asks chooseEngine, so a key in the environment no longer slips a
// request past the guard into a launch that cannot answer. The `claude` on
// PATH here refuses even `--version`, so the probe finds no CLI; the key is a
// placeholder no engine is ever handed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { makeStory, writeScene } from './fixture.ts'

const story = makeStory()
process.env.ARC_STORY_PATH = story
delete process.env.ARC_DRAFT_ENGINE
process.env.ANTHROPIC_API_KEY = 'placeholder-not-a-key'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-no-cli-'))
fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\nexit 1\n')
fs.chmodSync(path.join(dir, 'claude'), 0o755)
process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ''}`

const { currentEngine, currentEngineReason } = await import('../src/engine.ts')
const { createArcServer } = await import('../src/server.ts')
const server = createArcServer()
await new Promise<void>(resolve => server.listen(0, resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
test.after(() => { server.close(); delete process.env.ANTHROPIC_API_KEY })

const post = (p: string, body: unknown) =>
  fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('a key with no CLI picks no engine, and the banner says why', () => {
  assert.equal(currentEngine(), null)
  assert.match(currentEngineReason(), /^none — a key is set, but the SDK answers only when ARC_DRAFT_ENGINE=sdk/)
})

test('every engine-gated route refuses a key with no CLI, in the plain sentence', async () => {
  const routes: [string, unknown][] = [
    ['/api/prose/redraft', { scene: 'sc.01-1' }],
    ['/api/prose/work-notes', { scene: 'sc.01-1' }],
    ['/api/prose/reroute', { scene: 'sc.01-1' }],
    ['/api/prose/reroute/again', { scene: 'sc.01-1', alt: 'alt.1' }],
    ['/api/prose/reroute/revise', { scene: 'sc.01-1', alt: 'alt.1', note: 'x' }],
    ['/api/record/update', { scene: 'sc.01-1' }],
    ['/api/prose/draft-scene', { chapter: 'ch.01' }],
    ['/api/prose/lenses', { scene: 'sc.01-1' }],
    ['/api/prose/suggest', { kind: 'rephrase', selection: 'something' }],
  ]
  for (const [route, body] of routes) {
    const res = await post(route, body)
    const { error } = await res.json() as { error: string }
    assert.ok(res.status === 400 || res.status === 503, `${route} answered ${res.status}`)
    assert.match(error, /Install Claude Code, open a terminal, type {2}claude {2}and press Return to sign in/, route)
    assert.match(error, /A key on its own is not enough/, route)
  }
})

test('the note-work door (intake, then the judgment) and the change reading refuse the same way', async () => {
  // a note to work: the intake and the judgment are reached only through it
  const { note } = await (await post('/api/notes', { text: 'make the harbour colder' })).json() as { note: { file: string } }
  // a pending change to read, at the base the viewer would have been served
  writeScene(story, 'prose/ch-01/scene-01.md', 'sc.01-1', 'A pending revision.')
  const draft = await (await fetch(`${base}/api/prose/draft`)).json() as { changes: { file: string; base: string }[] }
  const served = draft.changes.find(c => c.file === 'prose/ch-01/scene-01.md')!.base
  for (const [route, body] of [
    ['/api/notes/work', { file: note.file }],
    ['/api/prose/inspect', { scene: 'sc.01-1', base: served }],
  ] as [string, unknown][]) {
    const res = await post(route, body)
    const { error } = await res.json() as { error: string }
    assert.ok(res.status === 400 || res.status === 503, `${route} answered ${res.status}: ${error}`)
    assert.match(error, /Install Claude Code, open a terminal, type {2}claude {2}and press Return to sign in/, route)
  }
})
