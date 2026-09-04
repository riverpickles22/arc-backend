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
import type Anthropic from '@anthropic-ai/sdk'
import { dump as yamlDump, load as yamlLoad } from 'js-yaml'
import type { CanonDoc, ProseScene, ResolvedAnnotation, ResolvedLock, SceneContract } from 'arc-canon-graph'
import type { AdoptRouteResponse, RerouteRefusal, RerouteResponse, RouteAlternative, RouteCoverage, RouteListResponse, RouteLockNotice, RouteNote } from 'arc-canon-graph/api-types.ts'
import { dateOf, splitSentences } from 'arc-canon-graph'
import { buildContextPack } from 'arc-canon-graph/context-pack-lib.ts'
import { lockViolations, paragraphsOf } from 'arc-canon-graph/annotations.ts'
import { MODEL, STORY } from './config'
import { getClient } from './agent'
import { annotations, openNotesOn } from './annotations'
import { canonJson } from './canon'
import { currentEngine, runCliPrompt, stripFences } from './engine'
import { HttpError } from './http'
import { recordGenerated } from './ledger'
import { describeViolation, locksOn } from './locks'
import { contractBlock, literalWithholds, splitBriefing, withholdViolations } from './redraft'
import { proseScenes, proseWrite } from './story'
import { styleContract } from './style'

export const REROUTE_RULES = `You are arc's REROUTE pass. The author asked for ANOTHER WAY THROUGH a scene
of their own novel: the same destination, reached by a different route. You
are deliberately not shown the current prose. You are shown where it must
arrive, and the route it already takes, which you must not take again.

THE DESTINATION binds. Every item under "must be accomplished" happens in
your scene, by whatever realization you choose. A required beat is not
something to avoid — it is something to reach another way.

THE KNOWN ROUTE is fenced. Do not reproduce its ordering, its staging, what
it opens on or what it closes on. Find a different realization: enter
elsewhere, stage it differently, let a different thing carry the movement.

ARC'S OWN READING, where it appears, is context and binds nothing.

WHAT MUST SURVIVE, exactly:
1. The scene's meaning. Every event and fact the frontmatter binds still
   happens here, in canon's order; character state at this moment in the
   story is unchanged. Bound events are fact, not route.
2. The scene contract — purpose, must_establish, must_withhold, motifs,
   constraints. Withholding is deliberate: do not "fix" it.
3. The style contract. It is the author's voice; run its pre-draft
   checklist before answering.
4. POV, tense, and the anachronism boundary.
5. Locked paragraphs, VERBATIM, word for word, in the relative order given.
6. Canon is truth. Never invent a fact the record would have to carry — a
   new person, date, or place is a proposal for the author, not yours to
   make. If the destination cannot be reached without one, say so in the
   briefing: that is a story-state question, and only the author answers it.

ANSWER IN TWO PARTS, separated by a line that is exactly:
=== BRIEFING ===
Part one: the rerouted prose alone — no frontmatter, no commentary, no
fences. Part two, the briefing, in the ARGUED register (claims for the
author to judge, not verdicts): where each required beat lands, by paragraph
number; how your ordering and staging differ from the known route; how each
locked paragraph now sits and what changed around it; the style checklist
item by item; and any fact you needed that canon does not hold.
End the briefing with ONE fenced json block of exactly this shape, and
nothing else inside the fence:
\`\`\`json
{"coverage": [{"item": "<a required beat, verbatim>", "paragraph": <1-based paragraph number, or null>}]}
\`\`\``

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

/** The routes waiting on a scene: chain heads, so versions do not count. */
export function routesWaiting(scene: string): number {
  const alts = listAlternatives(scene)
  const revised = new Set(alts.map(a => a.revises).filter((r): r is string => typeof r === 'string'))
  return alts.filter(a => !revised.has(a.id)).length
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
    stable: [REROUTE_RULES, `=== THE STYLE CONTRACT (binding) ===\n${a.style}`].join('\n\n'),
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

/** The one way the current prose reaches a reroute prompt is the style
 *  contract's own touchstones: §6 quotes passages of the manuscript, and a
 *  passage of the scene being rerouted is the current route in the model's
 *  hands — the first live run treated it as exactly that. Strip every
 *  touchstone drawn from the target scene (by its label's file, or its
 *  anchor's scene) and say so in place, so the section stays honest. */
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
export function parseCoverageTail(briefing: string): { briefing: string; coverage: RouteCoverage[] | null } {
  const fence = /```(?:json)?\s*([\s\S]*?)```\s*$/
  const m = briefing.match(fence)
  let raw: string | null = null
  let rest = briefing
  if (m) { raw = m[1]; rest = briefing.slice(0, m.index).trimEnd() }
  else {
    const bare = briefing.match(/(\{[\s\S]*"coverage"[\s\S]*\})\s*$/)
    if (bare) { raw = bare[1]; rest = briefing.slice(0, bare.index).trimEnd() }
  }
  if (raw === null) return { briefing: briefing.trim(), coverage: null }
  try {
    const first = raw.indexOf('{'); const last = raw.lastIndexOf('}')
    const parsed = JSON.parse(first >= 0 && last > first ? raw.slice(first, last + 1) : raw) as unknown
    const rows = Array.isArray(parsed) ? parsed : (parsed as { coverage?: unknown })?.coverage
    if (!Array.isArray(rows)) return { briefing: rest, coverage: null }
    const coverage = rows
      .filter((r): r is { item: unknown; paragraph: unknown } => !!r && typeof r === 'object')
      .filter(r => typeof r.item === 'string' && r.item.trim())
      .map(r => ({ item: String(r.item).trim(), paragraph: Number.isInteger(r.paragraph) && (r.paragraph as number) > 0 ? r.paragraph as number : null }))
    return { briefing: rest, coverage }
  } catch {
    return { briefing: rest, coverage: null }
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

/** Every required beat gets a row, whether or not the pass mentioned it:
 *  the tail's rows are matched to the destination (exact, or by ≥60% of the
 *  item's words surviving in order — the model paraphrases), and a beat the
 *  tail never named shows as not reported. Rows naming nothing required are
 *  kept after them, so an honest extra claim is not thrown away. */
export function mergeCoverage(destination: string[], rows: RouteCoverage[] | null): RouteCoverage[] | null {
  if (rows === null) return null
  const used = new Set<number>()
  const find = (item: string): RouteCoverage | undefined => {
    const n = norm(item).toLowerCase()
    let best = -1; let bestScore = 0
    rows.forEach((r, i) => {
      if (used.has(i)) return
      const rn = norm(r.item).toLowerCase()
      const score = rn === n ? 1 : Math.max(wordSurvival(item, r.item), wordSurvival(r.item, item))
      if (score > bestScore) { bestScore = score; best = i }
    })
    if (best < 0 || bestScore < SURVIVAL_BAR) return undefined
    used.add(best)
    return rows[best]
  }
  const merged: RouteCoverage[] = destination.map(item => {
    const hit = find(item)
    return { item, paragraph: hit ? hit.paragraph : null }
  })
  rows.forEach((r, i) => { if (!used.has(i)) merged.push(r) })
  return merged
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
    body, briefing,
    coverage: Array.isArray(head.coverage) ? head.coverage as RouteCoverage[] : null,
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

export function writeAlternative(alt: RouteAlternative): void {
  const dir = DIR(alt.scene)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${alt.id}.md`), serialize(alt))
  // Generated alternatives are disposable: keep the newest few ROUTES (chain
  // heads), drop the rest — but a kept route keeps every version it came
  // through, because "save the difference in versions" is the rewrite's
  // contract with the author.
  const alts = listAlternatives(alt.scene)
  const keep = pruneKeepIds(alts, KEEP_ALTERNATIVES)
  for (const old of alts) {
    if (!keep.has(old.id)) fs.rmSync(path.join(dir, `${old.id}.md`), { force: true })
  }
}

const bodyHash = (body: string): string => createHash('sha256').update(body.trim()).digest('hex').slice(0, 16)

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

export function listRoutes(scene: string): RouteListResponse {
  if (!proseScenes().some(s => s.scene === scene)) throw new HttpError(400, `no scene ${scene}`)
  return { scene, alternatives: listAlternatives(scene), locks: constrainingLocks(scene) }
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
  const written = proseWrite(s.file, alt.body.trim() + '\n', s.body)
  const full = fs.readFileSync(path.join(STORY, s.file), 'utf8')
  recordGenerated(s.file, full, { engine: currentEngine() ?? 'sdk', scene, origin: 'reroute' })
  return { scene: written, file: s.file }
}

export function dropAlternative(scene: string, id: string): void {
  const file = path.join(DIR(scene), `${id}.md`)
  if (!/^alt-[0-9a-f]+$/.test(id) || !fs.existsSync(file)) throw new HttpError(404, `no alternative ${id} for ${scene}`)
  fs.rmSync(file)
}

// ---- the run --------------------------------------------------------------

export interface RerouteTarget { scene: string; count?: number; guidance?: string }

async function askSdk(p: ReroutePrompt): Promise<string> {
  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: 'text', text: p.stable, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: p.volatile, cache_control: { type: 'ephemeral' } },
  ]
  const message = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content: p.user }],
  })
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')
}

/** The CLI child runs with NO tools: the prose is withheld from the prompt,
 *  and a child that could read prose/ would make that a courtesy. The note
 *  tells the model so, and that its first line is the prose's first line. */
/** A whole scene in two parts is a long answer; the engine's default ten
 *  minutes was hit on a 2,300-word scene. Twenty, per call, for this pass. */
export const CLI_REROUTE_TIMEOUT_MS = 20 * 60 * 1000

export const CLI_ENGINE_NOTE = 'ENGINE NOTE: you have no tools and no files — everything you may know is in this prompt. Do not narrate, plan, or report what you checked; the first line of your answer is the first sentence of the prose.'

const ask = async (p: ReroutePrompt, pass: 'reroute' | 'reroute-revise' = 'reroute'): Promise<string> =>
  currentEngine() === 'claude-cli'
    ? (await runCliPrompt(`${flattenPrompt(p)}\n\n${CLI_ENGINE_NOTE}`, { cwd: STORY, pass, noTools: true, timeoutMs: CLI_REROUTE_TIMEOUT_MS })).text
    : askSdk(p)

type GateResult = { ok: true; alt: RouteAlternative } | { ok: false; reason: string }

export async function runReroute(t: RerouteTarget): Promise<RerouteResponse> {
  const scene = proseScenes().find(s => s.scene === t.scene)
  if (!scene) throw new HttpError(400, `no scene ${t.scene}`)
  // At the cap the author decides what goes. Checked before any token is
  // spent, and in the backend rather than the button, because a limit only
  // the viewer knows is not a limit.
  const waiting = routesWaiting(t.scene)
  if (waiting >= MAX_ROUTES) {
    throw new HttpError(409, `this scene already holds ${MAX_ROUTES} other ways through — cancel one you are done with to make room for another`)
  }
  // Never take a scene past the cap: a request for two with room for one
  // returns one rather than being refused outright.
  const count = Math.min(t.count ?? 2, MAX_ROUTES - waiting)
  if (!Number.isInteger(count) || count < 1 || count > SEEDS.length) throw new HttpError(400, `count must be 1–${SEEDS.length}`)

  // ---- PRECONDITIONS: proven refusals, before anything is spent -----------
  const kps = sceneKeypoints(t.scene, annotations())
  const destination = buildDestination(scene.contract, kps.author)
  if (!destination.length) {
    throw new HttpError(400, `${t.scene} declares no contract and carries no author-marked key points — there is no destination to reroute to; write one first`)
  }
  const live = locksOn(t.scene, scene.body)
    .filter(l => l.resolution.state === 'resolved' || l.resolution.state === 'drifted')
  const whole = live.find(l => l.scope === 'scene' || l.scope === 'chapter')
  if (whole) {
    throw new HttpError(423,
      `${whole.scope === 'chapter' ? 'this chapter' : 'this section'} is locked (${whole.id}) — the author settled it whole; a reroute would unsettle it. Unlock it to take another way through.`)
  }
  if (!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) && !currentEngine()) {
    throw new HttpError(400, 'no engine configured — set ANTHROPIC_API_KEY in arc-backend/.env, or log in to the claude CLI')
  }

  const paras = paragraphsOf(scene.body)
  const sceneLocks: ResolvedLock[] = live.filter(l => l.scope === 'paragraph' && l.resolution.paragraph !== null)
    .sort((x, y) => (x.resolution.paragraph as number) - (y.resolution.paragraph as number))
  const locked = sceneLocks.map(l => ({ paragraph: l.resolution.paragraph as number, text: paras[l.resolution.paragraph as number] ?? '' }))
  const lockedTexts = locked.map(l => l.text)

  // The canon pack, scoped exactly as redraft scopes it: the scene's own
  // bindings at the chapter's moment. Facts, in canon's order — never route.
  const canon = JSON.parse(canonJson()) as CanonDoc
  const chapter = (canon.chapters ?? []).find(c => c.id === scene.chapter)
  const at = dateOf(chapter?.span?.end) ?? dateOf(chapter?.span?.start)
  const pack = at
    ? buildContextPack(canon, { at, events: scene.events, pov: scene.pov ?? chapter?.pov })
    : buildContextPack(canon, { chapter: scene.chapter })
  const siblings = proseScenes().filter(s => s.chapter === scene.chapter && s.scene !== t.scene)
    .map(s => `=== ${s.file} ===\n${s.body.trim()}`).join('\n\n')
  const openNotes = openNotesOn(t.scene)

  const base = {
    scene, pack, style: stripSceneTouchstones(styleContract(), { scene: t.scene, file: scene.file }), siblings, notes: openNotes,
    destination, knownRoute: buildKnownRoute(kps.author, locked), inferred: inferredRoute(kps.agent),
    locked, guidance: t.guidance,
  }
  const literals = literalWithholds(scene.contract?.must_withhold)
  const andCap = andCapFromContract(base.style)
  const wordCap = wordCapFromContract(base.style)
  const basedOn = bodyHash(scene.body)

  const gate = (seed: { id: string; text: string }, text: string): GateResult => {
    const checked = gateAnswer({ sceneName: t.scene, sceneBody: scene.body, sceneLocks, lockedTexts, literals, andCap, wordCap, destination }, text)
    if (!checked.ok) return checked
    const created_at = new Date().toISOString()
    const id = 'alt-' + createHash('sha256').update(`${seed.id}\n${created_at}\n${checked.body}`).digest('hex').slice(0, 8)
    return {
      ok: true,
      alt: { id, scene: t.scene, seed: seed.id, guidance: t.guidance?.trim() || undefined, based_on: basedOn, created_at, body: checked.body, briefing: checked.briefing, coverage: checked.coverage, overlap: checked.overlap },
    }
  }

  const one = async (seed: { id: string; text: string }): Promise<GateResult> => {
    const prompt = buildReroutePrompt({ ...base, seed })
    // An engine failure — a timeout, a refused spawn — is this seed's refusal,
    // never the run's: the other seed's answer still lands.
    const attempt = async (p: ReroutePrompt): Promise<GateResult> => {
      try { return gate(seed, await ask(p)) } catch (e) { return { ok: false, reason: `engine: ${(e as Error).message}` } }
    }
    const first = await attempt(prompt)
    if (first.ok) return first
    if (first.reason.startsWith('engine:')) return first
    // One retry, with the refusal named and the route restated — then report.
    const again = await attempt({
      ...prompt,
      user: `${prompt.user}\n\nYOUR PREVIOUS ANSWER WAS REFUSED: ${first.reason}. Take the route again from the destination. The known route above is fenced; the locked paragraphs are verbatim and in order; reuse none of the current wording; no sentence joins more "and"s or runs more words than the style contract allows — break it into sentences.`,
    })
    if (again.ok) return { ok: true, alt: { ...again.alt, retried: first.reason } }
    return { ok: false, reason: `${first.reason}; retried once: ${again.reason}` }
  }

  const seeds = SEEDS.slice(0, count)
  // The SDK fans out: every call shares the two cached system blocks and only
  // the user turn differs. The CLI runs one prompt at a time.
  const results = currentEngine() === 'claude-cli'
    ? await seeds.reduce(async (acc, seed) => [...(await acc), await one(seed)], Promise.resolve([] as GateResult[]))
    : await Promise.all(seeds.map(one))

  const alternatives: RouteAlternative[] = []
  const refused: RerouteRefusal[] = []
  results.forEach((r, i) => {
    if (r.ok) { writeAlternative(r.alt); alternatives.push(r.alt) }
    else refused.push({ seed: seeds[i].id, reason: r.reason })
  })
  // Deliberately NO recordGenerated here — see the header: the ledger learns
  // of a route only when it is adopted.
  return { alternatives, refused }
}

// ---- the rewrite: a route revised under the same fence (A57) --------------

export interface GateCtx {
  sceneName: string
  sceneBody: string
  sceneLocks: ResolvedLock[]
  lockedTexts: string[]
  literals: ReturnType<typeof literalWithholds>
  andCap: number | null
  wordCap: number | null
  destination: string[]
}

export type GateChecked =
  | { ok: true; body: string; briefing: string; coverage: RouteCoverage[] | null; overlap: number | null }
  | { ok: false; reason: string }

/** Every check an answer must clear before it lands beside the scene — one
 *  set, shared by the reroute and the rewrite, so the two passes cannot
 *  drift apart gate by gate. */
export function gateAnswer(ctx: GateCtx, text: string): GateChecked {
  const { body, briefing: rawBriefing } = splitBriefing(stripFences(text))
  if (!body) return { ok: false, reason: 'the pass returned nothing' }
  const violated = lockViolations(ctx.sceneBody, body, ctx.sceneLocks)
  if (violated.length) return { ok: false, reason: `touched locked prose — ${describeViolation(ctx.sceneName, violated[0])}` }
  if (lockOrderViolation(body, ctx.lockedTexts)) return { ok: false, reason: 'the locked paragraphs came back out of their settled order' }
  const leaked = withholdViolations(ctx.literals, body)
  if (leaked.length) return { ok: false, reason: `names what the contract withholds verbatim (${leaked.map(x => `"${x}"`).join(', ')})` }
  if (ctx.andCap !== null) {
    const chains = andChainViolations(body, ctx.andCap, ctx.lockedTexts)
    if (chains.length) {
      const worst = chains.sort((x, y) => y.ands - x.ands)[0]
      return { ok: false, reason: `a sentence joins ${worst.ands} "and"s where the contract stops at ${ctx.andCap} (${chains.length} such sentence${chains.length === 1 ? '' : 's'}) — "${worst.sentence.slice(0, 160)}${worst.sentence.length > 160 ? '…' : ''}"` }
    }
  }
  if (ctx.wordCap !== null) {
    const long = longSentenceViolations(body, ctx.wordCap, ctx.lockedTexts)
    if (long.length) {
      const worst = long.sort((x, y) => y.words - x.words)[0]
      return { ok: false, reason: `a sentence runs ${worst.words} words where the contract stops at ${ctx.wordCap} (${long.length} such sentence${long.length === 1 ? '' : 's'}) — "${worst.sentence.slice(0, 160)}${worst.sentence.length > 160 ? '…' : ''}"` }
    }
  }
  const overlap = lexicalOverlap(body, ctx.sceneBody, ctx.lockedTexts)
  if (overlap.share !== null && overlap.share > MAX_OVERLAP) {
    return { ok: false, reason: `reused ${Math.round(overlap.share * 100)}% of the current wording (${overlap.overlapping} of ${overlap.counted} paragraphs; the limit is ${Math.round(MAX_OVERLAP * 100)}%)` }
  }
  const parsed = parseCoverageTail(rawBriefing)
  return { ok: true, body: body.trim(), briefing: parsed.briefing, coverage: mergeCoverage(ctx.destination, parsed.coverage), overlap: overlap.share }
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

export const REROUTE_REVISE_RULES = `You are arc's ROUTE REWRITE pass. The author read an alternative route for a
scene of their own novel and asked for it rewritten. The route is your
subject — you are shown it in full. The scene's current prose is
deliberately not shown to you.

THE AUTHOR'S NOTE binds. Keep what it keeps, change what it names. Where the
note and anything else below disagree, the note wins.

THE DESTINATION binds. Every item under "must be accomplished" happens in
your rewrite, by whatever realization you choose.

THE MANUSCRIPT'S KNOWN ROUTE is fenced. The rewrite stays another way
through: do not drift toward that ordering or staging, what it opens on or
what it closes on.

WHAT MUST SURVIVE, exactly:
1. The scene's meaning. Every event and fact the frontmatter binds still
   happens here, in canon's order; character state at this moment in the
   story is unchanged.
2. The scene contract — purpose, must_establish, must_withhold, motifs,
   constraints. Withholding is deliberate: do not "fix" it.
3. The style contract. It is the author's voice; run its pre-draft
   checklist before answering.
4. POV, tense, and the anachronism boundary.
5. Locked paragraphs, VERBATIM, word for word, in the relative order given.
6. Canon is truth. Never invent a fact the record would have to carry — a
   new person, date, or place is a proposal for the author, not yours to
   make. If the note asks for one, say so in the briefing: that is a
   story-state question, and only the author answers it.

ANSWER IN TWO PARTS, separated by a line that is exactly:
=== BRIEFING ===
Part one: the rewritten route alone — no frontmatter, no commentary, no
fences. Part two, the briefing, in the ARGUED register (claims for the
author to judge, not verdicts): what the note asked and what you changed for
it; what you kept of the route and why it earned its place; where each
required beat lands, by paragraph number; the style checklist item by item;
and any fact you needed that canon does not hold.
End the briefing with ONE fenced json block of exactly this shape, and
nothing else inside the fence:
\`\`\`json
{"coverage": [{"item": "<a required beat, verbatim>", "paragraph": <1-based paragraph number, or null>}]}
\`\`\``

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
    stable: [REROUTE_REVISE_RULES, `=== THE STYLE CONTRACT (binding) ===\n${a.style}`].join('\n\n'),
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

export interface ReviseTarget { scene: string; alt: string; note?: string }

/** Rewrite one alternative under the author's note. The result is a NEW
 *  version of the same route — `revises` names the parent, the old version
 *  stays on disk, and the ledger still learns of a route only on adopt. */
export async function runRevise(t: ReviseTarget): Promise<RerouteResponse> {
  const scene = proseScenes().find(s => s.scene === t.scene)
  if (!scene) throw new HttpError(400, `no scene ${t.scene}`)
  const parent = listAlternatives(t.scene).find(a => a.id === t.alt)
  if (!parent) throw new HttpError(404, `no alternative ${t.alt} for ${t.scene}`)
  // The notes ARE the brief. A rewrite with nothing to say is a fresh
  // reroute, and that button already exists.
  const brief = reviseBrief(parent.notes ?? [], t.note)
  if (!brief.trim()) throw new HttpError(400, 'say what to change — note the route, or add a line, and the rewrite follows it')

  const kps = sceneKeypoints(t.scene, annotations())
  const destination = buildDestination(scene.contract, kps.author)
  if (!destination.length) {
    throw new HttpError(400, `${t.scene} declares no contract and carries no author-marked key points — there is no destination; write one first`)
  }
  const live = locksOn(t.scene, scene.body)
    .filter(l => l.resolution.state === 'resolved' || l.resolution.state === 'drifted')
  const whole = live.find(l => l.scope === 'scene' || l.scope === 'chapter')
  if (whole) {
    throw new HttpError(423,
      `${whole.scope === 'chapter' ? 'this chapter' : 'this section'} is locked (${whole.id}) — the author settled it whole; a rewrite would unsettle it. Unlock it to keep working the route.`)
  }
  if (!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) && !currentEngine()) {
    throw new HttpError(400, 'no engine configured — set ANTHROPIC_API_KEY in arc-backend/.env, or log in to the claude CLI')
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
  const style = stripSceneTouchstones(styleContract(), { scene: t.scene, file: scene.file })
  const literals = literalWithholds(scene.contract?.must_withhold)
  const ctx: GateCtx = {
    sceneName: t.scene, sceneBody: scene.body, sceneLocks, lockedTexts, literals,
    andCap: andCapFromContract(style), wordCap: wordCapFromContract(style), destination,
  }

  const prompt = buildRevisePrompt({
    scene, pack, style, destination,
    knownRoute: buildKnownRoute(kps.author, locked), locked,
    routeBody: parent.body, notes: parent.notes ?? [], extra: t.note,
  })
  const attempt = async (p: ReroutePrompt): Promise<GateChecked> => {
    try { return gateAnswer(ctx, await ask(p, 'reroute-revise')) } catch (e) { return { ok: false, reason: `engine: ${(e as Error).message}` } }
  }
  const land = (checked: Extract<GateChecked, { ok: true }>, retried?: string): RouteAlternative => {
    const created_at = new Date().toISOString()
    const id = 'alt-' + createHash('sha256').update(`${parent.seed}\n${created_at}\n${checked.body}`).digest('hex').slice(0, 8)
    return {
      id, scene: t.scene, seed: parent.seed, guidance: brief.replace(/\s*\n+\s*/g, ' / '), based_on: bodyHash(scene.body),
      created_at, body: checked.body, briefing: checked.briefing, coverage: checked.coverage,
      overlap: checked.overlap, revises: parent.id, ...(retried ? { retried } : {}),
    }
  }

  const first = await attempt(prompt)
  if (first.ok) { const alt = land(first); writeAlternative(alt); return { alternatives: [alt], refused: [] } }
  if (first.reason.startsWith('engine:')) return { alternatives: [], refused: [{ seed: parent.seed, reason: first.reason }] }
  const again = await attempt({
    ...prompt,
    user: `${prompt.user}\n\nYOUR PREVIOUS ANSWER WAS REFUSED: ${first.reason}. Rewrite the route again under the author's note. The manuscript's known route stays fenced; the locked paragraphs are verbatim and in order; reuse none of the manuscript's wording; no sentence joins more "and"s or runs more words than the style contract allows.`,
  })
  if (again.ok) { const alt = land(again, first.reason); writeAlternative(alt); return { alternatives: [alt], refused: [] } }
  return { alternatives: [], refused: [{ seed: parent.seed, reason: `${first.reason}; retried once: ${again.reason}` }] }
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
export function clearAlternatives(scene: string): number {
  const dir = DIR(scene)
  if (!fs.existsSync(dir)) return 0
  const alts = listAlternatives(scene)
  for (const a of alts) fs.rmSync(path.join(dir, `${a.id}.md`), { force: true })
  return alts.length
}

/** How many routes wait on each scene — one read for the whole story, so the
 *  manuscript can mark every scene without a request per scene. Counts
 *  CHAINS, not versions: three rewrites of one route are one route waiting. */
export function routeCounts(): Record<string, number> {
  const root = path.join(STORY, '.arc', 'alternatives')
  if (!fs.existsSync(root)) return {}
  const out: Record<string, number> = {}
  for (const scene of fs.readdirSync(root)) {
    try { if (!fs.statSync(path.join(root, scene)).isDirectory()) continue } catch { continue }
    const n = routesWaiting(scene)     // the same counter the cap uses
    if (n) out[scene] = n
  }
  return out
}
