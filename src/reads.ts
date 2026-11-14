// WHAT A PROPOSAL READ, AND WHETHER IT STILL HOLDS (A72-4).
//
// Invariant 1: every proposal names the fingerprints of everything it read,
// and a changed fingerprint makes it stale — shown as stale with a one-click
// re-run, never written over newer work and never logged as a decision.
//
// This was built for routes and only for routes (`reroute.ts`), and its
// enumeration was body-only: a note whose STATUS the author changed, or whose
// anchor they moved, fingerprinted the same as before. A pass handed an open
// note and a pass handed a resolved one are not handed the same thing, so the
// map now covers what the record SAYS about each id and not just the words in
// it. Drafts read the same things routes do; they now record them the same
// way and are compared by the same function.
//
// THE TWO BARS STAY APART (the epic's decision 1). A moved READ makes a
// proposal stale — a warning the author may read past, because accepting
// destroys nothing of theirs. A moved BASE is a different thing entirely, at
// a different door (`base.ts`), and refuses.
import { annotations } from './annotations'
import { locksOn } from './locks'
import { proseScenes } from './story'
import { sha16 } from './records'

/** One thing a proposal read, and the version it read. */
export interface VersionedRead { id: string; version: string }

/** WHICH ENUMERATION PRODUCED A PROPOSAL'S VERSIONS. Bump it whenever what a
 *  fingerprint covers changes, because a version computed by a different rule
 *  is not a version this one can compare against — it is a string that looks
 *  comparable, which is worse than nothing. A proposal carrying reads minted
 *  under an older rule reads *written by an older arc*: arc genuinely cannot
 *  say what it was shown, and says so rather than calling the author's record
 *  moved when it has not.
 *
 *  1 — the body-only map (routes, before A72-4).
 *  2 — the scene with its frontmatter and contract, and notes with their
 *      status, kind, authorship and anchor (A72-4). */
export const READ_MAP = 2

/** What the ids a proposal read fingerprint to now. `full` says whether every
 *  id class the manifest can name was measured — the write path's map says
 *  yes, and then a read id this map has no entry for names something that has
 *  been DELETED since, rather than something nobody measured. */
export interface Fingerprints { at: Map<string, string>; full: boolean }

/** The ids `fingerprintsNow` enumerates completely, so that an id missing
 *  from it means the thing itself is gone rather than unmeasured. The canon
 *  pack and the sibling scenes cost a canon read and a chapter walk, so they
 *  are measured at the write path and not on every listing; the parent body
 *  of a rewrite never changes under it. */
export const recomputableAtRest = (id: string): boolean =>
  !id.startsWith('pack:') && !id.startsWith('siblings:') && id !== 'route'

/** A NOTE'S FINGERPRINT IS WHAT THE PASS WAS HANDED, not the words alone: a
 *  note the author resolved, re-anchored, dropped or re-attributed is a
 *  different instruction even when every letter of it is the same. Its
 *  RESOLUTION is deliberately not in here — where the anchor currently lands
 *  moves whenever the prose moves, which is the scene's own fingerprint
 *  saying so, and folding it in would make every draft stale against itself. */
export const noteVersion = (n: {
  body: string; status?: string; kind?: string; by?: string
  anchor: { scene: string; paragraph?: number; quote?: string }
}): string => sha16(JSON.stringify({
  body: n.body,
  status: n.status ?? 'open',
  kind: n.kind ?? 'note',
  by: n.by ?? 'author',
  anchor: { scene: n.anchor.scene, paragraph: n.anchor.paragraph ?? null, quote: n.anchor.quote ?? null },
}))

/** A SCENE'S FINGERPRINT IS THE WHOLE FILE as the pass was shown it — the
 *  body it rewrites and the frontmatter that tells it what the scene is for.
 *  A changed contract, a changed `facts:` list or a changed status is a
 *  changed assignment, and a map over the body alone could not see it. */
export const sceneVersion = (s: { body: string; status?: string; chapter?: string; pov?: string | null; facts?: string[]; events?: string[]; contract?: unknown; span?: unknown }): string =>
  sha16(JSON.stringify({
    body: s.body,
    status: s.status ?? null,
    chapter: s.chapter ?? null,
    pov: s.pov ?? null,
    facts: s.facts ?? [],
    events: s.events ?? [],
    contract: s.contract ?? null,
    span: s.span ?? null,
  }))

/** The cheap map, for listing proposals: the scene, the style contract, every
 *  annotation on it and every lock it carries. No canon read. */
export function fingerprintsNow(scene: string, styleFor: (s: { scene: string; file: string; body: string }) => string): Fingerprints {
  const at = new Map<string, string>()
  const all = proseScenes()
  const s = all.find(x => x.scene === scene)
  if (s) at.set(scene, sceneVersion(s))
  // THE SCENE BEHIND THIS ONE (the handoff layer, `slice.ts`). A pass is
  // shown the previous scene's last words and whether they are accepted; a
  // rewrite of THAT scene is a change to what this draft was written to
  // follow on from, and a map that stops at this scene cannot see it.
  if (s) {
    const ix = all.findIndex(x => x.scene === scene)
    const prev = ix > 0 ? all[ix - 1] : null
    if (prev) at.set(`handoff:${scene}`, sceneVersion(prev))
  }
  try { at.set('style', sha16(styleFor({ scene, file: s?.file ?? '', body: s?.body ?? '' }))) } catch { /* absent is not changed */ }
  // Every note on the scene, not only the open ones: a note that closed is a
  // note the pass would no longer be handed, and the proposal read it open.
  try { for (const n of annotations().filter(n => n.anchor.scene === scene)) at.set(n.id, noteVersion(n)) } catch { /* absent is gone */ }
  try { for (const l of locksOn(scene, s?.body ?? '')) at.set(l.id, sha16(String(l.anchor.quote ?? ''))) } catch { /* absent is gone */ }
  return { at, full: false }
}

/** Why a proposal no longer stands, in the two registers the author reads
 *  differently. `the record moved` is a warning about THEIR record changing;
 *  `written by an older arc` is arc saying it cannot tell, which is never the
 *  author's fault and is never called stale (A69's Q14 answer). */
export interface Staleness {
  changed: string[]
  why: 'the record moved' | 'written by an older arc'
  /** TRUE WHEN THE PASS THAT WROTE IT IS NOT THE PASS ARC HAS NOW. Separate
   *  from `why` because the two can be independently true: a proposal whose
   *  versions are still comparable can have a moved record AND have been made
   *  by a row that has since changed, and the author reads those as two
   *  different facts. When arc cannot compare at all, this is the only fact
   *  there is. */
  older?: boolean
}

/** The ONE comparison. A proposal with no reads at all predates the governed
 *  path; a proposal whose job fingerprint has moved was made by a version of
 *  this pass that no longer exists, which is the same answer for the same
 *  reason — arc cannot say what it was shown, so it does not pretend to. */
export function staleAgainst(
  proposal: { reads?: VersionedRead[]; run?: string; job?: string; v?: number },
  now: Fingerprints,
  job?: string,
): Staleness | null {
  if (!proposal.reads?.length || !proposal.run) {
    return { changed: [], why: 'written by an older arc', older: true }
  }
  // MINTED UNDER A DIFFERENT ENUMERATION: arc cannot compare the versions at
  // all, so there is nothing it can honestly say about the record.
  if (proposal.v !== READ_MAP) {
    return { changed: [], why: 'written by an older arc', older: true }
  }
  // A DIFFERENT VERSION OF THE PASS, but versions arc can still compare. Two
  // independent facts, and the author reads them as two.
  const older = Boolean(job && proposal.job && proposal.job !== job)
  const changed = proposal.reads.filter(r => {
    const cur = now.at.get(r.id)
    // Gone counts as changed: an open note the pass read and the author has
    // since answered or deleted is not the record it was written from.
    // Absence only means "not measured" for the ids this map does not carry.
    if (cur === undefined) return now.full ? r.id !== 'route' : recomputableAtRest(r.id)
    return cur !== r.version
  }).map(r => r.id)
  if (changed.length) return { changed, why: 'the record moved', ...(older ? { older: true } : {}) }
  return older ? { changed: [], why: 'written by an older arc', older: true } : null
}

/** WHAT A PASS WAS SHOWN, recorded. The other half of the comparison, and in
 *  the same module on purpose: a manifest built by one rule and compared by
 *  another is a map that agrees with nothing, which is how a scene whose
 *  frontmatter had never changed came to read as moved.
 *
 *  It takes the SCENE and the NOTES themselves, not their bodies: the rule
 *  about what counts lives in `sceneVersion` and `noteVersion`, once. */
export function readManifest(a: {
  style: string
  scene: { scene: string; body: string; status?: string; chapter?: string; pov?: string | null; facts?: string[]; events?: string[]; contract?: unknown; span?: unknown }
  pack: string
  notes: { id: string; body: string; status?: string; kind?: string; by?: string; anchor: { scene: string; paragraph?: number; quote?: string } }[]
  locks: { id: string; quote: string }[]
  siblings: string
  route?: string
  /** The scene this one follows on from, when the handoff layer gave one. */
  handoff?: { scene: string; body: string; status?: string } | null
}): VersionedRead[] {
  const id = a.scene.scene
  return [
    ...(a.handoff ? [{ id: `handoff:${id}`, version: sceneVersion(a.handoff) }] : []),
    { id: 'style', version: sha16(a.style) },
    { id, version: sceneVersion(a.scene) },
    { id: `pack:${id}`, version: sha16(a.pack) },
    // Named even when empty: a chapter that GAINS a sibling scene has moved
    // under a proposal written when it had none, and an id the proposal
    // never recorded can never be compared.
    { id: `siblings:${id}`, version: sha16(a.siblings) },
    ...(a.route ? [{ id: 'route', version: sha16(a.route) }] : []),
    ...a.notes.map(n => ({ id: n.id, version: noteVersion(n) })),
    ...a.locks.map(l => ({ id: l.id, version: sha16(l.quote) })),
  ]
}

/** REBASE ONE ID of a recorded read set to what is there now (A72-4).
 *
 *  Adopting a route writes the route's body into the destination — so the
 *  route's own record of what the destination USED to say is, a moment later,
 *  a record of something the adoption itself changed. Left alone it makes the
 *  adopted draft stale against its own output, which is a warning about
 *  nothing and teaches the author to ignore the ones that mean something.
 *
 *  Only the destination's own entry moves. Everything else the route read —
 *  the style contract, the canon pack, the siblings, the notes, the locks —
 *  is untouched: those are the things that CAN have moved under it, and the
 *  adopted draft is still a proposal written against them. */
export function rebase(reads: VersionedRead[], id: string, version: string): VersionedRead[] {
  const out = reads.filter(r => r.id !== id)
  out.push({ id, version })
  return out
}

/** The same thing a writing row needs, and for the same reason: the pass just
 *  REWROTE the scene it read, so the version it read is now a record of
 *  something the pass itself changed. Rebased to the scene as the landing
 *  left it, so what makes the draft stale is the author's record moving —
 *  never the draft's own output. Called inside the landing transaction, after
 *  the write, so "as the landing left it" is exactly what it says. */
export function rebaseToLanded(reads: VersionedRead[], scene: string): VersionedRead[] {
  const s = proseScenes().find(x => x.scene === scene)
  return s ? rebase(reads, scene, sceneVersion(s)) : reads
}

/** The reads to RECORD for a proposal about one scene, from a map already
 *  built. The write path builds the full map; this turns it into the list a
 *  proposal carries, minus the ids a given proposal never saw. */
export function readsFrom(now: Fingerprints, ids?: string[]): VersionedRead[] {
  const out: VersionedRead[] = []
  for (const [id, version] of now.at) {
    if (ids && !ids.includes(id)) continue
    out.push({ id, version })
  }
  return out
}
