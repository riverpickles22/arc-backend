// U9 · INSPECT · SCENE · THE PENDING DIFF (A72-10).
//
// "Before I accept, tell me what I am agreeing to." A reading of ONE pending
// change against the record — argued, never proven, and it writes nothing.
//
// It existed before this card as a bare seam call and an export the viewer
// never made: a pass that read the very surface this slice governs with no
// row, no receipt and no gate. Under the trust boundary that is not allowed
// to have a surface, so this gives it the row.
//
// WHAT IT IS ABOUT IS IMMUTABLE. The subject is the pending diff for one
// scene AS THE AUTHOR IS READING IT: the base they were shown (A72-3) comes
// with the request and is checked before anything is spent, so a reading is
// never made about a newer diff under an older question. The answer carries
// that base back, which is how the viewer can tell a reading that still
// describes what is on screen from one that describes words the author has
// since changed.
//
// EVERY CLAIM CITES, OR IT IS DROPPED. The reading answers with findings,
// each citing ids from the record it was given or paragraphs of the scene it
// read. Arc resolves them: a claim whose citation it cannot place is dropped
// and counted, in the author's words, and when nothing survives the reading
// is NOT REPORTED rather than reported empty. The model's judgement is
// argued; which of its claims rest on something is proven.
//
// IT VETOES NOTHING. The accept stays exactly as available during and after
// a reading as before it, and the reading creates no proposal, no canon and
// no prose.
import type { InspectDraftResponse, InspectFinding } from 'arc-canon-graph'
import { HttpError } from './http'
import { currentEngine, noEngineSentence, SDK_ENGINE_FIX } from './engine'
import { assertBase } from './base'
import { runGates } from './gates'
import { citedScope } from './citations'
import { proseDraft, proseScenes } from './story'
import { READ_MAP, readsFrom } from './reads'
import { endingOf, fingerprintsAtWrite, gateCtx as gateCtxOf } from './reroute'
import { jobFingerprint, type SealedRow } from './registry'
import { resolveRequest } from './request'
import { sha16 } from './records'
import { closeReceipt, openRowRun } from './rowrun'
import { endRun, stateOf } from './runs'
import { assembleWritingSlice } from './slice'
import { outcomeSentence } from './run'

/** The sentence the author reads when the reading is over. */
export function inspectReply(kept: number, dropped: number): string {
  if (!kept && !dropped) return 'arc read the change and had nothing to say about it.'
  if (!kept) return `arc read the change, and nothing it said rested on your record — ${dropped === 1 ? 'one reading was' : `${dropped} readings were`} dropped. Not reported.`
  const tail = dropped ? ` ${dropped === 1 ? 'One reading was' : `${dropped} readings were`} dropped for resting on nothing.` : ''
  return `arc read the change and has ${kept === 1 ? 'one thing' : `${kept} things`} to say about it — all argued, none of it in your book.${tail}`
}

/** WHAT THE PASS IS ASKED, as the brief's last block: the scene as the book
 *  holds it, the scene as the draft proposes it, and the question. */
export function inspectAsk(a: { scene: string; accepted: string | null; pending: string }): string {
  const before = a.accepted === null
    ? '(this scene is not in the book yet — the draft proposes it whole)'
    : a.accepted.trim()
  return [
    `=== THE SCENE AS THE BOOK HOLDS IT (${a.scene}) ===`,
    before,
    `=== THE SCENE AS THIS PENDING CHANGE PROPOSES IT (${a.scene}) ===`,
    a.pending.trim(),
    'Read what this pending change would do to the story. Answer with the findings array alone.',
  ].join('\n\n')
}

/** READ ONE PENDING CHANGE. Rowed, receipted, gated — and it writes nothing
 *  anywhere, which is the one thing about it that is proven rather than
 *  promised: no path here opens a file for writing. */
export async function runInspect(scene: string, base: unknown): Promise<InspectDraftResponse> {
  const scenes = proseScenes()
  const live = scenes.find(s => s.scene === scene)
  if (!live) throw new HttpError(404, `arc has no scene called ${scene}.`)
  const draft = proseDraft()
  const mine = draft.changes.filter(c => c.file === live.file)
  if (!mine.length) {
    throw new HttpError(409, `${scene} has nothing waiting to be decided, so there is nothing to read.`)
  }
  // THE DIFF THE AUTHOR IS READING, and no other (A72-3): a base that has
  // moved refuses here, before a token is spent, rather than producing a
  // reading of words they have not seen.
  assertBase(live.file, base, 'read that change')

  const request = resolveRequest({
    said: `what would this change do to ${scene}?`,
    job: 'inspect', scope: 'scene', mode: 'one-shot',
    subject: scene,
  })
  const row = request.row as SealedRow

  if (currentEngine() === 'sdk') {
    throw new HttpError(400,
      'arc cannot read a change on the engine it is set up to use — it can only show you what a pass was given when it runs the claude CLI on your login. '
      + SDK_ENGINE_FIX)
  }
  if (!currentEngine()) {
    throw new HttpError(400, noEngineSentence())
  }

  // BOTH SIDES ARE BODIES. The accepted side is `main.body`; the pending
  // side must be too, or the pass reads the frontmatter block as text this
  // change introduces and every ¶n it cites is off by the header.
  const pending = live.body
  const accepted = mine[0].main?.body ?? null
  const slice = assembleWritingSlice(row, { chapter: live.chapter, scene: live }, { stage: 'write' })
  const used = slice.forReceipt()
  const ctx = openRowRun(request, row, {
    ...used,
    withheld: [],
    dropped: used.dropped_for_budget,
    // WHAT IT READ, CAPTURED AT LAUNCH (A72-4): a reading made against a
    // note or a lock the author has since moved is a reading of a record
    // that no longer stands, and the receipt is where that is provable. The
    // base is in it, so the receipt names the exact diff it read.
    read: [
      { id: `slice:${scene}`, version: sha16(slice.render()) },
      ...readsFrom(fingerprintsAtWrite(scene)),
      { id: `base:${scene}`, version: String(base) },
      { id: 'read-map', version: String(READ_MAP) },
      { id: 'job', version: jobFingerprint(row) },
    ],
  })
  const { run, receipt } = ctx

  const brief = {
    blocks: [
      { id: 'rules', text: row.rules, cached: true },
      { id: 'slice', text: slice.render(), cached: true },
      { id: 'ask', text: inspectAsk({ scene, accepted, pending }), cached: false },
    ],
  }
  // THE IDS THE BRIEF ACTUALLY CARRIED, read off the rendered brief itself.
  const scope = citedScope(slice.render(), pending)
  const gateCtx = { ...gateCtxOf({
    sceneName: scene, sceneBody: pending, sceneLocks: [], lockedTexts: [],
    literals: [], andCap: null, wordCap: null, destination: [], known: [],
  }), cites: scope }

  const out = await runGates({
    row: { ...row },
    run, receipt, brief,
    repair: (refusal: string, resumed: boolean) => ({
      blocks: resumed ? [{ id: 'repair', text: refusal, cached: false }]
        : [...brief.blocks, { id: 'repair', text: refusal, cached: false }],
    }),
    attempt: (n: 1 | 2) => `read-${n}`,
    gateCtx,
    render: b => b.blocks.map(x => x.text).join('\n\n'),
  })

  const answer = (findings: InspectFinding[], dropped: { claim: string; why: string }[], reply: string) =>
    // THE BASE IT READ, not the one that stands now: a reading is about the
    // diff it was handed, and naming a newer one would let a reading of
    // words the author has since replaced render as current advice.
    ({ scene, file: live.file, base: String(base), register: 'argued' as const, findings, dropped, reply, run: run.id })

  if (stateOf(run.id) === 'cancelled') {
    closeReceipt(ctx, 'cancelled'); endRun(run.id, 'cancelled', { stopped: scene })
    return answer([], [], outcomeSentence({ ending: 'cancelled', gates: receipt.gates }) ?? 'you stopped it before it had anything to say.')
  }
  if (!out.ok) {
    const ending = endingOf([{ kind: out.kind, gateRefused: out.gateRefused, unreadable: out.unreadable }], false)
    closeReceipt(ctx, ending); endRun(run.id, ending, { refused: out.reason })
    return answer([], [], outcomeSentence({ ending, gates: receipt.gates }) ?? out.reason)
  }
  // The reading branch of the gate runner hands back what survived the
  // citation gate, and what it dropped, already resolved.
  const read = JSON.parse(out.checked.body) as { findings: InspectFinding[]; dropped: { claim: string; why: string }[] }
  const kept = read.findings ?? []
  const dropped = read.dropped ?? []
  closeReceipt(ctx, 'landed')
  endRun(run.id, 'landed', { read: scene, findings: kept.length, dropped: dropped.length })
  return answer(kept, dropped, inspectReply(kept.length, dropped.length))
}
