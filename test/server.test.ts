// Route-level smoke on an ephemeral port: shapes, statuses, CORS.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { makeStory, writeScene } from './fixture.ts'

const story = makeStory()
process.env.ARC_STORY_PATH = story
process.env.ANTHROPIC_API_KEY = 'test-key-never-used'   // lets chat reach the body guard
const { createArcServer } = await import('../src/server.ts')

const server = createArcServer()
await new Promise<void>(resolve => server.listen(0, resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
test.after(() => server.close())

const get = (p: string, headers: Record<string, string> = {}) => fetch(base + p, { headers })
const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

test('GET shapes match the shared envelopes', async () => {
  const docs = await (await get('/api/docs')).json()
  assert.ok(Array.isArray(docs.articles))

  const prose = await (await get('/api/prose')).json()
  assert.equal(prose.scenes.length, 1)
  assert.equal(prose.scenes[0].scene, 'sc.01-1')

  const draft = await (await get('/api/prose/draft')).json()
  assert.equal(draft.git, true)
  assert.ok(Array.isArray(draft.changes) && Array.isArray(draft.history))

  const view = await get('/api/view')
  assert.equal(view.status, 200)
})

test('unknown route → 404, wrong method → 405, both with clean {error}', async () => {
  const missing = await get('/api/nope')
  assert.equal(missing.status, 404)
  assert.match((await missing.json()).error, /no route/)

  const wrong = await post('/api/docs', {})
  assert.equal(wrong.status, 405)
  assert.equal((await wrong.json()).error, 'GET only')
})

test('accept with no draft changes → 409 with the domain message', async () => {
  const res = await post('/api/prose/accept', {})
  assert.equal(res.status, 409)
  assert.equal((await res.json()).error, 'no draft changes to accept')
})

test('accept/discard roundtrip through the HTTP layer', async () => {
  writeScene(story, 'prose/ch-01/scene-01.md', 'sc.01-1', 'HTTP-layer revision.')
  const accept = await post('/api/prose/accept', { message: 'prose: via http' })
  assert.equal(accept.status, 200)
  const body = await accept.json()
  assert.match(body.hash, /^[0-9a-f]{7,}$/)

  writeScene(story, 'prose/ch-01/scene-01.md', 'sc.01-1', 'Doomed.')
  const discard = await post('/api/prose/discard', { file: 'prose/ch-01/scene-01.md' })
  assert.equal(discard.status, 200)
  assert.deepEqual(await discard.json(), { ok: true })

  const bad = await post('/api/prose/discard', { file: 'prose/../canon/story.yaml' })
  assert.equal(bad.status, 400)
})

test('malformed JSON body → 400', async () => {
  const res = await post('/api/prose/accept', '{not json')
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /not valid JSON/)
})

test('chat body guard → 400 before any SDK call', async () => {
  for (const bad of [{}, { messages: [] }, { messages: [{ role: 'system', content: 'x' }] }, { messages: [{ role: 'user' }] }]) {
    const res = await post('/api/chat', bad)
    assert.equal(res.status, 400, JSON.stringify(bad))
  }
})

test('oversize body → 413', async () => {
  const res = await post('/api/prose/accept', { message: 'x'.repeat(3 * 1024 * 1024) })
  assert.equal(res.status, 413)
})

test('accept with capture requested but no credentials skips capture gracefully', async () => {
  const savedKey = process.env.ANTHROPIC_API_KEY
  const savedToken = process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  try {
    writeScene(story, 'prose/ch-01/scene-01.md', 'sc.01-1', 'Capture-skip revision.')
    const res = await post('/api/prose/accept', { message: 'prose: capture skip', capture: true })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.match(body.hash, /^[0-9a-f]{7,}$/)
    assert.equal(body.capture, undefined)
  } finally {
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey
    if (savedToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = savedToken
  }
})

test('draft-scene guards: 503 with no engine, 400 without a chapter', async () => {
  process.env.ARC_DRAFT_ENGINE = 'none'   // a live CLI on the test machine must not count
  try {
    const res = await post('/api/prose/draft-scene', { chapter: 'ch.01' })
    assert.equal(res.status, 503)
    assert.match((await res.json()).error, /No generation engine/)
  } finally {
    delete process.env.ARC_DRAFT_ENGINE
  }
  const bad = await post('/api/prose/draft-scene', {})
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).error, 'chapter required')
})

test('CORS: localhost reflected, anything else gets no header', async () => {
  const ok = await get('/api/docs', { origin: 'http://localhost:5173' })
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173')

  const evil = await get('/api/docs', { origin: 'https://evil.example' })
  assert.equal(evil.headers.get('access-control-allow-origin'), null)
})

test('attention on a broken canon is a clean 500 (same contract as /api/canon)', async () => {
  const res = await get('/api/attention')   // fixture canon cannot export
  assert.equal(res.status, 500)
  const body = await res.json()
  assert.doesNotMatch(body.error, /Traceback/)
})

test('canon export failure is a clean 500, not a traceback', async () => {
  const res = await get('/api/canon')   // fixture canon is deliberately incomplete
  assert.equal(res.status, 500)
  const body = await res.json()
  assert.match(body.error, /canon export failed/)
  assert.doesNotMatch(body.error, /Traceback/)
})
