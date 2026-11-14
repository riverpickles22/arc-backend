// The review episode (A74-3): one trigger for U7 and U12, keyed and
// idempotent, derived from the record. The model is a STUB `claude` — no key,
// no subscription; what is under test is everything around it: when a read
// starts, that it starts after the response, that one key reads once, that a
// failure is listed and the hand completes it, that two scenes with pending
// changes are open and not due, the idle rule on a fake clock, and that
// deleting .arc/episodes.json forgets nothing but the idle clock.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { load as yamlLoad } from 'js-yaml'
import { installStubCli, makeExampleStory, git } from './fixture.ts'

const STORY = makeExampleStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'claude-cli'
const LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arc-episodes-log-')), 'reads.log')
process.env.STUB_LOG = LOG

const A = 'prose/ch-01/scene-01.md'
const B = 'prose/ch-02/scene-01.md'
const DEFAULT = [{ class: 'stated', subject: 'new', type: 'object', field: 'name', value: 'The barometer', evidence: ['¶5'], note: 'The glass beside the log.' }]

process.env.PATH = `${installStubCli({
  name: 'episodes',
  before: `
    if (process.env.STUB_FAIL === '1') { process.stderr.write('stub refused'); process.exit(3) }
    const isU7 = prompt.includes('=== THE ACCEPTED CHANGE')
    if (!isU7 && process.env.STUB_FAIL_LEARN === '1') { process.stderr.write('stub refused the learner'); process.exit(3) }
    require('node:fs').appendFileSync(process.env.STUB_LOG, (isU7 ? 'u7' : 'learn:' + (prompt.match(/--- EDIT /g) || []).length) + '\\n')`,
  answer: `process.env.STUB_ANSWER ?? ${JSON.stringify('```json\n' + JSON.stringify(DEFAULT) + '\n```')}`,
})}${path.delimiter}${process.env.PATH}`

const { createArcServer } = await import('../src/server.ts')
const { readSceneByHand } = await import('../src/episodes.ts')
const { unreadEpisodes, dueEpisodes, openEpisode, startDueEpisodes, episodesSettled, EPISODE_IDLE_MS, listEpisodes } = await import('../src/episodes.ts')
const { ROW_UPDATE_RECORD_SCENE } = await import('../src/registry.ts')
const { proseScenes } = await import('../src/story.ts')
const { baseOf } = await import('../src/base.ts')
const { runUpdateRecord } = await import('../src/update-record.ts')
const { receiptsOf } = await import('../src/run.ts')

const server = createArcServer()
await new Promise<void>(resolve => server.listen(0, resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
test.after(() => server.close())
const post = (p: string, body: unknown) =>
  fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const get = async <T>(p: string): Promise<T> => (await fetch(base + p)).json() as Promise<T>

/** the server answered; give the after-response start a moment to be queued, then wait it out */
const settle = async (): Promise<void> => { await new Promise(r => setTimeout(r, 80)); await episodesSettled() }
const reads = (): number => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(l => l === 'u7').length : 0)
const edit = (file: string, from: string, to: string): void => {
  const abs = path.join(STORY, file)
  fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace(from, to))
}
const head = (): string => git(STORY, 'rev-parse', 'HEAD').trim()
const sceneOf = (file: string): string => proseScenes().find(s => s.file === file)!.scene
const landed = () => receiptsOf('update-record').filter(r => r.ending === 'landed')
const historyReads = () => (fs.existsSync(path.join(STORY, 'history')) ? fs.readdirSync(path.join(STORY, 'history')) : []).filter(f => f.endsWith('.yaml'))
  .map(f => yamlLoad(fs.readFileSync(path.join(STORY, 'history', f), 'utf8')) as { cell?: { job: string }; result: { range?: { from: string; to: string } | null } })
  .filter(r => r.cell?.job === 'update-record')

const learnedKeys = (): string[] => receiptsOf('learn').filter(r => r.ending === 'landed' && r.key).map(r => r.key!)
const learns = (): number[] => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(l => l.startsWith('learn:')).map(l => Number(l.slice(6))) : [])

test('the interval is declared once, on the row', () => {
  assert.equal(ROW_UPDATE_RECORD_SCENE.episode?.idleMs, 10 * 60 * 1000)
  assert.equal(EPISODE_IDLE_MS, ROW_UPDATE_RECORD_SCENE.episode!.idleMs)
})

const rewrite = (file: string, n: number, words: string): void => {
  const abs = path.join(STORY, file)
  const m = /^(---\n[\s\S]*?\n---\n\n?)([\s\S]*)$/.exec(fs.readFileSync(abs, 'utf8'))!
  const paras = m[2].trimEnd().split('\n\n')
  paras[n] = words
  fs.writeFileSync(abs, m[1] + paras.join('\n\n') + '\n')
}
const paragraphOf = (file: string, n: number): string => {
  const m = /^(---\n[\s\S]*?\n---\n\n?)([\s\S]*)$/.exec(fs.readFileSync(path.join(STORY, file), 'utf8'))!
  return m[2].trimEnd().split('\n\n')[n]
}
const acceptOffline = async (file: string): Promise<void> => {
  process.env.ARC_DRAFT_ENGINE = 'none'   // an accept that starts nothing
  try { assert.equal((await post('/api/prose/accept', { files: [file], bases: { [file]: baseOf(file) } })).status, 200) } finally { process.env.ARC_DRAFT_ENGINE = 'claude-cli' }
}

test('old untrailered prose commits show nothing unread; one new accept shows one; the read is committed when it lands', async () => {
  assert.deepEqual(unreadEpisodes(), [], 'the example\'s commit carries no Arc-Lane trailer: not an accept arc was asked to read')
  edit(B, 'because counting', 'because plain counting')
  await acceptOffline(B)
  assert.deepEqual(unreadEpisodes().map(u => [u.scene, u.count, u.state]), [[sceneOf(B), 1, 'due']])
  process.env.STUB_ANSWER = '```json\n[]\n```'
  try {
    const res = await readSceneByHand(sceneOf(B))
    assert.ok(res.run)
    assert.deepEqual(unreadEpisodes(), [])
    assert.equal(git(STORY, 'status', '--porcelain', '--', 'history').trim(), '', 'nothing in history/ is left untracked or dirty')
    assert.match(git(STORY, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'history'), new RegExp(`history/${res.run}\\.yaml`), 'the receipt is at HEAD')
  } finally { delete process.env.STUB_ANSWER }
  fs.rmSync(LOG, { force: true })   // the tests below count reads from here
})

test('two accepts, then the scene fully decided: one U7 and one U12 read, started AFTER the accept response, spanning both commits', async () => {
  const h0 = historyReads().length, l0 = learnedKeys().length
  edit(A, 'Then the log.', 'Then the log, and the barometer beside it.')
  edit(A, 'The wind did what it did.', 'The wind did what it did, and rattled the storm lantern.')
  const first = await post('/api/prose/accept-paragraph', { file: A, side: 'draft', paragraph: 4, base: baseOf(A) })
  assert.equal(first.status, 200, await first.clone().text())
  const afterFirst = head()
  await settle()
  assert.equal(reads(), 0, 'the scene still has a change pending: not due, not read')
  assert.deepEqual(unreadEpisodes(), [], 'and not listed either — arc has not failed to do anything')
  assert.ok(openEpisode(proseScenes().find(s => s.file === A)!), 'but the episode is open')

  const second = await post('/api/prose/accept-paragraph', { file: A, side: 'draft', paragraph: 6, base: baseOf(A) })
  assert.equal(second.status, 200, await second.clone().text())
  const afterSecond = head()
  // the response is back; the read is a thing that happens now, not a thing the accept waited on
  await settle()
  assert.equal(reads(), 1, 'exactly one U7 read')
  const spans = historyReads().filter(r => r.result.range!.to === afterSecond)
  assert.equal(spans.length, 1, 'one record receipt names that range, in history/')
  assert.equal(historyReads().length, h0 + 1)
  assert.equal(spans[0].result.range!.to, afterSecond)
  assert.equal(git(STORY, 'rev-parse', `${afterFirst}^`).trim(), spans[0].result.range!.from, 'from the first accept\'s parent')
  assert.equal(learnedKeys().length, l0 + 1, 'and one U12 read')
  assert.deepEqual(unreadEpisodes(), [])
  assert.ok(fs.existsSync(path.join(STORY, 'canon/entities/objects/the-barometer.yaml')), 'what it proposed is waiting')
})

test('the same key again: no run, no second receipt, and the reply says so', async () => {
  const before = [reads(), historyReads().length, landed().length]
  const res = await post('/api/record/update', { scene: sceneOf(A) })
  assert.equal(res.status, 200)
  const body = await res.json() as { nothingNew?: boolean; proposed: number; reply: string }
  assert.equal(body.nothingNew, true)
  assert.equal(body.proposed, 0)
  assert.match(body.reply, /already read/)
  await settle()
  assert.deepEqual([reads(), historyReads().length, landed().length], before)
})

test('a stub that exits 1: the read ends failed and is listed; the hand completes it; nothing is filed twice', async () => {
  process.env.STUB_ANSWER = '```json\n' + JSON.stringify([
    { class: 'stated', subject: 'new', type: 'object', field: 'name', value: 'The aurelia\'s bell', evidence: ['¶1'], note: 'It rang below the light.' },
  ]) + '\n```'
  process.env.STUB_FAIL = '1'
  try {
    edit(B, 'The light held.', 'The light held, and the bell below it rang.')
    const res = await post('/api/prose/accept', { files: [B], bases: { [B]: baseOf(B) } })
    assert.equal(res.status, 200)
    await settle()
    const scene = sceneOf(B)
    const failedRun = receiptsOf('update-record').find(r => r.request?.subject === scene && r.result.range?.to === head())!
    assert.ok(failedRun.ending && failedRun.ending !== 'landed', `ended ${failedRun.ending}`)
    assert.equal(failedRun.result.range!.to, head(), 'the failed receipt still says what it tried to read')
    const listed = unreadEpisodes()
    assert.deepEqual(listed.map(u => [u.scene, u.count, u.state]), [[scene, 1, 'failed']])
    assert.match(listed[0].title, /^scene \d+ of /, 'the title is the author\'s, never an id')
    assert.deepEqual((await get<{ unread: unknown[] }>('/api/briefing')).unread, listed, 'the briefing lists it')
    // a failed read is listed, not silently retried by the next lane commit
    const n = reads()
    edit(A, 'Then the log, and', 'Then the log, with')
    await post('/api/prose/accept', { files: [A], bases: { [A]: baseOf(A) } })
    await settle()
    assert.equal(reads(), n)
    assert.equal(unreadEpisodes().find(u => u.scene === scene)?.state, 'failed')
  } finally { delete process.env.STUB_FAIL }
  const res = await post('/api/record/update', { scene: sceneOf(B) })
  const body = await res.json() as { proposed: number; nothingNew?: boolean }
  assert.equal(res.status, 200)
  assert.equal(body.proposed, 1)
  assert.ok(!unreadEpisodes().some(u => u.scene === sceneOf(B)), 'the line is gone')
  const bell = fs.readdirSync(path.join(STORY, 'canon/entities/objects')).filter(f => f.includes('bell'))
  assert.equal(bell.length, 1, 'filed once')
  delete process.env.STUB_ANSWER
  // the accept to A in the middle failed on its own account too, and is listed the same way
  assert.deepEqual(unreadEpisodes().map(u => [u.scene, u.state]), [[sceneOf(A), 'failed']])
  assert.equal((await post('/api/record/update', { scene: sceneOf(A) })).status, 200)
  assert.deepEqual(unreadEpisodes(), [])
})

test('an accept on scene A then on scene B, with pending changes left in both: two open episodes, neither due', async () => {
  const sa = proseScenes().find(s => s.file === A)!, sb = proseScenes().find(s => s.file === B)!
  const n = reads()
  // A: two paragraphs changed, one accepted. B: its first paragraph changed and a new one added, the first accepted.
  edit(A, 'Then the log, with', 'Then the log; with')
  edit(A, 'rattled the storm lantern.', 'rattled the storm lantern twice.')
  edit(B, 'The light held, and', 'The light held; and')
  fs.appendFileSync(path.join(STORY, B), '\nThe second paragraph is still the author\'s to decide.\n')
  for (const [file, paragraph] of [[A, 4], [B, 0]] as const) {
    const res = await post('/api/prose/accept-paragraph', { file, side: 'draft', paragraph, base: baseOf(file) })
    assert.equal(res.status, 200, await res.clone().text())
  }
  await settle()
  assert.ok(openEpisode(sa) && openEpisode(sb), 'two open episodes')
  assert.deepEqual(dueEpisodes(), [], 'neither due')
  assert.equal(reads(), n, 'and nothing read')
  assert.deepEqual(unreadEpisodes(), [])
})

test('the idle rule, on a fake clock: ten minutes with no decision makes them due; listing launches nothing', async () => {
  const t0 = Date.now()
  assert.deepEqual(dueEpisodes(t0 + EPISODE_IDLE_MS - 5_000), [])
  assert.deepEqual(dueEpisodes(t0 + EPISODE_IDLE_MS + 60_000).sort(), [sceneOf(A), sceneOf(B)].sort())
  const n = reads()
  await get('/api/attention'); await get('/api/briefing')
  await settle()
  assert.equal(reads(), n, 'a GET only lists')
  // started on its own at the next lane commit — here, called as the commit's listener would: one after the other
  await startDueEpisodes(t0 + EPISODE_IDLE_MS + 60_000)
  await episodesSettled()
  assert.equal(reads(), n + 1, 'one per lane commit, never a fan-out')
  await startDueEpisodes(t0 + EPISODE_IDLE_MS + 60_000)
  await episodesSettled()
  assert.equal(reads(), n + 2, 'the next commit starts the other')
  assert.deepEqual(dueEpisodes(t0 + EPISODE_IDLE_MS + 60_000), [])
})

test('delete .arc/episodes.json: the unread accepts are still known, from the record', async () => {
  process.env.ARC_DRAFT_ENGINE = 'none'   // accepts here start nothing
  try {
    git(STORY, 'checkout', 'HEAD', '--', '.')   // the author put the pending lines away
    edit(B, 'The light held; and', 'The light held, and')
    assert.equal((await post('/api/prose/accept', { files: [B], bases: { [B]: baseOf(B) } })).status, 200)
    const scene = sceneOf(B)
    const want = [{ scene, title: unreadEpisodes()[0].title, count: 1, state: 'due' }]
    assert.deepEqual(unreadEpisodes(), want)
    fs.rmSync(path.join(STORY, '.arc/episodes.json'))
    assert.deepEqual(unreadEpisodes(), want, 'rebuilt from git and the receipts')
    assert.deepEqual((await get<{ unread: unknown[] }>('/api/attention')).unread, want)
  } finally { process.env.ARC_DRAFT_ENGINE = 'claude-cli' }
})

test('two runs with one key never both file: the key is checked inside the lane', async () => {
  process.env.STUB_ANSWER = '```json\n' + JSON.stringify([
    { class: 'stated', subject: 'new', type: 'object', field: 'name', value: 'The thrice bell', evidence: ['¶1'], note: 'It rang a third time.' },
  ]) + '\n```'
  try {
    const sc = sceneOf(B)
    const open = openEpisode(proseScenes().find(s => s.scene === sc)!)!
    const [x, y] = await Promise.all([
      runUpdateRecord(sc, open.range.from, open.range.to),
      runUpdateRecord(sc, open.range.from, open.range.to),
    ])
    assert.deepEqual([x.proposed, y.proposed].sort(), [0, 1], 'one filed, one did not')
    assert.ok([x, y].some(r => r.nothingNew))
    assert.equal(fs.readdirSync(path.join(STORY, 'canon/entities/objects')).filter(f => f.includes('thrice')).length, 1)
    assert.equal(listEpisodes().length, 0)
  } finally { delete process.env.STUB_ANSWER }
})

test('an older server\'s accept is listed, never run on its own: only an episode holding a commit this process saw starts', async () => {
  // a lane accept made by an EARLIER server process: marked, so it is unread, but not this process's to start
  git(STORY, 'checkout', 'HEAD', '--', '.')
  const sa = sceneOf(A)
  edit(A, 'Then the log; with', 'Then the log: with')
  git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'prose: made by an earlier server', '-m', 'Arc-Lane: accept')
  const old = head()
  const n = reads()
  assert.ok(unreadEpisodes().some(u => u.scene === sa && u.state === 'due'), 'listed as due')
  // an unrelated lane commit on another scene
  edit(B, 'The light held, and', 'The light held; and')
  fs.appendFileSync(path.join(STORY, B), '\nStill the author\'s to decide.\n')
  assert.equal((await post('/api/prose/accept-paragraph', { file: B, side: 'draft', paragraph: 0, base: baseOf(B) })).status, 200)
  await settle()
  assert.equal(reads(), n, 'nothing started: the old episode holds no commit of this process')
  assert.ok(unreadEpisodes().some(u => u.scene === sa && u.state === 'due'), 'and it is still listed')
  git(STORY, 'checkout', 'HEAD', '--', '.')
  // a new accept on that scene IN this process: its episode starts, and its range reaches back over the older commit
  edit(A, 'Then the log: with', 'Then the log, once more with')
  assert.equal((await post('/api/prose/accept', { files: [A], bases: { [A]: baseOf(A) } })).status, 200)
  const accepted = head()
  await settle()
  assert.ok(reads() > n, 'started')
  const mine = historyReads().find(r => r.result.range!.to === accepted)!
  assert.equal(git(STORY, 'rev-parse', `${old}^`).trim(), mine.result.range!.from, 'the older commit is inside the range')
})

test('a run that throws after its receipt is keyed ends, is listed failed, and no later commit relaunches it', async () => {
  edit(B, 'because plain counting', 'because slow counting')
  await acceptOffline(B)
  const accepted = head()
  const n = reads()
  const lock = path.join(STORY, '.git/index.lock')
  fs.writeFileSync(lock, '')   // something outside arc holds the index: the lane refuses to file
  try { await assert.rejects(readSceneByHand(sceneOf(B))) } finally { fs.rmSync(lock, { force: true }) }
  assert.equal(reads(), n + 1, 'the model was asked once')
  const failed = receiptsOf('update-record').filter(r => r.request?.subject === sceneOf(B) && r.ending === 'could not run' && r.result.range?.to === accepted)
  assert.equal(failed.length, 1, 'and the run ended')
  assert.deepEqual(unreadEpisodes().map(u => [u.scene, u.state]), [[sceneOf(B), 'failed']])
  // an unrelated lane commit (A has a change left pending, so it is not due either)
  rewrite(A, 4, paragraphOf(A, 4) + ' Another word here.')
  rewrite(A, 6, paragraphOf(A, 6) + ' And more words here.')
  assert.equal((await post('/api/prose/accept-paragraph', { file: A, side: 'draft', paragraph: 4, base: baseOf(A) })).status, 200)
  await settle()
  assert.equal(reads(), n + 1, 'not relaunched')
  assert.equal(unreadEpisodes().find(u => u.scene === sceneOf(B))?.state, 'failed')
  // finish A's pending so later tests start clean, then the hand completes B
  git(STORY, 'checkout', 'HEAD', '--', '.')
  assert.equal((await post('/api/record/update', { scene: sceneOf(B) })).status, 200)
  assert.ok(!unreadEpisodes().some(u => u.scene === sceneOf(B)))
})

test('a keyed receipt with no ending and no read in flight is failed, not forever running or relaunched', async () => {
  edit(B, 'because slow counting', 'because patient counting')
  await acceptOffline(B)
  const ep = openEpisode(proseScenes().find(s => s.file === B)!)!
  const dir = path.join(STORY, '.arc/runs/run.9001')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'receipt.yaml'), `run_id: run.9001\ncell:\n  job: update-record\nrequest:\n  subject: ${sceneOf(B)}\nkey: ${ep.key}\nresult:\n  records: []\n  commit: null\n  range: { from: ${ep.range.from}, to: ${ep.range.to} }\n`)
  assert.deepEqual(unreadEpisodes().map(u => [u.scene, u.state]), [[sceneOf(B), 'failed']])
  assert.equal((await post('/api/record/update', { scene: sceneOf(B) })).status, 200)
  assert.deepEqual(unreadEpisodes(), [])
})

test('the learner starts from the episode\'s own start: two accepts\' edits both reach it', async () => {
  const sc = sceneOf(A)
  const before = learns().length
  rewrite(A, 4, paragraphOf(A, 4) + ' Plainly said, with four words.')
  rewrite(A, 6, paragraphOf(A, 6) + ' Slowly now, with four words.')
  assert.equal((await post('/api/prose/accept-paragraph', { file: A, side: 'draft', paragraph: 4, base: baseOf(A) })).status, 200)
  assert.equal((await post('/api/prose/accept-paragraph', { file: A, side: 'draft', paragraph: 6, base: baseOf(A) })).status, 200)
  await settle()
  assert.equal(learns().length, before + 1, 'one learner read')
  assert.equal(learns().at(-1), 2, 'with both accepts\' edits in front of it')
  assert.ok(!unreadEpisodes().some(u => u.scene === sc))
})

test('a learner that throws is listed failed with the same line; no later commit retries it; the hand completes it', async () => {
  const sc = sceneOf(A)
  const before = learns().length
  process.env.STUB_FAIL_LEARN = '1'
  try {
    rewrite(A, 4, paragraphOf(A, 4) + ' Quietly, with four words.')
    assert.equal((await post('/api/prose/accept', { files: [A], bases: { [A]: baseOf(A) } })).status, 200)
    await settle()
    assert.deepEqual(unreadEpisodes().map(u => [u.scene, u.count, u.state]), [[sc, 1, 'failed']])
    assert.deepEqual((await get<{ unread: unknown[] }>('/api/attention')).unread, unreadEpisodes())
    // the failed read names its run, so the drawer can open it (A74-6 for A74-5)
    const failedRun = receiptsOf('learn').find(r => r.key && r.ending && r.ending !== 'landed' && r.request?.subject === sc)
    assert.ok(failedRun, 'the learner left a keyed receipt that did not land')
    assert.equal(unreadEpisodes()[0].run, failedRun!.run_id, 'and the listing carries its run id')
    // an unrelated commit does not retry it
    rewrite(B, 0, paragraphOf(B, 0) + ' Else, with four words.')
    await acceptOffline(B)
    await settle()
    assert.equal(learns().length, before, 'the learner was not run again')
  } finally { delete process.env.STUB_FAIL_LEARN }
  assert.equal((await post('/api/record/update', { scene: sc })).status, 200)
  assert.ok(learns().length > before, 'the hand ran it')
  assert.ok(!unreadEpisodes().some(u => u.scene === sc && u.state === 'failed'))
})
