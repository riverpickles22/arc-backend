// PUT IT BACK (A72-8): one recorded accept, reversed, after showing what
// putting it back touches.
//
// Changing her mind is a daily event, not an edge case (harness §12). An
// accept lands as a commit; regretting it — after locks and later work have
// stacked on it — needs its own ceremony: show what putting back touches,
// the impact walk pointed backward, and land it as an ordinary revert she
// never sees named. The unit is ONE ACCEPT, the decision record A72-3 writes
// (`Judgment.decision`); slice 4 groups accepts into episodes.
//
// WHAT IS REVERSED IS THE DECISION'S OWN PROSE CHANGE, never the scene. The
// accept's commit is found exactly, by the decision's id in the evidence log
// (`git log -S` on the record, never a subject line), and the two versions of
// the file on either side of that commit give the change the author made.
// The inverse of that change is applied to the scene AS IT NOW STANDS, by the
// same paragraph alignment every other surface uses: later edits elsewhere in
// the scene are kept, a later edit ON a paragraph this decision touched is an
// overlap and refuses, and a scene that has not moved since goes back to the
// bytes it had. Nothing here guesses: a decision without a provable commit —
// one from before the record carried an id, or one never committed — is
// readable in history and not reversible.
//
// PREVIEW IS READ-ONLY and returns a token over everything the decision
// depends on — the current accepted bytes, the working tree, the locks, the
// inverse itself. Confirm recomputes inside the lane and refuses when the
// token moved, so what lands is exactly what was shown. A second confirm of
// the same decision returns the reversal already on record and appends
// nothing: the record is what makes it idempotent, across a lost response,
// a double click and a restart.
//
// WHAT IT NEVER DOES: recreate a draft, reopen the notes the accept resolved,
// relock prose, retract canon or style. Those are named in the preview as
// effects that remain, so the author decides about them with their eyes
// open; nothing about them is argued by a model here.
import fs from 'node:fs'
import path from 'node:path'
import { alignParagraphs, mainInsertionPoint } from 'arc-canon-graph'
import type { PutBackPreview, PutBackResult, DecisionHistoryItem } from 'arc-canon-graph'
import { STORY } from './config'
import { git, inLane, type Tx } from './lane'
import { HttpError } from './http'
import { sha16 } from './records'
import { EVIDENCE_REL, mintDecision, readJudgments, readPutBacks, recordPutBack, type Judgment, type PutBack } from './evidence'
import { parseScene } from './story'
import { assertUnlocked, locksOn } from './locks'
import { readNoteResolutions } from './note-lifecycle'
import { paragraphsOf } from './blast-radius'
import { tokenFor } from './base'

const FM_RE = /^---\n[\s\S]*?\n---\n?/
const split = (text: string): { fm: string; paras: string[]; lead: string; trail: string } => {
  const m = text.match(FM_RE)
  const body = m ? text.slice(m[0].length) : text
  // the whitespace around the body is the file's, not the decision's: kept
  return { fm: m?.[0] ?? '', paras: paragraphsOf(body), lead: body.match(/^\s*/)?.[0] ?? '', trail: body.match(/\s*$/)?.[0] || '\n' }
}
const assemble = (fm: string, paras: string[], lead = '', trail = '\n'): string => fm + lead + paras.join('\n\n') + trail

const isAccept = (j: Judgment): boolean => j.verdict === 'accepted' || j.verdict === 'approved'

// ---- history -------------------------------------------------------------------

/** EVERY DECISION ON RECORD, newest first, with where it stands: standing,
 *  reversed (and by what), a reversal itself, or not reversible — a record
 *  from before decisions carried an id, or a refusal, which commits nothing
 *  and so has nothing to put back. From the records, never from commit
 *  subjects. */
export function decisionHistory(scene?: string): DecisionHistoryItem[] {
  const backs = readPutBacks().filter(p => commitOf(p.decision))
  const reversedBy = new Map(backs.map(p => [p.reverses, p.decision]))
  const items: DecisionHistoryItem[] = []
  for (const j of readJudgments()) {
    if (scene && j.scene !== scene) continue
    const state: DecisionHistoryItem['state'] = !j.decision || !isAccept(j) ? 'not reversible'
      : reversedBy.has(j.decision) ? 'reversed' : 'standing'
    items.push({
      ...(j.decision ? { decision: j.decision } : {}), at: j.at, file: j.file, scene: j.scene,
      granularity: j.granularity, paragraph: j.paragraph, verdict: j.verdict, origin: j.origin,
      ...(j.run ? { run: j.run } : {}), state,
      ...(j.decision && reversedBy.has(j.decision) ? { reversedBy: reversedBy.get(j.decision)! } : {}),
    })
  }
  for (const p of backs) {
    if (scene && p.scene !== scene) continue
    items.push({ decision: p.decision, at: p.at, file: p.file, scene: p.scene, granularity: p.granularity, paragraph: p.paragraph ?? null, verdict: 'put back', origin: 'author', state: 'reversal', reverses: p.reverses })
  }
  return items.sort((a, b) => b.at.localeCompare(a.at))
}

// ---- the inverse ----------------------------------------------------------------

/** THE COMMIT THAT CARRIED A DECISION. The record rides in the decision's
 *  own commit (A72-3), so the commit is the one that added the line naming
 *  it — found by content, never by subject. The put-back's own record names
 *  the original as `reverses`, which is a different key, so this cannot
 *  find the reversal by mistake. Null when no commit carries it. */
function commitOf(decision: string): string | null {
  try {
    const hashes = git('log', '--format=%H', `-S"decision":"${decision}"`, '--', EVIDENCE_REL).split('\n').filter(Boolean)
    return hashes.at(-1) ?? null   // oldest: the one that added it
  } catch {
    return null
  }
}

/** THE REVERSAL ON RECORD FOR A DECISION — counted only once its own commit
 *  exists. A process killed between the record's append and the commit
 *  leaves a line nothing will ever commit (`stageAppended` puts it back
 *  after every later decision), and a scene reversed in the working tree but
 *  not in the book; reading that line as done would report a reversal that
 *  never landed, which is criterion 6's last clause backwards. */
export function reversalOf(decision: string): PutBack | null {
  // every line naming it, because an orphan line may sit beside the real one
  return readPutBacks().filter(x => x.reverses === decision).find(p => commitOf(p.decision)) ?? null
}

/** Every reversal that landed, by the decision it reverses. */
export const reversedDecisions = (): Set<string> =>
  new Set(readPutBacks().filter(p => commitOf(p.decision)).map(p => p.reverses))

/** THE DECISIONS THAT STILL STAND: every judgment less the accepts that were
 *  put back. What a reader asking "what has the author taken" reads; the
 *  history itself keeps all of them. */
export function standingJudgments(): Judgment[] {
  const reversed = reversedDecisions()
  return readJudgments().filter(j => !j.decision || !reversed.has(j.decision))
}

const atCommit = (commit: string, file: string): string | null => {
  try { return git('show', `${commit}:${file}`) } catch { return null }
}

/** THE DECISION'S CHANGE, undone on the scene as it now stands. Pure over the
 *  three texts: what the file was before the accept, what it was after, and
 *  what the book holds now. Null result = the file goes away (the accept
 *  added it). Throws the author's sentence when the inverse cannot be
 *  placed without guessing. */
export function inverseOf(before: string | null, after: string | null, now: string | null): { result: string | null; touched: { changed: number; added: number; removed: number } } {
  // THE SIMPLE CASE FIRST, and byte-exact: nothing has moved since the
  // accept, so the file goes back to exactly what it was.
  if (now === after) return { result: before, touched: touchedBetween(after, before) }
  if (after === null) {
    // the accept DELETED the scene and something has since put a file there
    throw new HttpError(409, 'that scene was deleted by this decision and has been written again since, so putting it back would take words that came later. Decide about the newer scene first.')
  }
  if (now === null) {
    throw new HttpError(409, 'that scene has been deleted since this decision, so there is nothing to put the change back into.')
  }
  if (before === null) {
    // the accept ADDED the scene and it has been edited since: taking it
    // away would take the later work with it
    throw new HttpError(409, 'this decision added that scene and it has been edited since, so putting it back would take the later work too. Put the later changes back first, or edit the scene instead.')
  }
  const b = split(before), a = split(after), n = split(now)
  // the accept's own change, after → before (after is the main side)
  const change = alignParagraphs(a.paras, b.paras)
  // where each paragraph of the accepted text stands now
  const since = alignParagraphs(a.paras, n.paras)
  const nowIndexOf = new Map<number, number>()   // after index → current index, when unchanged since
  const anchorOf = new Map<number, number>()     // the same, but a paragraph edited since still anchors
  for (const s of since) {
    if (s.kind === 'same') nowIndexOf.set(s.mainIndex!, s.draftIndex!)
    if (s.kind === 'same' || s.kind === 'changed') anchorOf.set(s.mainIndex!, s.draftIndex!)
  }
  const overlap = (where: string): never => {
    throw new HttpError(409, `${where} has been edited since this decision, so putting it back would undo later work as well. Edit the scene instead.`)
  }
  // Build the result as edits on the CURRENT paragraphs, by current index.
  const result: (string | null)[] = n.paras.map(p => p)
  const inserts = new Map<number, string[]>()   // current index to insert BEFORE
  const tail: string[] = []
  let changed = 0, added = 0, removed = 0
  for (const c of change) {
    if (c.kind === 'same') continue
    if (c.kind === 'changed') {
      // the accept rewrote this paragraph: put the earlier words back where it now sits
      const at = nowIndexOf.get(c.mainIndex!)
      if (at === undefined) overlap(`paragraph ${c.mainIndex! + 1}`)
      result[at!] = b.paras[c.draftIndex!]; changed++
    } else if (c.kind === 'del') {
      // the paragraph exists only after the accept: the accept inserted it; take it out
      const at = nowIndexOf.get(c.mainIndex!)
      if (at === undefined) overlap(`paragraph ${c.mainIndex! + 1}`)
      result[at!] = null; removed++
    } else {
      // only before the accept: the accept deleted it; put it back in front of
      // the paragraph that followed it, where that paragraph now stands — a
      // later edit TO that neighbour is not an overlap, the accept never
      // touched it; the neighbour being gone is, because the place is
      // — AND THE SEAM MUST BE INTACT: if something has been inserted
      // between the two paragraphs it used to sit between, which side of
      // that it belongs on is a guess, and a guess refuses.
      const afterAt = mainInsertionPoint(change, c.draftIndex!)
      const prevAt = afterAt === 0 ? -1 : anchorOf.get(afterAt - 1)
      if (afterAt >= a.paras.length) {
        if (prevAt !== (afterAt === 0 ? -1 : n.paras.length - 1)) overlap(`the end of the scene`)
        tail.push(b.paras[c.draftIndex!]); added++; continue
      }
      const at = anchorOf.get(afterAt)
      if (at === undefined || prevAt === undefined || prevAt !== at - 1) overlap(`the passage around paragraph ${afterAt + 1}`)
      inserts.set(at!, [...(inserts.get(at!) ?? []), b.paras[c.draftIndex!]]); added++
    }
  }
  const out: string[] = []
  result.forEach((p, i) => { out.push(...(inserts.get(i) ?? [])); if (p !== null) out.push(p) })
  out.push(...tail)
  // Frontmatter: the decision's own change to it is undone only if nothing
  // has touched it since; otherwise the later frontmatter stands.
  let fm = n.fm
  if (a.fm !== b.fm) {
    if (n.fm !== a.fm) overlap('the scene\'s header')
    fm = b.fm
  }
  return { result: assemble(fm, out, n.lead, n.trail), touched: { changed, added, removed } }
}

function touchedBetween(from: string | null, to: string | null): { changed: number; added: number; removed: number } {
  if (from === null || to === null) return { changed: 0, added: to === null ? 0 : split(to).paras.length, removed: from === null ? 0 : split(from).paras.length }
  const t = { changed: 0, added: 0, removed: 0 }
  for (const c of alignParagraphs(split(from).paras, split(to).paras)) {
    if (c.kind === 'changed') t.changed++
    else if (c.kind === 'ins') t.added++
    else if (c.kind === 'del') t.removed++
  }
  return t
}

// ---- preview ---------------------------------------------------------------------

interface Computed { preview: PutBackPreview; result: string | null; judgment: Judgment }

/** THE IMPACT WALK, POINTED BACKWARD. Read-only. Everything the confirm
 *  depends on is under the token. */
export function previewPutBack(decision: string): Computed {
  const j = readJudgments().find(x => x.decision === decision)
  if (!j) throw new HttpError(404, 'arc has no record of that decision.')
  if (!isAccept(j)) throw new HttpError(409, 'that decision put nothing into the book, so there is nothing to put back.')
  if (reversalOf(decision)) throw new HttpError(409, 'that decision has already been put back.')
  const commit = commitOf(decision)
  if (!commit) throw new HttpError(409, 'arc cannot prove what that decision changed, so it will not guess at putting it back. Edit the scene instead.')
  const file = j.file
  const before = atCommit(`${commit}^`, file)
  const after = atCommit(commit, file)
  // 4: the commit that carried the record must have carried the change too
  if (before === after) throw new HttpError(409, 'arc cannot prove what that decision changed, so it will not guess at putting it back. Edit the scene instead.')
  const now = atCommit('HEAD', file)
  const abs = path.join(STORY, file)
  let working: string | null = null
  try { working = fs.readFileSync(abs, 'utf8') } catch { working = null }
  if (working !== now) {
    throw new HttpError(409, 'that scene has unaccepted edits. Decide about those first — accept or discard them — then put this back.')
  }
  const { result, touched } = inverseOf(before, after, now)
  const scene = j.scene ?? parseScene(now ?? after ?? '', file)?.scene ?? null
  // LOCKS: a lock on a paragraph the inverse would change refuses, exactly
  // as it refuses every other write (rule 2). A reversal that only takes
  // words away from a locked paragraph is still a change to it.
  if (scene && now !== null) {
    // a scene the inverse removes is a change to every locked paragraph in it
    assertUnlocked(scene, parseScene(now, file)?.body ?? '', result === null ? '' : parseScene(result, file)?.body ?? '', 'putting it back')
  }
  const locks = scene && now !== null ? locksOn(scene, parseScene(now, file)?.body ?? '').map(l => ({ id: l.id, paragraph: l.resolution.paragraph })) : []
  // WHAT REMAINS, named and deterministic — nothing here is a model's view.
  const notes = readNoteResolutions().filter(r => r.decision === decision).map(r => r.note)
  const later = standingJudgments().filter(x => x.file === file && x.at > j.at && isAccept(x) && x.decision).map(x => x.decision!)
  const token = sha16(JSON.stringify({ decision, now: now === null ? null : sha16(now), working: working === null ? null : sha16(working), locks, result: result === null ? null : sha16(result) }))
  const preview: PutBackPreview = {
    decision, file, scene, at: j.at, granularity: j.granularity, paragraph: j.paragraph,
    now: now === null ? null : parseScene(now, file)?.body ?? now,
    restored: result === null ? null : parseScene(result, file)?.body ?? result,
    touched,
    remains: {
      notes,
      receipt: j.run ? { run: j.run, state: 'stays as it is: the receipt records what that pass wrote and what was decided then' } : null,
      laterDecisions: later,
      locks,
      unknown: j.run ? [] : ['no pass is linked to this decision, so arc cannot say which receipt it came from'],
    },
    token,
  }
  return { preview, result, judgment: j }
}

// ---- confirm -----------------------------------------------------------------------

export function putBack(decision: string, token: unknown): PutBackResult {
  if (typeof token !== 'string' || !token) throw new HttpError(400, 'look at what putting it back touches first — the preview is what this confirms')
  return inLane('putting a change back', tx => confirmPutBack(tx, decision, token))
}

function confirmPutBack(tx: Tx, decision: string, token: string): PutBackResult {
  // ALREADY DONE: the record is the answer, and nothing is appended twice.
  const already = reversalOf(decision)
  if (already) {
    return { reversal: already.decision, reverses: decision, file: already.file, scene: already.scene, hash: commitOf(already.decision)?.slice(0, 7) ?? null, already: true }
  }
  const { preview: p, result } = previewPutBack(decision)
  if (p.token !== token) {
    throw new HttpError(409, 'that scene, its locks or its pending edits changed since you looked at what putting it back touches. Look again.')
  }
  const abs = path.join(STORY, p.file)
  tx.keep(abs, path.join(STORY, EVIDENCE_REL))
  if (result === null) {
    fs.rmSync(abs, { force: true })
  } else {
    fs.writeFileSync(abs, result)
    tx.wrote(abs, result)
  }
  const reversal = mintDecision()
  recordPutBack({
    decision: reversal, reverses: decision, file: p.file, scene: p.scene, granularity: p.granularity, paragraph: p.paragraph,
    base: token, after: tokenFor(p.file, result, result), touched: p.touched,
  })
  tx.stage([p.file], { all: true })
  const evidence = tx.stageAppended(EVIDENCE_REL) ? [EVIDENCE_REL] : []
  tx.commit(`prose: put back one change in ${p.scene ?? path.basename(p.file)}`, [p.file, ...evidence])
  return { reversal, reverses: decision, file: p.file, scene: p.scene, hash: git('rev-parse', '--short', 'HEAD').trim(), already: false }
}
