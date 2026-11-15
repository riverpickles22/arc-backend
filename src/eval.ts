// A PRIVATE EVALUATION OF THE DRAFTING BRIEF (A82-3; idea-prose-eval-loop).
//
// The fixture engine answers a brief from a recording, so a change to the
// drafting rules passes every test and says nothing about the prose it will
// produce. This is the other instrument: it keeps what the engine REALLY
// answers to the brief the pass really sends, under a label, so two versions
// of the rules can be set side by side and judged by the only reader whose
// judgement counts.
//
// WHAT A RECORDING IS, AND IS NOT.
//
//   · IT IS THE PASS'S OWN BRIEF. `writeBriefFor` in draft.ts assembles it
//     for the pass and for this file; nothing here renders a prompt.
//   · IT IS NOT A RUN. No run is minted, no receipt is written, no gate
//     reads the answer and nothing is offered to the author as a draft: the
//     answer never reaches the draft layer, the ledger or history/. A run is
//     arc proposing something for the book; this is arc measuring itself.
//     The launch still carries its row, so the envelope — no tools, no
//     project context, a scratch directory — is proven exactly as a run's is.
//   · IT LIVES IN `.arc/eval/`, the story's own git-ignored working state:
//     it holds generated prose in the book's world, so it stays where the
//     book's other working files stay, and it outlives the card that built it.
//
// REGISTERS. That two labels' rules differ is proven — two fingerprints.
// Which answer is better is the author's, on three axes, 1 to 5; the tally
// only counts what they wrote. Nothing here argues.
import fs from 'node:fs'
import path from 'node:path'
import type { CanonDoc } from 'arc-canon-graph'
import { STORY } from './config'
import { canonJson } from './canon'
import { askRow, currentEngine, isDry, renderBrief, type Brief, type EnvelopeProof, type Tokens } from './engine'
import { git } from './lane'
import { proseFiles, sceneSlot, writeBriefFor, writeLaunchSpec } from './draft'
import { proseScenes } from './story'
import { resolveRequest } from './request'
import { rowKey, type StagedRow } from './registry'
import { sha16 } from './records'

export const AXES = ['voice', 'usefulness', 'effort'] as const
export type Axis = typeof AXES[number]
export const AXES_LINE =
  '1 (worst) to 5 (best) — voice: does it sound like the book · usefulness: would you build on it · effort: 5 means it needs the least revision'

export interface EvalCase {
  v: 1
  label: string
  case: string
  chapter: string
  scene: string
  row: string
  rules_fingerprint: string
  /** everything in the brief that is not the rules — the slice and the ask */
  record_fingerprint: string
  brief_fingerprint: string
  answer_fingerprint: string
  brief: string
  answer: string
  model: string | null
  runtime: string | null
  tokens: Tokens
  wall_clock_ms: number
  envelope: EnvelopeProof | null
  /** where the runtime kept its own transcript of this launch, if it said.
   *  It is outside the story and holds the brief; no run exists to delete it
   *  through, so the recording names it and the author can. */
  transcript: string | null
  recorded_at: string
}

export class EvalError extends Error {}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
const CASE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export const evalDir = (): string => path.join(STORY, '.arc', 'eval')

function checkLabel(label: string): string {
  if (!NAME_RE.test(label)) {
    throw new EvalError(`a label is a short name in lower case — letters, digits and hyphens, like "before" or "rules-v2" — and "${label}" is not one.`)
  }
  return label
}

/** One case is one request: a chapter's next scene. The same request under
 *  two labels is what gets compared. */
export function caseKey(chapterId: string): string {
  if (!CASE_RE.test(chapterId)) throw new EvalError(`arc cannot name a recording after "${chapterId}".`)
  return chapterId
}

/** The brief a draft of this chapter's next scene would be sent, built by the
 *  pass's own assembly. Reads the record; writes nothing.
 *
 *  NO LINE FROM THE AUTHOR. A line said at the draft never reaches the
 *  writing stage as words — the slice gives the writing pass only the craft
 *  plan a reading made of it (`slice.ts`, the intent layer), and that reading
 *  is a model call of its own whose answer would differ between two
 *  recordings before the rules had any say. So a case is the plain request,
 *  which is also the one every draft makes. */
export function draftEvalBrief(chapterId: string): {
  row: StagedRow; stage: StagedRow['stages'][number]; sceneId: string; file: string; brief: Brief; rendered: string
} {
  const canon = JSON.parse(canonJson()) as CanonDoc
  const chapter = (canon.chapters ?? []).find(c => c.id === chapterId)
  if (!chapter) {
    const known = (canon.chapters ?? []).map(c => c.id).join(', ')
    throw new EvalError(`this story has no chapter ${chapterId}.${known ? ` Its chapters: ${known}.` : ''}`)
  }
  const request = resolveRequest({
    said: `draft the next scene of ${chapterId}`,
    job: 'draft', scope: 'scene', mode: 'one-shot',
    subject: chapterId,
  })
  const row = request.row as StagedRow
  const stage = row.stages.find(s => s.id === 'write')
  if (!stage) throw new EvalError('the drafting row has no writing stage.')
  const { file, sceneId } = sceneSlot(chapterId, chapter.order, proseFiles())
  const chapterScenes = proseScenes().filter(s => s.chapter === chapterId)
  const { brief } = writeBriefFor(row, stage, { chapterId, sceneId, file, said: '', chapterScenes })
  return { row, stage, sceneId, file, brief, rendered: renderBrief(brief) }
}

/** Everything that would refuse a recording before a token is spent, as one
 *  sentence each: a bad label, no engine, a story that would show the
 *  recordings as changes, a case already recorded. The CLI asks this before
 *  it prints a word. */
export function assertCanRecord(chapterId: string, label: string, opts: { again?: boolean } = {}): string {
  checkLabel(label)
  const key = caseKey(chapterId)
  if (!currentEngine()) {
    throw new EvalError('Nothing was recorded, because nothing can answer: Claude Code is not installed and signed in on this computer, or the ARC_DRAFT_ENGINE setting has turned arc\'s writing off.')
  }
  // THE RECORDINGS ARE WORKING STATE, and a story that does not ignore them
  // would show generated prose as untracked files one `git add` from the
  // record. A story that is not a repository has nothing to show them in.
  let ignored = true
  try { git('check-ignore', '-q', path.join('.arc', 'eval', label, `${key}.json`)) }
  catch (e) { ignored = (e as { status?: number }).status !== 1 }
  if (!ignored) {
    throw new EvalError('Nothing was recorded, because this story does not ignore its .arc/ folder, so a recording would show up as a change to the book — add a line reading .arc/ to the story\'s .gitignore and ask again.')
  }
  if (!opts.again && fs.existsSync(path.join(evalDir(), label, `${key}.json`))) {
    throw new EvalError(`Nothing was recorded, because ${key} is already recorded under "${label}" and recording it again would replace that answer — use another label, or add --again to replace it.`)
  }
  return key
}

/** Ask the engine once and keep what it said. Nothing is written unless an
 *  answer came back, and nothing is written in the story outside `.arc/eval/`. */
export async function recordCase(chapterId: string, label: string, opts: { again?: boolean } = {}): Promise<{ file: string; saved: EvalCase }> {
  const key = assertCanRecord(chapterId, label, opts)
  const { row, stage, sceneId, brief, rendered } = draftEvalBrief(chapterId)
  const spec = writeLaunchSpec(row, stage)
  const at = new Date()
  const answer = await askRow(spec, brief, { runId: `eval-${label}-${sha16(`${key}-${at.getTime()}`).slice(0, 12)}` })
  if (isDry(answer)) throw new EvalError('a dry answer where an answer was asked for')
  if (!answer.text.trim()) throw new EvalError('the engine answered with nothing, so nothing was recorded.')

  const saved: EvalCase = {
    v: 1, label, case: key, chapter: chapterId, scene: sceneId,
    row: rowKey(spec),
    rules_fingerprint: sha16(stage.rules),
    record_fingerprint: sha16(brief.blocks.filter(b => b.id !== 'rules').map(b => b.text).join('\n\n')),
    brief_fingerprint: sha16(rendered),
    answer_fingerprint: sha16(answer.text),
    brief: rendered, answer: answer.text,
    model: answer.model, runtime: answer.runtimeVersion,
    tokens: answer.tokens, wall_clock_ms: answer.wallClockMs,
    envelope: answer.envelope ?? null,
    transcript: answer.transcriptPath,
    recorded_at: at.toISOString(),
  }
  const dir = path.join(evalDir(), label)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${key}.json`)
  fs.writeFileSync(file, JSON.stringify(saved, null, 2) + '\n')
  return { file, saved }
}

export function readLabel(label: string): EvalCase[] {
  const dir = path.join(evalDir(), checkLabel(label))
  if (!fs.existsSync(dir)) return []
  const out: EvalCase[] = []
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as EvalCase
      if (c?.v === 1 && c.case && typeof c.answer === 'string') out.push(c)
    } catch { /* a file that is not a recording is not one */ }
  }
  return out
}

export const labels = (): string[] =>
  fs.existsSync(evalDir())
    ? fs.readdirSync(evalDir(), { withFileTypes: true }).filter(d => d.isDirectory() && NAME_RE.test(d.name)).map(d => d.name).sort()
    : []

// ---- compare ------------------------------------------------------------------------------

type Scores = Record<Axis, number | null>
interface Judged { X: Scores; Y: Scores; of: { X: string; Y: string } }
export interface Judgments { how: string; cases: Record<string, Judged> }

export interface Comparison {
  lines: string[]
  page: string | null
  judgments: string | null
  /** the tally, when at least one case is judged in full */
  tally: null | {
    judged: number
    means: Record<string, Record<Axis, number>>
    won: Record<string, number>
    ties: number
  }
}

const blank = (): Scores => ({ voice: null, usefulness: null, effort: null })
const scored = (s: Scores | undefined): s is Record<Axis, number> =>
  !!s && AXES.every(a => Number.isInteger(s[a]) && (s[a] as number) >= 1 && (s[a] as number) <= 5)
const started = (j: Judged | undefined): boolean =>
  !!j && [j.X, j.Y].some(s => s && AXES.some(a => s[a] !== null && s[a] !== undefined))

/** Which label hides behind X for a case: fixed by the names, so asking again
 *  never reshuffles what the author has already judged. */
export const xIs = (key: string, a: string, b: string): string =>
  parseInt(sha16(`${key}|${a}|${b}`).slice(0, 2), 16) % 2 === 0 ? a : b

/** Set two labels side by side. Writes the page, the key and the judgments
 *  file under `.arc/eval/`; reads the judgments back when the author has
 *  filled them. A judgment the author has started is never overwritten. */
export function compare(first: string, second: string): Comparison {
  checkLabel(first); checkLabel(second)
  if (first === second) throw new EvalError('comparing a label with itself shows nothing — name two.')
  // ONE COMPARISON PER PAIR, whichever way round it is asked for: the files
  // are named for the two labels in order, so the author's judgments are
  // found again when the arguments are swapped.
  const [a, b] = [first, second].sort()
  const A = new Map(readLabel(a).map(c => [c.case, c]))
  const B = new Map(readLabel(b).map(c => [c.case, c]))
  const lines: string[] = []
  for (const [name, set] of [[a, A], [b, B]] as const) {
    if (!set.size) {
      const have = labels()
      throw new EvalError(`nothing is recorded under "${name}".${have.length ? ` Recorded labels: ${have.join(', ')}.` : ' Record a case first: npm run eval:record -- <chapter-id> --label ' + name}`)
    }
  }
  const both = [...A.keys()].filter(k => B.has(k)).sort()
  const onlyA = [...A.keys()].filter(k => !B.has(k)), onlyB = [...B.keys()].filter(k => !A.has(k))
  // A CASE IS ONE REQUEST. "The chapter's next scene" is a different scene
  // once one has been drafted or accepted in between, and two answers to two
  // different requests are not a pair — said, and not set side by side.
  const otherScene = both.filter(k => A.get(k)!.scene !== B.get(k)!.scene)
  const shared = both.filter(k => !otherScene.includes(k))
  const apart = otherScene.map(k => `${k} (${A.get(k)!.scene} under ${a}, ${B.get(k)!.scene} under ${b})`).join(', ')
  if (!shared.length) {
    throw new EvalError(otherScene.length
      ? `"${a}" and "${b}" share no case that asked for the same scene, so there is nothing to set side by side: ${apart}. Record the chapter again under one of them.`
      : `"${a}" and "${b}" share no case, so there is nothing to set side by side. ${a}: ${[...A.keys()].join(', ')}. ${b}: ${[...B.keys()].join(', ')}.`)
  }

  lines.push(`${shared.length} case${shared.length === 1 ? '' : 's'} recorded under both ${a} and ${b}: ${shared.join(', ')}`)
  if (onlyA.length) lines.push(`only under ${a} (not compared): ${onlyA.join(', ')}`)
  if (onlyB.length) lines.push(`only under ${b} (not compared): ${onlyB.join(', ')}`)
  if (otherScene.length) lines.push(`proven: the chapter's next scene was a different scene by the second recording, so these are not pairs (not compared): ${apart}`)

  // PROVEN: what differs between the two labels is fingerprints, and the
  // rules and the rest of the brief are told apart — a rules change measured
  // across a record that also moved is not the rules' alone, and says so.
  const rulesMoved = shared.filter(k => A.get(k)!.rules_fingerprint !== B.get(k)!.rules_fingerprint)
  const recordMoved = shared.filter(k => A.get(k)!.record_fingerprint !== B.get(k)!.record_fingerprint)
  if (rulesMoved.length === shared.length) lines.push(`proven: the drafting rules differ between ${a} and ${b} in every case`)
  else if (rulesMoved.length) lines.push(`proven: the drafting rules differ in ${rulesMoved.length} of ${shared.length} cases (${rulesMoved.join(', ')}) and are the same in the rest`)
  else lines.push(`proven: the drafting rules are the same in both`)
  if (recordMoved.length) lines.push(`proven: the rest of the brief — what the record gave the pass — differs in ${recordMoved.length} of ${shared.length} cases (${recordMoved.join(', ')}), so the record moved between the recordings and a difference there is not the rules' alone`)
  else if (!rulesMoved.length) lines.push(`proven: the brief is identical in both, so any difference here is the engine answering the same question twice — the spread, not a change`)
  const models = new Set(shared.flatMap(k => [A.get(k)!.model, B.get(k)!.model]))
  if (models.size > 1) lines.push(`proven: the answers did not all come from one model (${[...models].join(', ')})`)

  const base = path.join(evalDir(), `compare-${a}-vs-${b}`)
  const pageFile = `${base}.md`, keyFile = `${base}.key.json`, judgeFile = `${base}.judgments.json`

  // THE PAGE: blind. The author reads X and Y; which is which is in the key.
  const key: Record<string, { X: string; Y: string }> = {}
  const page: string[] = [
    `# ${a} and ${b}, side by side`, '',
    `Private working state — generated prose, never the record. Written ${new Date().toISOString().slice(0, 10)}.`, '',
    `Read each pair, then put three numbers on each answer in \`${path.basename(judgeFile)}\`:`,
    AXES_LINE + '.', '',
    `Which label is X and which is Y changes from case to case; it is in \`${path.basename(keyFile)}\`. Judge first.`, '',
  ]
  for (const k of shared) {
    const x = xIs(k, a, b), y = x === a ? b : a
    key[k] = { X: x, Y: y }
    const cx = (x === a ? A : B).get(k)!, cy = (y === a ? A : B).get(k)!
    page.push(`## ${k}`, '', `The next scene of ${cx.chapter}.`, '',
      '### X', '', cx.answer.trim(), '', '### Y', '', cy.answer.trim(), '')
  }
  fs.mkdirSync(evalDir(), { recursive: true })
  fs.writeFileSync(pageFile, page.join('\n'))
  fs.writeFileSync(keyFile, JSON.stringify(key, null, 2) + '\n')

  // THE JUDGMENTS: the author's file. What they have started is kept as it
  // is; a case they have not touched is (re)laid out against what is recorded
  // now; a judged case whose answers were recorded again is not counted.
  let held: Judgments = { how: AXES_LINE, cases: {} }
  let unreadable = false, onDisk: string | null = null
  if (fs.existsSync(judgeFile)) {
    onDisk = fs.readFileSync(judgeFile, 'utf8')
    try {
      // Everything the author put in the file stays in it — a note beside a
      // case, a key of their own — not only the numbers.
      const parsed = JSON.parse(onDisk) as Judgments
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      held = { ...parsed, how: parsed.how ?? AXES_LINE, cases: parsed.cases ?? {} }
    } catch { unreadable = true }
  }
  const stale: string[] = []
  if (!unreadable) {
    for (const k of shared) {
      const of = { X: (key[k].X === a ? A : B).get(k)!.answer_fingerprint, Y: (key[k].Y === a ? A : B).get(k)!.answer_fingerprint }
      const j = held.cases[k]
      if (started(j)) { if (j.of?.X !== of.X || j.of?.Y !== of.Y) stale.push(k); continue }
      // Untouched: laid out against what is recorded now, keeping anything
      // else the author wrote on the case.
      held.cases[k] = { ...j, X: blank(), Y: blank(), of }
    }
    const next = JSON.stringify(held, null, 2) + '\n'
    if (onDisk === null || JSON.stringify(JSON.parse(onDisk)) !== JSON.stringify(held)) fs.writeFileSync(judgeFile, next)
  }

  const means: Record<string, Record<Axis, number>> = {}
  const won: Record<string, number> = { [a]: 0, [b]: 0 }
  let ties = 0
  const judged = unreadable ? [] : shared.filter(k => !stale.includes(k) && scored(held.cases[k]?.X) && scored(held.cases[k]?.Y))
  const partly = unreadable ? [] : shared.filter(k => !judged.includes(k) && !stale.includes(k) && started(held.cases[k]))
  if (judged.length) {
    const sums: Record<string, Record<Axis, number>> = { [a]: { voice: 0, usefulness: 0, effort: 0 }, [b]: { voice: 0, usefulness: 0, effort: 0 } }
    for (const k of judged) {
      const j = held.cases[k]
      const total: Record<string, number> = {}
      for (const side of ['X', 'Y'] as const) {
        const label = key[k][side], s = j[side] as Record<Axis, number>
        for (const ax of AXES) sums[label][ax] += s[ax]
        total[label] = AXES.reduce((n, ax) => n + s[ax], 0)
      }
      if (total[a] > total[b]) won[a]++; else if (total[b] > total[a]) won[b]++; else ties++
    }
    for (const label of [a, b]) {
      means[label] = { voice: 0, usefulness: 0, effort: 0 }
      for (const ax of AXES) means[label][ax] = Math.round((sums[label][ax] / judged.length) * 100) / 100
    }
  }

  lines.push('', `the page:      ${pageFile}`, `the judgments: ${judgeFile}`)
  if (unreadable) {
    lines.push('', `the judgments file is not readable as JSON, so it was left exactly as it is and nothing was counted. Mend it, or move it aside, and ask again.`)
  } else if (!judged.length) {
    lines.push('', `nothing is judged yet. Open the page, read each pair, and replace each null in the judgments file with a number from 1 to 5 — ${AXES_LINE}. Then ask again.`)
  } else {
    lines.push('', `your judgments, over ${judged.length} of ${shared.length} case${shared.length === 1 ? '' : 's'}:`)
    for (const label of [a, b]) lines.push(`  ${label.padEnd(Math.max(a.length, b.length))}  ${AXES.map(ax => `${ax} ${means[label][ax].toFixed(2)}`).join(' · ')}`)
    lines.push(`  judged better overall: ${a} in ${won[a]}, ${b} in ${won[b]}${ties ? `, level in ${ties}` : ''}`)
  }
  if (partly.length) lines.push(`not counted — some numbers still missing, or not 1 to 5: ${partly.join(', ')}`)
  if (stale.length) lines.push(`not counted — recorded again since you judged them: ${stale.join(', ')}. Your numbers are kept; remove the case from the judgments file to judge the new answers.`)

  return {
    lines, page: pageFile, judgments: judgeFile,
    tally: judged.length ? { judged: judged.length, means, won, ties } : null,
  }
}
