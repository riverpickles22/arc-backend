// WHAT A PASS'S GATES MEASURE AGAINST, AND HOW A RUN THAT PRODUCED NOTHING
// ENDED (A80-1).
//
// Every writing pass hands the gate runner (gates.ts) the same shape: the
// scene, its locks, its quoted withholds, the caps the contract ratified, and
// the measurements that travel with them — what counts as overlap, what a
// chain is, where the coverage tail is. They were born in the reroute pass
// and every other pass reached into reroute.ts for them; they live here so no
// pass imports another for shared code. The gates themselves stay in
// gates.ts, called by the runner from the row's gate ids (A67-6).
import type { ResolvedLock, RunEnding } from 'arc-canon-graph'
import type { DroppedClaim, RouteCoverage } from 'arc-canon-graph/api-types.ts'
import { paragraphsOf } from 'arc-canon-graph/annotations.ts'
import { sentencesOver } from './countable'
import type { EngineErrorKind } from './engine'
import type { ProseGateCtx } from './gates'

export const MAX_OVERLAP = 0.4
/** Below this many words a paragraph is not counted on either side of the
 *  overlap gate: nearestParagraph measures survival over the passage's own
 *  words, so "No." survives in almost anything. */
export const MIN_COUNTED_WORDS = 8
/** Under this many countable paragraphs the gate cannot judge and says so. */
export const MIN_COUNTED_PARAS = 3

const words = (s: string): number => s.split(/\s+/).filter(Boolean).length
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** must_withhold items that are decidable: exact quoted literals.
 *
 *  "The settler's identity" names an idea and only a reading can judge a
 *  leak — that is argued. '"Havana"' names a string, and a string either
 *  appears or it does not — that is proven. The quoting convention is the
 *  author's way of opting a withhold into the hard gate. */
export function literalWithholds(items: unknown): string[] {
  if (!Array.isArray(items)) return []
  return items
    .map(String)
    .map(x => x.trim())
    .filter(x => /^["'“].*["'”]$/.test(x))
    .map(x => x.replace(/^["'“]|["'”]$/g, ''))
    .filter(Boolean)
}

/** The proven half of the withhold check: literals that appear verbatim. */
export const withholdViolations = (literals: string[], body: string): string[] =>
  literals.filter(w => body.includes(w))

/** Split the model's two-part answer. A missing marker is an honest
 *  degenerate case: all prose, no briefing — never the other way round. */
export function splitBriefing(text: string): { body: string; briefing: string } {
  const m = text.split(/^\s*=== BRIEFING ===\s*$/m)
  return { body: m[0].trim(), briefing: (m[1] ?? '').trim() }
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

/** PROVEN: sentences that join more than `cap` "and"s. The count is the
 *  decidable half of §3's rule; whether a chain is one process deepening or
 *  a procedure stays the author's reading. Locked paragraphs are the
 *  author's settled text and are never counted against. The counter is
 *  countable.ts's, shared with /api/prose/checks (A77-1). */
export function andChainViolations(body: string, cap: number, locked: string[] = []): { sentence: string; ands: number }[] {
  const lockedNorm = new Set(locked.map(norm))
  return sentencesOver(body, 'and-chain', cap, para => lockedNorm.has(norm(para)))
    .map(o => ({ sentence: o.sentence, ands: o.count }))
}

/** PROVEN: sentences longer than `cap` words; locked paragraphs never counted. */
export function longSentenceViolations(body: string, cap: number, locked: string[] = []): { sentence: string; words: number }[] {
  const lockedNorm = new Set(locked.map(norm))
  return sentencesOver(body, 'sentence-length', cap, para => lockedNorm.has(norm(para)))
    .map(o => ({ sentence: o.sentence, words: o.count }))
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

/** How a run that produced nothing ended.
 *
 *  A stop wins over everything: the author ended it. Then a GATE refusal,
 *  because that is what stopped the run — a repair that could not run
 *  afterwards is in the gate records and in the sentence, and does not
 *  relabel the refusal. Otherwise the kind the seam reported. */
export function endingOf(refused: { kind?: EngineErrorKind; gateRefused?: boolean; unreadable?: boolean }[], stopped: boolean): RunEnding {
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

/** The reading has no prose to measure and nothing to overlap: its one gate
 *  reads the answer's own shape. */
export const planGateCtx = (): ProseGateCtx => gateCtx({
  sceneName: '', sceneBody: '', sceneLocks: [], lockedTexts: [], literals: [],
  andCap: null, wordCap: null, destination: [], known: [],
})

