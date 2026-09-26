// THE CONTEXT ASSEMBLER: a writing job's slice, in named layers (A69-2;
// agent-workflows §4, "What a writing slice holds", and §11, where the
// assembler is one of the two capabilities every slice grows).
//
// §2's claim is that the quality lever is the brief, not the agent. This file
// is where that claim holds or does not. A writing pass is told the story
// from the record, in eleven layers, each from a named place, each carrying
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
import type { CanonDoc, ProseScene, ResolvedAnnotation, SceneContract } from 'arc-canon-graph'
import { buildContextPack } from 'arc-canon-graph/context-pack-lib.ts'
import { dateOf, diffCharacter, dk } from 'arc-canon-graph/canon-graph.ts'
import { canonJson } from './canon'
import fs from 'node:fs'
import path from 'node:path'
import { load as yamlLoad } from 'js-yaml'
import { STORY } from './config'
import { proseScenes } from './story'
import { openNotesOn } from './annotations'
import { locksOn } from './locks'
import { paragraphsOf } from 'arc-canon-graph/annotations.ts'
import { literalWithholds } from './redraft'
import { styleForPassRead } from './reroute'
import { styleContract } from './style'
import type { Row } from './registry'

/** §4's eleven layers, in the order a brief carries them. The list is the
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
  }
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
  const order = new Map((canon.chapters ?? []).map(c => [c.id, c.order ?? 0]))
  const num = (id: string): number => Number(id.split('-').pop()) || 0
  const rank = (chapter: string, scene: string): number => (order.get(chapter) ?? 0) * 1000 + num(scene)
  const mine = rank(subject.chapter, subject.scene?.scene ?? subject.sceneId ?? '')
  return scenes
    .filter(s => s.scene !== subject.scene?.scene)
    .map(s => ({ s, r: rank(s.chapter, s.scene) }))
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
function handoffText(canon: CanonDoc, prev: ProseScene, material: MaterialItem[]): string {
  const out: string[] = []
  const eras = (canon as { timeline?: { eras?: unknown[] } }).timeline?.eras ?? []
  out.push(`It follows ${prev.scene} (${prev.file}).`)

  const after = prev.contract?.reader_after?.trim()
  if (after) out.push(`WHAT THE READER NOW HAS\n${after}`)

  // The window the scene covers, from its own frontmatter.
  const span = (prev as unknown as { span?: { start?: string; end?: string } }).span
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

  const satisfies = (prev.contract as { satisfies?: string[] } | null)?.satisfies ?? []
  const opened = material.filter(m => m.type === 'obligation' && (m.related ?? []).some(r => (prev.facts ?? []).includes(r)))
  const obligations = [
    ...satisfies.map(id => `discharged ${id}`),
    ...opened.filter(m => !satisfies.includes(m.id)).map(m => `open ${m.id} — ${String(m.body ?? '').trim().split('\n')[0]}`),
  ]
  if (obligations.length) out.push(`WHAT IT LEFT OWING\n${obligations.map(o => `- ${o}`).join('\n')}`)
  return out.join('\n\n')
}

interface MaterialItem { id: string; type?: string; body?: string; related?: string[]; satisfied_by?: string[] }

/** The story's material, read fresh. Absent directory, no obligations. */
function materialItems(): MaterialItem[] {
  const dir = path.join(STORY, 'material')
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.yaml'))
      .map(f => yamlLoad(fs.readFileSync(path.join(dir, f), 'utf8')) as MaterialItem)
      .filter(m => m?.id)
  } catch {
    return []
  }
}

/** Every layer arc can assemble today, each with its ids and its reason.
 *  A layer that has no builder yet is here too, with the status that says so
 *  and the card that will build it — the manifest is the checklist, and a
 *  layer left off it is a gap nobody can see. */
function candidates(row: Row, subject: WritingSubject, stage: SliceStage, intent: Intent): (SliceBlock & { because?: string; note?: string })[] {
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
  const locks = scene
    ? locksOn(scene.scene, scene.body).filter(l => l.scope === 'paragraph' && l.resolution.paragraph !== null)
    : []
  const povVoice = pov ? (canon.entities?.[pov]?.voice ?? '').trim() : ''

  const b = (
    layer: WritingLayer, ids: string[], reason: string, text: string,
    extra: { because?: string; note?: string } = {},
  ): SliceBlock & { because?: string; note?: string } => ({
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
      const prev = previousScene(canon, subject, proseScenes())
      if (!prev) {
        return {
          layer: 'handoff' as const, ids: [], reason: 'the condition the previous scene left the story in',
          status: 'none' as const, text: '',
          because: 'this is the first scene of the book, so there is nothing behind it',
        }
      }
      // A SCENE THAT IS STILL A PROPOSAL IS SAID TO BE ONE. Writing the next
      // scene onto prose the author has not accepted is a reasonable thing to
      // do and a dangerous thing to do silently: the pass should know the
      // ground it is building on may move.
      const draft = prev.status !== 'canon'
      return {
        layer: 'handoff' as const, ids: [prev.scene], reason: 'the condition the previous scene left the story in',
        status: 'given' as const,
        text: (draft ? 'FOLLOWS A DRAFT — NOT YET ACCEPTED. What is below may change under you.\n\n' : '') +
          handoffText(canon, prev, materialItems()),
        ...(draft ? { note: `follows ${prev.scene}, which the author has not accepted` } : {}),
      }
    })(),

    { layer: 'dramatic-condition', ids: pov ? [pov] : [],
      reason: 'what the people here want, fear and believe, and what is already promised',
      status: 'deferred', text: '',
      because: 'what each person wants and fears is inside the record layer today; what the story still owes is not read yet' },

    b('canon', [...(scene?.facts ?? []), ...(scene?.events ?? [])],
      'what is true at this moment, each fact with the reason it is here', pack,
      { note: 'every fact is here; whether each one is settled, proposed or only material is not said yet' }),

    { layer: 'position', ids: [], reason: 'where this scene sits in the book', status: 'deferred', text: '',
      because: 'arc does not read the neighbouring scenes or the chapter summaries yet' },

    b('voice', pov ? [pov] : [], 'how the point-of-view character sounds',
      povVoice ? `${pov}: ${povVoice}` : '',
      { because: pov ? 'no voice is recorded for the point-of-view character' : 'this scene names no point of view',
        note: 'the point-of-view character only; the others in the scene are not described yet' }),

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
    .map(({ layer, ids, reason, status, text }) => ({ layer, ids, reason, status, text }))

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
    }),
  }
}

const rendered = (b: SliceBlock): string => `=== ${HEADINGS[b.layer]} ===\n${b.text}`
