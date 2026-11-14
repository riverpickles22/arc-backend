// THE CRAFT-PLAN STAGE: the reading a writing row stages in front of its
// write (§4; A69-8). The draft, the clean pass and the notes revision all run
// it, so it lives here rather than in any one of them (A80-1).
import type { DraftSceneResponse } from 'arc-canon-graph'
import { cellOf, endingOf, planGateCtx } from './gate-ctx'
import { parseCraftPlan, planSentence, runGates } from './gates'
import { sha16 } from './records'
import type { Stage, StagedRow } from './registry'
import type { ResolvedRequest } from './request'
import { closeReceipt, openRowRun } from './rowrun'
import { outcomeSentence } from './run'
import { endRun, stateOf } from './runs'
import { assembleWritingSlice, type WritingSubject } from './slice'

/** THE FIRST HALF OF A WRITING JOB THE AUTHOR GAVE A LINE TO: the reading
 *  alone. Every writing row stages it in front of its write (§4), so the
 *  draft and the clean pass share this one (A69-8).
 *
 *  Its own run, because it is its own launch with its own brief, its own
 *  gates and its own receipt — and because the author may never come back,
 *  in which case what is on record is a reading that happened and a draft
 *  that did not. Nothing is written here and nothing can be: the stage has
 *  no validator, no file and no ledger. */
export async function planFirst(
  request: ResolvedRequest, row: StagedRow, planStage: Stage,
  subject: WritingSubject, said: string,
): Promise<DraftSceneResponse> {
  const slice = assembleWritingSlice(
    { ...row, slice: planStage.slice, budget: planStage.budget }, subject,
    { stage: 'craft-plan', intent: { line: said } })

  const about = subject.scene?.scene ?? subject.sceneId ?? subject.chapter
  const ctx = openRowRun(request, row, {
    ...slice.forReceipt(),
    withheld: [],
    dropped: slice.forReceipt().dropped_for_budget,
    read: [{ id: `slice:${about}:craft-plan`, version: sha16(slice.render()) }],
  })
  const { run, receipt } = ctx
  receipt.intent = { said, plan: null }

  const brief = {
    blocks: [
      { id: 'rules', text: planStage.rules, cached: true },
      { id: 'slice', text: slice.render(), cached: true },
      { id: 'ask', text: `The author said: ${said}\n\nAnswer with the JSON block.`, cached: false },
    ],
  }

  try {
    const out = await runGates({
      row: { ...planStage, ...cellOf(row, 'craft-plan'), withholding: row.withholding, withheld: row.withheld, envelope: row.envelope },
      run, receipt, brief,
      repair: (refusal, resumed) => ({
        blocks: resumed
          ? [{ id: 'repair', text: refusal, cached: false }]
          : [...brief.blocks, { id: 'repair', text: refusal, cached: false }],
      }),
      attempt: n => `craft-plan-${n}`,
      gateCtx: planGateCtx(),
      render: b => b.blocks.map(x => x.text).join('\n\n'),
    })

    const stopped = stateOf(run.id) === 'cancelled'
    if (!out.ok) {
      const ending = endingOf([{ kind: out.kind, gateRefused: out.gateRefused, unreadable: out.unreadable }], stopped)
      closeReceipt(ctx, ending)
      endRun(run.id, ending, { refused: out.reason })
      return { reply: outcomeSentence({ ending, gates: receipt.gates }) ?? out.reason, actions: [], file: null, run: run.id }
    }
    const plan = parseCraftPlan(out.checked.body)!
    receipt.intent = { said, plan }
    closeReceipt(ctx, 'landed')
    endRun(run.id, 'landed', { plan: plan.moves.map(m => m.move) })
    return {
      reply: `Writing toward: ${planSentence(plan)}`,
      actions: [],
      file: null,
      run: run.id,
      plan,
    }
  } catch (e) {
    const ending = stateOf(run.id) === 'cancelled' ? 'cancelled' : 'could not run'
    closeReceipt(ctx, ending)
    endRun(run.id, ending, { error: (e as Error).message })
    throw e
  }
}
