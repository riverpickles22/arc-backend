// Working a note into the story: the AI step, made explicit and on demand.
//
// This is what filing used to do on submit, and the reason it no longer does.
// A note is now written down the instant the author asks (notes.ts); running
// the work graph over it is a separate act they choose, can retry, and cannot
// lose the note to. The pipeline itself is unchanged — slice 1's intake, claim
// derivation, capability-gated material worker, judge, and the author's
// keep-or-discard.
import path from 'node:path'
import { load as yamlLoad } from 'js-yaml'
import type { FiledItem, WorkResponse } from 'arc-canon-graph'
import { HttpError } from './http'
import { currentEngine } from './engine'
import { decide, runIntent, type RunOutcome } from './orchestrate'
import { adoptRun, closeRun, pendingOutcome } from './runs'
import { markWorked, readNote } from './notes'

export type { FiledItem }

/** What the worker actually put on disk, read back from the files themselves
 *  rather than from anything the model said it did. The author is being shown
 *  what arc understood, so it has to be the record, not the claim. */
function describeFiled(produced: { path: string; content: string }[]): FiledItem[] {
  return produced.map(p => {
    let item: Record<string, unknown> = {}
    try {
      item = (yamlLoad(p.content) ?? {}) as Record<string, unknown>
    } catch { /* an unparseable file is still worth naming */ }
    return {
      path: p.path,
      id: typeof item.id === 'string' ? item.id : path.basename(p.path, '.yaml'),
      type: typeof item.type === 'string' ? item.type : 'unknown',
      status: typeof item.status === 'string' ? item.status : 'unplaced',
      body: typeof item.body === 'string' ? item.body.trim() : '',
    }
  })
}

export async function workNote(file: string): Promise<WorkResponse> {
  const note = readNote(file)
  if (!note.text.trim()) throw new HttpError(400, 'that note is empty')
  if (!currentEngine()) {
    throw new HttpError(503, 'No generation engine available. Set ANTHROPIC_API_KEY, or log in to the claude CLI, and restart the backend. Your note is untouched.')
  }

  let outcome: RunOutcome
  try {
    outcome = await runIntent(note.text, 'ui')
  } catch (e) {
    // The worker can legitimately come back with nothing it is willing to
    // file. That is an outcome, not a crash — and it must never read like the
    // note was harmed, because it was not.
    const why = e instanceof Error ? e.message : String(e)
    throw new HttpError(422, `arc could not turn this note into material: ${why}. The note is unchanged — you can edit it and try again.`)
  }

  // The run registry holds it now — so a note worked from here is visible and
  // decidable on /api/runs like any other run, rather than in a private map.
  adoptRun(outcome)
  markWorked(file, outcome.run.id)

  return {
    run: outcome.run.id,
    note: file,
    filed: describeFiled(outcome.produced),
    verdict: outcome.judgment.verdict,
    argued: outcome.judgment.argued,
    asked: outcome.judgment.asked,
    reply: outcome.workerReply,
  }
}

/** The author's answer. Keep leaves the material unplaced; discard marks each
 *  item dropped rather than deleting it — "dropped beats deletion — intent
 *  history is story history" (conventions §12). Either way a receipt lands. */
export async function decideWork(runId: string, keep: boolean, note?: string): Promise<{ receipt: string; dropped: string[] }> {
  const decision = keep ? 'accepted' : 'rejected'
  const out = await decide(pendingOutcome(runId), decision, note)
  closeRun(runId, decision)
  return out
}
