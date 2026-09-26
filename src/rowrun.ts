// A ROWED RUN, OPENED AND CLOSED (A69-3).
//
// Slice 1 proved the shape on the two route passes: the run's id is minted
// before the first token, it is registered so a stop can reach it and the
// hook can join it, its receipt is on disk from the launch, and it ends —
// on every way out, including the ways nobody planned — with an ending from
// the closed set written to both records.
//
// Slice 2 adds four more passes that need exactly that and nothing more.
// This is the part they share. What each pass does between the two calls is
// its own: a route returns alternatives, a draft returns a file, and neither
// belongs here.
import type { ResolvedRequest } from './request'
import type { LayerReading } from './slice'
import type { Row } from './registry'
import { jobFingerprint } from './registry'
import { Run, emptyReceipt, writeWorkingReceipt, type Receipt } from './run'
import { arcRevision } from './records'
import { registerRun } from './runs'
import type { RunEnding } from 'arc-canon-graph'

/** The run and the receipt it is writing — one object, so every step of a
 *  pass adds to the same record. */
export interface RunCtx { run: Run; receipt: Receipt }

/** What the slice held for one run, in the receipt's own words. */
export interface SliceUsed {
  included: string[]
  withheld: string[]
  dropped: string[]
  read: { id: string; version: string }[]
  /** the layer reading, for a job whose slice the assembler built */
  layers?: LayerReading[]
}

/** Open the run and its receipt, before anything is sent.
 *
 *  Everything the author can later ask of the receipt that is knowable BEFORE
 *  the pass runs is written here: what they asked for, the cell it resolved
 *  to, what produced it, what the slice held and what it read. A receipt that
 *  only appears when a pass succeeds cannot describe the passes that did not,
 *  and those are the ones the author most needs described. */
export function openRowRun(request: ResolvedRequest, row: Row, slice: SliceUsed): RunCtx {
  const run = new Run('ui', request.gesture, { subject: request.subject })
  registerRun(run)
  const receipt = emptyReceipt(run)
  receipt.request = { gesture: request.gesture, cell: request.cell, subject: request.subject }
  receipt.cell = { job: row.job, scope: row.scope, mode: row.mode, depth: row.depth, stage: row.stage }
  receipt.produced_by = { arc_commit: arcRevision(), job_fingerprint: jobFingerprint(row) }
  receipt.slice = {
    included: slice.included,
    withheld_by_design: slice.withheld,
    dropped_for_budget: slice.dropped,
    runtime_added: [],
    ...(slice.layers ? { layers: slice.layers.map(l => ({ ...l })) } : {}),
  }
  receipt.context_manifest = slice.read
  receipt.gates = []
  receipt.evidence = { returned: 0, dropped: [] }
  writeWorkingReceipt(receipt)
  return { run, receipt }
}

/** Put the ending on the receipt. The run itself is ended by the caller,
 *  which knows what to say about what landed. */
export function closeReceipt(ctx: RunCtx, ending: RunEnding): void {
  ctx.receipt.ending = ending
  ctx.receipt.decided_at = new Date().toISOString()
  writeWorkingReceipt(ctx.receipt)
}
