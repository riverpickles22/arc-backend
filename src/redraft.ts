// The clean pass, on the governed path (U3 · Revise · scene | selection ·
// one-shot; A69-8). A rebuild, not a nudge.
//
// Redraft is the third verb, told apart from its siblings:
//   rephrase — a selection, alternatives offered, writes nothing
//   revise   — a scene, minimal, annotation-driven
//   redraft  — a scene or passage, REBUILT to its contract
//
// The author asks for a clean pass over a scene, or over a paragraph range
// of it; arc resolves the gesture to a row by code — a range is selection
// scope — assembles the writing slice from the record, mints a run before
// the first token, and hands the brief to the gate runner, which owns the
// child, reads the answer, offers the one repair and sees every ending.
// Only when every gate holds does the rebuilt scene reach the working
// tree, and it reaches it as an ordinary draft: word-diffed in the draft
// layer, the author's accept or discard still the only way into the book.
//
// TWO KINDS OF CHECK, NEVER BLURRED (conventions §11). Only deterministic
// conditions refuse the write, and they are the row's gates: the locks and
// their order, the story's own validator, the contract's quoted withholds,
// the ids the prose rests on, the two countable style rules. Everything a
// model merely reads — tense, POV adherence, whether must_establish landed,
// motif execution, non-literal leakage — is ARGUED: relayed to the author
// as claims, never enforced.
//
// WHAT THIS FILE NO LONGER DOES. It does not hold the pass's rules — they
// are the row's. It does not compose a brief of its own, call the seam,
// decide its tools or check locks on the answer: the assembler builds the
// slice, the runner launches, and the `locks` gate reads the rebuilt scene.
// What is left here is what only a clean pass knows: how a range becomes a
// passage with two seams, how a passage becomes the scene again, and how to
// write a file and put it back if the story rejects it.
import fs from 'node:fs'
import path from 'node:path'
import type { CraftPlanned, DraftSceneResponse, SceneContract } from 'arc-canon-graph'
import type { CanonDoc } from 'arc-canon-graph'
import { STORY } from './config'
import { openNotesOn } from './annotations'
import { canonJson } from './canon'
import { cellOf, planFirst, writeValidated } from './draft'
import { currentEngine } from './engine'
import { runGates, type ProseGateCtx } from './gates'
import { HttpError } from './http'
import { recordGenerated } from './ledger'
import { locksOn } from './locks'
import { andCapFromContract, endingOf, gateCtx as gateCtxOf, wordCapFromContract } from './reroute'
import { CRAFT_MOVES, stageRuns, type StagedRow } from './registry'
import { resolveRequest } from './request'
import { outcomeSentence } from './run'
import { closeReceipt, openRowRun } from './rowrun'
import { endRun, stateOf } from './runs'
import { sha16 } from './records'
import { assembleWritingSlice, weightOf } from './slice'
import { materialItems, parseScene, proseScenes } from './story'
import { styleContract } from './style'

/** The contract block as a brief shows it. reader_before / reader_after
 *  are deliberately absent — review-pass fields, not drafting fuel. */
export function contractBlock(c: SceneContract | null): string {
  if (!c) return '(this scene declares no contract)'
  const lines: string[] = []
  if (c.purpose) lines.push(`purpose: ${String(c.purpose).trim()}`)
  if (Array.isArray(c.must_establish) && c.must_establish.length) lines.push(`must_establish:\n${c.must_establish.map(x => `  - ${x}`).join('\n')}`)
  if (Array.isArray(c.must_withhold) && c.must_withhold.length) lines.push(`must_withhold:\n${c.must_withhold.map(x => `  - ${x}`).join('\n')}`)
  if (Array.isArray(c.motifs) && c.motifs.length) lines.push(`motifs: ${c.motifs.join(', ')}`)
  if (c.constraints) lines.push(`constraints: ${String(c.constraints).trim()}`)
  return lines.length ? lines.join('\n') : '(this scene declares no contract)'
}

/** must_withhold items that are decidable: exact quoted literals.
 *
 *  "The settler's identity" names an idea and only a reading can judge a
 *  leak — that is argued. '"Havana"' names a string, and a string either
 *  appears or it does not — that is proven. The quoting convention is the
 *  author's way of opting a withhold into the hard gate. */
export function literalWithholds(items: unknown): string[] {
  if (!Array.isArray(items)) return []
  return items
    .map(String)
    .map(x => x.trim())
    .filter(x => /^["'“].*["'”]$/.test(x))
    .map(x => x.replace(/^["'“]|["'”]$/g, ''))
    .filter(Boolean)
}

/** The proven half of the withhold check: literals that appear verbatim. */
export const withholdViolations = (literals: string[], body: string): string[] =>
  literals.filter(w => body.includes(w))

/** Replace paragraphs [from..to] with the redrafted passage, everything else
 *  byte-identical by construction — the passage redraft's whole safety story
 *  is that the model never gets to touch what it was not asked about. */
export function spliceRange(paragraphs: string[], from: number, to: number, replacement: string): string[] {
  const out = [...paragraphs]
  out.splice(from, to - from + 1, ...replacement.split(/\n{2,}/).map(x => x.trim()).filter(Boolean))
  return out
}

/** Split the model's two-part answer. A missing marker is an honest
 *  degenerate case: all prose, no briefing — never the other way round. */
export function splitBriefing(text: string): { body: string; briefing: string } {
  const m = text.split(/^\s*=== BRIEFING ===\s*$/m)
  return { body: m[0].trim(), briefing: (m[1] ?? '').trim() }
}

export interface RedraftTarget {
  scene: string
  /** Inclusive paragraph range, draft order. Absent: the whole scene. */
  paragraphs?: [number, number]
  guidance?: string
}

const paragraphsOf = (body: string): string[] =>
  body.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)

/** THE ASSIGNMENT — the brief's fifth slot, the ask. Pure, for tests: the
 *  scene as one attempt, or the passage with the two seams it must join. */
export function redraftAssignment(scene: { scene: string; body: string }, range?: { from: number; to: number; paras: string[] }): string {
  const subject = range
    ? [
      `=== THE PASSAGE TO REDRAFT (¶${range.from + 1}–¶${range.to + 1} of ${scene.scene}) ===`,
      range.paras.slice(range.from, range.to + 1).join('\n\n'),
      '',
      'SEAMS: your passage must join what surrounds it, which you may not change.',
      range.from > 0 ? `The paragraph ABOVE ends the ground your passage rises from:\n${range.paras[range.from - 1]}` : 'Your passage OPENS the scene.',
      range.to + 1 < range.paras.length ? `The paragraph BELOW is where your passage must land:\n${range.paras[range.to + 1]}` : 'Your passage CLOSES the scene.',
      'Answer with the redrafted passage alone — never the seams.',
    ].join('\n')
    : `=== THE SCENE AS IT STANDS (${scene.scene}; one attempt, not a floor) ===\n${scene.body.trim()}`
  return `${subject}\n\nRun the clean pass. Answer in the two parts.`
}

/** THE NOTES A PASS COULD HAVE ANSWERED, which is what the ledger names and
 *  therefore what the author's accept resolves.
 *
 *  Only the author's: a note arc wrote is arc's own reading, and handing it
 *  back as an instruction is a model's guess becoming the brief (§4).
 *
 *  And at SELECTION SCOPE only the notes inside the range. Everything outside
 *  it comes back byte-identical by construction, so a note on ¶7 cannot have
 *  been answered by a rebuild of ¶3–¶4 — closing it at the accept would
 *  resolve a request nobody acted on. A note about the whole scene anchors to
 *  no paragraph and is not claimed by a passage either.
 *
 *  Pure, so the rule is held by a test rather than by a landing. */
export function notesAnswerable<T extends { by?: string; resolution?: { paragraph?: number | null } }>(
  notes: readonly T[], range?: { from: number; to: number },
): T[] {
  return notes
    .filter(n => (n.by ?? 'author') === 'author')
    .filter(n => {
      if (!range) return true
      const p = n.resolution?.paragraph
      return typeof p === 'number' && p >= range.from && p <= range.to
    })
}

/** Run the clean pass over a scene or a paragraph range of it, as a
 *  governed run.
 *
 *  Throws HttpError(400) on an unknown scene, a range outside it, or a cell
 *  the rows do not list; HttpError(423) on settled prose the request would
 *  have to unsettle — before any token, in the author's words. `given` is
 *  the craft plan on the second call: `undefined` means the author has not
 *  been shown one yet; a plan means they settled it; `null` means they
 *  withdrew the line (A69-4). */
export async function runRedraft(t: RedraftTarget, given?: CraftPlanned | null): Promise<DraftSceneResponse> {
  const scene = proseScenes().find(s => s.scene === t.scene)
  if (!scene) throw new HttpError(400, `no scene ${t.scene}`)
  const paras = paragraphsOf(scene.body)

  let range: { from: number; to: number } | null = null
  if (t.paragraphs) {
    const [from, to] = t.paragraphs
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to >= paras.length) {
      throw new HttpError(400, `that range is not in ${t.scene} — it has ${paras.length} paragraph${paras.length === 1 ? '' : 's'}. Pick paragraphs it has and ask again; nothing was written.`)
    }
    range = { from, to }
  }

  // SETTLED PROSE THE REQUEST WOULD HAVE TO UNSETTLE is refused at intake,
  // before any token: a scene or chapter settled entire, or a locked
  // paragraph inside the very range the author asked to rebuild, is a
  // contradiction only they can resolve, from the viewer's unlock. What
  // the ANSWER does to the locks outside the range is the gate's to judge.
  const live = locksOn(t.scene, scene.body)
    .filter(l => l.resolution.state === 'resolved' || l.resolution.state === 'drifted')
  const whole = live.find(l => l.scope === 'scene' || l.scope === 'chapter')
  if (whole) {
    throw new HttpError(423,
      `${whole.scope === 'chapter' ? 'this chapter' : 'this section'} is locked (${whole.id}) — you settled it entire. Unlock it from the scene's header to take a clean pass; nothing was written.`)
  }
  const sceneLocks = live.filter(l => l.scope === 'paragraph' && l.resolution.paragraph !== null)
    .sort((x, y) => (x.resolution.paragraph as number) - (y.resolution.paragraph as number))
  if (range) {
    const hit = sceneLocks.find(l => l.resolution.paragraph! >= range!.from && l.resolution.paragraph! <= range!.to)
    if (hit) {
      throw new HttpError(423,
        `¶${hit.resolution.paragraph! + 1} is locked (${hit.id}) — unlock it from the paragraph, or redraft around it; nothing was written.`)
    }
  }
  const lockedTexts = sceneLocks.map(l => paras[l.resolution.paragraph as number] ?? '')

  // THE REQUEST (§4): the gesture the author made, resolved by code to a
  // cell — a range is selection scope — and then to the row that admits it.
  const request = resolveRequest({
    said: range ? `redraft ¶${range.from + 1}–¶${range.to + 1} of ${t.scene}` : `take a clean pass over ${t.scene}`,
    job: 'revise', scope: range ? 'selection' : 'scene', mode: 'one-shot',
    subject: t.scene,
  })
  const row = request.row as StagedRow
  const stage = row.stages.find(s => s.id === 'write')
  const planStage = row.stages.find(s => s.id === 'craft-plan')
  if (!stage || !planStage) throw new HttpError(500, 'the clean-pass row is missing a stage')

  // NO RUN FOR A PASS THAT CANNOT RUN (A69-3): every rowed pass refuses on
  // the `sdk` engine, before a run is minted.
  if (currentEngine() === 'sdk') {
    throw new HttpError(400,
      'arc cannot take a clean pass on the engine it is set up to use — it can only show you what a pass was given when it runs the claude CLI on your login. ' +
      'Log in with  claude  and ask again, or remove ANTHROPIC_API_KEY from arc-backend/.env.')
  }

  const said = t.guidance?.trim() ?? ''
  const subject = { chapter: scene.chapter, scene, ...(range ? { range: [range.from, range.to] as [number, number] } : {}) }

  // THE CRAFT PLAN (A69-4; §4): a line said now becomes craft before a token
  // is spent on prose, and the author reads it, edits it or drops it first.
  if (given === undefined && stageRuns(planStage, said)) {
    return await planFirst(request, row, planStage, subject, said)
  }
  const plan = given?.moves?.length ? { moves: given.moves } : undefined
  for (const m of plan?.moves ?? []) {
    if (!(m.move in CRAFT_MOVES)) {
      throw new HttpError(400,
        `arc does not know how to ask a writing pass for "${m.move}". It can work on ${Object.keys(CRAFT_MOVES).join(', ')}.`)
    }
  }

  // THE SLICE, before anything is sent — the stage's slice and ceiling. A
  // floor that will not fit refuses here, in the author's words.
  const slice = assembleWritingSlice(
    { ...row, slice: stage.slice, budget: stage.budget }, subject,
    { stage: 'write', intent: { line: said || undefined, plan } })

  const ctx = openRowRun(request, row, {
    ...slice.forReceipt(),
    withheld: [],
    dropped: slice.forReceipt().dropped_for_budget,
    read: [{ id: `slice:${t.scene}`, version: sha16(slice.render()) }],
  })
  const { run, receipt } = ctx
  receipt.intent = {
    said: said || null,
    plan: plan ?? null,
    ...(said && !plan ? { withdrawn: true } : {}),
    ...(!said && !plan ? { note: 'nothing to translate' } : {}),
  }

  const handed = notesAnswerable(openNotesOn(t.scene), range ?? undefined).map(n => n.id)

  const brief = {
    blocks: [
      { id: 'rules', text: stage.rules, cached: true },
      { id: 'slice', text: slice.render(), cached: true },
      { id: 'ask', text: redraftAssignment(scene, range ? { ...range, paras } : undefined), cached: false },
    ],
  }

  // HOW A PASSAGE BECOMES THE SCENE AGAIN: spliced into its range, the rest
  // byte-identical by construction. The whole-scene answer is the scene.
  const assembled = (prose: string): string =>
    range ? spliceRange(paras, range.from, range.to, prose).join('\n\n') : prose
  const abs = path.join(STORY, scene.file)
  const raw = fs.readFileSync(abs, 'utf8')
  const head = raw.slice(0, raw.length - (parseScene(raw, scene.file)?.body.length ?? 0))
  const fileOf = (prose: string): string => { const body = assembled(prose); return head + body + (body.endsWith('\n') ? '' : '\n') }

  // THE GATE CHECKS; IT DOES NOT WRITE. The validator reads a file on disk,
  // so the candidate goes down and the author's own text comes straight
  // back up whatever the verdict; the rebuilt scene is written once, below.
  const validate = (prose: string): { ok: boolean; output: string } => {
    const check = writeValidated(scene.file, fileOf(prose))
    if (check.ok) fs.writeFileSync(abs, raw)
    return check
  }

  const canon = JSON.parse(canonJson()) as CanonDoc
  const ctxForGates: ProseGateCtx = {
    ...gateCtxOf({
      sceneName: t.scene,
      sceneBody: scene.body,
      sceneLocks, lockedTexts,
      literals: literalWithholds(scene.contract?.must_withhold),
      andCap: andCapFromContract(styleContract()),
      wordCap: wordCapFromContract(styleContract()),
      destination: [],
      known: [],
    }),
    validate,
    ...(range ? { assembled } : {}),
    ...weightOf(canon, materialItems()),
  }

  let landed = false
  let wrote = false
  try {
    const out = await runGates({
      row: { ...stage, ...cellOf(row, 'write'), withholding: row.withholding, withheld: row.withheld, envelope: row.envelope },
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
      const ending = endingOf([{ kind: out.kind, gateRefused: out.gateRefused, unreadable: out.unreadable }], stopped)
      closeReceipt(ctx, ending)
      endRun(run.id, ending, { refused: out.reason })
      return {
        reply: outcomeSentence({ ending, gates: receipt.gates }) ?? out.reason,
        actions: [{ tool: 'redraft', path: scene.file, ok: false, detail: out.reason }],
        file: null,
        run: run.id,
      }
    }
    if (stopped) {
      closeReceipt(ctx, 'cancelled')
      endRun(run.id, 'cancelled', { stopped_by: 'author' })
      return {
        reply: outcomeSentence({ ending: 'cancelled', gates: receipt.gates }) ?? 'you stopped it before it landed — ask again to take the pass from where the scene stands now.',
        actions: [],
        file: null,
        run: run.id,
      }
    }

    // Every gate held, so the rebuilt scene is written — once, here. A write
    // the validator refuses is put back by writeValidated itself.
    wrote = true
    const next = fileOf(out.checked.body)
    const check = writeValidated(scene.file, next)
    if (!check.ok) {
      closeReceipt(ctx, 'could not run')
      endRun(run.id, 'could not run', { error: check.output })
      throw new HttpError(500, `arc could not write that pass into your story — ${check.output.split('\n')[0]}. Nothing was written.`)
    }
    landed = true
    recordGenerated(scene.file, next, { engine: currentEngine() ?? 'fixture', scene: t.scene, origin: 'redraft', notes: handed, run: run.id })
    closeReceipt(ctx, 'landed')
    endRun(run.id, 'landed', { landed: [t.scene] })

    const aged = receipt.slice?.leaned_on ?? []
    const agedLine = aged.length
      ? ` It leans on ${aged.map(l => `${l.id} as of ${l.as_of}`).join(', ')} — the record has not looked since.`
      : ''
    const where = range ? `¶${range.from + 1}–¶${range.to + 1} of ${t.scene}` : t.scene
    return {
      reply: [
        `Redrafted ${where}. It is waiting beside the scene — read it, then accept or discard.${agedLine}`,
        out.checked.briefing ? `\n=== THE PASS ARGUES (claims to judge, not verdicts) ===\n${out.checked.briefing}` : '',
      ].join(''),
      actions: [{ tool: 'redraft', path: scene.file, ok: true }],
      file: scene.file,
      run: run.id,
      ...(plan ? { plan } : {}),
    }
  } catch (e) {
    // Only a file this pass wrote and did not land is put back — to the
    // author's own text, never removed: the scene existed before the pass.
    if (wrote && !landed) { try { fs.writeFileSync(abs, raw) } catch { /* nothing to put back */ } }
    const ending = stateOf(run.id) === 'cancelled' ? 'cancelled' : 'could not run'
    closeReceipt(ctx, ending)
    endRun(run.id, ending, { error: (e as Error).message })
    throw e
  }
}
