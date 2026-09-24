// The registry: the one typed table that admits a launch (A67-1).
//
// agent-workflows.md §4, "The registry row": one table keyed by (job, scope,
// mode) with a stage sub-key, and a UNION over the pattern — sealed, staged,
// fan-out, investigation, record agent — never one wide row with optional
// columns. Every variant shares the base: the cell, the slice with its drop
// order and floor, the envelope in runtime-neutral terms, the gate ids, the
// answer shape, the budgets per pass, transcript retention, the rules text
// and the fixtures. Each variant then requires only what it can use, and the
// type makes the wrong field unwritable: a sealed row has no toolbelt to
// leave empty and no session to set, which is how "withholding ⇒ tools none
// and session none" is a property of the variant rather than a check that
// runs after someone writes a row wrong (registry.types.test.ts proves it).
//
// A row's STATUS is derived at startup, never typed: designed · built ·
// attended · batch-eligible (rowStatus below). A migrated job has exactly one
// definition — its row — and the configuration it replaced is deleted in the
// same change (§11's drift rule): the `*_RULES` text lives here, beside the
// row, and the pass module imports it.
//
// Two rows today, both sealed, both withholding: U4, another way through a
// scene, and U5, its rewrite from the author's notes on a route. Every
// other pass still launches by name through PASS_REGISTRY (invocation.ts);
// test/pass-registry.test.ts holds the ratchet on how many.
import fs from 'node:fs'
import path from 'node:path'
import { load as yamlLoad } from 'js-yaml'
import { STORY } from './config'
import { loadFixtures, type Fixture } from './fixtures'
import { sha16 } from './records'

// ---- the four axes (§3) ----------------------------------------------------

export type Job = 'draft' | 'revise' | 'explore' | 'compose' | 'inspect' | 'update-record' | 'learn' | 'import'
/** §3's seven positions, plus `route`: U5's subject is a route beside a
 *  scene, not a position in the book, and §11 names its row so. */
export type Scope = 'selection' | 'paragraph' | 'scene' | 'chapter' | 'manuscript' | 'world' | 'strand' | 'route'
export type Mode = 'one-shot' | 'iterative' | 'conversational' | 'triggered' | 'batch'
export type Depth = 'quick' | 'standard' | 'full'

export interface Cell { job: Job; scope: Scope; mode: Mode; depth: Depth; stage: string | null }

// ---- what every row carries ---------------------------------------------

/** The slice, declared: which layers the job's context holds, the order
 *  they drop when the budget bites, and the floor that never drops — a
 *  slice that cannot hold its floor refuses before any token (§4). The
 *  assembly itself stays in the pass until slice 2's assembler; the row
 *  names it so the job fingerprint moves when it changes. */
export interface SliceSpec {
  id: string
  layers: readonly string[]
  dropOrder: readonly string[]
  floor: readonly string[]
}

/** Envelope rule 1's fields, runtime-neutral. Every row declares project
 *  context none, network none and a scratch directory; what differs by
 *  variant is below. */
export interface EnvelopeBase {
  projectContext: 'none'
  /** what the runtime adds on its own — user-level instructions, memory,
   *  skills — which no engine on subscription auth can withhold (harness §5);
   *  a RECORDED field, listed on the receipt, never proven none */
  runtimeAdditions: 'none' | 'user-level'
  network: 'none'
  directory: 'scratch'
  /** Only the retention arc actually honours: the run's transcripts are
   *  deleted at the author's decision (`deleteRunTranscripts`). A `keep`
   *  option waits for something that keeps them — a type must not promise
   *  what no code does. */
  transcript: 'delete-at-decision'
}
/** A sealed launch: no tools, no subagents, and no session FIELD — a sealed
 *  row cannot resume, by type. */
export interface SealedEnvelope extends EnvelopeBase { tools: 'none'; subagents: 'none' }
/** The bounded investigation (U14): a named read set by tool id, at most one
 *  read subagent, and a session it may resume once. */
export interface InvestigationEnvelope extends EnvelopeBase {
  tools: { read: readonly string[] }
  subagents: 'none' | 'one-read'
  session: 'none' | 'resume-once'
}
/** The governed record agent (U13): arc's record tools and nothing else. */
export interface RecordAgentEnvelope extends EnvelopeBase {
  tools: 'record-tools'
  subagents: 'none'
  session: 'none' | 'resume-once'
}

/** The gates the runner may run on an answer, by id. Each is code that
 *  reads the answer and may refuse the write (§4, "The gates"). */
export type GateId =
  | 'locks' | 'lock-order' | 'withhold-literals' | 'and-chain' | 'sentence-length'
  | 'overlap' | 'coverage-tail' | 'validator' | 'leak'

/** How the answer is shaped, so a gate can read it without a model. */
export type AnswerShape = 'coverage-tail'

/** What a withholding row withholds, declared on the ROW rather than known
 *  by the pass (§4, envelope rule 4; A67-7). The leak gate reads this to
 *  build the set it proves the brief against, before anything is sent.
 *
 *  `source` names where the withheld text comes from; `less` what is
 *  deliberately allowed to appear in the brief anyway; `plus` what else
 *  belongs to the set because it quotes the source; `spanWords` is the bar —
 *  a run of that many consecutive words of the withheld set, appearing
 *  anywhere in the brief, is a leak. */
export interface WithheldSpec {
  source: 'the scene as it stands'
  less: readonly ('locked paragraphs' | 'quoted contract literals')[]
  plus: readonly ('note quotes' | 'touchstones drawn from the scene')[]
  spanWords: number
}

export interface RowBase extends Cell {
  /** the slice holds none of the current prose and the envelope cannot
   *  reach any — U4, U5, U15 */
  withholding: boolean
  /** present exactly when `withholding` — what the leak gate proves the
   *  brief against */
  withheld?: WithheldSpec
  slice: SliceSpec
  gates: readonly GateId[]
  answer: AnswerShape
  /** per pass: output tokens the answer may spend, and wall clock from send
   *  to answer — time waiting on the author is never budget */
  budget: { outputTokens: number; wallClockMs: number }
  /** the role and the rules, verbatim — the first slot of the brief */
  rules: string
  /** the recorded briefs under fixtures/<key>/, by name; two per
   *  thresholded gate and one that lands (§7, "Adding a job") */
  fixtures: readonly string[]
}

export interface SealedRow extends RowBase { pattern: 'sealed'; envelope: SealedEnvelope }
export interface StagedRow extends RowBase { pattern: 'staged'; envelope: SealedEnvelope; stages: readonly string[] }
export interface FanOutRow extends RowBase { pattern: 'fan-out'; envelope: SealedEnvelope; stages: readonly string[]; reduce: string }
export interface InvestigationRow extends RowBase {
  pattern: 'investigation'
  envelope: InvestigationEnvelope
  /** one pool for the whole tree */
  pool: { steps: number; subagents: number; subagentDepth: 1; wallClockMs: number }
}
export interface RecordAgentRow extends RowBase { pattern: 'record-agent'; envelope: RecordAgentEnvelope; claim: string }

export type Row = SealedRow | StagedRow | FanOutRow | InvestigationRow | RecordAgentRow

/** The row's key: job.scope.mode, with the stage when it has one. Names
 *  its fixture directory and its line on the receipt. */
export type RowKey = string
export const rowKey = (r: Cell): RowKey => `${r.job}.${r.scope}.${r.mode}${r.stage ? `.${r.stage}` : ''}`

// ---- U4 · Explore · scene · one-shot, withholding -------------------------

/** Twenty minutes per call (Q3, decided 2026-09-13 for this row only): a
 *  whole scene in two parts is a long answer, and a 2,300-word scene overran
 *  the engine's ten-minute default. Reset from the first ten receipts. */
export const ROUTE_WALL_CLOCK_MS = 20 * 60 * 1000
/** About four times the novel's longest scene (2,361 words) — provisional,
 *  so the `budget` ending can fire; reset from the first ten receipts. */
export const ROUTE_OUTPUT_TOKENS = 12_000

const ROUTE_ENVELOPE: SealedEnvelope = {
  tools: 'none',
  subagents: 'none',
  projectContext: 'none',
  runtimeAdditions: 'user-level',
  network: 'none',
  directory: 'scratch',
  transcript: 'delete-at-decision',
}

export const REROUTE_RULES = `You are arc's REROUTE pass. The author asked for ANOTHER WAY THROUGH a scene
of their own novel: the same destination, reached by a different route. You
are deliberately not shown the current prose. You are shown where it must
arrive, and the route it already takes, which you must not take again.

THE DESTINATION binds. Every item under "must be accomplished" happens in
your scene, by whatever realization you choose. A required beat is not
something to avoid — it is something to reach another way.

THE KNOWN ROUTE is fenced. Do not reproduce its ordering, its staging, what
it opens on or what it closes on. Find a different realization: enter
elsewhere, stage it differently, let a different thing carry the movement.

ARC'S OWN READING, where it appears, is context and binds nothing.

WHAT MUST SURVIVE, exactly:
1. The scene's meaning. Every event and fact the frontmatter binds still
   happens here, in canon's order; character state at this moment in the
   story is unchanged. Bound events are fact, not route.
2. The scene contract — purpose, must_establish, must_withhold, motifs,
   constraints. Withholding is deliberate: do not "fix" it.
3. The style contract. It is the author's voice; run its pre-draft
   checklist before answering.
4. POV, tense, and the anachronism boundary.
5. Locked paragraphs, VERBATIM, word for word, in the relative order given.
6. Canon is truth. Never invent a fact the record would have to carry — a
   new person, date, or place is a proposal for the author, not yours to
   make. If the destination cannot be reached without one, say so in the
   briefing: that is a story-state question, and only the author answers it.

ANSWER IN TWO PARTS, separated by a line that is exactly:
=== BRIEFING ===
Part one: the rerouted prose alone — no frontmatter, no commentary, no
fences. Part two, the briefing, in the ARGUED register (claims for the
author to judge, not verdicts): where each required beat lands, by paragraph
number; how your ordering and staging differ from the known route; how each
locked paragraph now sits and what changed around it; the style checklist
item by item; and any fact you needed that canon does not hold.
End the briefing with ONE fenced json block of exactly this shape, and
nothing else inside the fence:
\`\`\`json
{"coverage": [{"item": "<a required beat, verbatim>", "paragraph": <1-based paragraph number, or null>}]}
\`\`\``

/** The gates both route passes share — one set, so the two cannot drift
 *  apart gate by gate. `leak` is first and different in kind: it runs on the
 *  assembled brief BEFORE the send, and the rest run on the answer. */
const ROUTE_GATES: readonly GateId[] = ['leak', 'locks', 'lock-order', 'withhold-literals', 'and-chain', 'sentence-length', 'overlap', 'coverage-tail']

/** What U4 and U5 withhold: the scene as it stands, less what the author
 *  has settled (locked paragraphs) and what the contract quotes as a literal
 *  the pass is told to avoid — plus everything that QUOTES the scene, which
 *  is where the leak actually comes from (the author's open notes carry
 *  their quotes, and a touchstone may be drawn from this very scene). */
export const ROUTE_WITHHELD: WithheldSpec = {
  source: 'the scene as it stands',
  less: ['locked paragraphs', 'quoted contract literals'],
  plus: ['note quotes', 'touchstones drawn from the scene'],
  // Eight consecutive words: long enough that ordinary phrases ("she went
  // down to the") do not fire it, short enough to catch a quoted sentence.
  spanWords: 8,
}

export const ROW_EXPLORE_SCENE: SealedRow = {
  job: 'explore', scope: 'scene', mode: 'one-shot', depth: 'standard', stage: null,
  pattern: 'sealed',
  withholding: true,
  withheld: ROUTE_WITHHELD,
  slice: {
    id: 'route-fence',
    // reroute.ts assembles these today, in this order; none is the prose
    layers: ['style', 'contract', 'pack', 'destination', 'known-route', 'inferred', 'locked', 'siblings', 'notes'],
    dropOrder: ['siblings', 'inferred', 'notes'],
    floor: ['style', 'contract', 'pack', 'destination', 'known-route', 'locked'],
  },
  envelope: ROUTE_ENVELOPE,
  gates: ROUTE_GATES,
  answer: 'coverage-tail',
  budget: { outputTokens: ROUTE_OUTPUT_TOKENS, wallClockMs: ROUTE_WALL_CLOCK_MS },
  rules: REROUTE_RULES,
  // The recorded answers this row is testable against. The leak scenario
  // has none on purpose: its gate refuses the brief before the send, so
  // there is never an answer to record (A67-7).
  fixtures: ['lands', 'overlap', 'coverage-drop'],
}

// ---- U5 · Explore · route · one-shot, withholding -------------------------

export const REROUTE_REVISE_RULES = `You are arc's ROUTE REWRITE pass. The author read an alternative route for a
scene of their own novel and asked for it rewritten. The route is your
subject — you are shown it in full. The scene's current prose is
deliberately not shown to you.

THE AUTHOR'S NOTE binds. Keep what it keeps, change what it names. Where the
note and anything else below disagree, the note wins.

THE DESTINATION binds. Every item under "must be accomplished" happens in
your rewrite, by whatever realization you choose.

THE MANUSCRIPT'S KNOWN ROUTE is fenced. The rewrite stays another way
through: do not drift toward that ordering or staging, what it opens on or
what it closes on.

WHAT MUST SURVIVE, exactly:
1. The scene's meaning. Every event and fact the frontmatter binds still
   happens here, in canon's order; character state at this moment in the
   story is unchanged.
2. The scene contract — purpose, must_establish, must_withhold, motifs,
   constraints. Withholding is deliberate: do not "fix" it.
3. The style contract. It is the author's voice; run its pre-draft
   checklist before answering.
4. POV, tense, and the anachronism boundary.
5. Locked paragraphs, VERBATIM, word for word, in the relative order given.
6. Canon is truth. Never invent a fact the record would have to carry — a
   new person, date, or place is a proposal for the author, not yours to
   make. If the note asks for one, say so in the briefing: that is a
   story-state question, and only the author answers it.

ANSWER IN TWO PARTS, separated by a line that is exactly:
=== BRIEFING ===
Part one: the rewritten route alone — no frontmatter, no commentary, no
fences. Part two, the briefing, in the ARGUED register (claims for the
author to judge, not verdicts): what the note asked and what you changed for
it; what you kept of the route and why it earned its place; where each
required beat lands, by paragraph number; the style checklist item by item;
and any fact you needed that canon does not hold.
End the briefing with ONE fenced json block of exactly this shape, and
nothing else inside the fence:
\`\`\`json
{"coverage": [{"item": "<a required beat, verbatim>", "paragraph": <1-based paragraph number, or null>}]}
\`\`\``

export const ROW_EXPLORE_ROUTE: SealedRow = {
  job: 'explore', scope: 'route', mode: 'one-shot', depth: 'standard', stage: null,
  pattern: 'sealed',
  withholding: true,
  withheld: ROUTE_WITHHELD,
  slice: {
    id: 'route-rewrite',
    layers: ['style', 'contract', 'pack', 'destination', 'known-route', 'locked', 'route', 'route-notes'],
    dropOrder: [],
    floor: ['style', 'contract', 'pack', 'destination', 'known-route', 'locked', 'route', 'route-notes'],
  },
  envelope: ROUTE_ENVELOPE,
  gates: ROUTE_GATES,
  answer: 'coverage-tail',
  budget: { outputTokens: ROUTE_OUTPUT_TOKENS, wallClockMs: ROUTE_WALL_CLOCK_MS },
  rules: REROUTE_REVISE_RULES,
  fixtures: ['lands', 'overlap', 'coverage-drop'],
}

// ---- the table ---------------------------------------------------------------

export const ROWS: readonly Row[] = [ROW_EXPLORE_SCENE, ROW_EXPLORE_ROUTE]

/** The row for a cell, or nothing: a job × scope × mode the rows do not
 *  list is refused at intake (invariant 10), never mapped to a neighbour. */
export function findRow(cell: { job: Job; scope: Scope; mode: Mode; depth?: Depth; stage?: string | null }): Row | undefined {
  return ROWS.find(r =>
    r.job === cell.job && r.scope === cell.scope && r.mode === cell.mode &&
    (cell.depth === undefined || r.depth === cell.depth) &&
    (cell.stage === undefined || r.stage === (cell.stage ?? null)))
}

/** The job fingerprint: over the row — its cell, pattern, envelope, slice,
 *  gate set, answer shape, budgets — and its rules text. A receipt carries
 *  it; a proposal whose fingerprint no longer matches is "written by an
 *  older arc"; a row is attended only by receipts that match. The fixture
 *  list is left out: recording a fixture does not change the job. */
export function jobFingerprint(row: Row): string {
  const withoutFixtures = JSON.stringify(row, (key, value) => (key === 'fixtures' ? undefined : value))
  return sha16(withoutFixtures)
}

// ---- status, derived --------------------------------------------------------

export type RowStatus = 'designed' | 'built' | 'attended' | 'batch-eligible'

/** What status reads off a receipt in history/. A67-4 writes these fields;
 *  until then they are hand-written in tests, and a receipt without them
 *  attends nothing. */
export interface StatusReceipt {
  /** what produced the run: the arc commit and the row's job fingerprint
   *  (A67-4 writes it here; the flat field is the older shape) */
  produced_by?: { job_fingerprint?: string }
  job_fingerprint?: string
  author_decision?: { decision?: string }
  /** what the run was about — a scene id, a route id */
  request?: { subject?: string }
  subject?: string
  /** the ending, from the closed set: landed · refused · could not run · … */
  ending?: string
  invariant_violations?: readonly unknown[]
}

const fingerprintOf = (r: StatusReceipt): string | undefined => r.produced_by?.job_fingerprint ?? r.job_fingerprint
const subjectOf = (r: StatusReceipt): string | undefined => r.request?.subject ?? r.subject

export function readStatusReceipts(dir: string = path.join(STORY, 'history')): StatusReceipt[] {
  if (!fs.existsSync(dir)) return []
  const out: StatusReceipt[] = []
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.yaml')) continue
    try {
      const doc = yamlLoad(fs.readFileSync(path.join(dir, name), 'utf8')) as StatusReceipt | null
      if (doc && typeof doc === 'object') out.push(doc)
    } catch { /* a receipt that does not parse attends nothing */ }
  }
  return out
}

/** Is every fixture the row names recorded under its key? `recorded` is
 *  the store as loaded once by the caller — never re-read per row. */
export function fixturesRecorded(row: Row, recorded: readonly Fixture[]): boolean {
  const key = rowKey(row)
  return row.fixtures.length > 0 && row.fixtures.every(name => recorded.some(f => f.row === key && f.name === name))
}

/** designed (no fixtures recorded — nothing proves the code) · built (every
 *  fixture recorded) · attended (a receipt in history/ with an author
 *  decision and this row's job fingerprint) · batch-eligible (a batch row
 *  with attended decisions on more than one subject, at least one ending
 *  that was not landed, and no invariant violation). Earned from observed
 *  behaviour, never from one receipt. */
export function rowStatus(row: Row, receipts: readonly StatusReceipt[], built: boolean): RowStatus {
  if (!built) return 'designed'
  const fp = jobFingerprint(row)
  const attended = receipts.filter(r => fingerprintOf(r) === fp && typeof r.author_decision?.decision === 'string')
  if (!attended.length) return 'built'
  if (row.mode !== 'batch') return 'attended'
  const subjects = new Set(attended.map(subjectOf).filter((s): s is string => typeof s === 'string'))
  const notLanded = attended.some(r => r.ending !== undefined && r.ending !== 'landed')
  const violated = attended.some(r => (r.invariant_violations ?? []).length > 0)
  return subjects.size > 1 && notLanded && !violated ? 'batch-eligible' : 'attended'
}

/** Every row with its status, for the startup line and the surfaces. */
export function registryStatus(): { key: RowKey; status: RowStatus; fingerprint: string }[] {
  const receipts = readStatusReceipts()
  const recorded = loadFixtures()
  return ROWS.map(row => ({ key: rowKey(row), status: rowStatus(row, receipts, fixturesRecorded(row, recorded)), fingerprint: jobFingerprint(row) }))
}
