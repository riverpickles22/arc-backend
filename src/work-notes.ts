// "Work through my notes on this scene" — U2, on the governed path (Revise ·
// scene · one-shot · quick; A69-9).
//
// The author leaves notes in the margin and later asks for them to be
// worked — in Claude Code, from the rail, from a terminal. No ceremony: the
// scene's open notes ARE the brief. This module is the one place that
// sentence resolves to a row, so the register is chosen on purpose rather
// than by which button happened to be nearest:
//
//   revise  — the minimal revision; the notes are instructions, the prose
//             changes as little as they require. Its row is the QUICK pass
//             over a scene (registry.ts says why that is the axis).
//   redraft — the clean pass; the notes are answered where the rebuild
//             allows. Its row is the STANDARD one (U3, A69-8).
//
// THREE STAGES, AND THE FIRST ONE WRITES NOTHING.
//
//   conflict   always. Two notes that pull opposite ways are the author's
//              decision and not a model's, so the reading runs before any
//              token is spent on prose. A non-empty answer ends the run
//              `waiting for you` with the tensions on the response and
//              nothing written; a reading that could not run STOPS THE JOB
//              (§5, P2 fails closed) and never becomes a licence to write.
//   craft-plan when the author said a line. As everywhere, the pass that
//              writes receives the craft and never the effect.
//   write      once per note cluster, serially — voice continuity is not a
//              graph property (§5, P3) — each launch named on the run.
//
// Both modes record which notes they were handed on the generation ledger,
// so the viewer can say "answered in the draft" beside a note and the accept
// can close it — provenance, never a model's judgement that a note was met.
// A scene with no open notes is refused, not run on nothing.
import type { NoteConflict, WorkNotesMode, WorkNotesResponse } from 'arc-canon-graph'
import fs from 'node:fs'
import path from 'node:path'
import { openNotesOn } from './annotations'
import { STORY } from './config'
import { canonJson } from './canon'
import { cellOf, planGateCtx, writeValidated } from './draft'
import { currentEngine } from './engine'
import { parseCraftPlan, runGates, type ProseGateCtx } from './gates'
import { HttpError } from './http'
import { recordGenerated } from './ledger'
import { locksOn } from './locks'
import { sha16 } from './records'
import { notesAnswerable, runRedraft } from './redraft'
import { CRAFT_MOVES, stageRuns, type Stage, type StagedRow } from './registry'
import { resolveRequest } from './request'
import { andCapFromContract, endingOf, gateCtx as gateCtxOf, wordCapFromContract } from './reroute'
import { clusterNotes, parseConflicts } from './revise'
import { outcomeSentence, type Source } from './run'
import { closeReceipt, openRowRun } from './rowrun'
import { endRun, stateOf } from './runs'
import { assembleWritingSlice, weightOf } from './slice'
import { literalWithholds } from './redraft'
import { materialItems, parseScene, proseScenes } from './story'
import { styleContract } from './style'
import type { CanonDoc, CraftPlanned } from 'arc-canon-graph'

export interface WorkNotesTarget {
  scene: string
  mode?: WorkNotesMode
  /** Binding guidance for the clean pass; the minimal revision takes its
   *  instructions from the notes alone. */
  guidance?: string
  /** Who asked — the viewer, a terminal, a Claude Code session. */
  source?: Source
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The refusal for a scene with nothing to work through. Ends with the next
 *  action in the product's own gestures (CLAUDE.md: keystrokes, not verbs). */
export const nothingToWork = (scene: string): string =>
  `${scene} has no open notes — nothing to work through. Leave a note on the scene in arc first: highlight a phrase and write, or right-click a paragraph and choose "note". Then ask again.`

/** One paragraph for the author: what happened and where to look. Never the
 *  prose — the draft lands beside the scene, and arc is where it is read. */
export function describeOutcome(a: {
  scene: string; mode: WorkNotesMode; notes: string[]; changed: boolean
  conflicts: NoteConflict[]; refused?: string; error?: string
}): string {
  if (a.conflicts.length) {
    const pairs = a.conflicts.map(c => `${c.between.join(' and ')}: ${c.tension}`).join(' ')
    return `Two of your notes on ${a.scene} pull against each other, so nothing was written. ${pairs} Decide which wins — resolve or edit one in arc — then ask again.`
  }
  if (a.refused) return `${a.scene} was not revised: ${a.refused}. Nothing was written.`
  if (a.error) return `The pass over ${a.scene} did not finish: ${a.error}. Nothing was written.`
  if (!a.changed) return `The pass read ${count(a.notes.length, 'note')} on ${a.scene} and changed nothing. Nothing was written; the notes stay open.`
  const how = a.mode === 'redraft' ? 'answered in a clean pass over' : 'worked into'
  return `${count(a.notes.length, 'note')} on ${a.scene} ${a.notes.length === 1 ? 'was' : 'were'} ${how} the scene. The draft is beside the scene in arc — open the manuscript to review it. Nothing is accepted, and the notes stay open until you close them.`
}

export async function runWorkNotes(t: WorkNotesTarget): Promise<WorkNotesResponse> {
  const scene = proseScenes().find(s => s.scene === t.scene)
  if (!scene) throw new HttpError(400, `no scene ${t.scene}`)
  // THE NOTES THIS SURFACE WORKS ARE THE AUTHOR'S, and that is decided once,
  // here, before either mode reads them. Filtered later, the two modes
  // disagreed: a scene whose only open notes were arc's own refused in one
  // and rebuilt end to end in the other, reported as "your notes were
  // answered" with an empty list of them (A69-9 review).
  const open = notesAnswerable(openNotesOn(t.scene))
  if (!open.length) throw new HttpError(409, nothingToWork(t.scene))
  const mode: WorkNotesMode = t.mode ?? 'revise'

  // Settled prose, BEFORE any token is spent. Both passes refuse a scene
  // settled entire, but the minimal revision would first pay for a conflict
  // check; a lock is proven and free, so it answers first (A29, A40-1).
  const whole = locksOn(t.scene, scene.body)
    .filter(l => l.resolution.state === 'resolved' || l.resolution.state === 'drifted')
    .find(l => l.scope === 'scene' || l.scope === 'chapter')
  if (whole) {
    throw new HttpError(423,
      `${whole.scope === 'chapter' ? 'this chapter' : 'this section'} is settled — locked (${whole.id}). Unlock it from the scene's header in arc to work the notes; nothing was written.`)
  }

  if (mode === 'redraft') {
    // The clean pass reads the same notes itself and records them on the
    // ledger; its refusals — locks, the validator, a quoted withhold —
    // surface as they are, in the author's words. It stages a craft-plan
    // reading in front of its write when a line is said (A69-8, A69-4), and
    // this surface has no way to show the author that plan, so a plan the
    // reading returns is taken as it stands and the write runs on it.
    let out = await runRedraft({ scene: t.scene, guidance: t.guidance })
    if (out.plan && out.file === null && !out.actions.length) {
      out = await runRedraft({ scene: t.scene, guidance: t.guidance }, out.plan)
    }
    const changed = out.file !== null
    const ids = open.map(n => n.id)
    return {
      scene: t.scene, mode, notes: ids, file: out.file, changed, conflicts: [],
      reply: changed
        ? describeOutcome({ scene: t.scene, mode, notes: ids, changed: true, conflicts: [] })
        : out.reply,
      run: out.run ?? null,
    }
  }
  return runMinimalRevision(t, scene, open)
}

/** THE MINIMAL REVISION, as a governed run (A69-9).
 *
 *  One run, three stages, and the conflict reading first. Everything the
 *  author can later ask of the receipt that is knowable before the pass runs
 *  is on it from the launch — including which notes were handed and who
 *  wrote each one. */
async function runMinimalRevision(
  t: WorkNotesTarget, scene: NonNullable<ReturnType<typeof proseScenes>[number]>,
  open: ReturnType<typeof openNotesOn>,
): Promise<WorkNotesResponse> {
  // ONLY THE AUTHOR'S NOTES ARE INSTRUCTIONS (§4). A note arc wrote is arc's
  // own reading; handing it back as an instruction is how a model's guess
  // becomes the author's brief one pass later.
  const handed = notesAnswerable(open)
  const ids = handed.map(n => n.id)
  if (!ids.length) throw new HttpError(409, nothingToWork(t.scene))

  // THE REQUEST (§4): the gesture, resolved by code to a cell and then to the
  // row that admits it. The minimal revision is the QUICK pass over a scene;
  // the clean pass is the standard one (registry.ts says why).
  const request = resolveRequest({
    said: `work the open notes on ${t.scene} into the prose`,
    job: 'revise', scope: 'scene', mode: 'one-shot', depth: 'quick',
    subject: t.scene,
  })
  const row = request.row as StagedRow
  const stageBy = (id: string): Stage => {
    const s = row.stages.find(x => x.id === id)
    if (!s) throw new HttpError(500, `the notes-work row is missing its ${id} stage`)
    return s
  }
  const conflictStage = stageBy('conflict')
  const planStage = stageBy('craft-plan')
  const writeStage = stageBy('write')

  // NO RUN FOR A PASS THAT CANNOT RUN (A69-3): every rowed pass refuses on
  // the `sdk` engine, before a run is minted.
  if (currentEngine() === 'sdk') {
    throw new HttpError(400,
      'arc cannot work your notes on the engine it is set up to use — it can only show you what a pass was given when it runs the claude CLI on your login. ' +
      'Log in with  claude  and ask again, or remove ANTHROPIC_API_KEY from arc-backend/.env.')
  }

  const said = t.guidance?.trim() ?? ''
  const subject = { chapter: scene.chapter, scene }
  const sliceFor = (stage: Stage, intent?: { line?: string; plan?: { moves: { move: string; how: string }[] } }) =>
    assembleWritingSlice({ ...row, slice: stage.slice, budget: stage.budget }, subject,
      { stage: stage.id === 'craft-plan' ? 'craft-plan' : 'write', intent: intent ?? {} })

  // The run opens on the CONFLICT stage's slice, because that is the first
  // thing sent. Later stages add their own briefs to the same receipt.
  const first = sliceFor(conflictStage)
  const ctx = openRowRun(request, row, {
    ...first.forReceipt(),
    withheld: [],
    dropped: first.forReceipt().dropped_for_budget,
    read: [{ id: `slice:${t.scene}:conflict`, version: sha16(first.render()) }],
  })
  const { run, receipt } = ctx
  receipt.notes_handed = handed.map(n => ({ id: n.id, by: (n.by ?? 'author') as 'author' | 'agent' }))
  receipt.intent = { said: said || null, plan: null, ...(said ? {} : { note: 'nothing to translate' }) }

  const launch = (stage: Stage, name: string) => ({
    row: { ...stage, ...cellOf(row, stage.id), withholding: row.withholding, withheld: row.withheld, envelope: row.envelope },
    run, receipt,
    attempt: (n: 1 | 2) => `${name}-${n}`,
    render: (b: { blocks: { text: string }[] }) => b.blocks.map(x => x.text).join('\n\n'),
  })
  const repairOf = (brief: { blocks: { id: string; text: string; cached: boolean }[] }) =>
    (refusal: string, resumed: boolean) => ({
      blocks: resumed
        ? [{ id: 'repair', text: refusal, cached: false }]
        : [...brief.blocks, { id: 'repair', text: refusal, cached: false }],
    })

  /** The job stopped, and nothing more will be written. `already` is what
   *  EARLIER clusters put in the draft layer before this one was refused:
   *  writes are serial, so a refusal on the third cluster does not unwrite
   *  the first two, and telling the author nothing moved while prose sits in
   *  the draft layer and on the ledger is the one thing this must not say
   *  (A69-10 review). */
  const nothing = (
    ending: 'refused' | 'could not run' | 'cancelled' | 'unreadable',
    reply: string,
    already: { wrote: boolean; file: string } = { wrote: false, file: scene.file },
  ): WorkNotesResponse => {
    closeReceipt(ctx, ending)
    endRun(run.id, ending, { refused: reply, ...(already.wrote ? { landed_before_refusal: already.file } : {}) })
    return {
      scene: t.scene, mode: 'revise', notes: ids,
      file: already.file, changed: already.wrote, conflicts: [],
      reply: already.wrote
        ? `${reply} What arc had already worked into ${t.scene} before that is waiting in the manuscript — read it, then accept or discard.`
        : reply,
      run: run.id,
    }
  }

  try {
    // ---- 1. THE CONFLICT READING. Always, and before any prose. ----------
    const conflictBrief = {
      blocks: [
        { id: 'rules', text: conflictStage.rules, cached: true },
        { id: 'slice', text: first.render(), cached: true },
        { id: 'ask', text: 'Answer with the JSON array.', cached: false },
      ],
    }
    const read = await runGates({
      ...launch(conflictStage, 'conflict'),
      brief: conflictBrief, repair: repairOf(conflictBrief), gateCtx: planGateCtx(),
    })
    if (stateOf(run.id) === 'cancelled') {
      return nothing('cancelled', outcomeSentence({ ending: 'cancelled', gates: receipt.gates }) ?? 'you stopped it before anything was written.')
    }
    if (!read.ok) {
      // P2 FAILS CLOSED. A conflict reading that could not run is not a
      // licence to write blindly — the author is told, and nothing moves.
      const ending = endingOf([{ kind: read.kind, gateRefused: read.gateRefused, unreadable: read.unreadable }], false)
      return nothing(ending as 'refused' | 'could not run' | 'unreadable',
        `arc could not check your notes on ${t.scene} for conflicts, so nothing was written. Ask again.`)
    }
    const conflicts: NoteConflict[] = parseConflicts(read.checked.body)
    if (conflicts.length) {
      // REFUSED, AND THE REASON IS A DECISION ONLY THE AUTHOR CAN MAKE.
      // The reading did its job and found a real tension; arc then declines
      // to write and says why, which is what `refused` means everywhere else
      // here — the leak gate, the locks, a bad range. The run is OVER: there
      // is nothing to accept or reject, and the author's next move is to
      // settle the notes and ask again. `waiting for you` is for a run that
      // carries an outcome the author decides ON; parked there with none,
      // this run could never leave the state, would count as still working
      // in the briefing and in `arc doctor`, and would refuse to let its
      // transcript be deleted (A69-9 review). The conflicts and what is
      // waited on stay on the receipt.
      closeReceipt(ctx, 'refused')
      endRun(run.id, 'refused', { waiting_on: 'the author decides which note wins', conflicts })
      return {
        scene: t.scene, mode: 'revise', notes: ids, file: scene.file, changed: false, conflicts,
        reply: describeOutcome({ scene: t.scene, mode: 'revise', notes: ids, changed: false, conflicts }),
        run: run.id,
      }
    }

    // ---- 2. THE CRAFT PLAN, when a line was said. ------------------------
    let plan: CraftPlanned | undefined
    if (stageRuns(planStage, said)) {
      const planSlice = sliceFor(planStage, { line: said })
      const planBrief = {
        blocks: [
          { id: 'rules', text: planStage.rules, cached: true },
          { id: 'slice', text: planSlice.render(), cached: true },
          { id: 'ask', text: `The author said: ${said}\n\nAnswer with the JSON block.`, cached: false },
        ],
      }
      const out = await runGates({
        ...launch(planStage, 'craft-plan'),
        brief: planBrief, repair: repairOf(planBrief), gateCtx: planGateCtx(),
      })
      if (!out.ok) {
        const ending = endingOf([{ kind: out.kind, gateRefused: out.gateRefused, unreadable: out.unreadable }], false)
        return nothing(ending as 'refused' | 'could not run' | 'unreadable',
          `arc could not turn "${said}" into craft, so nothing was written. Ask again, or work the notes without a line.`)
      }
      const parsed = parseCraftPlanned(out.checked.body)
      if (parsed) plan = parsed
      receipt.intent = { said, plan: plan?.moves ? { moves: plan.moves } : null }
    }

    // ---- 3. THE WRITE, once per cluster, serially. -----------------------
    // At scene scope there is exactly one cluster; the loop is the shape the
    // rule names, and prose stays serial whatever the count (§5, P3).
    const clusters = clusterNotes(handed)
    if (!clusters.length) {
      return nothing('refused', `arc could not place your notes on ${t.scene} — their anchors no longer resolve. Nothing was written.`)
    }
    const canon = JSON.parse(canonJson()) as CanonDoc
    let wrote = false
    let lastFile = scene.file
    for (const [i, cluster] of clusters.entries()) {
      const name = `cluster-${i + 1}`
      const live = proseScenes().find(s => s.scene === cluster.scene)
      if (!live) continue
      // THE GATE CHECKS; IT DOES NOT WRITE. The validator reads a file on
      // disk, so the candidate goes down and the author's own text comes
      // straight back up whatever the verdict; the revision is written once,
      // below, because every gate held.
      const absLive = path.join(STORY, live.file)
      const rawLive = fs.readFileSync(absLive, 'utf8')
      const headLive = rawLive.slice(0, rawLive.length - (parseScene(rawLive, live.file)?.body.length ?? 0))
      const fileOf = (prose: string): string =>
        headLive + prose.trim() + (prose.trim().endsWith('\n') ? '' : '\n')
      const validate = (prose: string): { ok: boolean; output: string } => {
        const out = writeValidated(live.file, fileOf(prose))
        if (out.ok) fs.writeFileSync(absLive, rawLive)
        return out
      }
      const writeSlice = sliceFor(writeStage, { line: said || undefined, plan: plan?.moves ? { moves: plan.moves } : undefined })
      // THE RECEIPT NAMES WHAT THE WRITE WAS SHOWN, not what the conflict
      // reading was. The run opened on the reading's one-layer slice, and
      // leaving it there would have the receipt understate the model's brief
      // by eleven layers — the one thing the assembler exists to prevent —
      // and report no aged state fact the revision leaned on (A69-9 review).
      Object.assign(receipt.slice ?? (receipt.slice = {} as NonNullable<typeof receipt.slice>), writeSlice.forReceipt())
      const brief = {
        blocks: [
          { id: 'rules', text: writeStage.rules, cached: true },
          { id: 'slice', text: writeSlice.render(), cached: true },
          { id: 'ask', text: `=== THE SCENE AS IT STANDS (${live.scene}) ===\n${live.body.trim()}\n\nAnswer with the revised scene body alone.`, cached: false },
        ],
      }
      const out = await runGates({
        ...launch(writeStage, name),
        brief, repair: repairOf(brief),
        // A MINIMAL REVISION RETURNS WHAT IT WAS NOT ASKED ABOUT, word for
        // word, so the countable style rules measure only what it wrote.
        gateCtx: { ...writeGateCtx(live, canon), validate, exemptUnchanged: true },
      })
      const sofar = { wrote, file: lastFile }
      if (stateOf(run.id) === 'cancelled') {
        return nothing('cancelled', outcomeSentence({ ending: 'cancelled', gates: receipt.gates }) ?? 'you stopped it before it landed.', sofar)
      }
      if (!out.ok) {
        const ending = endingOf([{ kind: out.kind, gateRefused: out.gateRefused, unreadable: out.unreadable }], false)
        return nothing(ending as 'refused' | 'could not run' | 'unreadable',
          outcomeSentence({ ending, gates: receipt.gates }) ?? out.reason, sofar)
      }
      const body = out.checked.body.trim()
      const next = fileOf(body)
      const check = writeValidated(live.file, next)
      if (!check.ok) {
        return nothing('could not run',
          `arc could not write that revision into your story — ${check.output.split('\n')[0]}. Nothing was written.`, sofar)
      }
      recordGenerated(live.file, next, {
        engine: currentEngine() ?? 'fixture', scene: live.scene, origin: 'revise',
        notes: cluster.notes.map(n => n.id), run: run.id,
      })
      wrote = wrote || body !== live.body.trim()
      lastFile = live.file
    }

    closeReceipt(ctx, 'landed')
    endRun(run.id, 'landed', { landed: clusters.map(c => c.scene) })
    return {
      scene: t.scene, mode: 'revise', notes: ids, file: lastFile, changed: wrote, conflicts: [],
      reply: describeOutcome({ scene: t.scene, mode: 'revise', notes: ids, changed: wrote, conflicts: [] }),
      run: run.id,
    }
  } catch (e) {
    const ending = stateOf(run.id) === 'cancelled' ? 'cancelled' : 'could not run'
    closeReceipt(ctx, ending)
    endRun(run.id, ending, { error: (e as Error).message })
    throw e
  }
}

/** The craft plan as the reading answered it, or nothing. */
/** The plan the gate already read, in the shape the write stage takes. ONE
 *  PARSER: a second one here trimmed nothing and matched move ids exactly,
 *  so a plan the `plan-vocabulary` gate had passed could be silently dropped
 *  and the write would run with no craft while the author had been told
 *  their line became some (A69-9 review). */
function parseCraftPlanned(text: string): CraftPlanned | undefined {
  const moves = parseCraftPlan(text)?.moves.filter(m => m.move in CRAFT_MOVES)
  return moves?.length ? { moves } : undefined
}

/** What the write stage's gates measure against: this scene's locks, the
 *  contract's quoted withholds, and the two countable style rules. */
function writeGateCtx(live: { scene: string; body: string; contract: unknown }, canon: CanonDoc): ProseGateCtx {
  const sceneLocks = locksOn(live.scene, live.body)
    .filter(l => l.scope === 'paragraph' && l.resolution.paragraph !== null)
    .sort((x, y) => (x.resolution.paragraph as number) - (y.resolution.paragraph as number))
  const paras = live.body.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
  return {
    ...gateCtxOf({
      sceneName: live.scene,
      sceneBody: live.body,
      sceneLocks,
      lockedTexts: sceneLocks.map(l => paras[l.resolution.paragraph as number] ?? ''),
      literals: literalWithholds((live.contract as { must_withhold?: unknown } | null)?.must_withhold),
      andCap: andCapFromContract(styleContract()),
      wordCap: wordCapFromContract(styleContract()),
      destination: [],
      known: [],
    }),
    ...weightOf(canon, materialItems()),
  }
}
