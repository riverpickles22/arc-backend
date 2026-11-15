// THE AUTHOR'S DECISION ON A PENDING DRAFT, AND EVERYTHING THAT FOLLOWS IT
// (A80-1).
//
// Accept, reject and discard, at every grain — scene, paragraph, sentence —
// are one ceremony around one commit. Before the decision, while the ledger
// still answers: which run wrote each pending draft, and which route was
// adopted into which scene. The decision itself is story.ts's (the lock gate,
// the base check, the commit). After it: the step goes on the receipt of the
// run that wrote the draft and the receipts join the record in their own
// commit (A67-4, A76-1); a scene accept clears the routes waiting beside an
// adopted scene (A67-10); the notes the change answered close (A63-4, A72-7).
//
// AND THE COMMIT HAS ALREADY LANDED by the time any of the after-steps run
// (A72-11). They are arc's own bookkeeping; a failure in one must not reach
// the author as if their decision had not happened. What did not finish is
// said as what it is, in `afterwards`.
//
// The route handlers in server.ts only narrow the wire shape and call in
// here. This module is kept apart from story.ts so story.ts and reroute.ts
// stay acyclic.
import type {
  ProseAcceptResponse,
  ProseDiscardResponse,
  ProseParagraphRequest,
  ProsePartAcceptResponse,
  ProsePartRejectResponse,
  ProseSentenceRequest,
} from 'arc-canon-graph'
import { closeAnsweredNotes } from './annotations'
import { generatedFor } from './ledger'
import { landedThenFailed } from './refusal'
import { clearAlternatives } from './alternatives'
import { recordDraftDecision, type DraftStep } from './run'
import {
  commitRecords, proseAccept, proseAcceptParagraph, proseAcceptSentence, proseDiscard, proseDraft,
  proseRejectParagraph, proseRejectSentence,
} from './story'

/** After a paragraph or sentence accept, the notes whose change is now
 *  wholly in the book resolve — AT PARAGRAPH GRAIN (A72-7): one note's
 *  paragraph taken resolves that note while the rest of the scene still
 *  waits, and a note whose paragraph was discarded stays open however much
 *  else was accepted. `closeAnsweredNotes` reads the provenance; this is
 *  only the door the two part accepts share. */
const notesClosedAfter = (file: string): string[] => closeAnsweredNotes([file])

/** The run that wrote each of these pending drafts, from the ledger; a file
 *  arc never wrote, or wrote before runs were kept, has none (A76-1). */
function draftRuns(files: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const f of files) {
    const run = generatedFor(f)?.entry.run
    if (run) out.set(f, run)
  }
  return out
}

/** Nothing left pending at this path: a draft taken or refused piece by
 *  piece is decided once its last piece is (A76-1). */
const nothingPends = (file: string): true | undefined =>
  proseDraft().changes.some(c => c.file === file) ? undefined : true

/** THE AUTHOR'S DECISION ON A PENDING DRAFT, ONTO THE RECEIPT OF THE RUN THAT
 *  WROTE IT (A76-1) — one path for every origin and every grain. Called
 *  after the decision landed: the step goes on the receipt with the
 *  decision's hash, and the receipts join the record in their own commit
 *  right behind it (A67-4). Never throws — the decision already happened —
 *  and returns false when the record of it could not be kept. */
function joinDraftReceipts(runOf: Map<string, string>, steps: DraftStep[], what: string): boolean {
  const written: string[] = []
  let kept = true
  for (const step of steps) {
    const run = runOf.get(step.file)
    if (!run) continue
    try {
      const rel = recordDraftDecision(run, step)
      if (rel && !written.includes(rel)) written.push(rel)
    } catch (e) {
      console.error(`[records] the receipt of ${run} could not take the decision (the decision itself landed):`, e)
      kept = false
    }
  }
  if (written.length && !commitRecords(`Record: ${written.length === 1 ? 'the receipt' : `${written.length} receipts`} for ${what}`, written)) kept = false
  return kept
}

/** What the author reads when the record of a draft decision was not kept:
 *  the decision stands, in their words, and only arc's own record is
 *  outstanding. A refusal or a discard put no words in the book, so it does
 *  not say it did. */
const draftRecordLost = (landed: boolean): string => landed
  ? landedThenFailed('its note of where these words came from was not kept')
  : 'arc did what you asked. What it could not finish is its own record of it — its note of where this draft came from, and of what you decided, was not kept. Nothing of yours is lost.'

/** The scene-scoped accept (A64-3): the author read ONE scene's diff and
 *  ratified that. Which paths it may name is `acceptScope`'s, in story.ts. */
export function acceptScenes(message: string | undefined, files: string[], bases: unknown): ProseAcceptResponse {
  // WHICH scenes lose their field, decided BEFORE the accept while the
  // ledger still answers. An accept commits the scenes it names, and those
  // include scenes the author merely edited by hand — they keep their
  // routes and the notes on them. Only a scene an alternative was
  // actually ADOPTED into is settled by this accept, and the ledger
  // records exactly that (origin 'reroute', written at adopt).
  const adopted = new Map<string, string>()
  // And WHICH run wrote each pending draft — any origin, a route adopted
  // or a draft, a clean pass, a notes revision — so the accept can put
  // the author's decision and its commit on that run's receipt (A67-4,
  // A76-1). Read before the accept, while the ledger still answers.
  const runOf = draftRuns(proseDraft().changes.map(c => c.file))
  // And WHICH route was adopted, so the clear below does not record the
  // adopted route as superseded by its own adoption (A67-10).
  const adoptedRoute = new Map<string, string>()
  for (const c of proseDraft().changes) {
    const gen = generatedFor(c.file)
    if (gen?.entry.origin === 'reroute' && gen.entry.scene) adopted.set(c.file, gen.entry.scene)
    if (gen?.entry.origin === 'reroute' && gen.entry.route) adoptedRoute.set(c.file, gen.entry.route)
  }
  const result = proseAccept(message, files, bases)
  // Never on a paragraph or sentence accept — those do not settle the scene.
  const kept = joinDraftReceipts(runOf, result.files.map(f => ({ file: f, commit: result.hash, grain: 'scene' as const })), result.hash)
  const afterwards: string[] = kept ? [] : [draftRecordLost(true)]
  try {
    for (const f of result.files) {
      const scene = adopted.get(f)
      if (scene) clearAlternatives(scene, { adopted: adoptedRoute.get(f) })
    }
  } catch (e) {
    console.error('[error] the routes beside an accepted scene could not be cleared (the accept itself landed):', e)
    afterwards.push(landedThenFailed('the other ways through that scene are still beside it — cancel them by hand'))
  }
  // The notes this change answered close with it (A63-4): the ledger
  // says which, so nothing is judged — the thought goes because the
  // prose written from it is now the book.
  let notesResolved: string[] = []
  try {
    notesResolved = closeAnsweredNotes(result.files)
  } catch (e) {
    console.error('[error] the notes this accept answered could not be closed (the accept itself landed):', e)
    afterwards.push(landedThenFailed('the notes it answered are still open — close them by hand, or ask again'))
  }
  return { ...result, notesResolved, ...(afterwards.length ? { afterwards: afterwards.join(' ') } : {}) }
}

/** Accept one paragraph, leaving the rest of the draft pending. */
export function acceptParagraph(t: ProseParagraphRequest): ProsePartAcceptResponse {
  const runOf = draftRuns([t.file])
  const out = proseAcceptParagraph(t.file, t, t.base, t.message)
  const kept = joinDraftReceipts(runOf, [{ file: t.file, commit: out.hash, grain: 'paragraph', verdict: 'accepted', side: t.side, paragraph: t.paragraph, settled: nothingPends(t.file) }], out.hash)
  return { ...out, notesResolved: notesClosedAfter(t.file), ...(kept ? {} : { afterwards: draftRecordLost(true) }) }
}

/** Refuse one paragraph. A refusal commits no prose, so — as the discard —
 *  only the receipt joins the record (A76-1). */
export function rejectParagraph(t: ProseParagraphRequest): ProsePartRejectResponse {
  const runOf = draftRuns([t.file])
  const out = proseRejectParagraph(t.file, t, t.base)
  const kept = joinDraftReceipts(runOf, [{ file: t.file, commit: null, grain: 'paragraph', verdict: 'rejected', side: t.side, paragraph: t.paragraph, settled: nothingPends(t.file) }], `a refusal in ${t.file}`)
  return { ...out, ...(kept ? {} : { afterwards: draftRecordLost(false) }) }
}

/** Accept one sentence (A37-3). */
export function acceptSentence(t: ProseSentenceRequest): ProsePartAcceptResponse {
  const runOf = draftRuns([t.file])
  const out = proseAcceptSentence(t.file, t, t.base, t.message)
  const kept = joinDraftReceipts(runOf, [{ file: t.file, commit: out.hash, grain: 'sentence', verdict: 'accepted', side: t.side, paragraph: t.paragraph, sentence: t.sentence, settled: nothingPends(t.file) }], out.hash)
  return { ...out, notesResolved: notesClosedAfter(t.file), ...(kept ? {} : { afterwards: draftRecordLost(true) }) }
}

/** Refuse one sentence; receipt-only, as the paragraph refusal. */
export function rejectSentence(t: ProseSentenceRequest): ProsePartRejectResponse {
  const runOf = draftRuns([t.file])
  const out = proseRejectSentence(t.file, t, t.base)
  const kept = joinDraftReceipts(runOf, [{ file: t.file, commit: null, grain: 'sentence', verdict: 'rejected', side: t.side, paragraph: t.paragraph, sentence: t.sentence, settled: nothingPends(t.file) }], `a refusal in ${t.file}`)
  return { ...out, ...(kept ? {} : { afterwards: draftRecordLost(false) }) }
}

/** Discard rolls one draft file back to main. */
export function discardDraft(file: string, base: unknown): ProseDiscardResponse {
  // Before the discard, which clears the ledger entry that names the run.
  const runOf = draftRuns([file])
  proseDiscard(file, base)
  // The loudest refusal is a decision too (A76-1): it goes on the run's
  // receipt, and the receipt — only the receipt — joins the record, as a
  // never on a proposal does. A discard commits no prose, so there is no
  // decision commit for the receipt to name.
  const kept = joinDraftReceipts(runOf, [{ file, commit: null, grain: 'discard' }], `the discard of ${file}`)
  return { ok: true, ...(kept ? {} : { afterwards: draftRecordLost(false) }) }
}
