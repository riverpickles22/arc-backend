// THE REVIEW EPISODE (A74-3): one trigger for the two jobs that learn from
// what the author accepted — U7, which reads it against the record, and U12,
// which reads it against the style contract.
//
// An EPISODE is a scene's accepts since arc last read the scene: the lane
// commits that touched its prose file after the last LANDED U7 receipt's
// range. It is derived from the record — git's log and the receipts in
// history/ — and never held in a file of its own. `.arc/episodes.json` caches
// two things only, the time of the author's last decision on a scene (the
// idle clock) and the keys of reads in flight; delete it and every unread
// episode is still known.
//
// WHEN ONE RUNS (epic D2). There is no timer, thread or queue here. A due
// episode starts (a) after a lane commit has released the lane and the
// response of the request that made it has gone, and (b) when the author asks
// for it by hand. One at a time, in a module-level chain. Listing — the
// briefing, the attention list — never starts one: the viewer polls, and a
// launching GET would be a scheduler by the back door. A FAILED read is
// listed, never silently retried; only the hand runs it again.
//
// WHEN ONE IS DUE (epic D1). When the scene has no pending change left, or
// when the row's idle interval has passed since the author's last decision on
// it. The interval is declared once, on the row (`episode.idleMs`).
//
// THE REGISTERS. That so many commits touched a scene and arc has no landed
// receipt for them is proven. Nothing here judges anything.
import fs from 'node:fs'
import path from 'node:path'
import type { UnreadEpisode, UpdateRecordResponse } from 'arc-canon-graph'
import { STORY } from './config'
import { currentEngine } from './engine'
import { sceneLabel } from './decide-proposals'
import { git, onLaneCommit } from './lane'
import { runLearnStyle } from './learn-style'
import { ROW_UPDATE_RECORD_SCENE } from './registry'
import { receiptsOf, readWorkingReceipt } from './run'
import { acceptedDiff, bodyAt, EMPTY_TREE, runUpdateRecord } from './update-record'
import { runKey } from './rowrun'
import { proseDraft, proseScenes } from './story'
import type { ProseScene } from 'arc-canon-graph'

/** The idle interval, read from the row that declares it. */
export const EPISODE_IDLE_MS = ROW_UPDATE_RECORD_SCENE.episode!.idleMs

// ---- the cache ------------------------------------------------------------------

interface Cache {
  /** scene → when the author last decided something about it (ms) */
  lastDecisionAt: Record<string, number>
  /** key → the read in flight, and the process running it */
  inFlight: Record<string, { scene: string; pid: number; at: number }>
}

const cachePath = (): string => path.join(STORY, '.arc', 'episodes.json')

function readCache(): Cache {
  try {
    const c = JSON.parse(fs.readFileSync(cachePath(), 'utf8')) as Partial<Cache>
    return { lastDecisionAt: c.lastDecisionAt ?? {}, inFlight: c.inFlight ?? {} }
  } catch { return { lastDecisionAt: {}, inFlight: {} } }
}

function writeCache(c: Cache): void {
  try {
    fs.mkdirSync(path.dirname(cachePath()), { recursive: true })
    fs.writeFileSync(cachePath(), JSON.stringify(c, null, 1))
  } catch (e) { console.error('[episodes] could not write the cache (it is only a cache):', e) }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** The author decided something about a scene at `at`. Called by the lane's
 *  commit announcement, so every accept, adopt and put-back counts without
 *  each route having to say so. */
export function noteDecision(scene: string, at = Date.now()): void {
  const c = readCache()
  c.lastDecisionAt[scene] = at
  writeCache(c)
}

/** THE AUTO-START HORIZON: the commits this server process has seen the lane
 *  make, in memory and nowhere else. Triggered work is work the author's own
 *  gesture just caused — never a burst over history — so an episode starts on
 *  its own only when it contains one of these. The rest are listed, and the
 *  hand reads them. */
const ownCommits = new Set<string>()

/** At most this many episodes start per lane commit, so a single decision
 *  never fans out into many reads. */
export const MAX_STARTS_PER_COMMIT = 1

onLaneCommit((paths, hashes) => {
  for (const h of hashes) ownCommits.add(h)
  const prose = paths.filter(p => /(^|\/)prose\//.test(p))
  if (!prose.length) return
  let prefix = ''
  try { prefix = git('rev-parse', '--show-prefix').trim() } catch { /* not a repository */ }
  const files = new Set(prose.map(p => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p)))
  for (const s of proseScenes()) if (files.has(s.file)) noteDecision(s.scene)
})

// ---- deriving an episode from the record ----------------------------------------------

export interface Episode {
  scene: string
  file: string
  /** the lane commits arc has not read, oldest first */
  commits: string[]
  /** from the first commit's parent to the last commit */
  range: { from: string; to: string }
  /** this reading's U7 key */
  key: string
  /** the combined diff, rendered — what the keys fingerprint */
  diff: string
  /** when the newest of the commits was made (ms) */
  lastCommitAt: number
}

const isCommit = (rev: string): boolean => {
  try { git('cat-file', '-e', `${rev}^{commit}`); return true } catch { return false }
}
const isAncestor = (a: string, b: string): boolean => {
  try { git('merge-base', '--is-ancestor', a, b); return true } catch { return false }
}

/** The end of the last range arc LANDED a read of this scene over: from the
 *  receipts, the newest by the book's own order. */
export function lastRead(scene: string, receipts = receiptsOf('update-record')): { from: string; to: string } | null {
  let best: { from: string; to: string } | null = null
  for (const r of receipts) {
    const range = r.result?.range
    if (r.request?.subject !== scene || r.ending !== 'landed' || !range?.to || !isCommit(range.to)) continue
    if (!best || isAncestor(best.to, range.to)) best = range
  }
  return best
}

/** Every prose commit THE LANE MADE AS AN ACCEPT (it says so in a trailer),
 *  newest first, by file — one walk of the log for the whole book, because
 *  the attention list asks on every poll. Commits without the trailer —
 *  imports, hand commits, history from before it existed — are not accepts
 *  arc was ever asked to read. */
function proseCommits(): Map<string, { hash: string; at: number }[]> {
  const out = new Map<string, { hash: string; at: number }[]>()
  let prefix = ''
  let text = ''
  try {
    prefix = git('rev-parse', '--show-prefix').trim()
    text = git('-c', 'core.quotepath=false', 'log', '--grep=^Arc-Lane: accept$', '--format=%x00%H %ct', '--name-only', '--', 'prose')
  } catch { return out }
  for (const block of text.split('\0').slice(1)) {
    const [head, ...files] = block.split('\n')
    const [hash, ct] = head.trim().split(' ')
    for (const f of files.filter(Boolean)) {
      const file = prefix && f.startsWith(prefix) ? f.slice(prefix.length) : f
      let list = out.get(file)
      if (!list) out.set(file, list = [])
      list.push({ hash, at: Number(ct) * 1000 })
    }
  }
  return out
}

function describe(s: ProseScene, commits: { hash: string; at: number }[]): Episode | null {
  if (!commits.length) return null
  const oldest = commits[commits.length - 1]
  let from: string
  try { from = git('rev-parse', '--verify', `${oldest.hash}^`).trim() } catch { from = EMPTY_TREE }
  const range = { from, to: commits[0].hash }
  const after = bodyAt(range.to, s.file)
  if (after === null) return null                                  // the scene is gone
  const diff = acceptedDiff(bodyAt(range.from, s.file), after)
  if (!diff.citable.size) return null                              // the accepts left the words as they were
  return {
    scene: s.scene, file: s.file, commits: commits.map(c => c.hash).reverse(), range,
    key: runKey('update-record', s.scene, range, diff.text), diff: diff.text, lastCommitAt: commits[0].at,
  }
}

/** The scene's open episode: its lane commits after the last landed read. */
export function openEpisode(s: ProseScene, all = proseCommits(), receipts = receiptsOf('update-record')): Episode | null {
  const mine = all.get(s.file) ?? []
  const read = lastRead(s.scene, receipts)
  let commits = mine
  if (read) {
    const at = mine.findIndex(c => c.hash === read.to)
    if (at >= 0) commits = mine.slice(0, at)
    else {
      // the read ended on a commit that did not touch this file (a hand
      // override); the book's order decides which commits come after it
      try {
        const after = new Set(git('rev-list', `${read.to}..HEAD`).split('\n').filter(Boolean))
        commits = mine.filter(c => after.has(c.hash))
      } catch { commits = mine }
    }
  }
  return describe(s, commits)
}

// ---- what is due, and what is listed -------------------------------------------------

export interface ListedEpisode extends Episode { state: 'due' | 'failed' | 'running'; title: string }

/** The open episodes that are due, running or failed — the one list the
 *  briefing and the attention drawer read, and the one the trigger starts
 *  from. An open episode that is not yet due (the scene still has pending
 *  changes and the author is still deciding) is not listed: it is not
 *  something arc has failed to do. */
export function listEpisodes(now = Date.now()): ListedEpisode[] {
  const all = proseCommits()
  const receipts = receiptsOf('update-record')   // read once for the whole list
  const open = proseScenes().map(s => openEpisode(s, all, receipts)).filter((e): e is Episode => e !== null)
  if (!open.length) return []
  const pending = new Set(proseDraft().changes.map(c => c.file))
  const cache = readCache()
  const out: ListedEpisode[] = []
  for (const e of open) {
    const f = cache.inFlight[e.key]
    // a read is running while its process is alive AND it has not outlived the
    // row's own wall clock — a recycled pid cannot keep it running forever
    const flying = !!f && alive(f.pid) && now - f.at < ROW_UPDATE_RECORD_SCENE.budget.wallClockMs
    // failed: ended and not landed, or keyed, never ended and not in flight (it threw)
    const failed = receipts.some(r => r.key === e.key && (r.ending ? r.ending !== 'landed' : !flying))
    // the idle clock: the later of the last decision noted and the newest
    // accept itself, so a lost cache only ever restarts the clock
    const last = Math.max(cache.lastDecisionAt[e.scene] ?? 0, e.lastCommitAt)
    const due = !pending.has(e.file) || now - last >= EPISODE_IDLE_MS
    const state: ListedEpisode['state'] | null = flying ? 'running' : failed ? 'failed' : due ? 'due' : null
    if (state) out.push({ ...e, state, title: sceneLabel(e.scene) })
  }
  return out
}

/** THE ONE FUNCTION behind "arc has not read <n> of your accepts to <title>":
 *  the re-entry briefing and GET /api/attention both call it. It lists; it
 *  never starts a read. */
export function unreadEpisodes(now = Date.now()): UnreadEpisode[] {
  const u7 = receiptsOf('update-record')
  const learn = receiptsOf('learn')
  const newestRun = (rs: typeof u7, pick: (r: (typeof u7)[number]) => boolean): string | undefined =>
    rs.filter(pick).sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''))[0]?.run_id
  const listed = listEpisodes(now)
  const out: UnreadEpisode[] = listed.map(e => {
    // the run is found by the key every keyed receipt carries from its launch;
    // while U7 has landed and the learner is the one running, it is the learner's
    const run = e.state === 'running'
      ? newestRun(u7, r => r.key === e.key && !r.ending)
        ?? newestRun(learn, r => r.request?.subject === e.scene && !r.ending && !!r.key)
      : e.state === 'failed'
        ? newestRun(u7, r => r.key === e.key && !!r.ending && r.ending !== 'landed')
        : undefined
    return { scene: e.scene, title: e.title, count: e.commits.length, state: e.state, ...(run ? { run } : {}) }
  })
  // a style read that did not land is listed the same way: its episode is
  // closed (the record was read), but the style contract was not
  const seen = new Set(out.map(u => u.scene))
  for (const f of failedLearns()) {
    if (seen.has(f.scene)) continue
    seen.add(f.scene)
    const run = newestRun(learn, r => r.key === f.key)
    out.push({ scene: f.scene, title: sceneLabel(f.scene), count: f.count, state: 'failed', ...(run ? { run } : {}) })
  }
  return out
}

/** The scenes whose open episode is non-empty and due (and not failed or
 *  already running). */
export const dueEpisodes = (now = Date.now()): string[] =>
  listEpisodes(now).filter(e => e.state === 'due').map(e => e.scene)

// ---- running one ---------------------------------------------------------------------

/** One episode at a time (§4 invariant 2: triggered jobs and filing run one
 *  at a time). Every start — the trigger and the hand — goes through here. */
let chain: Promise<unknown> = Promise.resolve()
function inTurn<T>(job: () => Promise<T>): Promise<T> {
  const next = chain.then(job, job)
  chain = next.catch(() => undefined)
  return next
}

/** Resolves when every read started so far has finished — for a test, and for
 *  a shutdown that wants to wait. */
export const episodesSettled = async (): Promise<void> => { await chain }

function setInFlight(e: { scene: string; key: string }, on: boolean): void {
  const c = readCache()
  if (on) c.inFlight[e.key] = { scene: e.scene, pid: process.pid, at: Date.now() }
  else delete c.inFlight[e.key]
  writeCache(c)
}

/** How many of the file's lane accepts a range covers. */
function acceptsIn(file: string, range: { from: string; to: string }): number {
  try {
    const prefix = git('rev-parse', '--show-prefix').trim()
    const span = range.from === EMPTY_TREE ? range.to : `${range.from}..${range.to}`
    const n = Number(git('rev-list', '--count', '--grep=^Arc-Lane: accept$', span, '--', `${prefix}${file}`).trim())
    return Number.isFinite(n) && n > 0 ? n : 1
  } catch { return 1 }
}

/** U12 READS THAT DID NOT LAND, from the record (A74-6): a learner receipt
 *  that carries a key and ended in anything but `landed`, or was keyed and
 *  never ended and is not running. One per scene, the newest — and none once
 *  a landed read of the same key, or any newer read of the scene, exists,
 *  because the hand's second go closes it. U12's episode is the same as U7's
 *  (which has landed by then), so this is the only place a failed style read
 *  is told apart from an unread one. */
export function failedLearns(): { scene: string; key: string; count: number; range: { from: string; to: string } }[] {
  const receipts = receiptsOf('learn').filter(r => r.key && r.request?.subject && r.result?.range)
  const landed = receipts.filter(r => r.ending === 'landed')
  const keys = new Set(landed.map(r => r.key))
  // a scene whose episode is being read right now (U7 then U12 share the flight)
  const flying = new Set(Object.values(readCache().inFlight).filter(f => alive(f.pid)).map(f => f.scene))
  const newest = new Map<string, (typeof receipts)[number]>()
  for (const r of receipts) {
    const scene = r.request!.subject!
    if (r.ending === 'landed' || keys.has(r.key)) continue
    if (!r.ending && flying.has(scene)) continue    // still running
    if (landed.some(l => l.request!.subject === scene && l.started_at > r.started_at)) continue
    const cur = newest.get(scene)
    if (!cur || r.started_at > cur.started_at) newest.set(scene, r)
  }
  const files = new Map(proseScenes().map(s => [s.scene, s.file]))
  return [...newest].map(([scene, r]) => ({
    scene, key: r.key!, range: r.result!.range!,
    count: files.has(scene) ? acceptsIn(files.get(scene)!, r.result!.range!) : 1,
  }))
}

/** U12 over the episode's range, on its own row (A74-6). Once per key — the
 *  learner itself finds a landed receipt carrying it and does nothing. A
 *  failure is logged and left to the hand (it is listed from its receipt); it
 *  never undoes what U7 landed. */
async function learnFrom(file: string, scene: string, range: { from: string; to: string }, diff: string): Promise<void> {
  if (!currentEngine()) return
  try {
    // from the episode's own start, so two accepts are read as one change
    await runLearnStyle([file], { [file]: range.from }, { episode: { scene, range, diff } })
  } catch (e) {
    console.error('[error] learning from the accepts to a scene failed (the read of the record stands):', e)
  }
}

async function readOne(s: { scene: string; file: string }, range: { from: string; to: string }, diff: string, key: string): Promise<UpdateRecordResponse> {
  const flight = { scene: s.scene, key }
  setInFlight(flight, true)
  try {
    const res = await runUpdateRecord(s.scene, range.from, range.to)
    // U12 follows U7, and only a U7 that landed or had landed already
    const landed = res.nothingNew || readWorkingReceipt(res.run)?.ending === 'landed'
    if (landed) await learnFrom(s.file, s.scene, range, diff)
    return res
  } finally { setInFlight(flight, false) }
}

/** THE HAND (the viewer's keystroke, POST /api/record/update {scene}): read
 *  the scene's due or latest episode now. With `from`/`to` it reads exactly
 *  that range and only U7 — the overrides are for tests. */
export function readSceneByHand(scene: string, from?: string, to?: string): Promise<UpdateRecordResponse> {
  return inTurn(async () => {
    if (from || to) return runUpdateRecord(scene, from, to)
    const s = proseScenes().find(x => x.scene === scene)
    if (!s) return runUpdateRecord(scene)   // the same 404 as ever
    const open = openEpisode(s)
    if (open) return readOne(s, open.range, open.diff, open.key)
    // nothing open: the latest read, which the key will say is done — and
    // which is also where a U12 that failed earlier gets its second go
    const last = lastRead(scene)
    if (last) {
      const diff = acceptedDiff(bodyAt(last.from, s.file), bodyAt(last.to, s.file) ?? '')
      return readOne(s, last, diff.text, runKey('update-record', scene, last, diff.text))
    }
    return runUpdateRecord(scene)           // never accepted: the 409 that says so
  })
}

let ticking = false
/** THE TRIGGER: start every due episode, one after another. Called after a
 *  lane commit has released the lane and its response has gone; never
 *  awaited by the request. Errors are caught into the run's ending (or
 *  logged when the run could not begin); nothing reaches the accept. */
export function startDueEpisodes(now = Date.now()): Promise<void> {
  const engine = currentEngine()
  // the sdk engine refuses every rowed pass with a sentence, and with no
  // engine there is nothing to start: the episode stays listed
  if (ticking || (engine !== 'claude-cli' && engine !== 'fixture')) return Promise.resolve()
  ticking = true
  return inTurn(async () => {
    ticking = false
    const tried = new Set<string>()
    while (tried.size < MAX_STARTS_PER_COMMIT) {
      // an episode that holds none of this process's own commits is history: listed, read by hand
      const next = listEpisodes(now).find(e => e.state === 'due' && !tried.has(e.key) && e.commits.some(c => ownCommits.has(c)))
      if (!next) return
      tried.add(next.key)
      try { await readOne(next, next.range, next.diff, next.key) } catch (e) {
        console.error('[error] reading the accepts to a scene for the record failed (the accepts themselves stand):', e)
      }
    }
  })
}
