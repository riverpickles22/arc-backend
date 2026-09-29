// THE CONTEXT ASSEMBLER: a writing job's slice, in named layers (A69-2;
// agent-workflows §4, "What a writing slice holds", and §11, where the
// assembler is one of the two capabilities every slice grows).
//
// §2's claim is that the quality lever is the brief, not the agent. This file
// is where that claim holds or does not. A writing pass is told the story
// from the record, in twelve layers — §4's eleven and the lock notice —
// each from a named place, each carrying
// its ids and the reason it is here — and the slice is not finished until
// every layer has a STATUS the receipt can show the author:
//
//   given      it is in the brief
//   not shown  room ran out; it is in the row's drop order and it dropped
//   deferred   arc does not read this source yet, by design, and says so —
//              a layer whose builder has not been written is deferred, NEVER
//              `none`, or `none` stops being able to mean the thing below
//   none       there is honestly nothing — the first scene has no handoff,
//              this scene has no open notes, this story has no contract
//
// Never `missing`. "arc chose not to show it", "arc ran out of room" and
// "there is nothing to show" are three different facts about a book, and a
// single word for all three is how a brief stops being readable.
//
// THE FLOOR NEVER DROPS. A slice that cannot hold its floor inside the row's
// input budget is refused before a token is spent, in the author's words. The
// budget is a CEILING and not a target: layers drop in the row's order only
// as far as they must, and nothing is ever padded to fill it.
//
// WHAT THIS DOES NOT DO. It does not edit anything. The style contract is the
// author's ratified file; what a withholding pass receives is a RENDERED
// PROJECTION of it, abbreviated where it quotes the scene the pass must work
// without, and the manifest says how many passages that cost. Constrain the
// representation, never the record.
import { HttpError } from './http'
import type { CanonDoc, EraLike, MaterialItem, ProseScene, ResolvedAnnotation, SceneContract } from 'arc-canon-graph'
import { buildContextPack } from 'arc-canon-graph/context-pack-lib.ts'
import { dateOf, diffCharacter, dk, eraSpanKeys, stateAt, timeRefKey } from 'arc-canon-graph/canon-graph.ts'
import type { TimeRef } from 'arc-canon-graph/canon-graph.ts'
import { loadGraph } from 'arc-canon-graph'
import { canonJson } from './canon'
import { materialItems, proseDraft, proseScenes } from './story'
import { dueRows } from './briefing'
import { openNotesOn } from './annotations'
import { locksOn } from './locks'
import { paragraphsOf } from 'arc-canon-graph/annotations.ts'
import { literalWithholds } from './redraft'
import { styleForPassRead } from './reroute'
import { styleContract } from './style'
import type { Row } from './registry'
import { placeInChapter, siblingLadder, type Rung } from './ladder'
import { loadStyleLayers } from './style'

/** §4's eleven layers and the lock notice, in the order a brief carries them. The list is the
 *  checklist: a layer arc cannot assemble yet is still named, with the status
 *  that says so, because a brief whose gaps are invisible cannot be audited. */
export const WRITING_LAYERS = [
  'intent', 'contract', 'handoff', 'dramatic-condition', 'canon',
  'position', 'voice', 'research', 'notes', 'promoted-rules', 'withholds',
  // §4's table lists eleven; its FLOOR sentence names a twelfth — "the
  // contract, the withholds, the lock notice, the handoff and the canon".
  // A writing pass told nothing about locked prose will rewrite it, and the
  // locks gate will refuse the answer afterwards; the honest place to say so
  // is the brief.
  'locks',
] as const
export type WritingLayer = (typeof WRITING_LAYERS)[number]

export type LayerStatus = 'given' | 'not shown' | 'deferred' | 'none'

/** One layer of the brief, as text and as record. */
export interface SliceBlock {
  layer: WritingLayer
  /** what it carries, by id — never the text, so a receipt can name it */
  ids: string[]
  /** why this is in the brief, in the author's words */
  reason: string
  status: LayerStatus
  /** the rendered layer; empty unless `given` */
  text: string
  /** the state facts given past the row's freshness distance (A69-6) */
  leaned_on?: LeanedOn[]
}

/** A STATE FACT THE PROSE RESTS ON that the record has not looked at since
 *  before the freshness distance (A69-6). Proven from the record by code:
 *  the snapshot's own timeref against the scene's moment. */
export interface LeanedOn {
  id: string
  /** the snapshot's timeref, as the record spells it */
  as_of: string
  /** how far past the freshness distance, in days of story time */
  older_by_days: number
}

/** One line of the manifest the receipt shows. */
export interface LayerReading {
  layer: WritingLayer
  status: LayerStatus
  ids: string[]
  /** why, whenever the status is not `given` — in the author's words */
  because?: string
  /** what the rendering did, when it did something worth recording */
  note?: string
  /** the state facts given past the row's freshness distance (A69-6) */
  leaned_on?: LeanedOn[]
  /** the rung each sibling scene reached the pass on (A69-7) */
  rungs?: { scene: string; rung: Rung }[]
}

/** What a layer's builder hands the assembler: the block, plus why it is
 *  not given, what the rendering did, and — for a layer that can shrink
 *  before it drops — how to shrink it one step (A69-7). */
type Candidate = SliceBlock & {
  because?: string
  note?: string
  rungs?: { scene: string; rung: Rung }[]
  /** Lower the layer one step in place — a sibling one rung — and say
   *  whether anything moved. The drop loop calls this until the brief fits
   *  or nothing is left to lower, and only then drops the layer. */
  lower?: () => boolean
}

export interface WritingSlice {
  blocks: SliceBlock[]
  manifest: LayerReading[]
  /** the estimated size of what went in, in tokens (chars ÷ 4) */
  estimate: number
  render(): string
  /** the manifest in the receipt's own shape — the two summary lists it
   *  keeps, and the reading behind them. `withheld_by_design` stays the
   *  row's to state: it is about the envelope, not about this slice. */
  forReceipt(): {
    included: string[]
    dropped_for_budget: string[]
    layers: LayerReading[]
    /** every state fact given past the freshness distance, from the manifest */
    leaned_on: LeanedOn[]
  }
}

/** WHAT MAY BEAR WEIGHT (§4, "Canon, with status"; conventions §5). Every
 *  id the record holds, split by whether the author has ratified it: a
 *  `canon` record may bear weight; a `proposed` one, a deprecated one, and
 *  every piece of material may be mentioned and never rested on. A record
 *  with no status stated is treated as proposed — the conservative reading,
 *  and the one the tag says out loud. The gate that reads a draft's leans-on
 *  tail measures against these same two lists. */
export function weightOf(canon: CanonDoc, material: MaterialItem[]): { settled: string[]; unsettled: string[] } {
  const settled: string[] = [], unsettled: string[] = []
  const place = (id: string, status: string | undefined): void => { (status === 'canon' ? settled : unsettled).push(id) }
  for (const e of Object.values(canon.entities ?? {})) place(e.id, e.status)
  for (const e of Object.values(canon.events ?? {})) place(e.id, e.status)
  for (const r of canon.relationships ?? []) place(r.id, (r as { status?: string }).status)
  // The brief prints chapters, eras and themes by id too; a tail naming one
  // is naming something the record holds. A chapter or theme carries its
  // own status; an era is the timeline's, settled by being there.
  for (const c of canon.chapters ?? []) place(c.id, c.status ?? 'canon')
  for (const t of canon.themes ?? []) place(t.id, (t as { status?: string }).status ?? 'canon')
  for (const e of canon.timeline?.eras ?? []) settled.push(e.id)
  for (const m of material) unsettled.push(m.id)
  return { settled: settled.sort(), unsettled: unsettled.sort() }
}

/** A status tag as the brief spells it. */
function tagOf(status: string | undefined): string {
  return status === 'canon' ? '[canon]'
    : status === 'proposed' ? '[proposed — reference only]'
      : status ? `[${status} — reference only]`
        : '[status unstated — read as proposed, reference only]'
}

/** Days of story time between two date keys, approximately — a timeref's
 *  own precision is coarser than any error here. */
function daysBetween(a: number, b: number): number {
  const days = (k: number): number => Math.floor(k / 10000) * 365 + (Math.floor(k / 100) % 100 - 1) * 30 + (k % 100)
  return days(b) - days(a)
}

/** THE LAST MOMENT A TIMEREF STILL COVERS. A state recorded `1910` with
 *  year precision is a claim about the whole of 1910, so a scene in that
 *  November is INSIDE it, not 360 days after its first instant. `timeRefKey`
 *  collapses a timeref to its earliest moment, which is right for ordering
 *  and wrong for age: measured from there, every year-precision state in a
 *  late chapter reads as stale, and the author is told the record has not
 *  looked since — a proven count that is not true. */
function coversUntil(at: TimeRef, eras: EraLike[]): number {
  if (at.date) return dk(at.date, true)
  const era = eras.find(e => e.id === (at as { era?: string }).era)
  return era ? eraSpanKeys(era)[1] : timeRefKey(at, eras)
}

/** The timeref as the record spells it — the date, else the era, with the
 *  precision when one is stated. */
function asOf(at: TimeRef): string {
  const p = (at as { precision?: string }).precision
  return `${at.date ?? at.era}${p ? ` (${p} precision)` : ''}`
}

/** THE RECORD WITH ITS STATUS (A69-6; §4, "Canon, with status"). The pack
 *  is the graph's own selection with the reason each item is here; this
 *  says, on every item, whether it may bear weight — and on every state
 *  fact, when the record last looked. The weight rule is stated once at the
 *  head, because a tag the reader has not been told the meaning of is
 *  decoration. Nothing here edits the pack's selection: constrain the
 *  representation, never the record. */
function canonWithStatus(
  canon: CanonDoc, pack: string, T: number | undefined, freshness: number | undefined,
): { text: string; leaned_on: LeanedOn[]; tagged: number } {
  const eras = canon.timeline?.eras ?? []
  const status = new Map<string, string | undefined>()
  for (const e of Object.values(canon.entities ?? {})) status.set(e.id, e.status)
  for (const e of Object.values(canon.events ?? {})) status.set(e.id, e.status)
  for (const r of canon.relationships ?? []) status.set(r.id, (r as { status?: string }).status)

  const leaned_on: LeanedOn[] = []
  const seen = new Set<string>()
  /** The lines that follow an entity's item: when its state was taken, and
   *  whether that is past the distance the row allows. */
  const stateLines = (id: string, indent: string): string[] => {
    const ent = canon.entities?.[id]
    if (!ent?.states?.length || seen.has(id)) return []
    seen.add(id)
    // No dated moment to measure from: the chapter's span names an era and
    // no date, or nothing. The pack anchors at the end of time then, and an
    // age measured from there is millions of days of nothing. Say so.
    if (T === undefined) return [`${indent}  as of: the chapter states no dated span, so how current this state is cannot be measured`]
    const st = stateAt(ent as { states: { at: TimeRef }[] }, T, eras)
    if (!st) return [`${indent}  as of: no state at this moment — nothing the record says about them applies yet`]
    // Aged from the last moment the state still covers, not the first.
    const age = daysBetween(coversUntil(st.at, eras), T)
    const lines = [`${indent}  as of: ${asOf(st.at)}`]
    if (freshness !== undefined && age > freshness) {
      leaned_on.push({ id, as_of: asOf(st.at), older_by_days: age - freshness })
      lines.push(`${indent}  AGED: this state is ${age} days of story time old, ${age - freshness} past what this pass may treat as current — it is given anyway, and the author is told so`)
    }
    return lines
  }

  let tagged = 0
  const out: string[] = []
  // The state lines follow the pack's own "— included:" line when there is
  // one, so an item reads: what it is, why it is here, when it was last true.
  let pending: string[] = []
  // An object renders as a heading, then its one `- ` item, then that item's
  // "— included:" line; the state lines wait for the last of those.
  let afterHeading = false
  for (const line of pack.split('\n')) {
    const included = /^\s*— included:/.test(line)
    const itemUnderHeading = afterHeading && /^- /.test(line)
    if (pending.length && !included && !itemUnderHeading) { out.push(...pending); pending = []; afterHeading = false }
    // An item: `- \`id\` …` — the id is the first thing on the line.
    const item = line.match(/^(\s*- )`([^`]+)`(.*)$/)
    if (item && status.has(item[2])) {
      tagged++
      out.push(`${item[1]}\`${item[2]}\` ${tagOf(status.get(item[2]))}${item[3]}`)
      pending = stateLines(item[2], item[1].replace(/- $/, ''))
      continue
    }
    // An object's own heading.
    const head = line.match(/^(## Object: )`([^`]+)`(.*)$/)
    if (head && status.has(head[2])) {
      tagged++
      out.push(`${head[1]}\`${head[2]}\` ${tagOf(status.get(head[2]))}${head[3]}`)
      pending = stateLines(head[2], '')
      afterHeading = true
      continue
    }
    out.push(line)
    if (pending.length && included) { out.push(...pending); pending = []; afterHeading = false }
  }
  out.push(...pending)
  const rule = [
    'WEIGHT. Every item below carries a tag. [canon] is settled and may bear weight.',
    '[proposed] may be mentioned and must not be rested on — the author has not decided; a scene that would fall without it is a scene the author cannot decide against.',
    'Material — the story\'s filed thoughts, listed under WHAT IS LIVE HERE — binds nothing.',
    'A state fact says when the record last looked (as of); one marked AGED is older than this pass may treat as current.',
  ].join('\n')
  return { text: `${rule}\n\n${out.join('\n')}`, leaned_on, tagged }
}

/** WHAT IS LIVE HERE (A69-6; §4, "Dramatic condition"): how the people
 *  present stand to each other at this moment, and what the story owes in
 *  this chapter. Wants, fears and beliefs stay where the record layer already
 *  renders them, on each person's line — said twice they cost the budget and
 *  teach nothing. Fenced payoffs are the record layer's too. What was not
 *  in any brief before this: every present person's stances, not only the
 *  point of view's, and the obligations due here with the scene expected to
 *  discharge each — the briefing's own WHAT'S DUE, handed to the pass. */
function dramaticCondition(
  canon: CanonDoc, T: number | undefined, chapterId: string, present: string[], material: MaterialItem[], scenes: ProseScene[],
): { text: string; ids: string[]; because: string } {
  const eras = canon.timeline?.eras ?? []
  const ids: string[] = []
  const stances: string[] = []
  for (const id of present) {
    const ent = canon.entities?.[id]
    if (!ent?.states?.length || T === undefined) continue
    const st = stateAt(ent as { states: { at: TimeRef; relationships?: { toward: string; stance: string }[] }[] }, T, eras)
    const rel = st?.relationships ?? []
    if (!rel.length) continue
    ids.push(id)
    stances.push(`${id} (as of ${asOf(st!.at)})\n${rel.map(r => `  → ${r.toward}: ${r.stance.trim()}`).join('\n')}`)
  }

  // Due here: the briefing's own WHAT'S DUE — one pipeline, so the pass is
  // never told a different debt than the author's panel shows.
  const owing = dueRows(canon, chapterId, material, scenes).map(o => {
    ids.push(o.id)
    const expected = o.satisfiers.length ? `expected in ${o.satisfiers.join(', ')}` : 'no scene claims it yet'
    const window = o.window ? ` · window ${o.window.from ?? '…'} → ${o.window.to ?? '…'}` : ''
    return `- ${o.id} — ${o.body.split('\n')[0]} · ${expected}${o.klass === 'overdue' ? ' · OVERDUE' : ''}${window}`
  })

  const parts: string[] = []
  if (stances.length) parts.push(`HOW THEY STAND TO EACH OTHER\n${stances.join('\n')}`)
  parts.push(`WHAT THE STORY OWES IN THIS CHAPTER\n${owing.length ? owing.join('\n') : 'nothing is due in this chapter'}`)
  const because = 'nobody present has a stance on record at this moment, and nothing is due in this chapter'
  return { text: stances.length || owing.length ? parts.join('\n\n') : '', ids, because }
}


/** The subject of a writing job. A revise names a scene that exists; a draft
 *  names the chapter and the id of the scene it is about to write, and has no
 *  prose and no contract of its own yet. */
export interface WritingSubject {
  chapter: string
  /** the scene as it stands, when there is one */
  scene?: ProseScene
  /** the id being written, for a draft whose scene does not exist yet */
  sceneId?: string
  /** the paragraph range at selection scope, inclusive — what the pass is
   *  asked to rebuild, and the only part of the scene it may answer with */
  range?: [number, number]
}

/** Which stage of the job is being briefed. The craft plan is the one stage
 *  that MAY see the contract's reader-effect fields: turning them into craft
 *  is its whole purpose. The write stage may not — writing toward a stated
 *  effect is the no-comment law's own failure (§4, U1's constraints). */
export type SliceStage = 'craft-plan' | 'write'

/** What the author said, and what it became. The craft-plan stage is shown
 *  the LINE; every writing stage is shown the PLAN and never the line — that
 *  separation is the whole point of the stage (§4, "The craft plan"). */
export interface Intent {
  /** the line the author said now, in their words */
  line?: string
  /** the craft the reading turned it into */
  plan?: { moves: { move: string; how: string }[] }
}

const est = (text: string): number => Math.ceil(text.length / 4)
const subjectOf = (s: WritingSubject): string => s.scene?.scene ?? s.sceneId ?? s.chapter

/** The contract, as a layer. The reader-effect fields go only to the stage
 *  that exists to translate them. */
function contractBlock(c: SceneContract | null | undefined, stage: SliceStage): string {
  if (!c) return ''
  const line = (k: string, v: unknown): string =>
    v == null || (Array.isArray(v) && !v.length) ? '' :
      Array.isArray(v) ? `${k}:\n${v.map(x => `  - ${String(x).trim()}`).join('\n')}` : `${k}: ${String(v).trim()}`
  return [
    line('purpose', c.purpose),
    stage === 'craft-plan' ? line('reader_before', c.reader_before) : '',
    stage === 'craft-plan' ? line('reader_after', c.reader_after) : '',
    line('must_establish', c.must_establish),
    line('must_withhold', c.must_withhold),
    line('motifs', c.motifs),
    line('constraints', c.constraints),
  ].filter(Boolean).join('\n')
}

/** THE SCENE THIS ONE FOLLOWS, in book order: chapter by `order`, then scene
 *  by the number in its id. Across a chapter boundary it is the last scene of
 *  the chapter before — the book's momentum does not stop at a chapter break,
 *  and a draft that begins one is exactly where the handoff matters most. */
export function previousScene(canon: CanonDoc, subject: WritingSubject, scenes: ProseScene[]): ProseScene | null {
  const order = new Map((canon.chapters ?? []).map(c => [c.id, c.order]))
  // A chapter the canon does not list, or lists without an `order`, ranks by
  // the number in its id — never as chapter zero. Ranked first, the scene
  // after it would read as "the first scene of the book": a false `none`,
  // the one status this file promises is honest.
  const chapterRank = (chapter: string): number => order.get(chapter) ?? Number(chapter.match(/\d+/)?.[0] ?? 0)
  // Within a chapter, file order (conventions §10) — the ladder's one
  // definition of where a scene sits, so a scene whose id tail is not a
  // number is still the scene before the one after it.
  const sceneId = subject.scene?.scene ?? subject.sceneId
  const mine = chapterRank(subject.chapter) * 1000 + placeInChapter({ chapter: subject.chapter, sceneId }, scenes).at
  const rank = (s: ProseScene): number =>
    chapterRank(s.chapter) * 1000 + placeInChapter({ chapter: s.chapter, sceneId: s.scene }, scenes).at
  return scenes
    .filter(s => s.scene !== sceneId)
    .map(s => ({ s, r: rank(s) }))
    .filter(x => x.r < mine)
    .sort((a, b) => b.r - a.r)[0]?.s ?? null
}

/** WHAT THE LAST SCENE LEFT BEHIND (§4; A69-5). Not an object of its own —
 *  three things read back out of the record:
 *
 *  its `reader_after`, which is what the reader now knows; the state the
 *  events it binds moved, per person, named and not counted; and the
 *  obligations it opened or discharged. U7 writes those at the accept; this
 *  reads them back, and that is how the book's momentum crosses a scene
 *  boundary without anyone maintaining a summary by hand. */
function handoffText(canon: CanonDoc, prev: ProseScene, material: MaterialItem[], scenes: ProseScene[]): string {
  const out: string[] = []
  const eras = (canon as { timeline?: { eras?: unknown[] } }).timeline?.eras ?? []
  out.push(`It follows ${prev.scene} (${prev.file}).`)

  const after = prev.contract?.reader_after?.trim()
  if (after) out.push(`WHAT THE READER NOW HAS\n${after}`)

  // The window the scene covers, from its own frontmatter (parseScene
  // carries it; a scene that states none has nothing to diff over).
  const span = prev.span
  const fromDate = dateOf(span?.start) ?? dateOf(span?.end)
  const toDate = dateOf(span?.end) ?? fromDate
  const from = fromDate ? dk(fromDate) : null
  const to = toDate ? dk(toDate, true) : null
  const moved: string[] = []
  if (from != null && to != null) {
    for (const id of prev.facts ?? []) {
      const entity = canon.entities?.[id]
      if (!entity?.states?.length) continue
      const d = diffCharacter(entity as { states?: { at: never }[] }, from, to, eras as never)
      const lines = [
        ...d.scalars.map(x => `${x.field}: ${x.before ?? '—'} → ${x.after ?? '—'}`),
        ...d.lists.flatMap(x => [
          ...x.added.map(v => `${x.field} gained: ${v}`),
          ...x.removed.map(v => `${x.field} lost: ${v}`),
        ]),
        ...d.relationships.map(r => `toward ${r.toward}: ${r.before ?? '—'} → ${r.after ?? '—'}`),
      ]
      if (lines.length) moved.push(`${id}\n${lines.map(l => `  ${l}`).join('\n')}`)
    }
  }
  out.push(moved.length
    ? `WHAT IT MOVED\n${moved.join('\n')}`
    : 'WHAT IT MOVED\nnothing the record has caught up with yet')

  // WHAT IT LEFT OWING: what its contract says it discharged, and every
  // obligation the story still owes that names one of the people or places
  // the scene binds. "Still owes" is arc-core's one definition — the graph's
  // `obligations()`, which the briefing and the attention report read too:
  // nothing claims it, or what claims it is not written, or it landed late.
  // Only prose discharges an obligation; a debt the record marks absorbed
  // or dropped is not owing, whoever it touches, and one a scene's contract
  // says it satisfies is owed until that scene exists. Two definitions here
  // would tell the pass a debt is settled that the author's briefing says
  // is due.
  const satisfies = prev.contract?.satisfies ?? []
  const owed = loadGraph(canon).obligations(material,
    scenes.map(s => ({ scene: s.scene, chapter: s.chapter, satisfies: s.contract?.satisfies })))
  const bound = new Set(prev.facts ?? [])
  const touches = new Map(material.filter(m => m.type === 'obligation' && (m.related ?? []).some(r => bound.has(r))).map(m => [m.id, m]))
  const live = [...owed.unowned, ...owed.unwritten, ...owed.overdue].filter(o => touches.has(o.id))
  const obligations = [
    ...satisfies.map(id => `discharged ${id}`),
    ...live.filter(o => !satisfies.includes(o.id)).map(o => `open ${o.id} — ${o.body.split('\n')[0]}`),
  ]
  if (obligations.length) out.push(`WHAT IT LEFT OWING\n${obligations.map(o => `- ${o}`).join('\n')}`)
  return out.join('\n\n')
}

/** Every layer arc can assemble today, each with its ids and its reason.
 *  A layer that has no builder yet is here too, with the status that says so
 *  and the card that will build it — the manifest is the checklist, and a
 *  layer left off it is a gap nobody can see. */
function candidates(row: Row, subject: WritingSubject, stage: SliceStage, intent: Intent): Candidate[] {
  const scene = subject.scene
  const canon = JSON.parse(canonJson()) as CanonDoc
  const chapter = (canon.chapters ?? []).find(c => c.id === subject.chapter)
  const pov = scene?.pov ?? chapter?.pov
  const at = dateOf(chapter?.span?.end) ?? dateOf(chapter?.span?.start)

  // The style contract, rendered for THIS pass. Not edited: read, and
  // abbreviated where it quotes the scene this pass must work without.
  // THE CONTRACT IS ABBREVIATED ONLY FOR A PASS THAT MUST WORK WITHOUT THE
  // SCENE. A withholding row is shown none of the current prose, so a rule
  // quoting it hands the pass the thing it is meant to find another way to;
  // a row that is given the scene in full loses nothing by reading the rule
  // whole, and abbreviating it there would charge the author for passages
  // "left out" of a pass that could read them anyway. A draft has no prose
  // to quote at all, so there is nothing to abbreviate either way.
  const style = scene && row.withholding && row.withheld
    ? styleForPassRead({ scene: scene.scene, file: scene.file, body: scene.body })
    : { text: styleContract(), abbreviated: 0 }

  const pack = at
    ? buildContextPack(canon, { at, events: scene?.events ?? [], pov })
    : buildContextPack(canon, { chapter: subject.chapter })
  // The scene's moment, as the pack anchors it: the end of the chapter's
  // span — or nothing, when the span states no date.
  const T = at ? dk(at, true) : undefined
  const withStatus = canonWithStatus(canon, pack, T, row.slice.freshness)
  // Who is here: the point of view, whoever the scene binds, and whoever
  // takes part in or witnesses the events it depicts — the pack's own cast.
  const present: string[] = [...new Set([
    ...(pov ? [pov] : []),
    ...(scene?.facts ?? []).filter(id => canon.entities?.[id]?.type === 'character'),
    ...(scene?.events ?? []).flatMap(e => [
      ...(canon.events?.[e]?.participants ?? []).map(p => p.entity),
      ...(canon.events?.[e]?.witnesses ?? []),
    ]),
  ])]
  // Read once, for every layer that wants them.
  const material = materialItems()
  const scenes = proseScenes()

  // WHO IS HERE. A written scene names them; a scene arc is about to draft
  // names nobody, so the chapter's own cast stands in — the people its other
  // scenes bind and its events name. One list, for every layer that asks.
  const here = scene ? present : [...new Set([...present, ...chapterCast(canon, subject.chapter, scenes)])]

  // ONLY THE AUTHOR'S NOTES REACH A WRITING PASS (§4, "Notes and key points,
  // `by: author` only"). A note arc wrote is arc's own reading, and handing
  // it back as an instruction is how a model's guess becomes the author's
  // brief one pass later.
  // A scene arc has not written yet can still carry notes: the author asks
  // for the next scene and says what it should do. Read them by id either
  // way — an absent scene is not an absent request.
  const about = scene?.scene ?? subject.sceneId
  const notes: ResolvedAnnotation[] = about
    ? openNotesOn(about).filter(n => (n.by ?? 'author') === 'author')
    : []

  const literals = literalWithholds(scene?.contract?.must_withhold)
  const paras = scene ? paragraphsOf(scene.body) : []
  // LOCKS THE ANSWER WILL HAVE TO CARRY. At scene scope that is every
  // settled paragraph: the pass rebuilds the whole body and reproduces them
  // in place. At SELECTION scope the pass answers with the passage alone
  // (the rules say so), and everything outside the range is preserved by
  // splicing — so a lock outside the range is not the pass's to reproduce,
  // and telling it to would make it emit a paragraph that then lands twice
  // and is refused by the very gate the notice exists to satisfy.
  const inRange = (p: number): boolean =>
    !subject.range || (p >= subject.range[0] && p <= subject.range[1])
  const locks = scene
    ? locksOn(scene.scene, scene.body)
      .filter(l => l.scope === 'paragraph' && l.resolution.paragraph !== null)
      .filter(l => inRange(l.resolution.paragraph as number))
    : []
  const b = (
    layer: WritingLayer, ids: string[], reason: string, text: string,
    extra: { because?: string; note?: string } = {},
  ): Candidate => ({
    layer, ids, reason, status: text.trim() ? 'given' : 'none', text: text.trim() ? text : '', ...extra,
  })

  return [
    // THE LINE GOES TO THE READING; THE CRAFT GOES TO THE WRITING. A writing
    // stage handed the author's own words would write about the effect
    // instead of producing it, which is the no-comment law's own failure.
    stage === 'craft-plan'
      ? b('intent', [], 'what the author said about this scene, to be turned into craft',
        intent.line?.trim() ?? '',
        { because: 'the author said nothing about this scene' })
      : intent.plan?.moves.length
        ? b('intent', intent.plan.moves.map(m => m.move), 'what we are doing differently right now, as craft',
          intent.plan.moves.map(m => `${m.move}: ${m.how}`).join('\n'))
        : {
          layer: 'intent' as const, ids: [], reason: 'what we are doing differently right now', status: 'none' as const, text: '',
          because: intent.line?.trim()
            ? 'the author withdrew the line they said'
            : 'the author said nothing about this scene, so there was nothing to translate',
        },

    b('contract', scene ? [scene.scene] : [], 'what this scene must establish, withhold and do',
      contractBlock(scene?.contract, stage),
      { because: 'this scene has not been written yet, so it has no contract of its own' }),

    (() => {
      // Only a slice that declares the handoff pays for it: the craft-plan
      // reading declares two layers, and building this one — the previous
      // scene, the record's diff over it, the draft layer under git — for a
      // manifest that will not list it is work the receipt never shows.
      const reason = 'the condition the previous scene left the story in'
      if (!(row.slice.layers as readonly string[]).includes('handoff')) {
        return { layer: 'handoff' as const, ids: [], reason, status: 'none' as const, text: '', because: 'not a layer of this reading' }
      }
      const prev = previousScene(canon, subject, scenes)
      if (!prev) {
        return {
          layer: 'handoff' as const, ids: [], reason,
          status: 'none' as const, text: '',
          because: 'this is the first scene of the book, so there is nothing behind it',
        }
      }
      // A SCENE THAT IS STILL A PROPOSAL IS SAID TO BE ONE — and which kind.
      // Writing the next scene onto ground that may move is a reasonable
      // thing to do and a dangerous thing to do silently. Two different
      // facts, said apart: the text on disk is not what the author accepted
      // (the draft layer — main is HEAD), or the scene is in the book and its
      // frontmatter still says `proposed`, because promotion to canon is an
      // explicit authorial act and never a side effect of the accept
      // (conventions §4). The second is every accepted scene of a book whose
      // author has not promoted yet; calling it "not accepted" would teach
      // the pass to ignore the first.
      const layer = proseDraft()
      const pending = new Set(layer.changes.filter(c => c.status !== 'deleted').map(c => c.file))
      const unaccepted = pending.has(prev.file)
      const proposed = prev.status !== 'canon'
      const heading = unaccepted
        ? 'FOLLOWS A DRAFT — NOT YET ACCEPTED. What is below may change under you.\n\n'
        : proposed
          ? 'FOLLOWS A SCENE STILL PROPOSED — in the book, not yet promoted to canon; what it settles is not yet a fact.\n\n'
          : ''
      const note = unaccepted
        ? `follows ${prev.scene}, which the author has not accepted`
        : proposed
          ? `follows ${prev.scene}, accepted and not yet promoted to canon`
          : layer.git ? undefined : `follows ${prev.scene}; whether it is accepted could not be read — this story is not under git`
      return {
        layer: 'handoff' as const, ids: [prev.scene], reason,
        status: 'given' as const,
        text: heading + handoffText(canon, prev, material, scenes),
        ...(note ? { note } : {}),
      }
    })(),

    (() => {
      // A scene not yet written binds nobody, so who is HERE is read from
      // the chapter — as the voice layer does. Without it a draft's brief
      // carries the point of view's stances alone, and this layer's whole
      // claim is every present person's.
      const live = dramaticCondition(canon, T, subject.chapter, here, material, scenes)
      return b('dramatic-condition', live.ids,
        'how the people here stand to each other, and what the story owes in this chapter',
        live.text,
        { because: live.because,
          note: 'wants, fears and beliefs are on each person\'s line in the record layer; planted payoffs are fenced there too' })
    })(),

    {
      ...b('canon', [...(scene?.facts ?? []), ...(scene?.events ?? [])],
        'what is true at this moment, each fact tagged with whether it may bear weight, and the reason it is here',
        withStatus.text,
        { note: `${withStatus.tagged} item${withStatus.tagged === 1 ? '' : 's'} tagged with status` +
          (withStatus.leaned_on.length
            ? `; ${withStatus.leaned_on.length} state fact${withStatus.leaned_on.length === 1 ? '' : 's'} given past the freshness distance`
            : '') }),
      leaned_on: withStatus.leaned_on,
    },

    positionCandidate(row, canon, subject, chapter, pov, T, scenes),

    // A scene not yet written binds nobody. Who is here is then read from the
    // chapter — the characters its other scenes bind and its events name —
    // so the voices of the people the draft will most likely meet are in the
    // brief, and a gap in the record is shown before the pass fills it.
    voiceCandidate(row, canon, pov, here, !scene),

    // Q16 is open and this is the honest answer until it is settled.
    { layer: 'research', ids: [], reason: 'what the bound records cite', status: 'deferred', text: '',
      because: 'research is not read yet (Q16)' },

    b('notes', notes.map(n => n.id), 'what you said about this scene',
      notes.map(n => `- ${n.body.trim()}`).join('\n'),
      { because: 'you have no open notes on this scene' }),

    b('promoted-rules', ['style'], 'your voice, as you ratified it', style.text,
      { because: 'this story has no style contract yet',
        ...(style.abbreviated
          ? { note: `abbreviated: ${style.abbreviated} passage${style.abbreviated === 1 ? '' : 's'} of the contract quote this scene and were left out of the rendering — your contract is unchanged` }
          : {}) }),

    b('withholds', literals.map((_, i) => `withhold-${i + 1}`), 'what the prose must not reveal',
      literals.map(l => `- ${l}`).join('\n'),
      { because: 'this scene withholds nothing by name' }),

    b('locks', locks.map(l => l.id), 'the paragraphs the author has settled, which survive word for word',
      locks.length
        ? locks.map(l => `${l.id} — ¶${(l.resolution.paragraph ?? 0) + 1}, verbatim:\n${paras[l.resolution.paragraph ?? 0] ?? ''}`).join('\n\n')
        : '',
      { because: 'nothing in this scene is locked' }),
  ]
}

/** WHERE THIS SCENE SITS (A69-7; §4, "Position"): the chapter and the one
 *  before it as the record summarises them, the point of view's road to this
 *  moment, and the chapter's other scenes on the ladder. The ladder is what
 *  makes this layer shrink before it drops: `lower()` takes the farthest
 *  sibling down a rung, and the manifest names where each one stood. */
type ChapterRow = { id: string; order?: number; title?: string; summary?: string }

function positionCandidate(
  row: Row, canon: CanonDoc, subject: WritingSubject, chapterIn: { id: string; order?: number } | undefined,
  pov: string | undefined, T: number | undefined, scenes: ProseScene[],
): Candidate {
  const reason = 'where this scene sits in the book'
  // Only a slice that declares the layer pays for it (as the handoff): the
  // ladder reads every sibling and the lock directory.
  if (!(row.slice.layers as readonly string[]).includes('position')) {
    return { layer: 'position', ids: [], reason, status: 'none', text: '', because: 'not a layer of this reading' }
  }
  const chapter = chapterIn as ChapterRow | undefined
  if (!chapter) {
    return { layer: 'position', ids: [], reason, status: 'none', text: '', because: `the record lists no chapter ${subject.chapter}` }
  }
  const chapters = [...((canon.chapters ?? []) as ChapterRow[])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const prev = [...chapters].reverse().find(c => (c.order ?? 0) < (chapter.order ?? 0))
  const line = (c: ChapterRow, label: string): string =>
    `${label} ${c.order ?? '?'} · ${c.title ?? c.id}${c.summary ? ` — ${oneLine(c.summary)}` : ' — no summary recorded'}`

  const road = povRoad(canon, pov, T)

  const ladder = siblingLadder({ chapter: subject.chapter, sceneId: subject.scene?.scene ?? subject.sceneId }, scenes)
  const siblings = (): string => ladder.rungs.length
    ? `THE CHAPTER'S OTHER SCENES (yours follows or precedes them; do not retell them)\n${ladder.text()}`
    : "THE CHAPTER'S OTHER SCENES: none yet — this is the chapter's first"
  const render = (): string => [
    line(chapter, 'CHAPTER'),
    prev ? line(prev, 'THE CHAPTER BEFORE —') : 'THE CHAPTER BEFORE — none; this is the first chapter',
    road,
    siblings(),
  ].filter(Boolean).join('\n\n')
  const noteOf = (): string => ladder.rungs.length ? ladder.note() : 'no other scenes in this chapter'

  const c: Candidate = {
    layer: 'position',
    ids: [chapter.id, ...(prev ? [prev.id] : []), ...(pov ? [pov] : []), ...ladder.rungs.map(r => r.scene)],
    reason, status: 'given', text: render(), note: noteOf(), rungs: ladder.rungs.map(r => ({ scene: r.scene, rung: r.rung })),
    lower: () => {
      if (!ladder.lower()) return false
      c.text = render(); c.note = noteOf(); c.rungs = ladder.rungs.map(r => ({ scene: r.scene, rung: r.rung }))
      return true
    },
  }
  return c
}

const oneLine = (s: string | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim()

/** THE POINT OF VIEW'S ROAD HERE: every snapshot of the point-of-view
 *  character up to this moment, in the record's own time — eras and dates
 *  through one key, as the record layer places them — with the one that
 *  holds at this moment marked. What each snapshot claims in full is the
 *  record layer's; this is the shape of the road, not the ground. A chapter
 *  whose span states no date has no moment to place the road against, and
 *  the brief says so rather than marking a present it cannot know. */
export function povRoad(canon: CanonDoc, pov: string | undefined, T: number | undefined): string {
  if (!pov) return ''
  const eras = canon.timeline?.eras ?? []
  const entity = canon.entities?.[pov]
  const all = ((entity?.states ?? []) as { at: TimeRef; location?: string; condition?: string; psychology?: string }[])
    .map(s => ({ s, k: timeRefKey(s.at, eras) }))
    .sort((a, b) => a.k - b.k)
  if (!all.length) return `THE POINT OF VIEW'S ROAD HERE — ${pov}: no state history recorded`
  const line = (x: (typeof all)[number], mark: string): string => {
    const parts = [x.s.location && `at ${x.s.location}`, x.s.condition && oneLine(x.s.condition), x.s.psychology && oneLine(x.s.psychology)].filter(Boolean)
    return `  as of ${asOf(x.s.at)}${mark}: ${parts.join('; ') || 'nothing recorded'}`
  }
  if (T === undefined) {
    return [`THE POINT OF VIEW'S ROAD — ${pov} (the chapter states no dated span, so which of these holds at this scene cannot be placed)`,
      ...all.map(x => line(x, ''))].join('\n')
  }
  const upTo = all.filter(x => x.k <= T)
  if (!upTo.length) return `THE POINT OF VIEW'S ROAD HERE — ${pov}: no state at or before this moment — the record says nothing about them yet`
  return [`THE POINT OF VIEW'S ROAD HERE — ${pov}`,
    ...upTo.map((x, i) => line(x, i === upTo.length - 1 ? ' (their state at this moment)' : ''))].join('\n')
}

/** THE POINT-OF-VIEW RULE for the book, read out of §1 of THIS BOOK's style
 *  contract — `docs/style.md`, never the author's constant layer, whose own
 *  §1 is about every book — the bullets of that section that speak of point
 *  of view, each with its indented qualifications. The contract is the
 *  author's file and this is a reading of it, not an edit; which of several
 *  rules is this chapter's is for the pass to see, since the record does not
 *  say. Absent §1, or a §1 with no such bullet, the brief says so. */
export function povRuleOf(contract: string): string {
  const lines = contract.split('\n')
  const start = lines.findIndex(l => /^##\s*1\b/.test(l))
  if (start < 0) return ''
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l))
  if (end < 0) end = lines.length
  const bullets: string[] = []
  for (const l of lines.slice(start + 1, end)) {
    const m = l.match(/^(\s*)[-*]\s+(.*)$/)
    // A bullet at the margin is a rule; an indented one is part of the rule
    // above it — a qualification that must travel with what it qualifies.
    if (m && (m[1].length === 0 || !bullets.length)) bullets.push(l.trim())
    else if (m) bullets[bullets.length - 1] += ' ' + m[2].trim()
    else if (bullets.length && /^\s+\S/.test(l)) bullets[bullets.length - 1] += ' ' + l.trim()
  }
  return bullets.filter(b => /\bPOV\b|point[- ]of[- ]view/i.test(b)).join('\n')
}

/** The characters a chapter has already put on the page: bound by its
 *  scenes, or named by its events. */
function chapterCast(canon: CanonDoc, chapterId: string, scenes: ProseScene[]): string[] {
  const chapter = (canon.chapters ?? []).find(c => c.id === chapterId) as { events?: string[] } | undefined
  return [...new Set([
    ...scenes.filter(s => s.chapter === chapterId).flatMap(s => s.facts ?? []),
    ...(chapter?.events ?? []).flatMap(e => [
      ...(canon.events?.[e]?.participants ?? []).map(p => p.entity),
      ...(canon.events?.[e]?.witnesses ?? []),
    ]),
  ])].filter(id => canon.entities?.[id]?.type === 'character')
}

/** VOICE (A69-7; §4, "Voice"): the point-of-view rule from the contract,
 *  then how every character here sounds — the point of view, whoever the
 *  scene binds, whoever its events name — each by id, and *no voice
 *  recorded* where the record is silent, so the gap is the author's to see
 *  rather than the model's to fill. */
function voiceCandidate(row: Row, canon: CanonDoc, pov: string | undefined, present: string[], fromChapter = false): Candidate {
  const reason = 'how the point of view is told, and how each person here sounds'
  if (!(row.slice.layers as readonly string[]).includes('voice')) {
    return { layer: 'voice', ids: [], reason, status: 'none', text: '', because: 'not a layer of this reading' }
  }
  const rule = povRuleOf(loadStyleLayers().story?.body ?? '')
  const cast = [...new Set([...(pov ? [pov] : []), ...present])]
    .filter(id => canon.entities?.[id]?.type === 'character')
  const voices = cast.map(id => {
    const v = (canon.entities?.[id]?.voice ?? '').trim()
    return `${id}${id === pov ? ' (point of view)' : ''} — ${v ? oneLine(v) : 'no voice recorded'}`
  })
  const text = [
    rule ? `THE POINT-OF-VIEW RULE (your style contract, §1)\n${rule}` : '',
    voices.length ? `WHO IS HERE, AND HOW EACH SOUNDS\n${voices.join('\n')}` : '',
  ].filter(Boolean).join('\n\n')
  const silent = cast.filter(id => !(canon.entities?.[id]?.voice ?? '').trim())
  // Why there is nothing, said for the gap that is actually there.
  const because = [
    !pov ? 'this scene names no point of view and nobody is on the page yet'
      : canon.entities?.[pov]?.type !== 'character' ? `the point of view, ${pov}, is not a character the record knows — check the chapter's pov`
        : '',
    rule ? '' : 'your style contract states no point-of-view rule in §1',
  ].filter(Boolean).join(', and ')
  return {
    layer: 'voice', ids: cast, reason,
    status: text ? 'given' : 'none', text,
    because,
    note: [
      rule ? 'the point-of-view rule is read from §1 of your contract' : 'your style contract states no point-of-view rule in §1',
      silent.length ? `no voice recorded for ${silent.join(', ')}` : `${cast.length} voice${cast.length === 1 ? '' : 's'} on record`,
      ...(fromChapter ? ['who is here is read from the chapter, since this scene is not written yet'] : []),
    ].join('; '),
  }
}

const HEADINGS: Record<WritingLayer, string> = {
  intent: 'WHAT WE ARE DOING DIFFERENTLY RIGHT NOW',
  contract: 'THE SCENE CONTRACT (binding)',
  handoff: 'WHERE THE LAST SCENE LEFT THE STORY',
  'dramatic-condition': 'WHAT IS LIVE HERE',
  canon: 'THE RECORD AT THIS MOMENT (every item carries the reason it is here)',
  position: 'WHERE THIS SCENE SITS',
  voice: 'VOICE',
  research: 'RESEARCH',
  notes: "THE AUTHOR'S OPEN NOTES ON THIS SCENE",
  'promoted-rules': "THE AUTHOR'S STYLE CONTRACT (binding)",
  withholds: 'WHAT THIS SCENE MUST NOT REVEAL',
  locks: 'LOCKED PARAGRAPHS — these survive word for word, in this order',
}

/** Assemble one writing job's slice.
 *
 *  Refuses, before any token, when the row carries no input budget or when
 *  the floor alone will not fit inside it — those are the two states in which
 *  a brief cannot be honest, and a pass launched from a dishonest brief costs
 *  the author money to be told something arc already knew. */
export function assembleWritingSlice(
  row: Row, subject: WritingSubject, opts: { stage?: SliceStage; intent?: Intent } = {},
): WritingSlice {
  const stage = opts.stage ?? 'write'
  const budget = row.budget.inputTokens
  if (!budget) {
    throw new HttpError(500, `the ${row.job} · ${row.scope} row carries no input budget, so arc cannot tell whether a brief fits. Nothing was sent.`)
  }
  const built = candidates(row, subject, stage, opts.intent ?? {})
  const byLayer = new Map(built.map(c => [c.layer, c]))
  const floor = new Set(row.slice.floor)
  const droppable = new Set(row.slice.dropOrder)
  // THE SLICE'S OWN LAYERS, not every layer arc knows. A reading declares two
  // and is complete at two; measuring it against the writing slice's twelve
  // would refuse it for leaving out layers it never claimed (A69-4).
  const declared = row.slice.layers as readonly WritingLayer[]
  // A layer in neither list would never drop and would refuse the brief
  // whenever it did not fit — floor by accident, which is the one way a floor
  // stops meaning anything. The row says which, or the row is wrong.
  const unplaced = declared.filter(l => !floor.has(l) && !droppable.has(l))
  if (unplaced.length) {
    throw new HttpError(500,
      `the ${row.job} · ${row.scope} row does not say whether ${unplaced.join(', ')} may be left out when the brief is too long. Nothing was sent.`)
  }
  // And a layer in BOTH lists is the same mistake wearing the opposite face:
  // the drop loop skips it, so it behaves as floor, and the row's author is
  // told nothing while their drop order quietly does not work.
  const both = declared.filter(l => floor.has(l) && droppable.has(l))
  if (both.length) {
    throw new HttpError(500,
      `the ${row.job} · ${row.scope} row calls ${both.join(', ')} both a floor and something it may drop. Nothing was sent.`)
  }

  // What is actually in the brief, before the budget bites.
  // THE LAYERS THE SLICE DECLARES, and no others. A layer arc can assemble is
  // not a layer every job wants: the craft-plan reading declares two, and
  // handing it the record as well would both cost it its budget and make the
  // receipt — which is built from the declared list — understate what the
  // model was shown. That understatement is the one thing this file exists to
  // prevent (A69-4).
  const given = built.filter(c => c.status === 'given' && declared.includes(c.layer))
  const fits = (keep: Set<WritingLayer>): number =>
    given.filter(c => keep.has(c.layer)).reduce((n, c) => n + est(rendered(c)), 0)

  const keep = new Set<WritingLayer>(given.map(c => c.layer))
  const dropped: WritingLayer[] = []
  // Drop in the ROW's order, and only while it does not fit: a ceiling, not
  // a target — nothing is ever added to use the room that is left.
  for (const layer of row.slice.dropOrder as WritingLayer[]) {
    if (fits(keep) <= budget) break
    if (!keep.has(layer) || floor.has(layer)) continue
    // A layer that can shrink shrinks first — a sibling a rung at a time —
    // and drops only when it is as small as it can be and still too big.
    const c = byLayer.get(layer)
    while (fits(keep) > budget && c?.lower?.()) { /* one rung */ }
    if (fits(keep) <= budget) break
    keep.delete(layer); dropped.push(layer)
  }

  if (fits(keep) > budget) {
    const over = fits(keep)
    const held = [...keep].filter(l => floor.has(l)).join(', ')
    throw new HttpError(400,
      `what ${subjectOf(subject)} needs to be written from does not fit in one pass — ` +
      `${over.toLocaleString()} of a ${budget.toLocaleString()} allowance, with nothing left that arc is allowed to leave out (${held}). ` +
      `Shorten the scene's notes or its contract, or split the scene, and ask again.`)
  }

  const blocks = given.filter(c => keep.has(c.layer))
    .map(({ layer, ids, reason, status, text, leaned_on }) => ({ layer, ids, reason, status, text, ...(leaned_on?.length ? { leaned_on } : {}) }))

  const manifest: LayerReading[] = declared.map(layer => {
    const c = byLayer.get(layer)!
    if (!c) throw new HttpError(500, `the ${row.job} · ${row.scope} row asks for a layer arc cannot assemble: ${layer}. Nothing was sent.`)
    const wasDropped = dropped.includes(layer)
    const status: LayerStatus = wasDropped ? 'not shown' : c.status
    return {
      layer, status, ids: c.ids,
      ...(status === 'given' ? {} : { because: wasDropped ? 'room ran out' : c.because ?? '' }),
      // A note describes what the rendering did. A layer that did not go
      // into the brief was not rendered, and telling the author the
      // contract was abbreviated when it was never sent is worse than
      // saying nothing.
      ...(c.note && status === 'given' ? { note: c.note } : {}),
      // And what was leaned on is only what was GIVEN: a state fact in a
      // layer that dropped for room reached no pass.
      ...(c.leaned_on?.length && status === 'given' ? { leaned_on: c.leaned_on.map(l => ({ ...l })) } : {}),
      // And where each sibling stood, as it was when the brief was sent.
      ...(c.rungs?.length && status === 'given' ? { rungs: c.rungs.map(r => ({ ...r })) } : {}),
    }
  })

  return {
    blocks, manifest,
    estimate: fits(keep),
    render: () => blocks.map(rendered).join('\n\n'),
    forReceipt: () => ({
      included: manifest.filter(l => l.status === 'given').map(l => l.layer),
      dropped_for_budget: manifest.filter(l => l.status === 'not shown').map(l => l.layer),
      layers: manifest.map(l => ({ ...l })),
      // PROVEN FROM THE MANIFEST, never argued: the receipt's `leaned on` is
      // what the canon layer marked aged, and nothing a model said.
      leaned_on: manifest.flatMap(l => l.leaned_on ?? []).map(l => ({ ...l })),
    }),
  }
}

const rendered = (b: SliceBlock): string => `=== ${HEADINGS[b.layer]} ===\n${b.text}`
