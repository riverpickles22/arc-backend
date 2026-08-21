// The engine seam under the claude-cli engine — the one condition every other
// test skips with ARC_DRAFT_ENGINE=none, which is exactly why the seam could
// be synchronous for this long without a test noticing (A13-6).
//
// Two properties, and they are the same property seen from two sides: a
// generation must not freeze the server, and four lenses must genuinely run at
// once. Both were false while runCliPrompt used spawnSync — spawnSync blocks
// the Node event loop, so Promise.all over four of them ran strictly in
// sequence and the fan-out's wall_ms against serial_ms could never move.
//
// A STUB `claude` on PATH, not the real one: the point is the async property
// of the seam, not what a model says. The stub takes the same arguments, reads
// the same stdin, and answers in the same `--output-format json` shape, so the
// code under test is the production path in full.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { makeExampleStory } from './fixture.ts'

/** How long the stub pretends to think. Long enough that a serialised
 *  fan-out is unmistakable, short enough to keep the suite quick. */
const DELAY_MS = 400

function installStubCli(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-stub-cli-'))
  const bin = path.join(dir, 'claude')
  fs.writeFileSync(bin, `#!/usr/bin/env node
// Stands in for \`claude -p --output-format json\`. Blocks its OWN process for
// DELAY_MS with Atomics.wait — real occupancy, so a caller that blocks with it
// is indistinguishable from a caller waiting on a slow model.
if (process.argv.includes('--version')) { process.stdout.write('stub 1.0\\n'); process.exit(0) }
const chunks = []
process.stdin.on('data', c => chunks.push(c))
process.stdin.on('end', () => {
  const prompt = chunks.join('')
  if (process.env.STUB_FAIL === '1') { process.stderr.write('stub refused'); process.exit(3) }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${DELAY_MS})
  process.stdout.write(JSON.stringify({
    subtype: 'success', is_error: false, session_id: 'stub-session',
    result: JSON.stringify([{ about: 'stub', claim: 'a stub claim', evidence: 'stub evidence' }]),
    saw_prompt_bytes: prompt.length,
  }))
})
`)
  fs.chmodSync(bin, 0o755)
  return dir
}

const STORY = makeExampleStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'claude-cli'
process.env.PATH = `${installStubCli()}${path.delimiter}${process.env.PATH}`

const { runCliPrompt, currentEngine } = await import('../src/engine.ts')
const { runLensFanOut } = await import('../src/lenses.ts')
const { Run } = await import('../src/run.ts')
const { createArcServer } = await import('../src/server.ts')

const SCENE_ID = 'sc.02-1'

/** Ticks a 20ms interval and reports how many landed — the event loop's own
 *  pulse. Zero ticks across a multi-second call is what a frozen server looks
 *  like from the inside. */
function watchEventLoop(): () => { ticks: number; elapsed: number } {
  const started = Date.now()
  let ticks = 0
  const t = setInterval(() => { ticks++ }, 20)
  return () => {
    clearInterval(t)
    return { ticks, elapsed: Date.now() - started }
  }
}

test('the engine really is claude-cli here — otherwise this file proves nothing', () => {
  assert.equal(currentEngine(), 'claude-cli')
})

test('one CLI turn does NOT block the event loop', async () => {
  const stop = watchEventLoop()
  const { text, sessionId } = await runCliPrompt('hello', { cwd: STORY })
  const { ticks, elapsed } = stop()

  assert.match(text, /a stub claim/, 'the production parse path ran')
  assert.equal(sessionId, 'stub-session')
  assert.ok(elapsed >= DELAY_MS, `the call really took time (${elapsed}ms)`)
  // Under spawnSync this was exactly 0, every time.
  assert.ok(ticks >= elapsed / 20 * 0.5,
    `the loop kept running during the call: ${ticks} ticks in ${elapsed}ms`)
})

test('four concurrent turns cost about one, not four', async () => {
  const t0 = Date.now()
  const out = await Promise.all(Array.from({ length: 4 }, (_, i) =>
    runCliPrompt(`turn ${i}`, { cwd: STORY })))
  const wall = Date.now() - t0

  assert.equal(out.length, 4)
  assert.ok(wall < DELAY_MS * 2.5,
    `four turns in ${wall}ms — serial would be about ${DELAY_MS * 4}ms`)
})

test('a failing CLI still reports its exit code and stderr', async () => {
  process.env.STUB_FAIL = '1'
  try {
    await assert.rejects(runCliPrompt('x', { cwd: STORY }), /claude CLI exited 3: stub refused/)
  } finally {
    delete process.env.STUB_FAIL
  }
})

// ---- the claim A13-3 makes, checked on the engine that can break it --------

test('the lens fan-out is concurrent on claude-cli: wall_ms well under serial_ms', async () => {
  const { proseScenes } = await import('../src/story.ts')
  const scene = proseScenes().find(s => s.scene === SCENE_ID) ?? proseScenes()[0]
  assert.ok(scene, 'the example story has a scene to read')

  const run = new Run('cli', 'a13-6: fan-out concurrency on the claude-cli engine')
  const out = await runLensFanOut(scene, run)

  const { LENSES } = await import('../src/lenses.ts')
  assert.equal(out.lenses.length, LENSES.length)
  assert.deepEqual(out.lenses.filter(l => l.error).map(l => `${l.lens}: ${l.error}`), [])
  // Under spawnSync wall_ms equalled the sum of the calls. The margin is
  // deliberately loose — this asserts "concurrent", not a speed target.
  assert.ok(out.wall_ms < out.serial_ms * 0.6,
    `wall ${out.wall_ms}ms vs serial ${out.serial_ms}ms — the lenses overlapped`)
  assert.ok(out.wall_ms < DELAY_MS * 3,
    `wall ${out.wall_ms}ms is nearer one lens (${DELAY_MS}ms) than four`)
})

// ---- and the same property from the server's side --------------------------

test('the server keeps answering while a generation is in flight', async () => {
  const server = createArcServer()
  await new Promise<void>(resolve => server.listen(0, resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // Tail the run stream before starting the work, the way the viewer does.
  const ac = new AbortController()
  const streamed: string[] = []
  let running = false
  let sawEventMidRun = false
  const stream = fetch(`${base}/api/runs/stream`, { signal: ac.signal }).then(async res => {
    assert.equal(res.status, 200)
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        const chunk = dec.decode(value, { stream: true })
        streamed.push(chunk)
        // Delivered WHILE the run is still going — the viewer's whole reason
        // for holding the stream open. Arriving in one burst at the end is
        // what a frozen loop looks like from the client's side.
        if (running && chunk.includes('task.started')) sawEventMidRun = true
      }
    } catch { /* aborted below — expected */ }
  })

  running = true
  const lenses = fetch(`${base}/api/prose/lenses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scene: SCENE_ID }),
  }).finally(() => { running = false })

  // Poll canon for the whole life of the run rather than probing once: a
  // single probe can land in the gap before the server picks the POST up and
  // pass against a backend that is about to freeze solid. The WORST latency
  // across the run is the honest measure — under spawnSync, whichever poll is
  // in flight when the fan-out starts waits for all four lenses.
  const latencies: number[] = []
  let entities = 0
  while (running) {
    const t0 = Date.now()
    const canon = await fetch(`${base}/api/canon`)
    latencies.push(Date.now() - t0)
    assert.equal(canon.status, 200, 'canon answered during the generation')
    entities = Object.keys((await canon.json()).entities ?? {}).length
    await new Promise(r => setTimeout(r, 25))
  }

  const worst = Math.max(...latencies)
  assert.ok(entities > 0, 'and answered with the graph, not an empty shell')
  assert.ok(latencies.length >= 4,
    `the server served ${latencies.length} canon reads while generating — a frozen one serves ~1`)
  assert.ok(worst < DELAY_MS,
    `the slowest canon read took ${worst}ms; a blocked backend would take about ${DELAY_MS * 4}ms`)

  const res = await lenses
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.lenses.length, (await import('../src/lenses.ts')).LENSES.length)
  assert.ok(body.wall_ms < body.serial_ms * 0.6, 'over the wire too')

  // The stream carried the run's events, so the viewer saw the work happen.
  assert.match(streamed.join(''), /task\.started/, 'the live stream carried the run')
  assert.ok(sawEventMidRun, 'and delivered while the run was still going, not in one burst at the end')

  ac.abort()
  await stream
  await new Promise<void>(resolve => server.close(() => resolve()))
})
