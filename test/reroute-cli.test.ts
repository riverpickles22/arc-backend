// The reroute pass end to end, on a STUB `claude` that answers with a canned
// two-part reroute. What is under test is everything around the model: the
// alternative lands beside the manuscript with its coverage and overlap, the
// ledger stays silent until adopt, adopt goes through the lock-gated write
// and only then records origin 'reroute', drop removes the file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeExampleStory } from './fixture.ts'

const ANSWER = [
  'Ines was already on the stairs when the sea changed its mind about the morning.',
  '',
  'She had counted forty-one steps before she let herself hear it, and forty-two before she let herself stop.',
  '',
  'Wren\'s coat hung where Wren had left it, and the salt on its shoulders had dried into a map of nothing.',
  '',
  'By the time the light turned again there was no one to tell, and she told the light.',
  '',
  '=== BRIEFING ===',
  'The wreck is reached from the stairs, not from the light: the beat lands in ¶2. The coat carries what the scene withholds.',
  '',
  '```json',
  '{"coverage": [{"item": "The wreck is known before it is seen.", "paragraph": 2}, {"item": "Wren is absent.", "paragraph": 3}]}',
  '```',
].join('\n')

function installStubCli(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-stub-reroute-'))
  const bin = path.join(dir, 'claude')
  fs.writeFileSync(bin, `#!/usr/bin/env node
if (process.argv.includes('--version')) { process.stdout.write('stub 1.0\\n'); process.exit(0) }
const chunks = []
process.stdin.on('data', c => chunks.push(c))
process.stdin.on('end', () => {
  const prompt = chunks.join('')
  if (process.env.STUB_FAIL === '1') { process.stderr.write('stub refused'); process.exit(3) }
  process.stdout.write(JSON.stringify({
    subtype: 'success', is_error: false, session_id: 'stub-session',
    result: ${JSON.stringify(ANSWER)},
    saw: prompt.includes('The light held') ? 'PROSE-LEAKED' : 'clean',
  }))
})
`)
  fs.chmodSync(bin, 0o755)
  return dir
}

const STORY = makeExampleStory()
// The example scene gains a contract — a reroute needs a destination.
const sceneFile = path.join(STORY, 'prose', 'ch-02', 'scene-01.md')
fs.writeFileSync(sceneFile, fs.readFileSync(sceneFile, 'utf8').replace(
  'events: [event.the-wreck]\n---',
  'events: [event.the-wreck]\ncontract:\n  purpose: Let the wreck be known before it is seen.\n  must_establish:\n    - The wreck is known before it is seen.\n    - Wren is absent.\n  must_withhold:\n    - \'"Whitcombe"\'\n---'))
{ const { git } = await import('./fixture.ts'); git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'scene contract') }
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'claude-cli'
process.env.PATH = `${installStubCli()}${path.delimiter}${process.env.PATH}`

const { runReroute, listRoutes, adoptAlternative, dropAlternative } = await import('../src/reroute.ts')
const { generatedFor } = await import('../src/ledger.ts')
const { proseScenes } = await import('../src/story.ts')

test('a reroute lands beside the manuscript, coverage read from the tail, and the ledger stays silent', async () => {
  const res = await runReroute({ scene: 'sc.02-1', count: 1, guidance: 'colder' })
  assert.equal(res.refused.length, 0, JSON.stringify(res.refused))
  assert.equal(res.alternatives.length, 1)
  const alt = res.alternatives[0]
  assert.equal(alt.seed, 'late-entry'); assert.equal(alt.guidance, 'colder')
  assert.match(alt.body, /^Ines was already on the stairs/); assert.doesNotMatch(alt.body, /=== BRIEFING ===/)
  assert.match(alt.briefing, /reached from the stairs/); assert.doesNotMatch(alt.briefing, /```/)
  assert.deepEqual(alt.coverage, [{ item: 'The wreck is known before it is seen.', paragraph: 2 }, { item: 'Wren is absent.', paragraph: 3 }])
  assert.equal(alt.overlap, 0)
  const file = path.join(STORY, '.arc', 'alternatives', 'sc.02-1', `${alt.id}.md`)
  assert.ok(fs.existsSync(file))
  assert.match(fs.readFileSync(file, 'utf8'), /^---\nid: alt-/)
  // the manuscript is untouched and the ledger knows nothing yet
  assert.match(proseScenes().find(s => s.scene === 'sc.02-1')!.body, /The light held/)
  assert.equal(generatedFor('prose/ch-02/scene-01.md'), null)
  const listed = listRoutes('sc.02-1')
  assert.deepEqual(listed.alternatives.map(a => a.id), [alt.id]); assert.deepEqual(listed.locks, [])
})

test('adopt writes the route through the scene write and only then records the ledger; drop removes the file', async () => {
  const before = listRoutes('sc.02-1').alternatives[0]
  const adopted = adoptAlternative('sc.02-1', before.id)
  assert.equal(adopted.file, 'prose/ch-02/scene-01.md')
  assert.match(adopted.scene.body, /^Ines was already on the stairs/)
  assert.match(proseScenes().find(s => s.scene === 'sc.02-1')!.body, /forty-one steps/)
  const gen = generatedFor('prose/ch-02/scene-01.md')
  assert.ok(gen && gen.entry.origin === 'reroute' && gen.entry.scene === 'sc.02-1')
  assert.match(gen!.content, /^---\nscene: sc\.02-1/)   // the whole file, frontmatter intact
  dropAlternative('sc.02-1', before.id)
  assert.deepEqual(listRoutes('sc.02-1').alternatives, [])
  assert.throws(() => dropAlternative('sc.02-1', before.id), (e: unknown) => (e as { status?: number }).status === 404)
})

// ---- the routes, on an ephemeral port ---------------------------------------
import type { AddressInfo } from 'node:net'
const { createArcServer } = await import('../src/server.ts')
const server = createArcServer()
await new Promise<void>(resolve => server.listen(0, resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
test.after(() => server.close())
const get = (p: string) => fetch(base + p)
const post = (p: string, body: unknown) =>
  fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('the routes: validation, run, list, adopt (ledger only after), drop', async () => {
  assert.equal((await post('/api/prose/reroute', {})).status, 400)
  assert.equal((await post('/api/prose/reroute', { scene: 'sc.02-1', count: 9 })).status, 400)
  assert.equal((await get('/api/prose/reroute')).status, 400)
  assert.equal((await post('/api/prose/reroute/adopt', { scene: 'sc.02-1' })).status, 400)

  // the earlier adopt left the route in the working tree; put main back so the
  // stub's answer is fresh against the original scene again
  const { git } = await import('./fixture.ts')
  git(STORY, 'checkout', 'HEAD', '--', 'prose')
  const { clearGenerated } = await import('../src/ledger.ts')
  clearGenerated(['prose/ch-02/scene-01.md'])

  const run = await post('/api/prose/reroute', { scene: 'sc.02-1', count: 1 })
  assert.equal(run.status, 200)
  const body = await run.json() as { alternatives: { id: string }[]; refused: unknown[] }
  assert.equal(body.alternatives.length, 1)
  assert.equal(generatedFor('prose/ch-02/scene-01.md'), null)

  const list = await (await get('/api/prose/reroute?scene=sc.02-1')).json() as { scene: string; alternatives: { id: string }[]; locks: unknown[] }
  assert.equal(list.scene, 'sc.02-1'); assert.deepEqual(list.alternatives.map(a => a.id), [body.alternatives[0].id]); assert.deepEqual(list.locks, [])

  const adopt = await post('/api/prose/reroute/adopt', { scene: 'sc.02-1', alt: body.alternatives[0].id })
  assert.equal(adopt.status, 200)
  const adopted = await adopt.json() as { file: string; scene: { body: string } }
  assert.equal(adopted.file, 'prose/ch-02/scene-01.md'); assert.match(adopted.scene.body, /forty-one steps/)
  assert.equal(generatedFor('prose/ch-02/scene-01.md')?.entry.origin, 'reroute')

  assert.equal((await post('/api/prose/reroute/drop', { scene: 'sc.02-1', alt: body.alternatives[0].id })).status, 200)
  assert.equal((await post('/api/prose/reroute/drop', { scene: 'sc.02-1', alt: body.alternatives[0].id })).status, 404)
  assert.equal((await post('/api/prose/reroute/drop', { scene: 'sc.02-1', alt: '../../etc' })).status, 404)
})

test('an engine failure is the seed\'s refusal, never the run\'s', async () => {
  process.env.STUB_FAIL = '1'
  try {
    const res = await runReroute({ scene: 'sc.02-1', count: 1 })
    assert.equal(res.alternatives.length, 0)
    assert.equal(res.refused.length, 1)
    assert.match(res.refused[0].reason, /^engine: claude CLI exited 3/)
  } finally { delete process.env.STUB_FAIL }
})
