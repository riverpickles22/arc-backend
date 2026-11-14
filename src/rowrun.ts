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
import type { LayerReading, LeanedOn } from './slice'
import type { Row } from './registry'
import { jobFingerprint } from './registry'
import { Run, emptyReceipt, receiptsOf, writeWorkingReceipt, type Receipt, type Source } from './run'
import { arcRevision, sha16 } from './records'
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
  /** the state facts given past the freshness distance (A69-6) */
  leaned_on?: LeanedOn[]
}

/** Open the run and its receipt, before anything is sent.
 *
 *  Everything the author can later ask of the receipt that is knowable BEFORE
 *  the pass runs is written here: what they asked for, the cell it resolved
 *  to, what produced it, what the slice held and what it read. A receipt that
 *  only appears when a pass succeeds cannot describe the passes that did not,
 *  and those are the ones the author most needs described. */
export function openRowRun(request: ResolvedRequest, row: Row, slice: SliceUsed, source: Source = 'ui'): RunCtx {
  // WHO ASKED, carried rather than assumed. The terminal and a Claude Code
  // session reach the same operations the viewer does, and a run that says
  // `ui` about all of them makes "who asked" wrong wherever the briefing,
  // `/api/runs` and `arc doctor` show it (A69-12 review).
  const run = new Run(source, request.gesture, { subject: request.subject })
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
    ...(slice.leaned_on ? { leaned_on: slice.leaned_on.map(l => ({ ...l })) } : {}),
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
  // THE FIRST ENDING WINS, on the receipt as well as on the run (A72-4). A
  // row that ends honestly and then throws is caught by its own surrounding
  // catch, which would relabel the receipt `could not run` — leaving the run
  // record and its receipt disagreeing about what happened, and the receipt
  // no longer saying that the destination moved. `endRun` has held this rule
  // since A67-3; the receipt had not.
  if (ctx.receipt.ending) return
  ctx.receipt.ending = ending
  ctx.receipt.decided_at = new Date().toISOString()
  writeWorkingReceipt(ctx.receipt)
}

/** THE KEY OF A TRIGGERED RUN: the job, the scene, the commits it read and a
 *  fingerprint of the combined diff it was given. The same key is the same
 *  reading — a run that finds a landed receipt carrying it does nothing, and
 *  one that finds only failed or cancelled ones runs again. */
export const runKey = (job: string, scene: string, range: { from: string; to: string }, diffText: string): string =>
  sha16([job, scene, range.from, range.to, sha16(diffText)].join('\u0000'))

/** The receipt of a LANDED run of `job` (U7 by default; U12 since A74-6) that carries this key, apart from `except`
 *  (the run asking). Read from the record (history/) and the open runs. */
export function landedByKey(key: string, except?: string, job: 'update-record' | 'learn' = 'update-record'): string | null {
  return receiptsOf(job).find(r => r.key === key && r.ending === 'landed' && r.run_id !== except)?.run_id ?? null
}
