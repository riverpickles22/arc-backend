// THE WRITER'S MENU, on the governed path (A69-10). Rephrase a selected
// passage against the author's OWN style contract — that is the whole point,
// and the difference from every generic "improve this" button — or offer
// synonyms with nuance notes that respect the scene's period.
//
// Two rows, one shape: the author selects, arc resolves the gesture to a row
// by code, mints a run before the first token, assembles the contract into a
// slice and hands the brief to the gate runner. Nothing is written by either
// pass, ever. What comes back is a list the author picks one of or none, and
// the machine never applies its own suggestion — everything here is the
// ARGUED register (conventions §11).
//
// WHAT A GATE DOES TO A MENU. It drops a wording, never the menu. Five
// wordings of which one breaks a ratified rule are four good wordings and a
// near miss, and the receipt says how many went and which (A69-10).
import type { SuggestRequest, SuggestResponse } from 'arc-canon-graph'
import { STORY } from './config'
import { currentEngine } from './engine'
import { parseOptions, runGates, type ProseGateCtx } from './gates'
import { HttpError } from './http'
import { andCapFromContract, endingOf, gateCtx as gateCtxOf, wordCapFromContract } from './reroute'
import { type SealedRow } from './registry'
import { resolveRequest } from './request'
import { outcomeSentence } from './run'
import { closeReceipt, openRowRun } from './rowrun'
import { endRun, stateOf } from './runs'
import { sha16 } from './records'
import { assembleWritingSlice } from './slice'
import { parseScene } from './story'
import { styleContract } from './style'
import fs from 'node:fs'
import path from 'node:path'

/** Tolerant parse: an array of strings, fences stripped, junk dropped. The
 *  gate runner reads the same list through `parseOptions` — one definition,
 *  so what the gate measured and what the author is shown cannot differ. */
export function parseSuggestions(text: string): string[] {
  const options = parseOptions(text)
  if (options === null) throw new Error(`suggest pass did not return a JSON array: ${text.slice(0, 160)}`)
  return options.slice(0, 6)
}

/** What the ask gets to know about the scene: POV and chapter, read fresh
 *  from the file's own frontmatter. Absent file, absent context — the pass
 *  still works on the selection alone. */
export function sceneContextFor(file?: string): string | undefined {
  if (!file || !file.startsWith('prose/') || file.includes('..')) return undefined
  try {
    const scene = parseScene(fs.readFileSync(path.join(STORY, file), 'utf8'), file)
    if (!scene) return undefined
    return `Scene ${scene.scene}, chapter ${scene.chapter}${scene.pov ? `, narrated from the point of view of ${scene.pov}` : ''}.`
  } catch {
    return undefined
  }
}

/** THE ASSIGNMENT — the brief's fifth slot, the ask. What the author pointed
 *  at a moment ago: the scene's own line, the paragraph the selection sits
 *  in, and the selection itself. Pure, for tests. */
export function suggestAssignment(req: {
  selection: string
  paragraph?: string
  sceneContext?: string
}): string {
  return [
    req.sceneContext ? `=== SCENE CONTEXT ===\n${req.sceneContext}` : '',
    req.paragraph ? `=== THE PARAGRAPH IT SITS IN ===\n${req.paragraph}` : '',
    `=== THE SELECTION ===\n${req.selection}`,
    'Answer with the JSON array.',
  ].filter(Boolean).join('\n\n')
}

/** Offer wordings for a selection, as a governed run.
 *
 *  Throws HttpError(400) on an empty selection and on a cell the rows do not
 *  list — before a run is minted, in the author's words. */
export async function runSuggest(req: SuggestRequest): Promise<SuggestResponse> {
  if (!req.selection?.trim()) {
    throw new HttpError(400, 'nothing is selected — highlight the words you want other wordings for, then ask again.')
  }

  // THE REQUEST (§4): the gesture the author made, resolved by code. The
  // KIND is the job — rephrase asks for another way to say this, synonyms
  // for another word — and the selection is the scope.
  //
  // AND THE GESTURE CARRIES NO PROSE. What the author selected is the
  // author's book; it belongs in the brief's ask, which is kept with the run
  // and gitignored, and not in `request.gesture`, which `toRecordReceipt`
  // copies verbatim into a committed record that holds ids, hashes and links
  // (A67-4). No menu run reaches a decision today — nothing is written, so
  // there is nothing to decide — but a gesture that quotes the manuscript is
  // a leak waiting for the first row that does.
  const rephrase = req.kind === 'rephrase'
  const request = resolveRequest({
    said: rephrase ? 'other wordings for the selection' : 'other words for the selection',
    job: rephrase ? 'revise' : 'explore',
    scope: 'selection',
    mode: 'one-shot',
    ...(rephrase ? { depth: 'quick' } : {}),
    subject: req.file ?? 'a selection',
  })
  const row = request.row as SealedRow

  // NO RUN FOR A PASS THAT CANNOT RUN (A69-3), and the refusal names the
  // fix. Both of these happen BEFORE `openRowRun`: a run and a receipt on
  // disk for a pass that could never have started are a record of nothing.
  if (!currentEngine()) {
    throw new HttpError(503,
      'arc has no way to ask for wordings yet — log in with  claude  in a terminal, or put ANTHROPIC_API_KEY in arc-backend/.env, then ask again.')
  }
  if (currentEngine() === 'sdk') {
    throw new HttpError(400,
      'arc cannot offer wordings on the engine it is set up to use — it can only show you what a pass was given when it runs the claude CLI on your login. ' +
      'Log in with  claude  and ask again, or remove ANTHROPIC_API_KEY from arc-backend/.env.')
  }

  const slice = assembleWritingSlice(row, { chapter: '' })
  const ctx = openRowRun(request, row, {
    ...slice.forReceipt(),
    withheld: [],
    dropped: slice.forReceipt().dropped_for_budget,
    read: [{ id: 'slice:selection', version: sha16(slice.render()) }],
  })
  const { run, receipt } = ctx

  const brief = {
    blocks: [
      { id: 'rules', text: row.rules, cached: true },
      { id: 'slice', text: slice.render(), cached: true },
      {
        id: 'ask',
        text: suggestAssignment({
          selection: req.selection,
          paragraph: req.paragraph,
          sceneContext: sceneContextFor(req.file),
        }),
        cached: false,
      },
    ],
  }

  // What the countable rules are measured against, for rephrase. There is no
  // scene to lock and no withhold to prove: a wording is judged by the
  // author's own caps and by nothing else.
  const gateCtx: ProseGateCtx = gateCtxOf({
    sceneName: '', sceneBody: '', sceneLocks: [], lockedTexts: [], literals: [],
    andCap: andCapFromContract(styleContract()),
    wordCap: wordCapFromContract(styleContract()),
    destination: [], known: [],
  })

  try {
    const out = await runGates({
      row: { ...row, withholding: row.withholding, withheld: row.withheld, envelope: row.envelope },
      run, receipt, brief,
      repair: (refusal, resumed) => ({
        blocks: resumed
          ? [{ id: 'repair', text: refusal, cached: false }]
          : [...brief.blocks, { id: 'repair', text: refusal, cached: false }],
      }),
      attempt: n => `menu-${n}`,
      gateCtx,
      render: b => b.blocks.map(x => x.text).join('\n\n'),
    })

    const stopped = stateOf(run.id) === 'cancelled'
    if (!out.ok) {
      const ending = endingOf([{ kind: out.kind, gateRefused: out.gateRefused, unreadable: out.unreadable }], stopped)
      closeReceipt(ctx, ending)
      endRun(run.id, ending, { refused: out.reason })
      throw new HttpError(422, outcomeSentence({ ending, gates: receipt.gates }) ?? out.reason)
    }

    // The wordings that survived their gates, in the order the pass offered
    // them. Nothing was written and nothing will be: the author places one.
    const suggestions = parseSuggestions(out.checked.body)
    closeReceipt(ctx, 'landed')
    endRun(run.id, 'landed', { offered: suggestions.length })
    return {
      suggestions,
      register: 'argued',
      engine: currentEngine() ?? 'fixture',
      run: run.id,
    }
  } catch (e) {
    if (e instanceof HttpError) throw e
    const ending = stateOf(run.id) === 'cancelled' ? 'cancelled' : 'could not run'
    closeReceipt(ctx, ending)
    endRun(run.id, ending, { error: (e as Error).message })
    throw e
  }
}
