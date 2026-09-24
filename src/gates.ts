// The gate runner: one place that owns the child, runs the row's gates on
// the answer, offers exactly one repair, and sees every ending (A67-6;
// agent-workflows §4, "The gates", invariant 5).
//
// Three things were spread across the passes before this:
//
//   the launch          each pass called the seam itself and did its own
//                       receipt bookkeeping
//   the gates           each pass ran its own checks inline, in its own
//                       order, with its own refusal strings
//   the repair          each pass had its own retry loop, and each had to
//                       remember that a transport failure earns none
//
// The runner is what makes those one thing. A pass now says which ROW it is,
// what brief to send, and what its gates need to judge; the runner launches,
// records the launch and the envelope, walks the row's GATE IDS in order,
// writes a typed record for every one that ran, keeps the refused text with
// the run, and — on a gate refusal, never on a transport failure — resumes
// the same transcript once with the refusal and the previous answer as the
// only new input. Nothing retries further, and nothing decides to run
// another job.
//
// A gate never repairs; it refuses and says why. `could not judge` is not a
// pass: the author reads it as *not checked*.
import type { ResolvedLock } from 'arc-canon-graph'
import type { DroppedClaim, RouteCoverage } from 'arc-canon-graph/api-types.ts'
import { lockViolations } from 'arc-canon-graph/annotations.ts'
import { EngineError, askRow, engineResumes, isDry, recordedEnvelope, stripFences, type Brief, type EngineErrorKind } from './engine'
import { describeViolation } from './locks'
import type { GateId, SealedRow } from './registry'
import { keepWithRun, recordLaunch, writeWorkingReceipt, type GateRecord, type Receipt, type Run } from './run'
import { sha16 } from './records'
import { attachLaunch } from './runs'
import { splitBriefing } from './redraft'

// ---- what a gate is given, and what it says ------------------------------

/** Everything the prose gates of slice 1 measure against. Assembled by the
 *  pass, read by the runner — a gate never reaches for the record itself. */
export interface ProseGateCtx {
  sceneName: string
  /** the current prose, which the gates measure against and no gate sends */
  sceneBody: string
  sceneLocks: ResolvedLock[]
  lockedTexts: string[]
  /** the contract's quoted withholds */
  literals: string[]
  andCap: number | null
  wordCap: number | null
  destination: string[]
  /** the overlap bar and where it came from */
  maxOverlap: number
  /** measured survival of the current wording, in order */
  lexicalOverlap: (alternative: string, current: string, locked: string[]) => { share: number | null; counted: number; overlapping: number }
  andChainViolations: (body: string, cap: number, locked: string[]) => { sentence: string; ands: number }[]
  longSentenceViolations: (body: string, cap: number, locked: string[]) => { sentence: string; words: number }[]
  withholdViolations: (literals: string[], body: string) => string[]
  lockOrderViolation: (rebuilt: string, lockedInOrder: string[]) => boolean
  parseCoverageTail: (briefing: string) => { briefing: string; coverage: RouteCoverage[] | null; unparseable: number }
  /** each claim resolved against the destination the pass was given; what
   *  does not resolve is dropped and counted by reason (A67-8) */
  resolveCoverage: (destination: string[], rows: RouteCoverage[] | null, known: string[]) => { coverage: RouteCoverage[] | null; dropped: DroppedClaim[]; returned: number }
  /** what the record holds but did not bind — arc's own key points, which
   *  are context and never the destination */
  known: string[]
}

/** The answer, split by the row's answer shape, as the gates read it. */
export interface ParsedAnswer {
  body: string
  briefing: string
  coverage: RouteCoverage[] | null
  /** claims that did not resolve, by reason */
  dropped: DroppedClaim[]
  /** how many claims the pass made that DID resolve — not the destination's
   *  length, which is the same for every answer */
  returned: number
  overlap: number | null
}

type GateVerdict =
  | { verdict: 'held' | 'could not judge' | 'not applicable'; record: Omit<GateRecord, 'gate' | 'attempt' | 'verdict'> }
  | { verdict: 'refused'; reason: string; record: Omit<GateRecord, 'gate' | 'attempt' | 'verdict'> }

type GateFn = (ctx: ProseGateCtx, a: ParsedAnswer) => GateVerdict

const held = (record: Omit<GateRecord, 'gate' | 'attempt' | 'verdict'> = { stage: 'answer' }): GateVerdict => ({ verdict: 'held', record })
const refuse = (reason: string, record: Omit<GateRecord, 'gate' | 'attempt' | 'verdict'>): GateVerdict => ({ verdict: 'refused', reason, record })

/** The gate ids of slice 1, each an implementation the runner calls by id.
 *  A row naming an id that is not here is refused rather than skipped — a
 *  declared gate that silently does not run is the failure the typed record
 *  exists to prevent. */
export const GATES: Partial<Record<GateId, GateFn>> = {
  locks: (ctx, a) => {
    const violated = lockViolations(ctx.sceneBody, a.body, ctx.sceneLocks)
    const record = { measured: violated.length, bar: 0, bar_from: 'locks/', measured_against: ctx.sceneLocks.map(l => l.id), stage: 'answer' as const }
    return violated.length
      ? refuse(`touched locked prose — ${describeViolation(ctx.sceneName, violated[0])}`, record)
      : held(record)
  },
  'lock-order': (ctx, a) => {
    const record = { measured_against: ctx.sceneLocks.map(l => l.id), stage: 'answer' as const }
    return ctx.lockOrderViolation(a.body, ctx.lockedTexts)
      ? refuse('the locked paragraphs came back out of their settled order', record)
      : held(record)
  },
  'withhold-literals': (ctx, a) => {
    const leaked = ctx.withholdViolations(ctx.literals, a.body)
    const record = { measured: leaked.length, bar: 0, bar_from: "the contract's must_withhold, quoted", stage: 'answer' as const }
    return leaked.length
      ? refuse(`names what the contract withholds verbatim (${leaked.map(x => `"${x}"`).join(', ')})`, record)
      : held(record)
  },
  'and-chain': (ctx, a) => {
    const bar_from = 'the style contract: "a chain stops at N"'
    if (ctx.andCap === null) return { verdict: 'not applicable', record: { bar_from: 'the style contract states no chain rule', stage: 'answer' } }
    const chains = ctx.andChainViolations(a.body, ctx.andCap, ctx.lockedTexts)
    if (!chains.length) return held({ measured: 0, bar: ctx.andCap, bar_from, stage: 'answer' })
    const worst = [...chains].sort((x, y) => y.ands - x.ands)[0]
    return refuse(
      `a sentence joins ${worst.ands} "and"s where the contract stops at ${ctx.andCap} (${chains.length} such sentence${chains.length === 1 ? '' : 's'}) — "${worst.sentence.slice(0, 160)}${worst.sentence.length > 160 ? '…' : ''}"`,
      { measured: worst.ands, bar: ctx.andCap, bar_from, stage: 'answer' })
  },
  'sentence-length': (ctx, a) => {
    const bar_from = 'the style contract: "a sentence stops at N words"'
    if (ctx.wordCap === null) return { verdict: 'not applicable', record: { bar_from: 'the style contract states no sentence rule', stage: 'answer' } }
    const long = ctx.longSentenceViolations(a.body, ctx.wordCap, ctx.lockedTexts)
    if (!long.length) return held({ measured: 0, bar: ctx.wordCap, bar_from, stage: 'answer' })
    const worst = [...long].sort((x, y) => y.words - x.words)[0]
    return refuse(
      `a sentence runs ${worst.words} words where the contract stops at ${ctx.wordCap} (${long.length} such sentence${long.length === 1 ? '' : 's'}) — "${worst.sentence.slice(0, 160)}${worst.sentence.length > 160 ? '…' : ''}"`,
      { measured: worst.words, bar: ctx.wordCap, bar_from, stage: 'answer' })
  },
  overlap: (ctx, a) => {
    const measured = ctx.lexicalOverlap(a.body, ctx.sceneBody, ctx.lockedTexts)
    const bar_from = `MAX_OVERLAP, arc-backend ${ctx.maxOverlap}`
    if (measured.share === null) {
      // Too few countable paragraphs to judge. Not a pass: the author reads
      // this as *not checked*.
      return { verdict: 'could not judge', record: { measured: measured.counted, bar: ctx.maxOverlap, bar_from, stage: 'answer' } }
    }
    const record = { measured: measured.share, bar: ctx.maxOverlap, bar_from, measured_against: [ctx.sceneName], stage: 'answer' as const }
    return measured.share > ctx.maxOverlap
      ? refuse(`reused ${Math.round(measured.share * 100)}% of the current wording (${measured.overlapping} of ${measured.counted} paragraphs; the limit is ${Math.round(ctx.maxOverlap * 100)}%)`, record)
      : held(record)
  },
  // The marker the gate reads. Absent, the coverage gate cannot run — and a
  // gate that cannot run refuses the write rather than letting the answer
  // land unchecked (§4, "Evidence resolution").
  'coverage-tail': (ctx, a) => {
    const bar_from = "the row's answer shape: a fenced coverage tail"
    if (a.coverage === null) {
      return refuse('the answer carried no coverage tail, so arc cannot say which required beats it reached', { bar_from, measured_against: ctx.destination, stage: 'answer' })
    }
    // How many of the required beats the answer actually reported, against
    // how many there are — two different numbers, or the record proves
    // nothing.
    return held({ measured: a.coverage.filter(c => c.paragraph !== null).length, bar: ctx.destination.length, bar_from, measured_against: ctx.destination, stage: 'answer' })
  },
}

export type GateChecked =
  | { ok: true; body: string; briefing: string; coverage: RouteCoverage[] | null; dropped: DroppedClaim[]; returned: number; overlap: number | null; gates: GateRecord[] }
  | { ok: false; reason: string; gates: GateRecord[]; kind?: EngineErrorKind; unreadable?: boolean }

/** Run the row's gate ids, in the row's order, over one answer. Every gate
 *  that runs leaves a typed record; the first refusal stops the walk,
 *  because a refused write is refused. */
export function runRowGates(row: SealedRow, ctx: ProseGateCtx, text: string, attempt = 1, launch?: string): GateChecked {
  const gates: GateRecord[] = []

  // The answer shape first: the gates read the parts, so a shapeless answer
  // is refused before any of them runs.
  const { body, briefing: rawBriefing } = splitBriefing(stripFences(text))
  if (!body.trim()) {
    gates.push({ gate: 'shape', verdict: 'refused', attempt, ...(launch ? { launch } : {}), stage: 'answer', measured: 0, bar: 'a body and a briefing', bar_from: "the row's answer shape" })
    // An answer that parsed to nothing is UNREADABLE, never an empty route.
    return { ok: false, reason: 'that pass answered with nothing arc could read as prose, so nothing was written. Ask again.', gates, unreadable: true }
  }
  gates.push({ gate: 'shape', verdict: 'held', attempt, ...(launch ? { launch } : {}), stage: 'answer' })

  // Evidence resolution before the gates read it: every claim is checked
  // against the destination this pass was given, and what does not resolve
  // is dropped and counted (§4).
  const parsedTail = ctx.parseCoverageTail(rawBriefing)
  const resolved = ctx.resolveCoverage(ctx.destination, parsedTail.coverage, ctx.known)
  const dropped = [
    ...resolved.dropped,
    ...(parsedTail.unparseable ? [{ reason: 'unparseable' as const, count: parsedTail.unparseable }] : []),
  ]
  const a: ParsedAnswer = { body: body.trim(), briefing: parsedTail.briefing, coverage: resolved.coverage, dropped, returned: resolved.returned, overlap: null }

  for (const id of row.gates) {
    // The leak gate ran on the BRIEF, before the send — not here.
    if (id === 'leak') continue
    const fn = GATES[id]
    if (!fn) {
      // A declared gate with no implementation must never be a gate that
      // quietly did not run.
      gates.push({ gate: id, verdict: 'could not judge', attempt, ...(launch ? { launch } : {}), stage: 'answer', bar_from: 'this arc has no implementation for that gate' })
      return { ok: false, reason: `arc could not check ${id} on that answer, so nothing was written. Ask again.`, gates }
    }
    const out = fn(ctx, a)
    gates.push({ gate: id, verdict: out.verdict, attempt, ...(launch ? { launch } : {}), ...out.record })
    if (out.verdict === 'refused') {
      return { ok: false, reason: out.reason, gates }
    }
    // The overlap gate's measurement is what the route carries.
    if (id === 'overlap' && out.verdict === 'held') a.overlap = typeof out.record.measured === 'number' ? out.record.measured : null
  }

  return { ok: true, body: a.body, briefing: a.briefing, coverage: a.coverage, dropped: a.dropped, returned: a.returned, overlap: a.overlap, gates }
}

// ---- the leak gate: proven before the send -------------------------------
//
// envelope rule 4. For a withholding row the runner proves the ASSEMBLED
// BRIEF before anything is sent: no span of the withheld set above the row's
// bar appears anywhere in it. The set is the row's declaration realised by
// the pass — the scene as it stands, less the locked paragraphs the pass is
// told to reproduce and the contract literals it is told to avoid, plus
// everything that quotes the scene (an open note carries the author's own
// quote; a touchstone may be drawn from this very scene).
//
// This is the gate that catches the leak that existed before it: reroute
// hands the pass the scene's open notes, and a note that quotes a sentence
// hands over the sentence.

/** What the pass gives the runner to prove the brief against. */
export interface WithheldSet {
  /** every text the brief must not carry a long span of */
  text: string[]
  /** spans that may appear anyway — the locked paragraphs the pass sends on
   *  purpose, and the contract's quoted literals */
  allowed: string[]
  /** a run of this many consecutive words is a leak */
  spanWords: number
}

/** ONE TOKENIZER. The gate and the stripper must read the same word stream or
 *  the stripper leaves a run the gate still finds, and the pass refuses with
 *  nothing left to point at — so `leakWords` is DERIVED from this rather than
 *  written a second time beside it.
 *
 *  Iterated by code point, not by UTF-16 unit: an astral letter is one letter,
 *  and testing half a surrogate pair against `\p{L}` splits a word in two.
 *  Folding is done on the SLICE, not per character, so a context-sensitive
 *  lowercase — Greek final sigma — folds the way it does in running text; and
 *  a combining mark that a lowercase introduces (İ → i + U+0307) is dropped by
 *  the same class test that drops punctuation.
 *
 *  Each token carries where it came from in the untouched string, so a run
 *  found by the gate's rule can be cut out of the original with the
 *  punctuation and capitals around it intact. */
export interface LeakToken { w: string; from: number; to: number }

// One apostrophe. A note pasted through an editor that smart-quotes, or typed
// straight against typographic prose, must not slip a quote past the gate by
// shifting the word stream at a contraction.
const APOSTROPHES = /[\u2018\u2019\u02bc]/g

const foldSlice = (s: string, from: number, to: number): string =>
  s.slice(from, to).toLowerCase().replace(APOSTROPHES, "'").replace(/[^\p{L}\p{N}']/gu, '')

export function leakTokens(s: string): LeakToken[] {
  const out: LeakToken[] = []
  let from = -1
  let i = 0
  for (const ch of s) {
    const c = ch.replace(APOSTROPHES, "'")
    if (/^[\p{L}\p{N}']$/u.test(c)) { if (from < 0) from = i }
    else if (from >= 0) { const w = foldSlice(s, from, i); if (w) out.push({ w, from, to: i }); from = -1 }
    i += ch.length
  }
  if (from >= 0) { const w = foldSlice(s, from, s.length); if (w) out.push({ w, from, to: s.length }) }
  return out
}

const leakWords = (s: string): string[] => leakTokens(s).map(t => t.w)

/** Every span of `n` consecutive words in a text, as joined strings. */
function spans(text: string, n: number): string[] {
  const w = leakWords(text)
  if (w.length < n) return []
  const out: string[] = []
  for (let i = 0; i + n <= w.length; i++) out.push(w.slice(i, i + n).join(' '))
  return out
}

/** CUT THE SOURCE'S OWN PROSE OUT OF A TEXT, by the leak gate's rule and the
 *  leak gate's tokenizer (A67-14).
 *
 *  The gate refuses a brief that carries a run of `n` consecutive words of
 *  what the row withheld. A ratified style contract teaches by quoting the
 *  book, so on the one pass that must work without the scene, the contract
 *  itself carries the scene in and the gate — correctly — refuses every run.
 *  What is wrong there is the contract handed to the gate, not the gate, so
 *  this removes the quotation and leaves the rule.
 *
 *  It lives here beside `leaks` deliberately: a stripper that tokenized even
 *  slightly differently from the gate would leave a run the gate still finds,
 *  and the pass would refuse with nothing left to point at.
 *
 *  Each maximal run becomes ONE marker, so a quoted sentence is replaced once
 *  rather than word by word. */
export function stripQuotedSpans(text: string, source: string, n: number, marker: string, allowed: string[] = []): { text: string; stripped: number } {
  const src = new Set(spans(source, n))
  if (!src.size) return { text, stripped: 0 }
  // What the row lets through — locked paragraphs, the contract's own quoted
  // withholds — is not a leak, and the gate subtracts it. Cutting it here
  // would gut a rule for no gate reason AND put a marker saying the passage
  // is withheld from a pass that is handed it verbatim two blocks later.
  for (const a of allowed) for (const sp of spans(a, n)) src.delete(sp)
  if (!src.size) return { text, stripped: 0 }
  const toks = leakTokens(text)
  if (toks.length < n) return { text, stripped: 0 }
  const hit = new Array<boolean>(toks.length).fill(false)
  for (let i = 0; i + n <= toks.length; i++) {
    if (src.has(toks.slice(i, i + n).map(t => t.w).join(' '))) for (let k = i; k < i + n; k++) hit[k] = true
  }
  let out = ''
  let last = 0
  let stripped = 0
  let i = 0
  while (i < toks.length) {
    if (!hit[i]) { i++; continue }
    let j = i
    while (j + 1 < toks.length && hit[j + 1]) j++
    // The newlines inside the cut come back. A run can straddle the closing
    // quote of one line and the first word of the next — the words after it
    // really are the scene's, so they have to go — but swallowing the line
    // breaks with them collapses three lines of the contract into one and the
    // rule stops reading as a rule.
    const cut = text.slice(toks[i].from, toks[j].to)
    const breaks = cut.match(/\n/g)?.join('') ?? ''
    out += text.slice(last, toks[i].from) + marker + breaks
    last = toks[j].to
    stripped++
    i = j + 1
  }
  return stripped ? { text: out + text.slice(last), stripped } : { text, stripped: 0 }
}

export interface LeakFinding { span: string; from: string }

/** The passages of the withheld set that appear in the brief, minus
 *  anything the row allows through — each one a maximal RUN, not every
 *  window inside it, so a quoted sentence is one finding rather than five.
 *  Pure, so the gate is testable without a launch. */
export function leaks(brief: string, withheld: WithheldSet): LeakFinding[] {
  const n = withheld.spanWords
  const inBrief = new Set(spans(brief, n))
  if (!inBrief.size) return []
  const allowed = new Set(withheld.allowed.flatMap(t => spans(t, n)))
  const leaked = (w: string[], i: number): boolean => {
    const span = w.slice(i, i + n).join(' ')
    return inBrief.has(span) && !allowed.has(span)
  }
  const found: LeakFinding[] = []
  for (const text of withheld.text) {
    const w = leakWords(text)
    let i = 0
    while (i + n <= w.length) {
      if (!leaked(w, i)) { i++; continue }
      let end = i + n
      while (end < w.length && leaked(w, end - n + 1)) end++
      found.push({ span: w.slice(i, end).join(' '), from: text.slice(0, 60) })
      i = end - n + 2
    }
  }
  return found
}

/** The leak gate, as a typed record and — when it fires — a refusal in the
 *  author's words. Runs on the brief, before the send. */
export function leakGate(brief: string, withheld: WithheldSet, attempt: number, launch?: string): { record: GateRecord; reason?: string } {
  const found = leaks(brief, withheld)
  // Measured and bar in the SAME units, as every other thresholded gate:
  // how many passages of the withheld set are in the brief, against none
  // allowed. The span length is the bar's definition, not its value.
  const base = {
    gate: 'leak' as const,
    attempt,
    ...(launch ? { launch } : {}),
    stage: 'brief' as const,
    bar: 0,
    bar_from: `the row's withheld set: no run of ${withheld.spanWords} consecutive words`,
    measured: found.length,
  }
  if (!found.length) return { record: { ...base, verdict: 'held' } }
  return {
    record: { ...base, verdict: 'refused', measured_against: [found[0].span] },
    reason: `arc was about to hand the pass a piece of the scene it is meant to work without — "${found[0].span}" — so it did not send it. That comes from a note or a touchstone that quotes the prose; resolve or reword it, and ask again.`,
  }
}

// ---- the runner owns the child -------------------------------------------

/** What the runner needs to launch, judge and repair one job. */
export interface GateJob {
  row: SealedRow
  run: Run
  receipt: Receipt
  /** the brief for the first attempt */
  brief: Brief
  /** The one repair's brief. `resumed` says whether the engine is carrying
   *  the first attempt's transcript: when it is, the refusal is the only new
   *  input; when it is not — the SDK is stateless, the fixture answers a
   *  brief it has seen — the same brief goes again with the refusal on the
   *  end. Never a fresh slice either way (invariant 5). */
  repair: (refusal: string, resumed: boolean) => Brief
  /** names each launch within the run: `late-entry-1`, `late-entry-2` */
  attempt: (n: 1 | 2) => string
  /** what the row's gates measure against */
  gateCtx: ProseGateCtx
  /** what the brief must not carry, for a withholding row — the row's
   *  declaration, realised by the pass */
  withheld?: WithheldSet
  /** the rendered brief, for the fingerprint the receipt names */
  render: (brief: Brief) => string
}

export type GateOutcome =
  | { ok: true; checked: Extract<GateChecked, { ok: true }>; retried?: string }
  | {
    ok: false
    reason: string
    /** set when an ENGINE failure ended it — the kind the run ends with,
     *  unless a gate had already refused (see `gateRefused`) */
    kind?: EngineErrorKind
    /** true when a gate refused an answer at any point: the run's ending is
     *  `refused`, because that is what stopped it, and the repair's own
     *  failure is in the records and in the sentence */
    gateRefused?: boolean
    /** the answer parsed to nothing: the run ends `unreadable` */
    unreadable?: boolean
    gates: GateRecord[]
  }

/** Both tries, as one thing the author can read: a gate's reason is a
 *  clause, not a sentence, so it is closed before the second is added. */
function join(first: string, second: string): string {
  const closed = /[.!?]$/.test(first.trim()) ? first.trim() : `${first.trim()}.`
  return `${closed} arc tried once more, and: ${second}`
}

/** The sentence a failed launch gives the author. It reaches the route
 *  reader verbatim, so it carries no machine word and ends in the next
 *  keystroke; the engine's own message is kept on the receipt instead. */
export function engineSentence(e: unknown): string {
  const kind = e instanceof EngineError ? e.kind : null
  switch (kind) {
    case 'envelope': return (e as EngineError).message   // already written for the author
    case 'cancelled': return 'stopped before it landed'
    case 'timed out': return 'that pass ran past the time arc gives it and was stopped, so nothing was written. Ask again, or ask for one way through instead of two.'
    case 'rate-limited': return 'your account is at its limit just now, so that pass could not run and nothing was written. Try again in a while.'
    case 'unreachable': return 'arc could not reach the writing engine, so nothing was written. Check that you are logged in to the claude CLI, and ask again.'
    default: return 'that pass ended before it answered, so nothing was written. Ask again.'
  }
}

/** What actually happened, for the receipt: the launch stage's record, with
 *  the engine's own words as what it was measured against. */
export const engineGate = (e: unknown, attempt: number, launch?: string): GateRecord => ({
  gate: 'engine',
  verdict: 'could not judge',
  attempt,
  ...(launch ? { launch } : {}),
  stage: 'launch',
  measured: e instanceof EngineError ? e.kind : 'died',
  bar_from: (e as Error).message,
})

/** Refused before the send: the leak gate fired on the assembled brief. */
export class LeakRefusal extends Error {
  constructor(readonly record: GateRecord, message: string) {
    super(message)
    this.name = 'LeakRefusal'
  }
}

/** Launch once, and put everything the launch learned on the receipt. */
async function launchOnce(job: GateJob, brief: Brief, attempt: string, n: 1 | 2, resumeAttempt?: string): Promise<string> {
  const { row, run, receipt } = job
  const rendered = job.render(brief)

  // BEFORE the send: no span of the withheld set is in this brief (envelope
  // rule 4). A refusal here costs nothing but the assembly.
  if (row.gates.includes('leak')) {
    if (!job.withheld) {
      // A declared gate that silently did not run is the failure the typed
      // record exists to prevent — including this one.
      const record: GateRecord = {
        gate: 'leak', verdict: 'could not judge', attempt: n, launch: attempt, stage: 'brief',
        bar_from: 'the row declares a leak gate and the pass handed over no withheld set',
      }
      receipt.gates = [...(receipt.gates ?? []), record]
      writeWorkingReceipt(receipt)
      throw new LeakRefusal(record, 'arc could not check what that pass was about to be shown, so it did not send it. Ask again.')
    }
    const { record, reason } = leakGate(rendered, job.withheld, n, attempt)
    receipt.gates = [...(receipt.gates ?? []), record]
    writeWorkingReceipt(receipt)
    if (reason) throw new LeakRefusal(record, reason)
  }
  // The slots by id and fingerprint; the brief itself is kept once, whole,
  // under its own fingerprint — the same one the fixture engine keys on.
  receipt.brief = [...(receipt.brief ?? []), ...brief.blocks.map(b => ({ attempt, id: b.id, fingerprint: sha16(b.text), cached: b.cached }))]
  keepWithRun(run.id, 'brief', rendered)
  const estimate = { input: Math.round(rendered.length / 4), output: row.budget.outputTokens }
  receipt.tokens = {
    estimated: {
      input: (receipt.tokens?.estimated?.input ?? 0) + estimate.input,
      output: (receipt.tokens?.estimated?.output ?? 0) + estimate.output,
    },
    actual: receipt.tokens?.actual ?? null,
  }
  writeWorkingReceipt(receipt)

  let detach = () => {}
  try {
    const a = await askRow(row, brief, {
      runId: run.id,
      attempt,
      resumeAttempt,
      onLaunch: launch => {
        detach = attachLaunch(run.id, launch)
        recordLaunch(run.id, { attempt, session_id: launch.sessionId, scratch_dir: launch.scratchDir, expected_transcript: launch.expectedTranscript, at: new Date().toISOString() })
      },
      onProof: proof => {
        receipt.envelope = {
          declared: { ...row.envelope },
          observed: [...(receipt.envelope?.observed ?? []), {
            attempt, proven: proof.proven, recorded: proof.recorded,
            ...(proof.ok ? {} : { refused: proof.refusal }),
          }],
        }
        writeWorkingReceipt(receipt)
      },
    })
    if (isDry(a)) throw new Error('a dry answer where an answer was asked for')
    if (a.transcriptPath) recordLaunch(run.id, { attempt, session_id: a.sessionId, scratch_dir: a.cwd ?? '', expected_transcript: null, transcript_path: a.transcriptPath, at: new Date().toISOString() })

    receipt.engine = { engine: a.runtimeVersion === 'fixture' ? 'fixture' : 'claude-cli', model: a.model, runtime: a.runtimeVersion }
    receipt.tokens = {
      estimated: receipt.tokens?.estimated ?? null,
      actual: {
        input: (receipt.tokens?.actual?.input ?? 0) + a.tokens.input,
        output: (receipt.tokens?.actual?.output ?? 0) + a.tokens.output,
      },
    }
    receipt.wall_clock_ms = (receipt.wall_clock_ms ?? 0) + a.wallClockMs
    if (!receipt.envelope?.observed?.some(o => o.attempt === attempt)) {
      const proof = a.envelope ?? { proven: {}, recorded: recordedEnvelope(a.init) }
      receipt.envelope = {
        declared: { ...row.envelope },
        observed: [...(receipt.envelope?.observed ?? []), { attempt, proven: proof.proven, recorded: proof.recorded }],
      }
    }
    // What the runtime added on its own, across every launch of the run.
    const added = new Map<string, string>()
    for (const o of receipt.envelope?.observed ?? []) {
      for (const [field, v] of Object.entries(o.recorded ?? {})) {
        const value = v.value
        const has = Array.isArray(value) ? value.length > 0 : value && typeof value === 'object' ? Object.keys(value).length > 0 : Boolean(value)
        if (has) added.set(field, `${field} — ${v.observed_in}`)
      }
    }
    receipt.slice = {
      ...(receipt.slice ?? { included: [], withheld_by_design: [], dropped_for_budget: [], runtime_added: [] }),
      runtime_added: [...added.values()],
    }
    receipt.answers = [...(receipt.answers ?? []), { attempt, fingerprint: keepWithRun(run.id, 'answer', a.text), landed: false }]
    writeWorkingReceipt(receipt)
    return a.text
  } finally {
    detach()
  }
}

/** Launch, judge, and repair once — the whole of what a pass hands over.
 *
 *  A gate refusal earns exactly one repair, resuming the same transcript so
 *  the refusal and the previous answer are the only new input. A transport
 *  failure earns none: it is not a refusal, and the run ends with its kind
 *  (invariant 5). */
export async function runGates(job: GateJob): Promise<GateOutcome> {
  const { receipt } = job

  const attempt1 = job.attempt(1)
  let text: string
  try {
    text = await launchOnce(job, job.brief, attempt1, 1)
  } catch (e) {
    // A leak is a REFUSAL, not a transport failure: the brief was never
    // sent, and there is nothing to repair — the fix is the author's note.
    if (e instanceof LeakRefusal) {
      writeWorkingReceipt(receipt)
      return { ok: false, reason: e.message, gates: [e.record], gateRefused: true }
    }
    const record = engineGate(e, 1, attempt1)
    receipt.gates = [...(receipt.gates ?? []), record]
    writeWorkingReceipt(receipt)
    return { ok: false, reason: engineSentence(e), kind: e instanceof EngineError ? e.kind : 'died', gates: [record] }
  }

  const first = runRowGates(job.row, job.gateCtx, text, 1, attempt1)
  receipt.gates = [...(receipt.gates ?? []), ...first.gates]
  if (first.ok) {
    markLanded(receipt, attempt1, first)
    writeWorkingReceipt(receipt)
    return { ok: true, checked: first }
  }
  // The refused text is kept with the run and named by fingerprint — never
  // filed as a proposal, never in history/.
  keepWithRun(job.run.id, 'refused', text)
  writeWorkingReceipt(receipt)

  // ONE repair, and only for a gate refusal.
  const attempt2 = job.attempt(2)
  const resumes = engineResumes()
  let repaired: string
  try {
    // Resumed where the engine keeps a transcript, so the refusal and the
    // previous answer are the only new input; otherwise the same brief goes
    // again with the refusal on the end.
    repaired = await launchOnce(job, job.repair(first.reason, resumes), attempt2, 2, resumes ? attempt1 : undefined)
  } catch (e) {
    if (e instanceof LeakRefusal) {
      writeWorkingReceipt(receipt)
      return { ok: false, reason: join(first.reason, e.message), gates: [...first.gates, e.record], gateRefused: true }
    }
    const record = engineGate(e, 2, attempt2)
    receipt.gates = [...(receipt.gates ?? []), record]
    writeWorkingReceipt(receipt)
    // A transport failure on the repair is still a transport failure: the
    // run ends with ITS kind, not as a gate refusal (invariant 5).
    return { ok: false, reason: join(first.reason, engineSentence(e)), gates: [...first.gates, record], kind: e instanceof EngineError ? e.kind : 'died', gateRefused: true }
  }

  const second = runRowGates(job.row, job.gateCtx, repaired, 2, attempt2)
  receipt.gates = [...(receipt.gates ?? []), ...second.gates]
  if (second.ok) {
    markLanded(receipt, attempt2, second)
    writeWorkingReceipt(receipt)
    return { ok: true, checked: second, retried: first.reason }
  }
  keepWithRun(job.run.id, 'refused', repaired)
  writeWorkingReceipt(receipt)
  // Nothing retries further.
  // What the LAST attempt was is what the run ended as: a first answer that
  // parsed to nothing, repaired into prose a gate then refused, ended on
  // the gate.
  return { ok: false, reason: join(first.reason, second.reason), gates: [...first.gates, ...second.gates], gateRefused: true, unreadable: second.unreadable }
}

function markLanded(receipt: Receipt, attempt: string, checked: Extract<GateChecked, { ok: true }>): void {
  // Claims returned, and every drop counted by reason (§4).
  const dropped = new Map<string, number>((receipt.evidence?.dropped ?? []).map(d => [d.reason, d.count]))
  for (const d of checked.dropped) dropped.set(d.reason, (dropped.get(d.reason) ?? 0) + d.count)
  receipt.evidence = {
    // Claims the pass MADE that resolved — never the destination's length,
    // which is the same for every answer.
    returned: (receipt.evidence?.returned ?? 0) + checked.returned,
    dropped: [...dropped].map(([reason, count]) => ({ reason, count })),
  }
  const answered = receipt.answers?.find(x => x.attempt === attempt)
  if (answered) answered.landed = true
}
