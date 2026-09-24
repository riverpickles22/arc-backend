// The reroute pass: another way to the same destination.
//
// arc's editing passes all take the manuscript as their subject. Revise
// changes "as little as the notes require"; redraft is told the text is "one
// attempt, not a floor" and, in the same breath, to keep what earns its
// place — and a model handed two thousand words of good prose and told to
// keep what works keeps the structure too. That is those prompts working as
// designed, and it is why no pass could ever find a different way through a
// scene: none had the CONTRACT as its subject.
//
// Reroute inverts one thing: it is not given the current prose. It is given
// three objects, kept apart, two of which bind:
//
//   DESTINATION  — the contract's must_establish items and every key point
//                  with author authority. Must be reached, by any realization.
//   KNOWN ROUTE  — what arc can state about the current route WITHOUT
//                  interpreting the prose: the order of author-authority key
//                  points, what the scene opens and closes on, the locked
//                  passages in their relative order. Must not be retaken.
//   INFERRED     — arc's own unconfirmed key points: a model's reading, shown
//                  as context, binding nothing until the author confirms it.
//
// Bound events are fact, not route: they sit in the context pack in canon's
// order, and a fence that told the model to avoid that order would invite it
// to reorder what happened.
//
// Alternatives land BESIDE the manuscript (.arc/alternatives/<scene>/), never
// in it. Adopt is the ordinary lock-gated scene write, and only then does the
// ledger learn of the route: generatedFor() pairs by file path and the
// learning pass mines that pair, so a route recorded at generation would have
// taught style rules from prose the author never edited.
//
// TWO KINDS OF CHECK, NEVER BLURRED (conventions §11). Proven, and able to
// refuse: locks verbatim AND in their relative order (stricter than the
// shipped presence rule, this pass alone), quoted withholds, and lexical
// overlap — which proves the answer reused too much of the original WORDING
// and nothing more. Whether the scene took a different dramatic route is a
// reading; it stays argued, in the briefing and in the author's eye.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { dump as yamlDump, load as yamlLoad } from 'js-yaml'
import type { CanonDoc, ProseScene, ResolvedAnnotation, ResolvedLock, SceneContract } from 'arc-canon-graph'
import type { AdoptRouteResponse, DroppedClaim, RerouteRefusal, RerouteResponse, RouteAlternative, RouteCoverage, RouteListResponse, RouteLockNotice, RouteNote, RouteReceipt } from 'arc-canon-graph/api-types.ts'
import { dateOf, splitSentences } from 'arc-canon-graph'
import { buildContextPack } from 'arc-canon-graph/context-pack-lib.ts'
import { paragraphsOf } from 'arc-canon-graph/annotations.ts'
import { STORY } from './config'
import { annotations, openNotesOn } from './annotations'
import { canonJson } from './canon'
import { currentEngine, renderBrief, type Brief, type EngineErrorKind } from './engine'
import { runGates, stripQuotedSpans, type ProseGateCtx, type WithheldSet } from './gates'
import { ROUTE_WITHHELD, ROW_EXPLORE_ROUTE, ROW_EXPLORE_SCENE, jobFingerprint, type SealedRow } from './registry'
import type { ResolvedRequest } from './request'
import { Run, emptyReceipt, gateName, outcomeSentence, readWorkingReceipt, writeReceipt, writeWorkingReceipt, type GateRecord, type Receipt } from './run'
import { endRun, registerRun, stateOf } from './runs'
import type { RunEnding } from 'arc-canon-graph'
import { HttpError } from './http'
import { recordDisposition, type Disposition } from './evidence'
import { recordGenerated } from './ledger'
import { locksOn } from './locks'
import { contractBlock, literalWithholds, splitBriefing, withholdViolations } from './redraft'
import { arcRevision, sha16, storyRevision } from './records'
import { proseScenes, proseWrite } from './story'
import { styleContract } from './style'

// The rules are the row's (registry.ts, ROW_EXPLORE_SCENE.rules): one
// address per job, and this module reads them from there.

/** Seeds for difference — implementation detail, not product concepts. They
 *  exist so two alternatives differ from each other, not to teach craft. A
 *  seed that handed the scene's events to a different character was
 *  considered and dropped: canon records who caused what. */
export const SEEDS: { id: string; text: string }[] = [
  { id: 'late-entry', text: 'SEED — LATE ENTRY: enter the scene as late as the contract allows and leave it early; begin after something has already happened.' },
  { id: 'pressure-first', text: 'SEED — PRESSURE FIRST: open on what the scene withholds, without naming it; let the pressure of the unsaid organize the scene.' },
  { id: 'unseeded', text: 'NO SEED: take whatever route the destination invites that neither a late entry nor an opening on the withheld pressure would produce.' },
]

export const MAX_OVERLAP = 0.4
/** Below this many words a paragraph is not counted on either side of the
 *  overlap gate: nearestParagraph measures survival over the passage's own
 *  words, so "No." survives in almost anything. */
export const MIN_COUNTED_WORDS = 8
/** Under this many countable paragraphs the gate cannot judge and says so. */
export const MIN_COUNTED_PARAS = 3
export const KEEP_ALTERNATIVES = 6
/** How many other ways through a scene may hold at once. At the cap arc asks
 *  the author to cancel one rather than evicting the oldest itself: letting go
 *  of a route is a judgement about the work, and since A58 a route can carry
 *  the author's own notes. Counts ROUTES, not versions — a route rewritten
 *  three times is one way through. */
export const MAX_ROUTES = 4

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

/** How many of the four places on this scene are taken. */
export const routesWaiting = (scene: string): number => routeHeads(scene).governed

/** Has the ground moved under this route since it was written?
 *
 *  Invariant 1: every proposal names the fingerprints of everything it read,
 *  and a changed fingerprint makes it stale — shown as stale with a one-click
 *  re-run, never written over newer work and never logged as a decision. A
 *  route with no reads at all predates the governed path and is stale for a
 *  different reason, which the author reads differently. */
export function withStaleness(alt: RouteAlternative, now = fingerprintsNow(alt.scene)): RouteAlternative {
  if (!alt.reads?.length || !alt.run) {
    return { ...alt, stale: { changed: [], why: 'written by an older arc' } }
  }
  const changed = alt.reads.filter(r => {
    const cur = now.at.get(r.id)
    // Gone counts as changed: an open note the pass read and the author has
    // since answered or deleted is not the record the route was written
    // from. Absence only means "not measured" for the ids this map does not
    // carry — and the write path's map carries every one of them.
    if (cur === undefined) return now.full ? r.id !== 'route' : recomputableAtRest(r.id)
    return cur !== r.version
  }).map(r => r.id)
  return changed.length ? { ...alt, stale: { changed, why: 'the record moved' } } : alt
}

/** The ids `fingerprintsNow` enumerates completely, so that an id missing
 *  from it means the thing itself is gone rather than unmeasured: the scene,
 *  the style contract, every note and every lock. The canon pack and the
 *  sibling scenes cost a canon read and a chapter walk, so they are measured
 *  at the write path (`fingerprintsAtWrite`) and not on every listing; the
 *  parent body of a rewrite never changes under it. */
const recomputableAtRest = (id: string): boolean =>
  !id.startsWith('pack:') && !id.startsWith('siblings:') && id !== 'route'

/** What the ids a route read fingerprint to now. `full` says whether every
 *  id class the manifest can name was measured — the write path's map says
 *  yes, and then a read id this map has no entry for names something that
 *  has been deleted since. */
export interface Fingerprints { at: Map<string, string>; full: boolean }

/** The cheap map, for listing routes: the scene, the style contract, every
 *  annotation and every lock the scene carries. No canon read. */
export function fingerprintsNow(scene: string): Fingerprints {
  const at = new Map<string, string>()
  const s = proseScenes().find(x => x.scene === scene)
  if (s) at.set(scene, sha16(s.body))
  try { at.set('style', sha16(styleForPass({ scene, file: s?.file ?? '', body: s?.body ?? '' }))) } catch { /* absent is not changed */ }
  // Every note on the scene, not only the open ones: a note that closed is a
  // note the pass would no longer be handed, and the route read it open.
  try { for (const n of annotations().filter(n => n.anchor.scene === scene)) at.set(n.id, sha16(n.body)) } catch { /* absent is gone */ }
  try { for (const l of locksOn(scene, s?.body ?? '')) at.set(l.id, sha16(String(l.anchor.quote ?? ''))) } catch { /* absent is gone */ }
  return { at, full: false }
}

/** The whole map, for the write path (invariant 1: a changed fingerprint
 *  makes a route stale AT THE WRITE PATH). Adds the two ids the listing map
 *  leaves out, each of which costs a canon read. */
export function fingerprintsAtWrite(scene: string): Fingerprints {
  const { at } = fingerprintsNow(scene)
  const s = proseScenes().find(x => x.scene === scene)
  if (s) {
    const { pack, siblings } = packAndSiblings(s)
    at.set(`pack:${scene}`, sha16(pack))
    at.set(`siblings:${scene}`, sha16(siblings))
  }
  return { at, full: true }
}

/** The canon pack and the sibling scenes for one scene, built exactly once
 *  here so the reroute's brief and the staleness check can never drift into
 *  fingerprinting two different things. */
function packAndSiblings(s: ProseScene): { pack: string; siblings: string } {
  const canon = JSON.parse(canonJson()) as CanonDoc
  const chapter = (canon.chapters ?? []).find(c => c.id === s.chapter)
  const at = dateOf(chapter?.span?.end) ?? dateOf(chapter?.span?.start)
  const pack = at
    ? buildContextPack(canon, { at, events: s.events, pov: s.pov ?? chapter?.pov })
    : buildContextPack(canon, { chapter: s.chapter })
  // The siblings go in stripped of THIS scene's prose for the same reason the
  // contract does: two scenes of one chapter that share a sentence — a refrain,
  // a line that comes back — would otherwise hand the pass the very scene it is
  // meant to work without, through the neighbour rather than through itself.
  const siblings = withoutSubjectProse(
    proseScenes().filter(x => x.chapter === s.chapter && x.scene !== s.scene)
      .map(x => `=== ${x.file} ===\n${x.body.trim()}`).join('\n\n'),
    { scene: s.scene, body: s.body },
  )
  return { pack, siblings }
}

const words = (s: string): number => s.split(/\s+/).filter(Boolean).length
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** Who a key point answers to. `by` records who originated the statement and
 *  is never rewritten; confirmation, when the refresh pass exists, is a
 *  second fact. Only author authority binds a pass. */
export const authority = (a: { by?: string; confirmed_by?: string }): 'author' | 'agent' =>
  a.by !== 'agent' || !!a.confirmed_by ? 'author' : 'agent'

export interface Beat { paragraph: number; body: string }

/** The scene's key points that currently resolve, in paragraph order. */
export function sceneKeypoints(scene: string, all: ResolvedAnnotation[]): { author: Beat[]; agent: Beat[] } {
  const live = all
    .filter(a => a.kind === 'keypoint' && a.anchor.scene === scene)
    .filter(a => (a.resolution.state === 'resolved' || a.resolution.state === 'drifted') && a.resolution.paragraph !== null)
    .map(a => ({ paragraph: a.resolution.paragraph as number, body: a.body.trim(), who: authority(a as { by?: string; confirmed_by?: string }) }))
    .sort((x, y) => x.paragraph - y.paragraph)
  return {
    author: live.filter(b => b.who === 'author').map(({ paragraph, body }) => ({ paragraph, body })),
    agent: live.filter(b => b.who === 'agent').map(({ paragraph, body }) => ({ paragraph, body })),
  }
}

/** What must be accomplished: the contract's items and the author's beats.
 *  Empty is a refusal, not an empty prompt — a reroute with no destination is
 *  a redraft with the prose removed. */
export function buildDestination(contract: SceneContract | null, authorBeats: Beat[]): string[] {
  const items = Array.isArray(contract?.must_establish) ? contract!.must_establish.map(x => String(x).trim()).filter(Boolean) : []
  const beats = authorBeats.map(b => b.body).filter(Boolean)
  return [...items, ...beats.filter(b => !items.includes(b))]
}

/** The known route, from deterministic sources only. The prose enters here
 *  in exactly one form: the locked paragraphs, which are settled anyway. */
export function buildKnownRoute(authorBeats: Beat[], locked: { paragraph: number; text: string }[]): string {
  const lines: string[] = []
  if (authorBeats.length) {
    lines.push('The current prose passes through these author-marked beats, in this order:')
    for (const b of authorBeats) lines.push(`  ¶${b.paragraph + 1} — ${b.body}`)
    lines.push(`It opens on: ${authorBeats[0].body} (¶${authorBeats[0].paragraph + 1}).`)
    lines.push(`It closes on: ${authorBeats[authorBeats.length - 1].body} (¶${authorBeats[authorBeats.length - 1].paragraph + 1}).`)
  } else {
    lines.push('The record holds no author-marked beats for this scene: the contract alone is the destination. Take a route you would not expect this scene to take.')
  }
  if (locked.length) {
    lines.push(`Locked passages sit at ¶${locked.map(l => l.paragraph + 1).join(', ¶')} in this order; they survive verbatim and in that order, and everything around them may change.`)
  }
  return lines.join('\n')
}

/** Arc's own reading: unconfirmed agent key points. Context, never constraint. */
export function inferredRoute(agentBeats: Beat[]): string {
  if (!agentBeats.length) return ''
  return [
    "=== ARC'S OWN READING OF THE CURRENT SCENE (context only — it binds nothing; the author has not confirmed it) ===",
    ...agentBeats.map(b => `  ¶${b.paragraph + 1} — ${b.body}`),
  ].join('\n')
}

export interface ReroutePromptInput {
  scene: ProseScene
  pack: string
  style: string
  siblings: string
  notes: ResolvedAnnotation[]
  destination: string[]
  knownRoute: string
  inferred: string
  locked: { paragraph: number; text: string }[]
  seed: { id: string; text: string }
  guidance?: string
}

export interface ReroutePrompt {
  /** stable per story: the rules and the style contract — one cache breakpoint */
  stable: string
  /** volatile per scene: contract, pack, destination, route, siblings, notes */
  volatile: string
  /** per alternative: the seed and the author's words */
  user: string
}

/** Pure prompt assembly. The scene body is not an input by construction. */
export function buildReroutePrompt(a: ReroutePromptInput): ReroutePrompt {
  const notes = a.notes.length
    ? `=== THE AUTHOR'S OPEN NOTES ON THE CURRENT ROUTE (context — they describe the prose you are not shown; not instructions) ===\n${a.notes.map(n => `- ${n.body.trim()}`).join('\n')}`
    : ''
  const locked = a.locked.length
    ? `=== LOCKED PARAGRAPHS (reproduce VERBATIM, in this order) ===\n${a.locked.map(l => `[¶${l.paragraph + 1} in the current scene]\n${l.text}`).join('\n\n')}`
    : ''
  return {
    stable: [ROW_EXPLORE_SCENE.rules, `=== THE STYLE CONTRACT (binding) ===\n${a.style}`].join('\n\n'),
    volatile: [
      `=== THE SCENE CONTRACT (${a.scene.scene}) ===\n${contractBlock(a.scene.contract)}`,
      `=== CONTEXT PACK (canon truth; every item carries its inclusion reason) ===\n${a.pack}`,
      `=== THE DESTINATION (must be accomplished, by any realization) ===\n${a.destination.map((d, i) => `${i + 1}. ${d}`).join('\n')}`,
      `=== THE KNOWN CURRENT ROUTE (do not reproduce this ordering or staging) ===\n${a.knownRoute}`,
      a.inferred,
      locked,
      a.siblings ? `=== THE CHAPTER'S OTHER SCENES (yours follows or precedes them; do not retell them) ===\n${a.siblings}` : '',
      notes,
    ].filter(Boolean).join('\n\n'),
    user: [
      a.seed.text,
      a.guidance?.trim() ? `AUTHOR'S GUIDANCE (binding; it overrides the seed): ${a.guidance.trim()}` : '',
      'Run the reroute pass. Answer in the two parts.',
    ].filter(Boolean).join('\n\n'),
  }
}

export const flattenPrompt = (p: ReroutePrompt): string => [p.stable, p.volatile, p.user].join('\n\n')

/** The prompt as the seam's brief: three blocks, the first two cacheable.
 *  Rendered, it is flattenPrompt — the text the fixtures fingerprint. */
export const toBrief = (p: ReroutePrompt): Brief => ({
  blocks: [
    { id: 'stable', text: p.stable, cached: true },
    { id: 'volatile', text: p.volatile, cached: true },
    { id: 'user', text: p.user, cached: false },
  ],
})

/** The one way the current prose reaches a reroute prompt is the style
 *  contract's own touchstones: §6 quotes passages of the manuscript, and a
 *  passage of the scene being rerouted is the current route in the model's
 *  hands — the first live run treated it as exactly that. Strip every
 *  touchstone drawn from the target scene (by its label's file, or its
 *  anchor's scene) and say so in place, so the section stays honest. */
/** THE STYLE CONTRACT AS A WITHHOLDING PASS MAY SEE IT (A67-14).
 *
 *  Two strips, in order, and one place that does both — because the brief and
 *  the fingerprint of what the brief read must be the same string, and two
 *  call sites composing them separately is how they stop being.
 *
 *  First the touchstone blocks drawn from this scene, which go whole: a
 *  touchstone is an example and an example of the current route teaches the
 *  pass the thing it is meant to find another way to. Then any remaining run
 *  of this scene's own prose, wherever it sits — a Rhythm rule quoting the
 *  paragraph it is about is the same leak in a different shape, and the leak
 *  gate counts it the same way. */
export function styleForPass(target: { scene: string; file: string; body: string }): string {
  const contract = styleContract()
  const key = `${target.scene}\n${sha16(contract)}\n${sha16(target.body)}`
  const had = STYLE_FOR_PASS.get(key)
  if (had !== undefined) return had
  const out = withoutSubjectProse(stripSceneTouchstones(contract, target), target)
  // One manuscript render asks this once per scene through `routeCounts`, and
  // the answer only changes when the contract or the scene body does — which
  // is exactly what the key is.
  if (STYLE_FOR_PASS.size > 256) STYLE_FOR_PASS.clear()
  STYLE_FOR_PASS.set(key, out)
  return out
}
const STYLE_FOR_PASS = new Map<string, string>()

/** Cut any run of the subject scene's own prose out of a layer of the brief,
 *  by the leak gate's rule and minus what the row allows through.
 *
 *  It is not only the style contract. ANY layer can carry the scene: a rule
 *  that quotes the paragraph it is about, and a sibling scene that shares a
 *  sentence with this one — two scenes of a chapter that repeat a line are a
 *  thing authors do on purpose, and the pass is handed its siblings in full.
 *  Whatever the layer, the fix is the same and it is applied in one place. */
export function withoutSubjectProse(layer: string, target: { scene: string; body: string }): string {
  return stripQuotedSpans(
    layer,
    target.body,
    ROUTE_WITHHELD.spanWords,
    `**(a quotation from ${target.scene} is withheld from this pass — it is the current route)**`,
    allowedThrough(target),
  ).text
}

/** What the row lets through even though it is the scene: the locked
 *  paragraphs, which the brief hands over verbatim by design, and the
 *  contract's own quoted withholds. Computed here rather than passed in, so
 *  the brief and the fingerprint of what the brief read can never be built
 *  from two different allowances. */
function allowedThrough(target: { scene: string; body: string }): string[] {
  const s = proseScenes().find(x => x.scene === target.scene)
  if (!s) return []
  const paras = paragraphsOf(target.body)
  const locked = locksOn(target.scene, target.body)
    .filter(l => l.scope === 'paragraph' && l.resolution.paragraph !== null)
    .map(l => paras[l.resolution.paragraph as number] ?? '')
  return [...locked, ...literalWithholds(s.contract?.must_withhold)].filter(Boolean)
}

export function stripSceneTouchstones(style: string, target: { scene: string; file: string }): string {
  const lines = style.split('\n')
  const start = lines.findIndex(l => /^##\s+(?:\d+[.)]\s*)?touchstones\s*$/i.test(l))
  if (start < 0) return style
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) if (/^##\s+/.test(lines[i])) { end = i; break }
  const fileish = target.file.replace(/^prose\//, '').replace(/\.md$/, '')
  // A label opens with ** and may wrap onto following lines before it closes.
  const labelEnd = (i: number): number => {
    if (!/^\*\*/.test(lines[i])) return -1
    for (let k = i; k < end; k++) if (/\*\*\s*$/.test(lines[k]) && (k > i || lines[k].length > 2)) return k
    return -1
  }
  const out: string[] = lines.slice(0, start + 1)
  let stripped = 0
  let i = start + 1
  while (i < end) {
    const le = labelEnd(i)
    if (le < 0) { out.push(lines[i]); i++; continue }
    const label = lines.slice(i, le + 1).join(' ')
    let j = le + 1
    let sawQuote = false
    let anchorScene: string | null = null
    while (j < end) {
      const line = lines[j]
      if (labelEnd(j) >= 0) break
      const a = /arc:touchstone-anchor\s+(\{.*\})/.exec(line)
      if (a) { try { anchorScene = (JSON.parse(a[1]) as { scene?: string }).scene ?? null } catch { /* absent */ } }
      if (/^>\s?/.test(line)) sawQuote = true
      else if (sawQuote && line.trim() === '') { j++; break }
      j++
    }
    const m = /\bfrom\s+([\w./-]+)/.exec(label)
    const mine = (m !== null && m[1].replace(/[,:]+$/, '') === fileish) || anchorScene === target.scene
    if (mine) { stripped++; out.push(`**(a touchstone drawn from ${target.scene} is withheld from this pass — it is the current route)**`, '') }
    else out.push(...lines.slice(i, j))
    i = j
  }
  out.push(...lines.slice(end))
  return stripped ? out.join('\n') : style
}

/** The coverage tail: the one machine-readable thing the pass returns. Parsed
 *  tolerantly; absent or unreadable means null — shown as "not reported",
 *  never guessed. */
export function parseCoverageTail(briefing: string): { briefing: string; coverage: RouteCoverage[] | null; unparseable: number } {
  const fence = /```(?:json)?\s*([\s\S]*?)```\s*$/
  const m = briefing.match(fence)
  let raw: string | null = null
  let rest = briefing
  if (m) { raw = m[1]; rest = briefing.slice(0, m.index).trimEnd() }
  else {
    const bare = briefing.match(/(\{[\s\S]*"coverage"[\s\S]*\})\s*$/)
    if (bare) { raw = bare[1]; rest = briefing.slice(0, bare.index).trimEnd() }
  }
  if (raw === null) return { briefing: briefing.trim(), coverage: null, unparseable: 0 }
  try {
    const first = raw.indexOf('{'); const last = raw.lastIndexOf('}')
    const parsed = JSON.parse(first >= 0 && last > first ? raw.slice(first, last + 1) : raw) as unknown
    const rows = Array.isArray(parsed) ? parsed : (parsed as { coverage?: unknown })?.coverage
    if (!Array.isArray(rows)) return { briefing: rest, coverage: null, unparseable: 0 }
    const usable = rows
      .filter((r): r is { item: unknown; paragraph: unknown } => !!r && typeof r === 'object')
      .filter(r => typeof r.item === 'string' && r.item.trim())
    const coverage = usable
      .map(r => ({ item: String(r.item).trim(), paragraph: Number.isInteger(r.paragraph) && (r.paragraph as number) > 0 ? r.paragraph as number : null }))
    // A row that is not a claim at all — no item, or not an object — is
    // counted rather than silently dropped (§4: every drop is counted by
    // reason).
    return { briefing: rest, coverage, unparseable: rows.length - usable.length }
  } catch {
    return { briefing: rest, coverage: null, unparseable: 0 }
  }
}

/** The share of a paragraph's words that survive, IN ORDER, in another —
 *  longest common subsequence over lowercased words. Touchstones measure
 *  survival with an edit-distance bound instead (touchstones.ts), which is
 *  right for finding a passage's own descendant and wrong here: for a short
 *  fresh sentence against a long current one the bound admits almost any
 *  pair that shares a few names — "Ines", "the stairs", "the sea" — as a
 *  descendant. A reuse gate needs the words actually reused. */
export function wordSurvival(passage: string, other: string): number {
  const tok = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, ' ').split(/\s+/).filter(Boolean)
  const a = tok(passage); const b = tok(other)
  if (!a.length) return 0
  let prev = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0)
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    prev = cur
  }
  return prev[b.length] / a.length
}

/** Under this survival a paragraph is not a reuse of any current paragraph —
 *  the same 60% bar touchstones use to call a passage a descendant. */
export const SURVIVAL_BAR = 0.6

/** EVIDENCE RESOLUTION, minimal (A67-8; §4, "Evidence resolution").
 *
 *  Every argued claim names its evidence by id from the slice it was given.
 *  A route's coverage claims name beats; each is resolved against the
 *  DESTINATION the pass was handed, and a claim naming a beat the
 *  destination did not hold is DROPPED and counted by reason — never shown
 *  beside the required ones as though it were evidence of anything.
 *
 *  Every required beat still gets a row whether or not the pass mentioned
 *  it (matched exactly, or by ≥60% of the item's words surviving in order,
 *  because the model paraphrases); a beat the tail never named shows as not
 *  reported.
 *
 *  `known` is what the record holds but did not bind — arc's own key
 *  points, which are context and never the destination. A claim that
 *  matches one of those is *outside the slice*; a claim that matches
 *  nothing is *unresolvable*. */
export function resolveCoverage(
  destination: string[],
  rows: RouteCoverage[] | null,
  known: string[] = [],
): { coverage: RouteCoverage[] | null; dropped: DroppedClaim[]; returned: number } {
  if (rows === null) return { coverage: null, dropped: [], returned: 0 }
  const used = new Set<number>()
  const matches = (item: string, other: string): number => {
    const a = norm(item).toLowerCase(); const b = norm(other).toLowerCase()
    return a === b ? 1 : Math.max(wordSurvival(item, other), wordSurvival(other, item))
  }
  const find = (item: string): RouteCoverage | undefined => {
    let best = -1; let bestScore = 0
    rows.forEach((r, i) => {
      if (used.has(i)) return
      const score = matches(item, r.item)
      if (score > bestScore) { bestScore = score; best = i }
    })
    if (best < 0 || bestScore < SURVIVAL_BAR) return undefined
    used.add(best)
    return rows[best]
  }
  const coverage: RouteCoverage[] = destination.map(item => {
    const hit = find(item)
    return { item, paragraph: hit ? hit.paragraph : null }
  })
  const counts = new Map<DroppedClaim['reason'], number>()
  let returned = used.size
  rows.forEach((r, i) => {
    if (used.has(i)) return
    // A beat stated twice is a RESTATEMENT, not a drop: its evidence
    // resolved, and the row it belongs to is already in the coverage above.
    // Only a claim that resolves to nothing the pass was asked to reach is
    // dropped, and then it is counted by reason.
    if (destination.some(item => matches(item, r.item) >= SURVIVAL_BAR)) { returned++; return }
    const reason: DroppedClaim['reason'] = known.some(k => matches(k, r.item) >= SURVIVAL_BAR)
      ? 'outside the slice'
      : 'unresolvable'
    counts.set(reason, (counts.get(reason) ?? 0) + 1)
  })
  return { coverage, dropped: [...counts].map(([reason, count]) => ({ reason, count })), returned }
}

/** PROVEN: how much of the current wording the answer reused. Not a proof of
 *  a different route — a model could keep the structure and paraphrase every
 *  sentence — so the name says exactly what it measures. */
export function lexicalOverlap(alternative: string, current: string, locked: string[]): { share: number | null; counted: number; overlapping: number } {
  const lockedNorm = new Set(locked.map(norm))
  const currentParas = paragraphsOf(current).filter(p => words(p) >= MIN_COUNTED_WORDS)
  const altParas = paragraphsOf(alternative).filter(p => words(p) >= MIN_COUNTED_WORDS && !lockedNorm.has(norm(p)))
  const counted = altParas.length
  if (counted < MIN_COUNTED_PARAS) return { share: null, counted, overlapping: 0 }
  const overlapping = altParas.filter(p => currentParas.some(c => wordSurvival(p, c) >= SURVIVAL_BAR)).length
  return { share: overlapping / counted, counted, overlapping }
}

/** The one countable style rule the contract states as a number: "A chain
 *  stops at three." Read from the ratified contract, never from a constant,
 *  so the author owns the number; absent from the contract, there is no gate.
 *  Words up to twelve are accepted alongside digits. */
export function andCapFromContract(style: string): number | null {
  const m = /\bchain stops at (\w+)\b/i.exec(style)
  if (!m) return null
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 }
  const n = words[m[1].toLowerCase()] ?? Number(m[1])
  return Number.isInteger(n) && n > 0 ? n : null
}

/** PROVEN: sentences that join more than `cap` "and"s. The count is the
 *  decidable half of §3's rule; whether a chain is one process deepening or
 *  a procedure stays the author's reading. Locked paragraphs are the
 *  author's settled text and are never counted against. */
export function andChainViolations(body: string, cap: number, locked: string[] = []): { sentence: string; ands: number }[] {
  const lockedNorm = new Set(locked.map(norm))
  const out: { sentence: string; ands: number }[] = []
  for (const para of paragraphsOf(body)) {
    if (lockedNorm.has(norm(para))) continue
    for (const sentence of splitSentences(para)) {
      const ands = (sentence.text.match(/\band\b/gi) ?? []).length
      if (ands > cap) out.push({ sentence: sentence.text.trim(), ands })
    }
  }
  return out
}

/** The second countable rule: "A sentence stops at N words." A run-on is a
 *  run-on however it is joined — the first live route carried a 64-word
 *  sentence on two "and"s and six commas, longer than anything in the
 *  author's own manuscript (max 63, 95th percentile 44). Read from the
 *  contract like the and-cap; absent, no gate. */
export function wordCapFromContract(style: string): number | null {
  const m = /\bsentence stops at (\d+) words?\b/i.exec(style)
  if (!m) return null
  const n = Number(m[1])
  return Number.isInteger(n) && n > 0 ? n : null
}

/** PROVEN: sentences longer than `cap` words; locked paragraphs never counted. */
export function longSentenceViolations(body: string, cap: number, locked: string[] = []): { sentence: string; words: number }[] {
  const lockedNorm = new Set(locked.map(norm))
  const out: { sentence: string; words: number }[] = []
  for (const para of paragraphsOf(body)) {
    if (lockedNorm.has(norm(para))) continue
    for (const sentence of splitSentences(para)) {
      const n = words(sentence.text)
      if (n > cap) out.push({ sentence: sentence.text.trim(), words: n })
    }
  }
  return out
}

/** PROVEN: locked paragraphs keep their relative order. A missing one is
 *  lockViolations' finding; this only asks about the ones that survived. */
export function lockOrderViolation(rebuilt: string, lockedInOrder: string[]): boolean {
  const paras = paragraphsOf(rebuilt).map(norm)
  let last = -1
  for (const text of lockedInOrder) {
    const at = paras.indexOf(norm(text))
    if (at < 0) continue
    if (at < last) return true
    last = at
  }
  return false
}

// ---- the alternatives store: beside the manuscript, never in it ----------

const DIR = (scene: string) => path.join(STORY, '.arc', 'alternatives', scene)
const FM_RE = /^---\n([\s\S]*?)\n---\n/

function serialize(alt: RouteAlternative): string {
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
    body, briefing,
    coverage: Array.isArray(head.coverage) ? head.coverage as RouteCoverage[] : null,
    ...(Array.isArray(head.dropped) ? { dropped: head.dropped as DroppedClaim[] } : {}),
    overlap: typeof head.overlap === 'number' ? head.overlap : null,
    ...(typeof head.retried === 'string' ? { retried: head.retried } : {}),
    ...(typeof head.revises === 'string' ? { revises: head.revises } : {}),
    ...(Array.isArray(head.notes) ? { notes: head.notes as RouteNote[] } : {}),
  }
}

/** Every generated alternative for a scene, newest first. */
export function listAlternatives(scene: string): RouteAlternative[] {
  const dir = DIR(scene)
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
function removeAlternative(alt: RouteAlternative, disposition: Disposition, because: string): boolean {
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
    fs.rmSync(path.join(DIR(alt.scene), `${alt.id}.md`), { force: true })
    return true
  } catch (e) {
    console.error('[warn] route file could not be removed:', e)
    return false
  }
}

export function writeAlternative(alt: RouteAlternative): void {
  const dir = DIR(alt.scene)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${alt.id}.md`), serialize(alt))
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

const bodyHash = (body: string): string => sha16(body.trim())

/** The locks that would constrain a reroute of this scene — named before the
 *  run so the author knows the surrounding context of a settled paragraph
 *  will change, and that a whole-scene lock refuses the run entirely. */
export function constrainingLocks(scene: string): RouteLockNotice[] {
  const s = proseScenes().find(x => x.scene === scene)
  if (!s) return []
  return locksOn(scene, s.body)
    .filter(l => l.resolution.state === 'resolved' || l.resolution.state === 'drifted')
    .filter(l => l.scope === 'paragraph' || l.scope === 'scene' || l.scope === 'chapter')
    .map(l => ({ id: l.id, scope: l.scope as 'paragraph' | 'scene' | 'chapter', paragraph: l.resolution.paragraph }))
}

/** THE RECEIPT THE AUTHOR READS (A67-11). A projection of the run's working
 *  receipt, not the thing itself: the fingerprints, the session ids, the
 *  transcript paths and the git revision stay on disk, because none of them
 *  belongs on a page beside the prose. What crosses: what the pass was given,
 *  the three separate readings of what it was not, the gates, the ending, and
 *  the request in the author's own words.
 *
 *  ONE RUN, SEVERAL ROUTES. A run answers every seed it was asked for, and
 *  they share one receipt — so the projection keeps only the launches that
 *  made THIS route. Showing a route the gate records of its siblings puts two
 *  answers' checks under one heading and lets a sentence blame this route for
 *  what another one did; `launch` exists on the record precisely so the two
 *  never blur.
 *
 *  AND A ROUTE ON DISK LANDED. It is on disk because it passed its gates; a
 *  stop that killed a later seed, or a sibling that was refused, is the run's
 *  ending and not this route's. So the route's own ending is `landed` and it
 *  says nothing about why it did not — because it did.
 *
 *  A route written by an older arc has no run, so it has no receipt — which
 *  is the difference the reader shows rather than hides (criterion 6). A route
 *  whose run exists but whose receipt cannot be read is NOT that, and the
 *  difference is `alt.run`, which the reader reads for itself. */
export function routeReceipt(alt: RouteAlternative): RouteReceipt | null {
  if (!alt.run) return null
  const r = readWorkingReceipt(alt.run)
  if (!r) return null
  const mine = (r.gates ?? []).filter(g => !g.launch || !alt.seed || g.launch.startsWith(`${alt.seed}-`))
  return {
    run: r.run_id,
    ...(r.request ? { request: { gesture: r.request.gesture, cell: r.request.cell, ...(r.request.subject ? { subject: subjectWords(r.request.subject) } : {}) } } : {}),
    given: r.slice?.included ?? [],
    withheld_by_design: r.slice?.withheld_by_design ?? [],
    dropped_for_budget: r.slice?.dropped_for_budget ?? [],
    runtime_added: (r.slice?.runtime_added ?? []).map(addedWords),
    gates: mine.map(g => ({
      gate: g.gate, says: gateName(g.gate), verdict: g.verdict, attempt: g.attempt,
      bar: figure(g.bar), measured: figure(g.measured),
    })),
    ending: 'landed',
    outcome: null,
    ...(r.engine ? { engine: r.engine } : {}),
    ...(typeof r.wall_clock_ms === 'number' ? { wall_clock_ms: r.wall_clock_ms } : {}),
    started_at: r.started_at,
    decided_at: r.decided_at,
  }
}

/** A figure the author reads: a share like 0.3333333333333333 is the same
 *  number as 0.33 and one of them is unreadable. Integers and strings pass
 *  through as they are. */
const figure = (v: number | string | null | undefined): number | string | null =>
  typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 100) / 100 : v ?? null

/** The subject of the request, in the author's terms. A scene id is what the
 *  viewer labels its scenes with and the author reads it every day; a route id
 *  is a hash, and no author has ever wanted one. */
const subjectWords = (subject: string): string =>
  /^alt-/.test(subject) ? 'this route' : subject

/** What the runtime added, said rather than named. `recordedEnvelope` reports
 *  fields the way the record keeps them — `user_level_skills`, and where each
 *  was observed. The record keeps that; the page says it in words (rule 9). */
const ADDED_WORDS: Record<string, string> = {
  user_level_skills: 'skills installed for your user account',
  subagents_available: 'the helper sessions the runtime had loaded (none reachable — this pass has no tools)',
  memory: 'the memory files the runtime loads',
  user_level_instructions: 'your own standing instructions (~/CLAUDE.md)',
  project_instructions_above_the_launch_directory: 'project instructions above the folder it ran in',
  runtime: 'the runtime and its version',
}
const addedWords = (entry: string): string => {
  // `field — where it was observed`. The record keeps the where; the page
  // says what it is. An entry that is already a sentence is left alone, and a
  // field arc has no words for is said with spaces rather than underscores
  // rather than being dropped — an unnamed thing the runtime added is still
  // something the author should be told about.
  const [head, ...rest] = entry.split(' — ')
  const field = head.trim()
  if (ADDED_WORDS[field]) return ADDED_WORDS[field]
  if (!/^[a-z][a-z0-9_]*$/.test(field)) return entry
  const said = field.replace(/_/g, ' ')
  return rest.length ? `${said} — ${rest.join(' — ')}` : said
}

/** Every route as the reader takes it: its staleness, and its receipt.
 *
 *  `reads` does not cross. It is the fingerprint of everything the pass was
 *  given — the style contract, the scene body, the canon pack, every note and
 *  every lock — and staleness is already decided here, on the server, and sent
 *  as `stale`. Shipping the hashes as well would hand a page beside the prose
 *  the content fingerprints of the record, which is exactly what the receipt
 *  projection exists to keep off it. */
const asRead = (a: RouteAlternative, now: Fingerprints): RouteAlternative => {
  const read = withStaleness(a, now)
  delete read.reads
  return { ...read, receipt: routeReceipt(a) }
}

export function listRoutes(scene: string): RouteListResponse {
  if (!proseScenes().some(s => s.scene === scene)) throw new HttpError(400, `no scene ${scene}`)
  const now = fingerprintsNow(scene)
  return { scene, alternatives: listAlternatives(scene).map(a => asRead(a, now)), locks: constrainingLocks(scene) }
}

/** Adopt: the alternative's body enters the working tree through the same
 *  lock-gated write every scene edit uses, with the current body as the
 *  baseline so a stale route cannot clobber a newer edit. Only now does the
 *  ledger record the route — the pair learning will mine begins here. */
export function adoptAlternative(scene: string, id: string): AdoptRouteResponse {
  const s = proseScenes().find(x => x.scene === scene)
  if (!s) throw new HttpError(400, `no scene ${scene}`)
  const alt = listAlternatives(scene).find(a => a.id === id)
  if (!alt) throw new HttpError(404, `no alternative ${id} for ${scene}`)
  // A stale route is never written over newer work (invariant 1): the
  // ground moved under it, and the author re-runs it or cancels it.
  const staleness = withStaleness(alt, fingerprintsAtWrite(scene)).stale
  if (staleness && staleness.why === 'the record moved') {
    throw new HttpError(409, `${staleness.changed.includes(scene) ? 'this scene has changed' : 'what that route was written from has changed'} since that route was written, so arc did not put it into the book — run it again from where the scene stands now, or cancel it.`)
  }
  const written = proseWrite(s.file, alt.body.trim() + '\n', s.body)
  const full = fs.readFileSync(path.join(STORY, s.file), 'utf8')
  recordGenerated(s.file, full, { engine: currentEngine() ?? 'sdk', scene, origin: 'reroute', run: alt.run, route: alt.id })
  // The author decided about this route, so its receipt joins the record —
  // ids, hashes and links only. The commit follows at the accept
  // (`stampReceiptCommit`), which is the artefact this receipt is committed
  // beside. A route written by an older arc carries no run and no receipt.
  // The author decided about this route: adopted (§4, the evidence log).
  recordDisposition({
    scene, route: alt.id, disposition: 'adopted',
    notes: (alt.notes ?? []).map(n => ({ body: n.body, paragraph: n.paragraph, at: n.created_at })),
    because: `taken into ${s.file}`,
    ...(alt.run ? { run: alt.run } : {}),
  })
  if (alt.run) {
    const working = readWorkingReceipt(alt.run)
    if (working) {
      const decidedAt = new Date()
      // The route landed when the run ended; everything after that was the
      // author reading it. Never budget (§4, the engine seam).
      const landedAt = Date.parse(working.decided_at || working.started_at)
      writeReceipt({
        ...working,
        decided_at: decidedAt.toISOString(),
        story_revision_at_decision: storyRevision(),
        ...(Number.isFinite(landedAt) ? { waiting_on_author_ms: Math.max(0, decidedAt.getTime() - landedAt) } : {}),
        author_decision: { decision: 'accepted', note: `adopted ${alt.id} into ${s.file}` },
        result: { records: [s.file], commit: null },
      })
    }
  }
  return { scene: written, file: s.file }
}

/** Cancel: the author is done with this route. A judgement, so it is
 *  recorded as one — with their notes on it — before the file goes. */
export function dropAlternative(scene: string, id: string): void {
  const file = path.join(DIR(scene), `${id}.md`)
  if (!/^alt-[0-9a-f]+$/.test(id) || !fs.existsSync(file)) throw new HttpError(404, `no alternative ${id} for ${scene}`)
  const alt = listAlternatives(scene).find(a => a.id === id)
  if (!alt) throw new HttpError(404, `no alternative ${id} for ${scene}`)
  if (!removeAlternative(alt, 'cancelled', 'the author cancelled it')) {
    throw new HttpError(500, 'arc could not write the decision to the evidence log, so it left the route where it is — nothing was lost. Check that the story folder is writable and cancel it again.')
  }
}

// ---- the run --------------------------------------------------------------

export interface RerouteTarget {
  scene: string
  count?: number
  guidance?: string
  dry?: boolean
  /** the gesture the author made, resolved by code at the door (A67-8).
   *  Absent only for a caller inside arc — the CLI, a test — which gets the
   *  default cell for this pass. */
  request?: ResolvedRequest
}

/** The run was stopped while this launch was in flight. */
const wasStopped = (run: Run, kind?: EngineErrorKind): boolean => stateOf(run.id) === 'cancelled' || kind === 'cancelled'

/** How a run that produced nothing ended.
 *
 *  A stop wins over everything: the author ended it. Then a GATE refusal,
 *  because that is what stopped the run — a repair that could not run
 *  afterwards is in the gate records and in the sentence, and does not
 *  relabel the refusal. Otherwise the kind the seam reported. */
function endingOf(refused: { kind?: EngineErrorKind; gateRefused?: boolean; unreadable?: boolean }[], stopped: boolean): RunEnding {
  if (stopped || refused.some(r => r.kind === 'cancelled')) return 'cancelled'
  const first = refused[0]
  if (!first) return 'refused'
  // An answer that parsed to nothing is unreadable, never an empty route.
  if (first.unreadable) return 'unreadable'
  if (first.gateRefused || !first.kind) return 'refused'
  if (first.kind === 'timed out') return 'timed out'
  // unreachable · rate-limited · died · envelope: the pass never wore its
  // label, which is what `could not run` says.
  return 'could not run'
}

/** The run and the receipt it is writing — one object, so every step of a
 *  pass adds to the same record. */
export interface RunCtx { run: Run; receipt: Receipt }

/** The route run: minted before the first token, registered so the hook
 *  joins it and a stop can reach it, its receipt open from the launch, and
 *  ended on every way out with its ending on both. What landed before a
 *  stop stays. */
async function underRun(
  request: ResolvedRequest,
  row: SealedRow,
  slice: SliceSpecUsed,
  work: (ctx: RunCtx, kinds: { kind?: EngineErrorKind; gateRefused?: boolean; unreadable?: boolean }[]) => Promise<RerouteResponse>,
): Promise<RerouteResponse> {
  // Why each seed failed, in arc's words rather than the author's — the
  // ending is read from these, never from the sentence the author sees.
  const kinds: { kind?: EngineErrorKind; gateRefused?: boolean; unreadable?: boolean }[] = []
  const run = new Run('ui', request.gesture, { subject: request.subject })
  registerRun(run)
  const receipt = emptyReceipt(run)
  // The request as the author made it, and the cell it resolved to.
  receipt.request = { gesture: request.gesture, cell: request.cell, subject: request.subject }
  receipt.cell = { job: row.job, scope: row.scope, mode: row.mode, depth: row.depth, stage: row.stage }
  receipt.produced_by = { arc_commit: arcRevision(), job_fingerprint: jobFingerprint(row) }
  receipt.slice = { included: slice.included, withheld_by_design: slice.withheld, dropped_for_budget: slice.dropped, runtime_added: [] }
  receipt.context_manifest = slice.read
  receipt.gates = []
  receipt.evidence = { returned: 0, dropped: [] }
  writeWorkingReceipt(receipt)
  const ctx: RunCtx = { run, receipt }
  const close = (ending: RunEnding): void => {
    receipt.ending = ending
    receipt.decided_at = new Date().toISOString()
    writeWorkingReceipt(receipt)
  }
  try {
    const out = await work(ctx, kinds)
    const stopped = stateOf(run.id) === 'cancelled'
    const ending = out.alternatives.length ? (stopped ? 'cancelled' : 'landed') : endingOf(kinds, stopped)
    close(ending)
    endRun(run.id, ending, { landed: out.alternatives.map(a => a.id), refused: out.refused.length })
    // What the author reads about a seed that did not land, rendered HERE by
    // code from that seed's own ending and the gate records — never from the
    // answer's words, which a model wrote (A67-11, criterion 4). `kinds` is
    // pushed in step with `refused`, so seed i is judged on its own failure
    // and not on the run's.
    const refused = out.refused.map((r, i) => ({
      ...r,
      run: run.id,
      outcome: outcomeSentence({
        ending: endingOf(kinds[i] ? [kinds[i]] : kinds, stopped),
        // This seed's own gate records, never the run's: one receipt holds
        // every seed's, and a sentence built from all of them can name the
        // gate that refused a DIFFERENT answer. `launch` is what tells them
        // apart (`late-entry-1`, `pressure-first-2`).
        gates: (receipt.gates ?? []).filter(g => g.launch?.startsWith(`${r.seed}-`)),
      }) ?? undefined,
    }))
    // The receipt is on disk before the answer leaves, so every route the
    // author is handed can already show how it came to be.
    // Keyed off the route's OWN scene: a rewrite's subject is the route, not
    // the scene, and a fingerprint map built from the wrong id would call
    // every route stale.
    return { ...out, refused, alternatives: out.alternatives.map(a => asRead(a, fingerprintsNow(a.scene))), run: run.id }
  } catch (e) {
    const ending: RunEnding = stateOf(run.id) === 'cancelled' ? 'cancelled' : 'could not run'
    close(ending)
    endRun(run.id, ending, { error: (e as Error).message })
    // A STOP IS AN ANSWER, NOT AN ERROR (A67-11, criterion 3). The author
    // pressed stop; throwing here makes the request fail, and a failed
    // request whose error carries no message says nothing at all — the run
    // ends, the page goes quiet, and the author is left guessing whether the
    // press did anything. So a stopped run returns like any other run that
    // did not land: one refusal, with the sentence code renders for it.
    if (ending === 'cancelled') {
      return {
        alternatives: [],
        refused: [{
          seed: 'stopped',
          reason: 'stopped before it landed',
          outcome: outcomeSentence({ ending, gates: receipt.gates }) ?? undefined,
          run: run.id,
        }],
        run: run.id,
      }
    }
    throw e
  }
}

/** What the slice actually held for one run: the layers that went in, what
 *  was withheld by design, what was dropped for room, and the fingerprints
 *  of everything read. */
export interface SliceSpecUsed {
  included: string[]
  withheld: string[]
  dropped: string[]
  read: { id: string; version: string }[]
}

/** The row's withheld set, realised (A67-7): the scene as it stands, the
 *  author's open note quotes and the style contract's touchstones — less
 *  the locked paragraphs the pass sends on purpose and the contract's
 *  quoted literals. The ROW says what the set is made of; this turns that
 *  into the texts the runner proves the brief against. */
export function withheldSet(row: SealedRow, a: {
  sceneBody: string
  locked: string[]
  literals: string[]
  /** the route the rewrite is working ON. Its text is the pass's SUBJECT,
   *  sent on purpose: a span of the scene that survived into a landed route
   *  passed the overlap gate already, and refusing every rewrite of it would
   *  strand the author in front of a message about a note they cannot find. */
  subject?: string
}): WithheldSet | undefined {
  if (!row.withheld) return undefined
  // The set is the SCENE, and only the scene. The row's `plus` names where
  // a leak comes from — a note that quotes the prose, a touchstone drawn
  // from it — and both of those are quotes OF the scene, so a span of the
  // scene in the brief is exactly what catches them. Putting the notes or
  // the style contract into the set instead would fire on the author's own
  // words about the scene, which are theirs to send.
  return {
    text: [a.sceneBody],
    allowed: [
      ...(row.withheld.less.includes('locked paragraphs') ? a.locked : []),
      ...(row.withheld.less.includes('quoted contract literals') ? a.literals : []),
      ...(a.subject ? [a.subject] : []),
    ],
    spanWords: row.withheld.spanWords,
  }
}

/** The fingerprints of everything a route pass read — taken from the text
 *  it actually assembled, not from a map of canon records, because what a
 *  brief read is the style contract as composed, the pack as built and the
 *  scene as it stands. Invariant 1 compares these at the write path. */
export function readManifest(a: {
  style: string
  scene: string
  sceneBody: string
  pack: string
  notes: { id: string; body: string }[]
  locks: { id: string; quote: string }[]
  siblings: string
  route?: string
}): { id: string; version: string }[] {
  return [
    { id: 'style', version: sha16(a.style) },
    { id: a.scene, version: sha16(a.sceneBody) },
    { id: `pack:${a.scene}`, version: sha16(a.pack) },
    // Named even when empty: a chapter that GAINS a sibling scene has moved
    // under a route that was written when it had none, and an id the route
    // never recorded can never be compared.
    { id: `siblings:${a.scene}`, version: sha16(a.siblings) },
    ...(a.route ? [{ id: 'route', version: sha16(a.route) }] : []),
    ...a.notes.map(n => ({ id: n.id, version: sha16(n.body) })),
    ...a.locks.map(l => ({ id: l.id, version: sha16(l.quote) })),
  ]
}

/** A refusal before anything is spent still leaves a receipt, with the
 *  stage it refused at (invariant 9: EVERY run ends with one). */
export function refuseWithReceipt(request: ResolvedRequest, row: SealedRow, gate: GateRecord, message: string, status: number): never {
  const run = new Run('ui', request.gesture, { subject: request.subject })
  registerRun(run)
  const receipt = emptyReceipt(run)
  receipt.request = { gesture: request.gesture, cell: request.cell, subject: request.subject }
  receipt.cell = { job: row.job, scope: row.scope, mode: row.mode, depth: row.depth, stage: row.stage }
  receipt.produced_by = { arc_commit: arcRevision(), job_fingerprint: jobFingerprint(row) }
  receipt.gates = [gate]
  receipt.ending = gate.stage === 'launch' ? 'could not run' : 'refused'
  receipt.decided_at = new Date().toISOString()
  // The WORKING receipt only: history/ is written at the author's decision
  // (§4), and a refusal that produced nothing never reaches one. `arc
  // doctor` counts run records with no receipt, which this is not.
  writeWorkingReceipt(receipt)
  endRun(run.id, receipt.ending, { refused: message })
  throw new HttpError(status, message)
}

/** A seed's outcome. A refusal carries the sentence the author reads, and
 *  — when the engine was what failed — the KIND, because a transport
 *  failure earns no repair (invariant 5). The kind is a field rather than a
 *  prefix on the sentence: the sentence is what the author sees. */
type GateResult =
  | { ok: true; alt: RouteAlternative }
  | { ok: false; reason: string; gates: GateRecord[]; kind?: EngineErrorKind; gateRefused?: boolean; unreadable?: boolean }

/** The cell this pass is, for a caller inside arc that made no gesture. */
const defaultRequest = (row: SealedRow, said: string, subject: string): ResolvedRequest => ({
  gesture: said, cell: `${row.job} · ${row.scope} · ${row.mode}`, row, subject,
})

export async function runReroute(t: RerouteTarget): Promise<RerouteResponse> {
  const request = t.request ?? defaultRequest(ROW_EXPLORE_SCENE, `another way through ${t.scene}`, t.scene)
  const scene = proseScenes().find(s => s.scene === t.scene)
  if (!scene) throw new HttpError(400, `no scene ${t.scene}`)
  // At the cap the author decides what goes. Checked before any token is
  // spent, and in the backend rather than the button, because a limit only
  // the viewer knows is not a limit.
  const waiting = routesWaiting(t.scene)
  if (waiting >= MAX_ROUTES) {
    refuseWithReceipt(request, ROW_EXPLORE_SCENE,
      { gate: 'route-cap', verdict: 'refused', attempt: 1, stage: 'intake', measured: waiting, bar: MAX_ROUTES, bar_from: `MAX_ROUTES, arc-backend ${MAX_ROUTES}` },
      `this scene already holds ${MAX_ROUTES} other ways through — cancel one you are done with to make room for another`, 409)
  }
  // Never take a scene past the cap: a request for two with room for one
  // returns one rather than being refused outright.
  const count = Math.min(t.count ?? 2, MAX_ROUTES - waiting)
  if (!Number.isInteger(count) || count < 1 || count > SEEDS.length) throw new HttpError(400, `count must be 1–${SEEDS.length}`)

  // ---- PRECONDITIONS: proven refusals, before anything is spent -----------
  const kps = sceneKeypoints(t.scene, annotations())
  const destination = buildDestination(scene.contract, kps.author)
  if (!destination.length) {
    refuseWithReceipt(request, ROW_EXPLORE_SCENE,
      { gate: 'destination', verdict: 'refused', attempt: 1, stage: 'slice', measured: 0, bar: 1, bar_from: "the scene's contract and its author-marked key points" },
      `${t.scene} declares no contract and carries no author-marked key points — there is no destination to reroute to; write one first`, 400)
  }
  const live = locksOn(t.scene, scene.body)
    .filter(l => l.resolution.state === 'resolved' || l.resolution.state === 'drifted')
  const whole = live.find(l => l.scope === 'scene' || l.scope === 'chapter')
  if (whole) {
    refuseWithReceipt(request, ROW_EXPLORE_SCENE,
      { gate: 'locks', verdict: 'refused', attempt: 1, stage: 'intake', bar: 0, bar_from: 'locks/', measured_against: [whole.id] },
      `${whole.scope === 'chapter' ? 'this chapter' : 'this section'} is locked (${whole.id}) — the author settled it whole; a reroute would unsettle it. Unlock it to take another way through.`, 423)
  }
  // A dry run consults no engine, so it needs none; a live one refuses here,
  // before the slice is assembled.
  if (!t.dry && !(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) && !currentEngine()) {
    refuseWithReceipt(request, ROW_EXPLORE_SCENE,
      { gate: 'engine', verdict: 'could not judge', attempt: 1, stage: 'launch', bar_from: 'an engine the seam can reach' },
      'no engine configured — set ANTHROPIC_API_KEY in arc-backend/.env, or log in to the claude CLI', 400)
  }

  const paras = paragraphsOf(scene.body)
  const sceneLocks: ResolvedLock[] = live.filter(l => l.scope === 'paragraph' && l.resolution.paragraph !== null)
    .sort((x, y) => (x.resolution.paragraph as number) - (y.resolution.paragraph as number))
  const locked = sceneLocks.map(l => ({ paragraph: l.resolution.paragraph as number, text: paras[l.resolution.paragraph as number] ?? '' }))
  const lockedTexts = locked.map(l => l.text)

  // The canon pack, scoped exactly as redraft scopes it: the scene's own
  // bindings at the chapter's moment. Facts, in canon's order — never route.
  const { pack, siblings } = packAndSiblings(scene)
  const openNotes = openNotesOn(t.scene)

  const base = {
    scene, pack, style: styleForPass({ scene: t.scene, file: scene.file, body: scene.body }), siblings, notes: openNotes,
    destination, knownRoute: buildKnownRoute(kps.author, locked), inferred: inferredRoute(kps.agent),
    locked, guidance: t.guidance,
  }
  const literals = literalWithholds(scene.contract?.must_withhold)
  const andCap = andCapFromContract(base.style)
  const wordCap = wordCapFromContract(base.style)
  const basedOn = bodyHash(scene.body)
  const seeds = SEEDS.slice(0, count)

  // A dry run: the slice and the brief, rendered, and no engine consulted —
  // so it needs none.
  if (t.dry) return { alternatives: [], refused: [], briefs: seeds.map(seed => flattenPrompt(buildReroutePrompt({ ...base, seed }))) }

  // What the slice held, what it withheld by design, and the fingerprints
  // of everything read — the receipt's three headings (§4).
  const used: SliceSpecUsed = {
    included: [
      'style', 'contract', 'pack', 'destination', 'known-route',
      ...(base.inferred ? ['inferred'] : []), ...(locked.length ? ['locked'] : []),
      ...(siblings ? ['siblings'] : []), ...(openNotes.length ? ['notes'] : []),
    ],
    withheld: [
      `the current prose of ${t.scene} (${paras.length} paragraphs), less its locked paragraphs`,
      ...(literals.length ? [`the contract's quoted withholds (${literals.length})`] : []),
    ],
    dropped: [],
    read: readManifest({ style: base.style, scene: t.scene, sceneBody: scene.body, pack, notes: openNotes, locks: sceneLocks.map(l => ({ id: l.id, quote: String(l.anchor.quote ?? '') })), siblings }),
  }

  // The run exists before the first token, in the author's words, and its
  // record is on disk before the seam is called.
  return underRun(request, ROW_EXPLORE_SCENE, used, async (ctx, kinds) => {
  const { run, receipt } = ctx

  // Every seed is one job for the gate runner: it owns the child, walks
  // the row's gate ids, keeps the refused text, and offers the one repair
  // (A67-6). This pass supplies the brief, the repair's extra line, and
  // what its gates measure against — nothing else.
  const ctxGates = gateCtx({
    sceneName: t.scene, sceneBody: scene.body, sceneLocks, lockedTexts, literals, andCap, wordCap, destination,
    // arc's own key points are in the brief as context and bind nothing; a
    // claim that names one is outside the slice, not unresolvable.
    known: kps.agent.map(b => b.body),
  })

  const one = async (seed: { id: string; text: string }): Promise<GateResult> => {
    const prompt = buildReroutePrompt({ ...base, seed })
    const out = await runGates({
      row: ROW_EXPLORE_SCENE, run, receipt,
      brief: toBrief(prompt),
      // The one repair. Where the engine resumes, the brief is already in
      // the transcript and the refusal is the only new input; where it does
      // not, the SAME brief goes again with the refusal on the end — never a
      // fresh slice either way (invariant 5).
      repair: (refusal, resumed) => {
        const line = `YOUR PREVIOUS ANSWER WAS REFUSED: ${refusal} Take the route again from the destination you were given. The known route stays fenced; the locked paragraphs are verbatim and in order; reuse none of the current wording; no sentence joins more "and"s or runs more words than the style contract allows — break it into sentences. Answer in the two parts.`
        return resumed
          ? { blocks: [{ id: 'repair', cached: false, text: line }] }
          : toBrief({ ...prompt, user: `${prompt.user}\n\n${line}` })
      },
      attempt: n => `${seed.id}-${n}`,
      gateCtx: ctxGates,
      withheld: withheldSet(ROW_EXPLORE_SCENE, { sceneBody: scene.body, locked: lockedTexts, literals }),
      render: renderBrief,
    })
    if (!out.ok) return { ok: false, reason: out.reason, gates: out.gates, kind: out.kind, gateRefused: out.gateRefused, unreadable: out.unreadable }
    const created_at = new Date().toISOString()
    const id = 'alt-' + createHash('sha256').update(`${seed.id}\n${created_at}\n${out.checked.body}`).digest('hex').slice(0, 8)
    const alt: RouteAlternative = {
      id, scene: t.scene, seed: seed.id, guidance: t.guidance?.trim() || undefined, based_on: basedOn, created_at,
      body: out.checked.body, briefing: out.checked.briefing, coverage: out.checked.coverage, overlap: out.checked.overlap,
      ...(out.checked.dropped.length ? { dropped: out.checked.dropped } : {}),
      // What it read, so the write path can tell when the ground moved
      // under it (invariant 1).
      reads: used.read,
      run: run.id, ...(out.retried ? { retried: out.retried } : {}),
    }
    writeAlternative(alt)   // on disk as soon as it passed its gates, so a stop keeps it
    return { ok: true, alt }
  }

  // The SDK fans out: every call shares the two cached system blocks and only
  // the user turn differs. The CLI runs one prompt at a time.
  // A stop ends the run between seeds too — and a seed that was never
  // launched says so rather than vanishing from the answer.
  const results = currentEngine() === 'claude-cli'
    ? await seeds.reduce(async (acc, seed) => {
      const done = await acc
      if (stateOf(run.id) === 'cancelled') return [...done, { ok: false as const, reason: 'stopped before it started', gates: [], kind: 'cancelled' as const }]
      return [...done, await one(seed)]
    }, Promise.resolve([] as GateResult[]))
    : await Promise.all(seeds.map(one))

  const alternatives: RouteAlternative[] = []
  const refused: RerouteRefusal[] = []
  results.forEach((r, i) => {
    if (r.ok) { alternatives.push(r.alt); receipt.result.records = [...receipt.result.records, `.arc/alternatives/${t.scene}/${r.alt.id}.md`] }
    else {
      kinds.push({ kind: r.kind, gateRefused: r.gateRefused, unreadable: r.unreadable })
      refused.push({ seed: seeds[i].id, reason: r.reason === 'stopped before it started' ? r.reason : (wasStopped(run, r.kind) ? 'stopped before it landed' : r.reason) })
    }
  })
  // Deliberately NO recordGenerated here — see the header: the ledger learns
  // of a route only when it is adopted.
  return { alternatives, refused }
  })
}

// ---- the rewrite: a route revised under the same fence (A57) --------------

/** What this pass's gates measure against, in the shape the runner takes
 *  (gates.ts). The predicates travel with it, so the runner calls them by
 *  gate id and never reaches into this module. */
export function gateCtx(a: {
  sceneName: string
  sceneBody: string
  sceneLocks: ResolvedLock[]
  lockedTexts: string[]
  literals: string[]
  andCap: number | null
  wordCap: number | null
  destination: string[]
  /** what the record holds and the destination did not bind — arc's own
   *  key points, which are context; a claim that names one of these is
   *  *outside the slice* rather than unresolvable (A67-8) */
  known?: string[]
}): ProseGateCtx {
  return {
    ...a,
    known: a.known ?? [],
    maxOverlap: MAX_OVERLAP,
    lexicalOverlap, andChainViolations, longSentenceViolations, withholdViolations,
    lockOrderViolation, parseCoverageTail, resolveCoverage,
  }
}

/** Every check an answer must clear before it lands beside the scene — one
 *  set, shared by the reroute and the rewrite, so the two passes cannot
 *  drift apart gate by gate. */
// The gates themselves live in gates.ts, called by the runner from the
// row's gate ids (A67-6). This module keeps the measurements — what counts
// as overlap, what a chain is, where the coverage tail is — and hands them
// over in `gateCtx()`.
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


export interface RevisePromptInput {
  scene: ProseScene
  pack: string
  style: string
  destination: string[]
  knownRoute: string
  locked: { paragraph: number; text: string }[]
  routeBody: string
  /** the author's notes on this route — each with the paragraph it is about */
  notes: RouteNote[]
  /** an extra line typed at rewrite time, beside whatever the notes say */
  extra?: string
}

/** The rewrite's brief, in the author's own words: every note on the route,
 *  tagged with the paragraph it is about, plus anything typed at the moment
 *  of asking. Annotating a route IS how the next version is requested. */
export function reviseBrief(notes: RouteNote[], extra?: string): string {
  const lines = notes
    .filter(n => n.body?.trim())
    .map(n => `${n.paragraph === null ? '(the route as a whole)' : `¶${n.paragraph}`} — ${n.body.trim()}`)
  // A line typed at the moment of asking stands alone when it is the only
  // thing said; beside notes it is tagged, so the model can tell them apart.
  if (extra?.trim()) lines.push(lines.length ? `(said now) — ${extra.trim()}` : extra.trim())
  return lines.join('\n')
}

/** Pure prompt assembly. The scene body is not an input by construction —
 *  the subject is the ROUTE's text; the manuscript stays out exactly as in
 *  the reroute, and the same touchstone strip applies to the style block. */
export function buildRevisePrompt(a: RevisePromptInput): ReroutePrompt {
  const locked = a.locked.length
    ? `=== LOCKED PARAGRAPHS (reproduce VERBATIM, in this order) ===\n${a.locked.map(l => `[¶${l.paragraph + 1} in the current scene]\n${l.text}`).join('\n\n')}`
    : ''
  return {
    stable: [ROW_EXPLORE_ROUTE.rules, `=== THE STYLE CONTRACT (binding) ===\n${a.style}`].join('\n\n'),
    volatile: [
      `=== THE SCENE CONTRACT (${a.scene.scene}) ===\n${contractBlock(a.scene.contract)}`,
      `=== CONTEXT PACK (canon truth; every item carries its inclusion reason) ===\n${a.pack}`,
      `=== THE DESTINATION (must be accomplished, by any realization) ===\n${a.destination.map((d, i) => `${i + 1}. ${d}`).join('\n')}`,
      `=== THE MANUSCRIPT'S KNOWN ROUTE (do not drift toward this ordering or staging) ===\n${a.knownRoute}`,
      locked,
      `=== THE ROUTE AS IT STANDS (your subject — rewrite this; the numbers are the ¶ the author's notes name, and are not part of the prose) ===\n${paragraphsOf(a.routeBody).map((p, i) => `¶${i + 1}  ${p}`).join('\n\n')}`,
    ].filter(Boolean).join('\n\n'),
    user: [
      `=== THE AUTHOR'S NOTES ON THIS ROUTE (binding — keep what they keep, change what they name; a ¶ number is the paragraph of the route above) ===\n${reviseBrief(a.notes, a.extra)}`,
      'Run the rewrite pass. Answer in the two parts.',
    ].join('\n\n'),
  }
}

export interface ReviseTarget { scene: string; alt: string; note?: string; request?: ResolvedRequest }

/** Rewrite one alternative under the author's note. The result is a NEW
 *  version of the same route — `revises` names the parent, the old version
 *  stays on disk, and the ledger still learns of a route only on adopt. */
export async function runRevise(t: ReviseTarget): Promise<RerouteResponse> {
  const request = t.request ?? defaultRequest(ROW_EXPLORE_ROUTE, 'rewrite this route from my notes on it', t.alt)
  const scene = proseScenes().find(s => s.scene === t.scene)
  if (!scene) throw new HttpError(400, `no scene ${t.scene}`)
  const parent = listAlternatives(t.scene).find(a => a.id === t.alt)
  if (!parent) throw new HttpError(404, `no alternative ${t.alt} for ${t.scene}`)
  // The notes ARE the brief. A rewrite with nothing to say is a fresh
  // reroute, and that button already exists.
  const brief = reviseBrief(parent.notes ?? [], t.note)
  if (!brief.trim()) {
    refuseWithReceipt(request, ROW_EXPLORE_ROUTE,
      { gate: 'brief', verdict: 'refused', attempt: 1, stage: 'intake', measured: 0, bar: 1, bar_from: "the author's notes on the route" },
      'say what to change — note the route, or add a line, and the rewrite follows it', 400)
  }

  const kps = sceneKeypoints(t.scene, annotations())
  const destination = buildDestination(scene.contract, kps.author)
  if (!destination.length) {
    refuseWithReceipt(request, ROW_EXPLORE_ROUTE,
      { gate: 'destination', verdict: 'refused', attempt: 1, stage: 'slice', measured: 0, bar: 1, bar_from: "the scene's contract and its author-marked key points" },
      `${t.scene} declares no contract and carries no author-marked key points — there is no destination; write one first`, 400)
  }
  const live = locksOn(t.scene, scene.body)
    .filter(l => l.resolution.state === 'resolved' || l.resolution.state === 'drifted')
  const whole = live.find(l => l.scope === 'scene' || l.scope === 'chapter')
  if (whole) {
    refuseWithReceipt(request, ROW_EXPLORE_ROUTE,
      { gate: 'locks', verdict: 'refused', attempt: 1, stage: 'intake', bar: 0, bar_from: 'locks/', measured_against: [whole.id] },
      `${whole.scope === 'chapter' ? 'this chapter' : 'this section'} is locked (${whole.id}) — the author settled it whole; a rewrite would unsettle it. Unlock it to keep working the route.`, 423)
  }
  if (!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) && !currentEngine()) {
    refuseWithReceipt(request, ROW_EXPLORE_ROUTE,
      { gate: 'engine', verdict: 'could not judge', attempt: 1, stage: 'launch', bar_from: 'an engine the seam can reach' },
      'no engine configured — set ANTHROPIC_API_KEY in arc-backend/.env, or log in to the claude CLI', 400)
  }

  // The same context assembly as the reroute, minus the parts that describe
  // the manuscript's prose to a pass that must not drift toward it.
  const paras = paragraphsOf(scene.body)
  const sceneLocks: ResolvedLock[] = live.filter(l => l.scope === 'paragraph' && l.resolution.paragraph !== null)
    .sort((x, y) => (x.resolution.paragraph as number) - (y.resolution.paragraph as number))
  const locked = sceneLocks.map(l => ({ paragraph: l.resolution.paragraph as number, text: paras[l.resolution.paragraph as number] ?? '' }))
  const lockedTexts = locked.map(l => l.text)
  const canon = JSON.parse(canonJson()) as CanonDoc
  const chapter = (canon.chapters ?? []).find(c => c.id === scene.chapter)
  const at = dateOf(chapter?.span?.end) ?? dateOf(chapter?.span?.start)
  const pack = at
    ? buildContextPack(canon, { at, events: scene.events, pov: scene.pov ?? chapter?.pov })
    : buildContextPack(canon, { chapter: scene.chapter })
  const style = styleForPass({ scene: t.scene, file: scene.file, body: scene.body })
  const literals = literalWithholds(scene.contract?.must_withhold)
  const ctxGates = gateCtx({
    sceneName: t.scene, sceneBody: scene.body, sceneLocks, lockedTexts, literals,
    andCap: andCapFromContract(style), wordCap: wordCapFromContract(style), destination,
    known: kps.agent.map(b => b.body),
  })

  const prompt = buildRevisePrompt({
    scene, pack, style, destination,
    knownRoute: buildKnownRoute(kps.author, locked), locked,
    routeBody: parent.body, notes: parent.notes ?? [], extra: t.note,
  })
  const used: SliceSpecUsed = {
    included: ['style', 'contract', 'pack', 'destination', 'known-route', ...(locked.length ? ['locked'] : []), 'route', 'route-notes'],
    withheld: [`the current prose of ${t.scene} (${paras.length} paragraphs), less its locked paragraphs`],
    dropped: [],
    read: readManifest({ style, scene: t.scene, sceneBody: scene.body, pack, notes: [], locks: sceneLocks.map(l => ({ id: l.id, quote: String(l.anchor.quote ?? '') })), siblings: '', route: parent.body }),
  }
  return underRun(request, ROW_EXPLORE_ROUTE, used, async (rctx, kinds) => {
  const { run, receipt } = rctx
  // One job for the gate runner: it launches, walks the row's gates, keeps
  // the refused text and offers the one repair (A67-6).
  const out = await runGates({
    row: ROW_EXPLORE_ROUTE, run, receipt,
    brief: toBrief(prompt),
    // The one repair, resumed where the engine keeps a transcript and sent
    // whole where it does not (invariant 5).
    repair: (refusal, resumed) => {
      const line = `YOUR PREVIOUS ANSWER WAS REFUSED: ${refusal} Rewrite the route again under the author's note. The manuscript's known route stays fenced; the locked paragraphs are verbatim and in order; reuse none of the manuscript's wording; no sentence joins more "and"s or runs more words than the style contract allows. Answer in the two parts.`
      return resumed
        ? { blocks: [{ id: 'repair', cached: false, text: line }] }
        : toBrief({ ...prompt, user: `${prompt.user}\n\n${line}` })
    },
    attempt: n => `rewrite-${n}`,
    gateCtx: ctxGates,
    // The rewrite's subject is the ROUTE, so the route's own text is not
    // withheld — the scene's prose still is.
    withheld: withheldSet(ROW_EXPLORE_ROUTE, { sceneBody: scene.body, locked: lockedTexts, literals, subject: parent.body }),
    render: renderBrief,
  })
  if (!out.ok) {
    kinds.push({ kind: out.kind, gateRefused: out.gateRefused, unreadable: out.unreadable })
    return { alternatives: [], refused: [{ seed: parent.seed, reason: wasStopped(run, out.kind) ? 'stopped before it landed' : out.reason }] }
  }
  const created_at = new Date().toISOString()
  const alt: RouteAlternative = {
    id: 'alt-' + createHash('sha256').update(`${parent.seed}\n${created_at}\n${out.checked.body}`).digest('hex').slice(0, 8),
    scene: t.scene, seed: parent.seed, guidance: brief.replace(/\s*\n+\s*/g, ' / '), based_on: bodyHash(scene.body),
    created_at, body: out.checked.body, briefing: out.checked.briefing, coverage: out.checked.coverage,
    ...(out.checked.dropped.length ? { dropped: out.checked.dropped } : {}),
    reads: used.read,
    overlap: out.checked.overlap, revises: parent.id, run: run.id, ...(out.retried ? { retried: out.retried } : {}),
  }
  writeAlternative(alt)
  receipt.result.records = [`.arc/alternatives/${t.scene}/${alt.id}.md`]
  return { alternatives: [alt], refused: [] }
  })
}

// ---- notes on a route, and the field that clears (A58) --------------------

function loadAlt(scene: string, id: string): RouteAlternative {
  const alt = listAlternatives(scene).find(a => a.id === id)
  if (!alt) throw new HttpError(404, `no alternative ${id} for ${scene}`)
  return alt
}

/** Write the alternative back in place — notes changed, prose untouched. The
 *  route file is the note store: a note on a proposal is proposal-side data,
 *  so it travels with the route and goes when the route goes. */
function saveAlt(alt: RouteAlternative): void {
  fs.writeFileSync(path.join(DIR(alt.scene), `${alt.id}.md`), serialize(alt))
}

/** File a note on a route: about one of its paragraphs, or about the whole
 *  of it. The paragraph is an index into THIS route's body and needs no
 *  drift resolution — a route never changes in place. */
export function addRouteNote(scene: string, id: string, body: string, paragraph?: number | null): RouteAlternative {
  if (!body?.trim()) throw new HttpError(400, 'a note needs something in it')
  const alt = loadAlt(scene, id)
  // Only the newest version of a route takes notes. An earlier version has
  // already been answered — a note on it could reach no rewrite, and the
  // author would be writing into a version they have moved past.
  const superseded = listAlternatives(scene).find(a => a.revises === alt.id)
  if (superseded) {
    throw new HttpError(409, 'this is an earlier version of the route — notes go on the newest one, which is the version open above it')
  }
  const onPassage = typeof paragraph === 'number'
  if (onPassage) {
    const count = paragraphsOf(alt.body).length
    if (!Number.isInteger(paragraph) || (paragraph as number) < 1 || (paragraph as number) > count) {
      throw new HttpError(400, `this route has ${count} paragraph${count === 1 ? '' : 's'}; a note is about one of them, or about the whole route`)
    }
  }
  const created_at = new Date().toISOString()
  const note: RouteNote = {
    id: 'rnote-' + createHash('sha256').update(`${alt.id}\n${created_at}\n${body}`).digest('hex').slice(0, 8),
    paragraph: onPassage ? paragraph as number : null,
    body: body.trim(),
    created_at,
  }
  const next = { ...alt, notes: [...(alt.notes ?? []), note] }
  saveAlt(next)
  return next
}

export function deleteRouteNote(scene: string, id: string, noteId: string): RouteAlternative {
  const alt = loadAlt(scene, id)
  const notes = alt.notes ?? []
  if (!notes.some(n => n.id === noteId)) throw new HttpError(404, `no note ${noteId} on ${id}`)
  const next = { ...alt, notes: notes.filter(n => n.id !== noteId) }
  saveAlt(next)
  return next
}

/** Clear a scene's whole field of alternatives. Called when a scene change
 *  is ACCEPTED into the manuscript — the adopted route became the book, and
 *  the routes it beat go with it. Deliberately not on adopt: adopt only
 *  writes the draft, and a draft the author then discards must not cost
 *  them every route. Returns how many were removed. */
export function clearAlternatives(scene: string, opts: { because?: string; adopted?: string } = {}): number {
  const because = opts.because ?? 'a route on this scene was adopted and accepted'
  const dir = DIR(scene)
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
