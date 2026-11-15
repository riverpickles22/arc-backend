// THE ROUTES WAITING BESIDE A SCENE (A81-8): the store, and what it knows.
//
// A route is another way through a scene that the reroute pass wrote and the
// author has not yet taken or let go. It lives beside the manuscript, never
// in it — `.arc/alternatives/<scene>/<id>.md` — and this module is where
// that directory is listed, written (and pruned past the cap, never
// silently), removed from with the disposition on record first, cleared at
// an accept, and counted. It is the only place a route file is REMOVED.
// Two readers and one writer still touch the directory themselves — the
// reroute pass saves a route's notes in place (`saveAlt`) and checks a file
// is there, and doctor lists the scene folders — which is as it was.
//
// It was inside reroute.ts, and the accept, the briefing, doctor and the
// server all imported a PASS to reach a STORE — an edge the import-graph
// test could not see as wrong, because the file it pointed at was a pass.
// The pass lists, writes and removes routes through here like everyone else
// now. Nothing in this file launches anything.
import fs from 'node:fs'
import path from 'node:path'
import { dump as yamlDump, load as yamlLoad } from 'js-yaml'
import type { DroppedClaim, RouteAlternative, RouteCoverage, RouteNote } from 'arc-canon-graph/api-types.ts'
import { STORY } from './config'
import { recordDisposition, type Disposition } from './evidence'
import { splitBriefing } from './gate-ctx'
import { staleAgainst } from './reads'
import { fingerprintsNow } from './style-projection'

export const KEEP_ALTERNATIVES = 6

/** Has the ground moved under this route since it was written?
 *
 *  Invariant 1: every proposal names the fingerprints of everything it read,
 *  and a changed fingerprint makes it stale — shown as stale with a one-click
 *  re-run, never written over newer work and never logged as a decision. A
 *  route with no reads at all predates the governed path and is stale for a
 *  different reason, which the author reads differently. */
export function withStaleness(alt: RouteAlternative, now = fingerprintsNow(alt.scene)): RouteAlternative {
  // ONE COMPARISON for routes and drafts alike (A72-4): the rule about what
  // counts as moved lives in `reads.ts`, so the two kinds of proposal cannot
  // drift into disagreeing about their own record.
  const stale = staleAgainst(alt, now)
  return stale ? { ...alt, stale } : alt
}

/** The chain heads on a scene: versions do not count, a route rewritten
 *  three times is one way through. `governed` counts only the ones that
 *  still hold — a stale route, or one written by an older arc, is shown
 *  with a re-run and does not hold a place against the cap of four
 *  (A67-10, Q13) — while `all` is everything still waiting on the author,
 *  which is what the briefing counts. */
export function routeHeads(scene: string): { all: number; governed: number } {
  const now = fingerprintsNow(scene)
  const alts = listAlternatives(scene).map(a => withStaleness(a, now))
  const revised = new Set(alts.map(a => a.revises).filter((r): r is string => typeof r === 'string'))
  const heads = alts.filter(a => !revised.has(a.id))
  return { all: heads.length, governed: heads.filter(a => !a.stale).length }
}

export const alternativesDir = (scene: string) => path.join(STORY, '.arc', 'alternatives', scene)
const FM_RE = /^---\n([\s\S]*?)\n---\n/

export function serializeAlternative(alt: RouteAlternative): string {
  const { body, briefing, ...head } = alt
  return `---\n${yamlDump(head, { lineWidth: -1 })}---\n\n${body.trim()}\n\n=== BRIEFING ===\n${briefing.trim()}\n`
}

function parseAlternative(text: string): RouteAlternative | null {
  const m = text.match(FM_RE)
  if (!m) return null
  const head = yamlLoad(m[1]) as Partial<RouteAlternative> | null
  if (!head || typeof head.id !== 'string' || typeof head.scene !== 'string') return null
  const { body, briefing } = splitBriefing(text.slice(m[0].length))
  return {
    id: head.id, scene: head.scene, seed: String(head.seed ?? ''), guidance: head.guidance ?? undefined,
    based_on: String(head.based_on ?? ''), created_at: String(head.created_at ?? ''),
    ...(typeof head.run === 'string' ? { run: head.run } : {}),
    ...(Array.isArray(head.reads) ? { reads: head.reads as { id: string; version: string }[] } : {}),
    ...(typeof head.v === 'number' ? { v: head.v } : {}),
    body, briefing,
    coverage: Array.isArray(head.coverage) ? head.coverage as RouteCoverage[] : null,
    ...(Array.isArray(head.dropped) ? { dropped: head.dropped as DroppedClaim[] } : {}),
    overlap: typeof head.overlap === 'number' ? head.overlap : null,
    ...(typeof head.retried === 'string' ? { retried: head.retried } : {}),
    ...(typeof head.revises === 'string' ? { revises: head.revises } : {}),
    ...(head.reissued === true ? { reissued: true as const } : {}),
    ...(Array.isArray(head.notes) ? { notes: head.notes as RouteNote[] } : {}),
  }
}

/** Every generated alternative for a scene, newest first. */
export function listAlternatives(scene: string): RouteAlternative[] {
  const dir = alternativesDir(scene)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(n => n.endsWith('.md'))
    .map(n => { try { return parseAlternative(fs.readFileSync(path.join(dir, n), 'utf8')) } catch { return null } })
    .filter((a): a is RouteAlternative => a !== null)
    .sort((x, y) => y.created_at.localeCompare(x.created_at))
}

/** THE ONE WAY A ROUTE LEAVES DISK (A67-10). Its disposition is recorded
 *  first — with the author's own notes copied in — and only then is the file
 *  removed. No route leaves without one: not a cancel, not the accept that
 *  clears a scene's field, not the prune past the cap.
 *
 *  `fs.rmSync` on a route file appears nowhere else. */
export function removeAlternative(alt: RouteAlternative, disposition: Disposition, because: string): boolean {
  const recorded = recordDisposition({
    scene: alt.scene,
    route: alt.id,
    disposition,
    notes: (alt.notes ?? []).map(n => ({ body: n.body, paragraph: n.paragraph, at: n.created_at })),
    because,
    ...(alt.run ? { run: alt.run } : {}),
  })
  // THE ORDER IS THE INVARIANT. If the evidence log could not be written the
  // route KEEPS ITS FILE: a removal here would take the author's own notes
  // with it and leave nothing on record, which is the one thing this
  // function exists to prevent.
  if (!recorded) return false
  return dropFile(alt)
}

/** Remove a route's file once its disposition is on record. Separate because
 *  the accept also removes the route it adopted, whose disposition was
 *  written at the adopt — one entry, not two. */
function dropFile(alt: RouteAlternative): boolean {
  try {
    fs.rmSync(path.join(alternativesDir(alt.scene), `${alt.id}.md`), { force: true })
    return true
  } catch (e) {
    console.error('[warn] route file could not be removed:', e)
    return false
  }
}

export function writeAlternative(alt: RouteAlternative): void {
  const dir = alternativesDir(alt.scene)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${alt.id}.md`), serializeAlternative(alt))
  // Generated alternatives are disposable: keep the newest few ROUTES (chain
  // heads), drop the rest — but a kept route keeps every version it came
  // through, because "save the difference in versions" is the rewrite's
  // contract with the author. PRUNING IS NEVER SILENT: each route the prune
  // removes writes its `superseded` entry, with any notes copied in, before
  // the file goes.
  const alts = listAlternatives(alt.scene)
  const keep = pruneKeepIds(alts, KEEP_ALTERNATIVES)
  for (const old of alts) {
    if (!keep.has(old.id)) removeAlternative(old, 'superseded', `pruned: this scene keeps its newest ${KEEP_ALTERNATIVES} routes`)
  }
}

/** Which alternatives survive pruning: the newest `keep` chain heads and
 *  every version they descend from. A version whose parent is already gone
 *  reads as its own head. Pure, for the tests. */
export function pruneKeepIds(alts: RouteAlternative[], keep: number): Set<string> {
  const byId = new Map(alts.map(a => [a.id, a]))
  const revised = new Set(alts.map(a => a.revises).filter((r): r is string => typeof r === 'string'))
  const heads = alts.filter(a => !revised.has(a.id))
  const keepSet = new Set<string>()
  // Generated prose is disposable; the author's own words are not. A route
  // carrying a note survives pruning however old it is — losing it would
  // delete something the author wrote, silently and unrecoverably.
  const noted = alts.filter(a => (a.notes ?? []).some(n => n.body?.trim()))
  for (const h of [...heads.slice(0, keep), ...noted]) {
    let cur: RouteAlternative | undefined = h
    while (cur && !keepSet.has(cur.id)) {
      keepSet.add(cur.id)
      cur = cur.revises ? byId.get(cur.revises) : undefined
    }
  }
  return keepSet
}

/** Clear a scene's whole field of alternatives. Called when a scene change
 *  is ACCEPTED into the manuscript — the adopted route became the book, and
 *  the routes it beat go with it. Deliberately not on adopt: adopt only
 *  writes the draft, and a draft the author then discards must not cost
 *  them every route. Returns how many were removed. */
export function clearAlternatives(scene: string, opts: { because?: string; adopted?: string } = {}): number {
  const because = opts.because ?? 'a route on this scene was adopted and accepted'
  const dir = alternativesDir(scene)
  if (!fs.existsSync(dir)) return 0
  const alts = listAlternatives(scene)
  // Q13, decided by the author on 2026-09-13: clear and record. Each waiting
  // route gets a `superseded` entry with its author notes copied in, and
  // then the file goes — a new route can always be asked for the old way.
  //
  // THE ADOPTED ROUTE IS NOT SUPERSEDED BY ITS OWN ADOPTION. Its disposition
  // was written at the adopt (`adopted`, with the file it was taken into);
  // a second entry here would put both readings of the same route on record
  // and the later one would be the lie. Its file still goes: it has a
  // disposition, which is what the invariant asks.
  let gone = 0
  for (const a of alts) {
    const removed = a.id === opts.adopted ? dropFile(a) : removeAlternative(a, 'superseded', because)
    if (removed) gone += 1
  }
  return gone
}

/** How many routes wait on each scene — one read for the whole story, so the
 *  manuscript can mark every scene without a request per scene. Counts
 *  CHAINS, not versions: three rewrites of one route are one route waiting. */
export function routeCounts(): Record<string, { waiting: number; governed: number }> {
  const root = path.join(STORY, '.arc', 'alternatives')
  if (!fs.existsSync(root)) return {}
  const out: Record<string, { waiting: number; governed: number }> = {}
  for (const scene of fs.readdirSync(root)) {
    try { if (!fs.statSync(path.join(root, scene)).isDirectory()) continue } catch { continue }
    // TWO counts, because they answer two questions: what is still waiting
    // on the author (the briefing's, stale routes included — they are still
    // theirs to re-run or cancel), and how many of the four places are
    // taken (the cap's, which a stale route does not hold).
    const heads = routeHeads(scene)
    if (heads.all) out[scene] = { waiting: heads.all, governed: heads.governed }
  }
  return out
}
