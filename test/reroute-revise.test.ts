// The rewrite pass (A57): a route revised under the same fence. The engine
// is a stub; under test is everything around it — the registry pins the
// pass withholding, the prompt carries the route and never the manuscript,
// the shared gate refuses what the reroute's gates refuse, the result lands
// as a new VERSION (`revises` names the parent), and pruning keeps chains
// whole.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { git, makeExampleStory } from './fixture.ts'

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
  'The coat now arrives before the count: the note asked for it earlier, and the stairs kept their place.',
  '',
  '```json',
  '{"coverage": [{"item": "The wreck is known before it is seen.", "paragraph": 2}, {"item": "Wren is absent.", "paragraph": 3}]}',
  '```',
].join('\n')

function installStubCli(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-stub-revise-'))
  const bin = path.join(dir, 'claude')
  fs.writeFileSync(bin, `#!/usr/bin/env node
if (process.argv.includes('--version')) { process.stdout.write('stub 1.0\\n'); process.exit(0) }
const chunks = []
process.stdin.on('data', c => chunks.push(c))
process.stdin.on('end', () => {
  const prompt = chunks.join('')
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
// The example scene gains a contract — a rewrite needs a destination too.
const sceneFile = path.join(STORY, 'prose', 'ch-02', 'scene-01.md')
fs.writeFileSync(sceneFile, fs.readFileSync(sceneFile, 'utf8').replace(
  'events: [event.the-wreck]\n---',
  'events: [event.the-wreck]\ncontract:\n  purpose: Let the wreck be known before it is seen.\n  must_establish:\n    - The wreck is known before it is seen.\n    - Wren is absent.\n  must_withhold:\n    - \'"Whitcombe"\'\n---'))
git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'scene contract')
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'claude-cli'
process.env.PATH = `${installStubCli()}${path.delimiter}${process.env.PATH}`

const {
  runReroute, runRevise, listAlternatives, pruneKeepIds, gateAnswer, buildRevisePrompt, flattenPrompt,
  reviseBrief, addRouteNote, deleteRouteNote, clearAlternatives, listRoutes,
} = await import('../src/reroute.ts')
const reroute = await import('../src/reroute.ts')
const { literalWithholds } = await import('../src/redraft.ts')
const { buildCliArgs, assertSessionAllowed } = await import('../src/invocation.ts')

test('the registry pins the rewrite withholding: tools forced off, no session ever', () => {
  const args = buildCliArgs({ pass: 'reroute-revise', noTools: false })
  const at = args.indexOf('--tools')
  assert.ok(at >= 0 && args[at + 1] === '', 'the builder must force --tools "" for the rewrite no matter what the caller says')
  assert.throws(() => assertSessionAllowed('reroute-revise'))
})

test('the revise prompt carries the route and every note — and provably never the manuscript prose', () => {
  const scene = {
    scene: 'sc.x', chapter: 'ch.x', file: 'prose/ch-x/scene-01.md',
    body: 'The manuscript sentence that must never appear.\n\nAnother manuscript paragraph that stays out.',
    contract: { purpose: 'p', must_establish: ['A thing lands.'] },
  } as unknown as import('arc-canon-graph').ProseScene
  const p = buildRevisePrompt({
    scene, pack: 'PACK', style: 'STYLE', destination: ['A thing lands.'],
    knownRoute: 'opens on X, closes on Y', locked: [],
    routeBody: 'The route text to rewrite.',
    notes: [
      { id: 'rnote-1', paragraph: 2, body: 'the dogs arrive as sound first', created_at: '2026-08-31T00:00:00Z' },
      { id: 'rnote-2', paragraph: null, body: 'colder throughout', created_at: '2026-08-31T00:00:00Z' },
    ],
    extra: 'and keep the late entry',
  })
  const flat = flattenPrompt(p)
  assert.doesNotMatch(flat, /manuscript sentence/)
  assert.doesNotMatch(flat, /manuscript paragraph/)
  assert.match(flat, /THE ROUTE AS IT STANDS/)
  assert.match(flat, /The route text to rewrite\./)
  assert.match(flat, /¶2 — the dogs arrive as sound first/)
  assert.match(flat, /\(the route as a whole\) — colder throughout/)
  assert.match(flat, /\(said now\) — and keep the late entry/)
  assert.match(flat, /do not drift toward this ordering/)
})

test('the brief: notes carry their paragraph, a lone typed line stands alone, nothing said is nothing', () => {
  assert.equal(reviseBrief([], 'shorter'), 'shorter')
  assert.equal(reviseBrief([], undefined), '')
  assert.equal(reviseBrief([{ id: 'n', paragraph: 3, body: 'sound first', created_at: '' }], undefined), '¶3 — sound first')
  assert.match(reviseBrief([{ id: 'n', paragraph: null, body: 'colder', created_at: '' }], 'and shorter'), /^\(the route as a whole\) — colder\n\(said now\) — and shorter$/)
})

test('the shared gate refuses on the rewrite exactly as on the reroute: leak, cap, and manuscript reuse', () => {
  const sceneBody = [
    'The zinc counter sweated under his palms while Manuel talked at length about the weather outside.',
    'A photograph lay between the glasses, face down, and neither of them touched it before the light moved.',
    'When the lie finally came it came easily, the way a coin comes out of a pocket in the dark.',
  ].join('\n\n')
  const ctx = {
    sceneName: 'sc.x', sceneBody, sceneLocks: [], lockedTexts: [],
    literals: literalWithholds(['"Trinidad"']), andCap: 3, wordCap: 55, destination: ['A thing lands.'],
  }
  const wrap = (body: string) => `${body}\n\n=== BRIEFING ===\nnotes.`
  const leak = gateAnswer(ctx, wrap('He said Trinidad twice before the door closed on the noise of the street outside.'))
  assert.ok(!leak.ok && /withholds/.test(leak.reason))
  const chains = gateAnswer(ctx, wrap('He ran and fell and rose and ran and fell again before the wall.'))
  assert.ok(!chains.ok && /"and"s/.test(chains.reason))
  const reuse = gateAnswer(ctx, wrap(sceneBody))
  assert.ok(!reuse.ok && /reused/.test(reuse.reason))
  const clean = gateAnswer(ctx, wrap('A different route entirely, told in sentences that borrow nothing from the scene at all.\n\nIt lands the thing, and stops.\n\nNothing else moves in the patch tonight.'))
  assert.ok(clean.ok)
})

test('pruning keeps whole chains: the newest heads count, their ancestors survive, orphans read as heads', () => {
  const mk = (id: string, created_at: string, revises?: string) => ({
    id, scene: 'sc.x', seed: 's', based_on: 'b', created_at, body: 'x', briefing: '', coverage: null, overlap: null,
    ...(revises ? { revises } : {}),
  }) as import('arc-canon-graph/api-types.ts').RouteAlternative
  // newest first, the order listAlternatives returns
  const alts = [
    mk('alt-c', '2026-01-08T00:00:00Z', 'alt-p'),
    mk('alt-h7', '2026-01-07T10:00:00Z'), mk('alt-h6', '2026-01-06T10:00:00Z'),
    mk('alt-h5', '2026-01-05T10:00:00Z'), mk('alt-h4', '2026-01-04T10:00:00Z'),
    mk('alt-h3', '2026-01-03T10:00:00Z'), mk('alt-h2', '2026-01-02T10:00:00Z'),
    mk('alt-p', '2026-01-02T00:00:00Z', undefined), // revised by alt-c: not a head
    mk('alt-old', '2026-01-01T00:00:00Z'),
  ]
  const keep = pruneKeepIds(alts, 6)
  assert.ok(keep.has('alt-c') && keep.has('alt-p'), 'a kept route keeps its whole chain')
  for (const id of ['alt-h7', 'alt-h6', 'alt-h5', 'alt-h4', 'alt-h3']) assert.ok(keep.has(id), id)
  assert.ok(!keep.has('alt-h2') && !keep.has('alt-old'), 'beyond the six newest heads')
  const keep2 = pruneKeepIds([mk('alt-orph', '2026-01-09T00:00:00Z', 'alt-gone')], 6)
  assert.ok(keep2.has('alt-orph'), 'a version whose parent is gone reads as its own head')
})

test('a rewrite lands as a new version: revises names the parent, the note rides as guidance, the seed is inherited', async () => {
  const r0 = await runReroute({ scene: 'sc.02-1', count: 1 })
  assert.equal(r0.alternatives.length, 1, JSON.stringify(r0.refused))
  const parent = r0.alternatives[0]
  const res = await runRevise({ scene: 'sc.02-1', alt: parent.id, note: 'colder, and the coat earlier' })
  assert.equal(res.refused.length, 0, JSON.stringify(res.refused))
  const child = res.alternatives[0]
  assert.equal(child.revises, parent.id)
  assert.equal(child.guidance, 'colder, and the coat earlier')
  assert.equal(child.seed, parent.seed)
  const listed = listAlternatives('sc.02-1')
  assert.deepEqual(new Set(listed.map(a => a.id)), new Set([parent.id, child.id]), 'both versions on disk')
  const onDisk = fs.readFileSync(path.join(STORY, '.arc', 'alternatives', 'sc.02-1', `${child.id}.md`), 'utf8')
  assert.match(onDisk, new RegExp(`revises: ${parent.id}`))
})

test('a rewrite with nothing to say is refused before anything is spent; an unknown route is a 404', async () => {
  await assert.rejects(runRevise({ scene: 'sc.02-1', alt: 'alt-00000000', note: 'x' }),
    (e: unknown) => (e as { status?: number }).status === 404)
  const someAlt = listAlternatives('sc.02-1')[0]
  await assert.rejects(runRevise({ scene: 'sc.02-1', alt: someAlt.id, note: '   ' }),
    (e: unknown) => (e as { status?: number }).status === 400)
})

// ---- the route, on an ephemeral port --------------------------------------
import type { AddressInfo } from 'node:net'
const { createArcServer } = await import('../src/server.ts')
const server = createArcServer()
await new Promise<void>(resolve => server.listen(0, resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
test.after(() => server.close())
const post = (p: string, body: unknown) =>
  fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('the route: an empty note is a 400; a real note lands the next version of the chain', async () => {
  const head = listAlternatives('sc.02-1').find(a => !a.revises)
  assert.ok(head)
  const bad = await post('/api/prose/reroute/revise', { scene: 'sc.02-1', alt: head.id, note: '  ' })
  assert.equal(bad.status, 400)
  const good = await post('/api/prose/reroute/revise', { scene: 'sc.02-1', alt: head.id, note: 'shorter' })
  assert.equal(good.status, 200)
  const body = await good.json() as { alternatives: { revises?: string; guidance?: string }[] }
  assert.equal(body.alternatives[0].revises, head.id)
  assert.equal(body.alternatives[0].guidance, 'shorter')
})

// ---- notes on a route, and the field that clears (A58) --------------------

test('a note lands on a route, round-trips through its file, and can be about a paragraph or the whole route', async () => {
  const r = await runReroute({ scene: 'sc.02-1', count: 1 })
  const alt = r.alternatives[0]
  const withPara = addRouteNote('sc.02-1', alt.id, 'the coat should arrive earlier', 2)
  assert.equal(withPara.notes?.length, 1)
  assert.equal(withPara.notes![0].paragraph, 2)
  assert.match(withPara.notes![0].id, /^rnote-[0-9a-f]{8}$/)
  const withWhole = addRouteNote('sc.02-1', alt.id, 'colder throughout')
  assert.equal(withWhole.notes?.length, 2)
  assert.equal(withWhole.notes![1].paragraph, null)
  // the store is the route's own file: it survives a re-read
  const reread = listAlternatives('sc.02-1').find(a => a.id === alt.id)!
  assert.deepEqual(reread.notes?.map(n => [n.paragraph, n.body]), [[2, 'the coat should arrive earlier'], [null, 'colder throughout']])
  assert.equal(reread.body, alt.body, 'noting a route never touches its prose')
})

test('a note needs something in it, and a paragraph the route actually has', async () => {
  const alt = listAlternatives('sc.02-1')[0]
  assert.throws(() => addRouteNote('sc.02-1', alt.id, '   '), (e: unknown) => (e as { status?: number }).status === 400)
  assert.throws(() => addRouteNote('sc.02-1', alt.id, 'x', 99), (e: unknown) => (e as { status?: number }).status === 400)
  assert.throws(() => addRouteNote('sc.02-1', alt.id, 'x', 0), (e: unknown) => (e as { status?: number }).status === 400)
  assert.throws(() => addRouteNote('sc.02-1', 'alt-00000000', 'x'), (e: unknown) => (e as { status?: number }).status === 404)
})

test('deleting a note leaves the route and its other notes; an unknown note is a 404', () => {
  const alt = listAlternatives('sc.02-1').find(a => (a.notes?.length ?? 0) >= 2)!
  const drop = alt.notes![0].id
  const after = deleteRouteNote('sc.02-1', alt.id, drop)
  assert.equal(after.notes?.length, 1)
  assert.equal(after.notes![0].body, 'colder throughout')
  assert.throws(() => deleteRouteNote('sc.02-1', alt.id, drop), (e: unknown) => (e as { status?: number }).status === 404)
})

test('the notes are the brief: a rewrite with only notes runs, and with nothing said is refused', async () => {
  const parent = listAlternatives('sc.02-1').find(a => (a.notes?.length ?? 0) > 0)!
  const res = await runRevise({ scene: 'sc.02-1', alt: parent.id })
  assert.equal(res.refused.length, 0, JSON.stringify(res.refused))
  assert.equal(res.alternatives[0].revises, parent.id)
  assert.match(res.alternatives[0].guidance ?? '', /colder throughout/)
  // the child starts clean: notes belong to the version they were written on
  assert.equal(res.alternatives[0].notes, undefined)
  const bare = listAlternatives('sc.02-1').find(a => !(a.notes?.length))!
  await assert.rejects(runRevise({ scene: 'sc.02-1', alt: bare.id }),
    (e: unknown) => (e as { status?: number }).status === 400)
})

test('notes belong to their route: another route is untouched, and dropping one takes its notes with it', async () => {
  const r = await runReroute({ scene: 'sc.02-1', count: 2 })
  const [a, b] = r.alternatives.length >= 2 ? r.alternatives : [r.alternatives[0], listAlternatives('sc.02-1')[1]]
  addRouteNote('sc.02-1', a.id, 'only about A')
  const bAfter = listAlternatives('sc.02-1').find(x => x.id === b.id)!
  assert.ok(!(bAfter.notes ?? []).some(n => n.body === 'only about A'), 'a note on one route never appears on another')
  const { dropAlternative } = await import('../src/reroute.ts')
  dropAlternative('sc.02-1', a.id)
  assert.equal(listAlternatives('sc.02-1').find(x => x.id === a.id), undefined, 'the route and its notes go together')
})

test('clearing a field takes one scene only', async () => {
  await runReroute({ scene: 'sc.02-1', count: 1 })
  const before = listAlternatives('sc.02-1').length
  assert.ok(before > 0)
  assert.equal(clearAlternatives('sc.99-9'), 0, 'a scene with no field clears nothing and does not throw')
  assert.equal(clearAlternatives('sc.02-1'), before)
  assert.deepEqual(listAlternatives('sc.02-1'), [])
  assert.deepEqual(listRoutes('sc.02-1').alternatives, [])
})

test('accepting a scene clears its field: the adopted route became the book, the routes it beat go with it', async () => {
  const { adoptAlternative } = await import('../src/reroute.ts')
  const r = await runReroute({ scene: 'sc.02-1', count: 2 })
  assert.ok(r.alternatives.length >= 1, JSON.stringify(r.refused))
  assert.ok(listAlternatives('sc.02-1').length >= 1)
  adoptAlternative('sc.02-1', r.alternatives[0].id)
  const res = await post('/api/prose/accept', { message: 'accept the route' })
  assert.equal(res.status, 200, await res.text())
  assert.deepEqual(listAlternatives('sc.02-1'), [], 'the field is clear once the scene is accepted')
})

test('only the newest version of a route takes notes — an earlier one refuses', () => {
  const { writeAlternative } = reroute
  const base = { scene: 'sc.02-1', seed: 'late-entry', based_on: 'b', briefing: '', coverage: null, overlap: 0 }
  writeAlternative({ ...base, id: 'alt-aaaa1111', created_at: '2026-08-31T00:00:00Z', body: 'Parent version.' } as never)
  // noted while it is still the newest version — this is allowed
  addRouteNote('sc.02-1', 'alt-aaaa1111', 'written while it was newest', 1)
  // the rewrite lands: the parent becomes an earlier version
  writeAlternative({ ...base, id: 'alt-bbbb2222', created_at: '2026-08-31T01:00:00Z', body: 'Child version.', revises: 'alt-aaaa1111' } as never)
  // the parent is now an earlier version: it keeps what it has, takes no more
  assert.throws(() => addRouteNote('sc.02-1', 'alt-aaaa1111', 'too late'), (e: unknown) => (e as { status?: number }).status === 409)
  const kept = listAlternatives('sc.02-1').find(a => a.id === 'alt-aaaa1111')!
  assert.equal(kept.notes?.length, 1, 'the notes already written on it stand')
  // the newest version takes them
  assert.equal(addRouteNote('sc.02-1', 'alt-bbbb2222', 'closer, but colder').notes?.length, 1)
  clearAlternatives('sc.02-1')
})

test('a route the author has written on is never pruned away, however old it is', async () => {
  const mk = (id: string, created_at: string, notes?: { id: string; paragraph: number | null; body: string; created_at: string }[]) => ({
    id, scene: 'sc.x', seed: 's', based_on: 'b', created_at, body: 'x', briefing: '', coverage: null, overlap: null,
    ...(notes ? { notes } : {}),
  }) as import('arc-canon-graph/api-types.ts').RouteAlternative
  const noted = mk('alt-old', '2026-01-01T00:00:00Z', [{ id: 'rnote-1', paragraph: 1, body: 'keep this one', created_at: '' }])
  const alts = [
    mk('alt-h7', '2026-01-07T00:00:00Z'), mk('alt-h6', '2026-01-06T00:00:00Z'), mk('alt-h5', '2026-01-05T00:00:00Z'),
    mk('alt-h4', '2026-01-04T00:00:00Z'), mk('alt-h3', '2026-01-03T00:00:00Z'), mk('alt-h2', '2026-01-02T00:00:00Z'),
    noted,
  ]
  const keep = pruneKeepIds(alts, 6)
  assert.ok(keep.has('alt-old'), "the author's own words are not disposable")
  const unnoted = pruneKeepIds([...alts.slice(0, 6), mk('alt-plain', '2026-01-01T00:00:00Z')], 6)
  assert.ok(!unnoted.has('alt-plain'), 'an un-noted old route still prunes')
})

test('route counts: one read for the whole story, counting routes not versions', async () => {
  const { routeCounts, writeAlternative } = reroute
  clearAlternatives('sc.02-1')
  assert.equal(routeCounts()['sc.02-1'], undefined, 'a scene with no field is absent, not zero')
  const base = { scene: 'sc.02-1', seed: 'late-entry', based_on: 'b', briefing: '', coverage: null, overlap: 0 }
  writeAlternative({ ...base, id: 'alt-cccc1111', created_at: '2026-09-02T00:00:00Z', body: 'One.' } as never)
  writeAlternative({ ...base, id: 'alt-dddd2222', created_at: '2026-09-02T01:00:00Z', body: 'Two.' } as never)
  assert.equal(routeCounts()['sc.02-1'], 2)
  // a rewrite is a new VERSION of a route, not a second route waiting
  writeAlternative({ ...base, id: 'alt-eeee3333', created_at: '2026-09-02T02:00:00Z', body: 'Two, again.', revises: 'alt-dddd2222' } as never)
  assert.equal(routeCounts()['sc.02-1'], 2, 'three files, still two routes')
  clearAlternatives('sc.02-1')
  assert.equal(routeCounts()['sc.02-1'], undefined)
})

test('a scene holds four ways through, and the author clears the field', async () => {
  const { MAX_ROUTES, routesWaiting, writeAlternative } = reroute
  clearAlternatives('sc.02-1')
  const base = { scene: 'sc.02-1', seed: 'late-entry', based_on: 'b', briefing: '', coverage: null, overlap: 0 }
  const put = (id: string, at: string, revises?: string) =>
    writeAlternative({ ...base, id, created_at: at, body: `Body ${id}.`, ...(revises ? { revises } : {}) } as never)
  for (let i = 0; i < MAX_ROUTES; i++) put(`alt-ffff000${i}`, `2026-09-0${i + 1}T00:00:00Z`)
  assert.equal(routesWaiting('sc.02-1'), MAX_ROUTES)
  // at the cap the pass is refused before a token is spent
  await assert.rejects(runReroute({ scene: 'sc.02-1', count: 2 }),
    (e: unknown) => (e as { status?: number }).status === 409 && /cancel one/.test((e as Error).message))
  // a version is not a way through: rewriting never consumes room
  put('alt-ffffaaaa', '2026-09-09T00:00:00Z', 'alt-ffff0000')
  assert.equal(routesWaiting('sc.02-1'), MAX_ROUTES, 'a rewrite replaces its route, it does not add one')
  // cancelling makes room, and a run for two with room for one returns one
  const { dropAlternative } = reroute
  dropAlternative('sc.02-1', 'alt-ffff0001')
  dropAlternative('sc.02-1', 'alt-ffff0002')
  dropAlternative('sc.02-1', 'alt-ffff0003')
  assert.equal(routesWaiting('sc.02-1'), 1)
  const res = await runReroute({ scene: 'sc.02-1', count: 2 })
  assert.ok(res.alternatives.length + res.refused.length <= MAX_ROUTES - 1)
  assert.ok(routesWaiting('sc.02-1') <= MAX_ROUTES, 'a run never takes a scene past the cap')
  clearAlternatives('sc.02-1')
})
