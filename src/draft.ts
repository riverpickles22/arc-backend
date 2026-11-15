// The drafting pass, on the governed path (U1 · Draft · scene · one-shot;
// A69-3).
//
// The author asks for the next scene of a chapter; arc resolves the gesture
// to a row by code, assembles the writing slice from the record, mints a run
// before the first token, and hands the brief to the gate runner — which owns
// the child, reads the answer, offers the one repair and sees every ending.
// Only when the gates hold does a file reach the working tree, and it reaches
// it as an ordinary draft: word-diffed in the draft layer, the author's
// accept or discard still the only way into the book.
//
// WHAT THIS FILE NO LONGER DOES. It does not hold the pass's rules — they are
// the row's, because the row is the job's one definition. It does not call
// the seam, retry, or decide its own tools. It does not write from inside a
// tool call: the SDK tool-runner path is gone, and under the `sdk` engine
// this row refuses as `could not run`, exactly as the route rows do. What is
// left here is what only a draft knows: where the scene file goes, what the
// assignment says, and how to write a file and put it back if the story
// rejects it.
import fs from 'node:fs'
import path from 'node:path'
import type { CraftPlanned, DraftSceneResponse } from 'arc-canon-graph'
import { STORY } from './config'
import { canonJson } from './canon'
import { currentEngine, SDK_ENGINE_FIX, type Brief } from './engine'
import { styleContract } from './style'
import { recordGenerated } from './ledger'
import { landingSentence } from './refusal'
import { destinationAt, landOrKeep, leansOnSentence, movedSentence, restoreIfOurs, writeValidated } from './landing'
import { READ_MAP, readsFrom, rebaseToLanded } from './reads'
import { fingerprintsAtWrite } from './style-projection'
import { materialItems, proseScenes } from './story'
import { HttpError } from './http'
import { resolveWithin } from './safe-path'
import { resolveRequest } from './request'
import { assembleWritingSlice, weightOf } from './slice'
import { runGates, type ProseGateCtx } from './gates'
import { CRAFT_MOVES, jobFingerprint, rowKey, stageRuns, type StagedRow } from './registry'
import { openRowRun, closeReceipt } from './rowrun'
import { endRun, stateOf } from './runs'
import { planFirst } from './craft-plan'
import { outcomeSentence } from './run'
import { sha16 } from './records'
import { andCapFromContract, wordCapFromContract } from './countable'
import { cellOf, endingOf, gateCtx as gateCtxOf } from './gate-ctx'
import type { CanonDoc } from 'arc-canon-graph'

/** THE WRITING BRIEF OF A DRAFT, IN ONE PLACE (A82-3): rules · slice · ask.
 *  The pass calls this, and so does the evaluation recorder (`eval.ts`) —
 *  which exists to say whether a change to the rules made the prose better,
 *  and can only say it about the brief the pass really sends. A second
 *  assembly would drift from the first and the comparison would be of
 *  something nobody runs. Pure: it reads the record and writes nothing. */
export function writeBriefFor(
  row: StagedRow,
  stage: StagedRow['stages'][number],
  at: {
    chapterId: string; sceneId: string; file: string
    said: string; plan?: { moves: CraftPlanned['moves'] }
    chapterScenes: { scene: string; file: string }[]
  },
): { slice: ReturnType<typeof assembleWritingSlice>; brief: Brief } {
  // The STAGE's slice and ceiling, not the row's: a stage is a launch, and
  // the first stage with a narrower slice must not be briefed from the job.
  const slice = assembleWritingSlice(
    { ...row, slice: stage.slice, budget: stage.budget },
    { chapter: at.chapterId, sceneId: at.sceneId },
    { stage: 'write', intent: { line: at.said || undefined, plan: at.plan } })
  const assignment = draftUserMessage(at.chapterId, at.sceneId, at.file, undefined, at.chapterScenes)
  return {
    slice,
    brief: {
      blocks: [
        { id: 'rules', text: stage.rules, cached: true },
        { id: 'slice', text: slice.render(), cached: true },
        { id: 'ask', text: assignment, cached: false },
      ],
    },
  }
}

/** What the seam is handed for the writing stage: the stage's own budget,
 *  gates and answer, under the row's cell, withholding and envelope. */
export const writeLaunchSpec = (row: StagedRow, stage: StagedRow['stages'][number]) =>
  ({ ...stage, ...cellOf(row, 'write'), withholding: row.withholding, withheld: row.withheld, envelope: row.envelope })

/** Scene file slot for a chapter: directory from the chapter id's number
 *  (ch.00-prologue → prose/ch-00), next scene number from existing files.
 *  Pure — existingFiles is the story's current prose file list. */
export function sceneSlot(chapterId: string, order: number | undefined, existingFiles: string[]): { file: string; sceneId: string } {
  const m = chapterId.match(/^ch\.(\d+)/)
  const digits = m ? m[1] : String(order ?? 0).padStart(2, '0')
  const dir = `prose/ch-${digits}`
  let max = 0
  for (const f of existingFiles) {
    const sm = f.match(new RegExp(`^${dir}/scene-(\\d+)\\.md$`))
    if (sm) max = Math.max(max, Number(sm[1]))
  }
  const n = max + 1
  return { file: `${dir}/scene-${String(n).padStart(2, '0')}.md`, sceneId: `sc.${digits}-${n}` }
}

/** The user turn: the assignment. Pure, for tests. */
export function draftUserMessage(chapterId: string, sceneId: string, file: string, guidance: string | undefined, chapterScenes: { scene: string; file: string }[]): string {
  const existing = chapterScenes.length
    ? `This chapter already has ${chapterScenes.length} scene(s): ${chapterScenes.map(s => `${s.scene} (${s.file})`).join(', ')} — included above. Your scene follows them; do not retell them.`
    : 'This is the chapter\'s first scene.'
  return [
    `Draft scene ${sceneId} of chapter ${chapterId}.`,
    `Its file is ${file}, and its id is ${sceneId} — write them into the frontmatter exactly.`,
    existing,
    guidance?.trim() ? `AUTHOR'S GUIDANCE (binding): ${guidance.trim()}` : '',
    'Run the drafting pass.',
  ].filter(Boolean).join('\n\n')
}


/** THE ASSIGNMENT — the brief's fifth slot, the ask. Pure, for tests. */

/** Run the drafting pass for a chapter, as a governed run.
 *
 *  Throws HttpError(400) on an unknown chapter, on a cell the rows do not
 *  list, and — before a token — on a slice that cannot hold its floor. */
export async function runDraft(
  chapterId: string,
  guidance?: string,
  given?: CraftPlanned | null,
  /** ASKING AGAIN (A72-13): the pending proposal this run replaces, and the
   *  slot it goes back into. A replay of a drafted scene must land in ITS OWN
   *  target — `sceneSlot` picks the next free one, which after a landing is
   *  the one after this, so a replay without it would write a new scene
   *  beside the author's rather than in its place. */
  into?: { replaces: { sha: string; run?: string }; file: string; sceneId: string },
): Promise<DraftSceneResponse> {
  const canon = JSON.parse(canonJson()) as CanonDoc
  const chapter = (canon.chapters ?? []).find(c => c.id === chapterId)
  if (!chapter) throw new HttpError(400, `no chapter ${chapterId}`)

  // THE REQUEST (§4): the gesture the author made, resolved by code to a cell
  // and then to the row that admits it — refused here, in their words, if the
  // rows do not list it.
  const request = resolveRequest({
    said: `draft the next scene of ${chapterId}`,
    job: 'draft', scope: 'scene', mode: 'one-shot',
    subject: chapterId,
  })
  const row = request.row as StagedRow
  const stage = row.stages.find(s => s.id === 'write')
  const planStage = row.stages.find(s => s.id === 'craft-plan')
  if (!stage || !planStage) throw new HttpError(500, 'the drafting row is missing a stage')

  // NO RUN FOR A PASS THAT CANNOT RUN. Every rowed pass refuses on the `sdk`
  // engine (A69-3), and finding that out after a run is minted and a receipt
  // written leaves the author with a record of something that never started.
  if (currentEngine() === 'sdk') {
    throw new HttpError(400,
      'arc cannot draft on the engine it is set up to use — it can only show you what a pass was given when it runs the claude CLI on your login. ' +
      SDK_ENGINE_FIX)
  }

  const scenes = proseScenes()
  // THE SLOT IS ABOUT WHAT IS ON DISK, not about what parses. `proseScenes()`
  // drops any file whose frontmatter is broken — a scene the author is
  // halfway through editing — and a slot chosen from the parsed list would
  // hand back that exact path and write over their work (A69-3).
  const { file, sceneId } = into ?? sceneSlot(chapterId, chapter.order, proseFiles())
  // THE DESTINATION AT LAUNCH (A72-4). For a new scene that is its ABSENCE,
  // which is a state a target can stop being while the pass runs.
  const dest = destinationAt(file)
  const chapterScenes = scenes.filter(s => s.chapter === chapterId)

  // THE SLICE, before anything is sent. A floor that will not fit refuses
  // here, in the author's words, and nothing is spent finding out.
  // The STAGE's slice and ceiling, not the row's: a stage is a launch, and
  // the first stage with a narrower slice must not be briefed from the job.
  const subject = { chapter: chapterId, sceneId }
  const said = guidance?.trim() ?? ''

  // THE CRAFT PLAN (A69-4; §4). A line said now becomes craft before a token
  // is spent on prose, and the author reads it, edits it or drops it first.
  //
  // Whether a line "names an effect" is not something code can tell — that is
  // the reading's own judgement, and the reading is what we have. So any line
  // gets one, and the author's *drop* is the way out. No line, no stage, and
  // the receipt records that there was nothing to translate.
  //
  // `given` is what comes back on the second call: `undefined` means the
  // author has not been asked yet; a plan means they settled one; `null`
  // means they withdrew the line and want the draft without it.
  if (given === undefined && stageRuns(planStage, said)) {
    return await planFirst(request, row, planStage, subject, said)
  }
  // THE VOCABULARY IS CLOSED HERE TOO. The route checks what the page sent,
  // and this checks what any caller passes: a move outside the six reaching
  // the writing pass is the one thing the closed set exists to prevent, and
  // it must not depend on which door the plan came through (A69-4).
  const plan = given?.moves?.length ? { moves: given.moves } : undefined
  for (const m of plan?.moves ?? []) {
    if (!(m.move in CRAFT_MOVES)) {
      throw new HttpError(400,
        `arc does not know how to ask a writing pass for "${m.move}". It can work on ${Object.keys(CRAFT_MOVES).join(', ')}.`)
    }
  }

  // THE SLICE, before anything is sent. A floor that will not fit refuses
  // here, in the author's words, and nothing is spent finding out. The
  // STAGE's slice and ceiling, not the row's: a stage is a launch, and the
  // first stage with a narrower slice must not be briefed from the job.
  const { slice, brief } = writeBriefFor(row, stage, { chapterId, sceneId, file, said, plan, chapterScenes })

  const ctx = openRowRun(request, row, {
    ...slice.forReceipt(),
    withheld: [],
    dropped: slice.forReceipt().dropped_for_budget,
    read: [{ id: `slice:${sceneId}`, version: sha16(slice.render()) }],
  })
  // WHAT THE PASS WAS SHOWN, CAPTURED NOW (A72-4, invariant 1) — before the
  // model runs, not after it lands. A dependency the author moves WHILE the
  // pass is out has to make the answer stale, and a map sampled at the
  // landing records that change as if the pass had read it.
  const readAtLaunch = readsFrom(fingerprintsAtWrite(sceneId))
  const jobAtLaunch = jobFingerprint(row)
  const { run, receipt } = ctx
  // WHAT THE AUTHOR SAID AND WHAT IT BECAME, on the receipt. The plan is
  // ephemeral — it lives here and in the evidence-log row the decision
  // writes, and nowhere else (§4). A plan the author never settled dies with
  // the sitting.
  receipt.intent = {
    said: said || null,
    plan: plan ?? null,
    ...(said && !plan ? { withdrawn: true } : {}),
    // Only when there was nothing to translate AND nothing translated: a
    // second call may carry the settled plan and not the line that made it.
    ...(!said && !plan ? { note: 'nothing to translate' } : {}),
  }

  // THE GATE CHECKS; IT DOES NOT WRITE. The story's validator can only read a
  // file that is on disk, so the candidate goes down and comes straight back
  // up again whatever the verdict — and the draft is written once, below,
  // because every gate held. A gate whose side effect is what puts prose in
  // the book would mean removing that gate from the row silently stops the
  // pass writing at all.
  const validate = (content: string): { ok: boolean; output: string } => {
    const trial = writeTrial(file, content)
    trial.restore()
    return trial.check
  }

  const ctxForGates: ProseGateCtx = {
    ...gateCtxOf({
      sceneName: sceneId,
      sceneBody: '',
      sceneLocks: [],
      lockedTexts: [],
      literals: [],
      andCap: andCapFromContract(styleContract()),
      wordCap: wordCapFromContract(styleContract()),
      destination: [],
      known: [],
    }),
    validate,
    // What may bear weight, from the record the model was briefed with, so
    // the leans-on tail is measured against the same statuses the brief
    // tagged (A69-6).
    ...weightOf(canon, materialItems()),
  }

  let landed = false
  let wrote: string | null = null
  try {
    const out = await runGates({
      row: writeLaunchSpec(row, stage),
      run, receipt, brief,
      repair: (refusal, resumed) => ({
        blocks: resumed
          ? [{ id: 'repair', text: refusal, cached: false }]
          : [...brief.blocks, { id: 'repair', text: refusal, cached: false }],
      }),
      attempt: n => `write-${n}`,
      gateCtx: ctxForGates,
      render: b => b.blocks.map(x => x.text).join('\n\n'),
    })

    const stopped = stateOf(run.id) === 'cancelled'
    if (!out.ok) {
      // endingOf() is the one place the closed set is read (A67-3): a second
      // chain here would drift from it, and has.
      const ending = endingOf([{ kind: out.kind, gateRefused: out.gateRefused, unreadable: out.unreadable }], stopped)
      closeReceipt(ctx, ending)
      endRun(run.id, ending, { refused: out.reason })
      return {
        reply: outcomeSentence({ ending, gates: receipt.gates }) ?? out.reason,
        actions: [{ tool: 'draft', path: file, ok: false, detail: out.reason }],
        file: null,
        run: run.id,
      }
    }

    // A STOP IS NOT A DRAFT. The author pressed stop while this was working;
    // writing the answer now would put prose in the book after they said no.
    if (stopped) {
      closeReceipt(ctx, 'cancelled')
      endRun(run.id, 'cancelled', { stopped_by: 'author' })
      return {
        reply: outcomeSentence({ ending: 'cancelled', gates: receipt.gates }) ?? 'you stopped it before it landed — ask again to draft from where the chapter stands now.',
        actions: [],
        file: null,
        run: run.id,
      }
    }

    // Every gate held, so the draft is written — once, here, by this pass.
    // A write the story's validator refuses is put back by writeValidated
    // itself — the previous contents restored, or the file removed if there
    // were none — so nothing here removes the file on that path: a revert
    // after a restore would delete what was just put back.
    // THE LANDING COMPARE (A72-4, invariant 1). For a new scene the snapshot
    // is the file's ABSENCE: a destination that has become occupied while the
    // pass ran is one arc must not write over, and a plain write took it.
    const landing = landOrKeep(dest, run.id, out.checked.body, () => {
      wrote = out.checked.body   // what this pass put on disk, for the restore
      return writeValidated(file, out.checked.body)
    }, () => recordGenerated(file, out.checked.body, {
      engine: currentEngine() ?? 'fixture', scene: sceneId, origin: 'draft', run: run.id,
      reads: rebaseToLanded(readAtLaunch, sceneId), v: READ_MAP, job: jobAtLaunch,
      // THE REQUEST (A72-13). `file` is the slot THIS draft was written into:
      // asking again goes back to its own target, never to the next free one,
      // or a replay quietly becomes a different scene.
      replay: {
        row: rowKey(row), scene: sceneId, file,
        ...(guidance ? { guidance } : {}),
        ...(plan ? { plan: { moves: plan.moves } } : {}),
        // A new scene is written from no notes of its own — the scene did not
        // exist to carry any — so this is what the chapter's record said, and
        // it is recorded for the same reason the other rows record theirs.
        notes: readAtLaunch.filter(r => r.id.startsWith('note')),
      },
      ...(into ? { supersedes: into.replaces } : {}),
    }, true))
    if (!landing.ok && landing.why === 'moved') {
      closeReceipt(ctx, 'unfinished')
      endRun(run.id, 'unfinished', { error: 'the destination was taken while the pass ran' })
      throw new HttpError(409, movedSentence(sceneId))
    }
    if (!landing.ok) {
      closeReceipt(ctx, 'could not run')
      endRun(run.id, 'could not run', { error: landing.output })
      // THE CHECK IS READ, NOT QUOTED (A72-11): the landing's refusal is
      // usually the story's own validator, and its summary line is not the
      // author's language.
      console.error('[info] a draft could not land:\n' + landing.output)
      throw new HttpError(500, landingSentence('that draft', landing.output))
    }
    landed = true
    closeReceipt(ctx, 'landed')
    endRun(run.id, 'landed', { landed: [sceneId] })
    return {
      // the scene, not the path: the author has scenes (A72-11)
      reply: `Drafted ${sceneId}. It is waiting beside the scene in arc — read it, then accept or discard.${leansOnSentence(receipt.slice?.leaned_on)}`,
      actions: [{ tool: 'draft', path: file, ok: true }],
      file,
      run: run.id,
      ...(plan ? { plan } : {}),
    }
  } catch (e) {
    // Only a file this pass wrote and did not land is removed: a throw after
    // the draft is in the ledger must not delete the thing the ledger names,
    // and a throw before the write must not delete what was there before.
    // Only a file this pass wrote and did not land is put back, and only when
    // the file still holds what the pass put there (A72-4): a target someone
    // else has written since is theirs, not arc's to remove.
    if (wrote && !landed) restoreIfOurs(dest, wrote)
    const ending = stateOf(run.id) === 'cancelled' ? 'cancelled' : 'could not run'
    closeReceipt(ctx, ending)
    endRun(run.id, ending, { error: (e as Error).message })
    throw e
  }
}

/** Every markdown file under `prose/`, parsed or not. */
export function proseFiles(): string[] {
  const root = path.join(STORY, 'prose')
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.md')) out.push(path.relative(STORY, full))
    }
  }
  walk(root)
  return out.sort()
}

/** A TRIAL WRITE. The story's validator reads files, so a candidate has to be
 *  on disk to be judged — and whatever it finds, the working tree goes back
 *  exactly as it was: the previous content restored, or the file removed if
 *  there was none. Deleting instead of restoring is how a draft that went
 *  wrong takes the author's own scene with it. */
function writeTrial(rel: string, content: string): { check: { ok: boolean; output: string }; restore: () => void } {
  const abs = resolveWithin(STORY, rel)
  const had = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null
  const check = writeValidated(rel, content)
  return {
    check,
    restore: () => {
      try {
        if (had === null) fs.rmSync(abs, { force: true })
        else fs.writeFileSync(abs, had)
      } catch (e) { console.error('[warn] could not put the scene file back:', e) }
    },
  }
}

// `revert` is gone with A72-4: a rejected draft is put back by
// `restoreIfOurs`, which removes the file only when it still holds what this
// pass wrote. Deleting unconditionally is how a pass that failed could take a
// scene somebody else had written in the meantime.
