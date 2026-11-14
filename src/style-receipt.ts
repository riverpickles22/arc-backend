// THE AUTHOR'S WORD ON A PROPOSED RULE, ON THE RUN THAT PROPOSED IT (A74-8).
//
// A rule the learner proposed carries the run that argued for it. Ratifying or
// dismissing it is the author's decision on that run, so it lands on the run's
// receipt exactly as the accept's and the proposals' decisions do (D10): the
// decision goes on the receipt before the commit, the commit's hash goes on
// after it, and the receipt joins the record in its own commit behind. Without
// this the learner's row never becomes attended (registry.ts rowStatus reads
// author_decision). A proposal with no run — one written before runs were kept
// — skips all of it.
import path from 'node:path'
import { STORY } from './config'
import { readRecordReceipt, readWorkingReceipt, setReceiptCommit, writeReceipt, type Receipt } from './run'
import { storyRevision } from './records'
import { commitRecords } from './story'

/** Put the decision on the proposing run's receipt (in history/, not yet
 *  committed). Returns the receipt's path relative to the story, or null when
 *  there is no run or no receipt to put it on. */
export function stampStyleDecision(
  run: string | undefined,
  action: 'ratify' | 'dismiss',
  ruleId: string,
  keep: (abs: string) => void,
): string | null {
  if (!run) return null
  const base: Receipt | null = readRecordReceipt(run) ?? readWorkingReceipt(run)
  if (!base) return null
  const rel = path.join('history', `${run}.yaml`)
  keep(path.join(STORY, rel))
  const earlier = base.author_decision?.note
  const note = `${action === 'ratify' ? 'ratified' : 'dismissed'} ${ruleId}`
  writeReceipt({
    ...base,
    decided_at: new Date().toISOString(),
    story_revision_at_decision: storyRevision(),
    author_decision: { decision: action === 'ratify' ? 'accepted' : 'rejected', note: earlier ? `${earlier}; ${note}` : note },
    result: { ...base.result, commit: null },
  })
  return rel
}

/** Behind the decision's commit: its hash onto the receipt, and the receipt
 *  into the record. Never throws — the decision has already landed. */
export function joinStyleReceipt(run: string | undefined, rel: string | null, commit: string | null): void {
  if (!run || !rel || !commit) return
  try {
    setReceiptCommit(run, commit)
    commitRecords(`Record: the receipt for ${commit}`, [rel])
  } catch (e) {
    console.error('[warn] could not add the receipt of a style decision to the record:', e)
  }
}
