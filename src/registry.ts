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
  /** THE FRESHNESS DISTANCE (A69-6; §4, "Canon, with status"): how old a
   *  state fact may be, in days of STORY time, before the brief marks it as
   *  aged and the receipt lists it under `leaned on`. A snapshot taken a
   *  season before the scene is still the record's best word, and the pass
   *  is still given it — what changes is that the author is told the prose
   *  rests on something the record has not looked at since. Absent: nothing
   *  is marked. */
  freshness?: number
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
  | 'overlap' | 'coverage-tail' | 'validator' | 'leak' | 'plan-vocabulary'
  /** the ids the briefing says the prose rests on: a proposed or material id
   *  named there as settled is refused (A69-6) */
  | 'leaned-on'
  /** a minimal revision that changed a paragraph no handed note anchors to
   *  is refused — measured since A72-6 against the scene the pass was
   *  handed (`blast-radius.ts`). Declared on U2's row before it was built so
   *  the receipt said what was not yet checked (A69-9). */
  | 'blast-radius'
  /** three to six drop-in strings, each with something in it (A69-10) */
  | 'options-shape'
  /** every claim a reading makes must cite something the brief carried — an
   *  id from the slice, or a paragraph of the scene it read. A claim that
   *  cites nothing arc can place is dropped and counted, never refused:
   *  a reading that over-reaches loses that reading, not the whole answer
   *  (U9, A72-10; §11's citation gate) */
  | 'citations'
  /** U7 (A74-1): each evidence id a proposal names is a paragraph of the
   *  accepted change the brief carried — otherwise that proposal is dropped
   *  and counted. Proven. */
  | 'evidence-resolves'
  /** U7 (A74-1): a proposal whose key matches a record the book already
   *  holds, as canon or as a pending proposal, is refused as a duplicate.
   *  Proven. */
  | 'duplicate'
  /** U7 (A74-1): where code can show a proposal sits against the record it
   *  is filed WITH the contradiction named; the model's own claim of a
   *  conflict stays argued. Never refuses. No threshold, so no fixture of
   *  its own. */
  | 'contradiction'
  /** U12 (A74-6): a rule cites at least MIN_INDEPENDENT_EXAMPLES different
   *  places in the manuscript, counted from arc's own table of pairs — two
   *  passes at one paragraph are one example. Proven. */
  | 'two-examples'
  /** U12 (A74-6): a rule whose id or countable predicate the promoted
   *  contract already states is dropped (proven); one that only resembles a
   *  line of it by wording is kept and marked argued. */
  | 'not-in-contract'
  /** U12 (A74-6): a rule the author declined — same id or same countable
   *  predicate — is dropped (proven); one that only resembles a declined
   *  rule by wording is kept, with `resembles` recorded on it (argued). */
  | 'not-declined'
  /** A75-1: the prose came back WHOLE. Proven, by count alone: every
   *  paragraph a coverage claim names exists in the body, and the body holds
   *  at least the row's `minShareOfSubject` of the words of the scene it
   *  re-imagines. A lowercase first letter is recorded and never refuses on
   *  its own. Says nothing about whether the prose is good. */
  | 'answer-whole'

/** How the answer is shaped, so a gate can read it without a model. */
/** THE CRAFT MOVES (A69-4; §4, "The craft plan"). Q11, decided by the author
 *  2026-09-24: a FIXED vocabulary, because fixed is what a gate can check and
 *  what the style learner can count. Each move carries one free clause of how
 *  — that is what keeps it honest.
 *
 *  THE ID IS THE VOCABULARY; THE COPY IS NOT (the author's implementation
 *  note, 2026-09-24). The id is what the gate checks, what the receipt
 *  records and what the evidence log counts — so a plan stays comparable
 *  across every sitting, and the style learner can say "they keep asking for
 *  this one" about a thing with a name.
 *
 *  Be precise about what moves a fingerprint, because the note is easy to
 *  over-read. The wording below is part of the RULES the reading is given, so
 *  editing it IS a brief change and the job fingerprint moves — as it should,
 *  since the model is being told something different. What the note protects
 *  is the other direction: the author-facing labels in the viewer are not
 *  these strings, and rewording a label there changes nothing here. And an ID
 *  is never edited for readability: an id is a claim that two plans a year
 *  apart asked for the same thing. */
export const CRAFT_MOVES = {
  narrative_distance: 'how close the telling sits to the point-of-view character',
  sensory_access: 'which senses the scene gives the reader, and which it withholds',
  attention: 'whose noticing reveals whom',
  inventory: 'what is named, and what is cut because it reveals nobody',
  structure: 'the order of the beats, and what is kept of it',
  withheld: 'what the scene still does not say',
} as const
export type CraftMove = keyof typeof CRAFT_MOVES

export type AnswerShape =
  /** prose, then `=== BRIEFING ===`, then a fenced coverage tail */
  | 'coverage-tail'
  /** a complete scene file — frontmatter and body — then the briefing */
  | 'scene-file'
  /** one fenced JSON object: the craft moves chosen, each with one clause */
  | 'craft-plan'
  /** prose alone, then `=== BRIEFING ===`, then the argued self-report with
   *  its leans-on block — a rebuild of prose that already exists, so no
   *  frontmatter and no coverage tail (A69-8) */
  | 'body-and-briefing'
  /** one fenced JSON array of the tensions between the author's notes —
   *  a reading that writes nothing, and whose non-empty answer stops the
   *  job so the author can decide (A69-9) */
  | 'conflicts'
  /** the revised scene body alone: no frontmatter, no briefing, because a
   *  minimal revision answers instructions and has nothing to argue (A69-9) */
  | 'body-only'
  /** one fenced JSON array of findings about a pending change, each citing
   *  what it rests on — a reading that writes nothing, whose unsupported
   *  claims are DROPPED rather than refusing the answer (U9, A72-10) */
  | 'reading'
  /** one fenced JSON array of drop-in strings — three to six wordings the
   *  author picks one of, or none. The pass writes nothing, so there is no
   *  prose to gate and no briefing to argue: what the gates do here is drop
   *  an option, never refuse the answer (A69-10) */
  | 'options'
  /** one fenced JSON array of proposals for the record, each with the
   *  paragraph ids it rests on — code mints the id, renders the evidence
   *  and files the record; a gate failure drops that proposal and never the
   *  answer (U7, A74-1) */
  | 'proposals'
  /** one fenced JSON array of style rules, each citing the NUMBERS of the
   *  edit pairs it rests on — arc attaches the quotes itself; a gate failure
   *  drops that rule and never the answer (U12, A74-6) */
  | 'rules'

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
   *  to answer — time waiting on the author is never budget.
   *
   *  `inputTokens` is the CEILING on the assembled slice (A69-2, estimated as
   *  characters ÷ 4): layers drop in `slice.dropOrder` until the brief fits,
   *  the floor never drops, and a floor that will not fit refuses before a
   *  token is spent. It is a ceiling and not an operating point — nothing is
   *  padded to use the room that is left (the author, 2026-09-24). Optional
   *  because only a row whose slice the assembler builds can honour one, and
   *  a row that carries the number without the assembler would be promising
   *  what no code does. */
  budget: { outputTokens: number; wallClockMs: number; inputTokens?: number }
  /** the role and the rules, verbatim — the first slot of the brief */
  rules: string
  /** the recorded briefs under fixtures/<key>/, by name; two per
   *  thresholded gate and one that lands (§7, "Adding a job") */
  fixtures: readonly string[]
  /** A TRIGGERED JOB'S REVIEW EPISODE (A74-3, epic D1): how long a scene may
   *  go with no decision before what was accepted of it is due to be read
   *  even though more is still pending. Declared once, on the row that owns
   *  the trigger; the jobs that share the episode read it from there. A
   *  ceiling the author owns, not a tuning knob. */
  episode?: { idleMs: number }
  /** U12's bar (A74-6): how many DIFFERENT places in the manuscript a rule
   *  must rest on. Declared on the row that owns the gate, so the number has
   *  one address and the gate's record names it. */
  minIndependentExamples?: number
  /** THE FLOOR of the `answer-whole` gate (A75-1): the share of the
   *  words of the MANUSCRIPT SCENE the answer re-imagines below which an
   *  answer is not a whole one. Always the scene, on the rewrite row too, and
   *  never the route being rewritten: a route is a way through the whole
   *  scene, and measuring a rewrite against its parent would let a
   *  fragment's rewrite pass as whole. Declared on the row, so the number has one
   *  address and the gate's record names it. Absent: the gate does not
   *  measure length, and its record says so.
   *
   *  A STAGED ROW'S FLOOR IS THE ROW'S (A75-2): the write stage lists the
   *  gate, and the launch carries this number from the row, as it carries
   *  the envelope. At selection scope the subject is the PASSAGE the pass
   *  rebuilds, which the pass hands the gate (`ProseGateCtx.subjectPassage`);
   *  the whole scene would refuse every honest passage. */
  minShareOfSubject?: number
  /** WHY THIS ROW DOES NOT LIST `answer-whole` (A75-2): one line, on every
   *  row whose answer is prose (`WRITES_PROSE`) and whose gates do not name
   *  the gate. A row either measures its answer against a subject or says
   *  why it has none to measure against — never neither, and never both
   *  (test/answer-whole-rows.test.ts). Left out of the job fingerprint, as
   *  the fixture list is: saying why a gate is absent changes no job. */
  noAnswerWhole?: string
}

/** THE ANSWER SHAPES THAT ARE PROSE (A75-2): a route, a scene file, a
 *  rebuilt or revised body, and the menu's drop-in wordings. Every row that
 *  answers in one of these either lists `answer-whole` with a floor or
 *  carries `noAnswerWhole`. A reading, a plan, proposals and rules write no
 *  prose and are not asked. */
export const WRITES_PROSE: readonly AnswerShape[] = ['coverage-tail', 'scene-file', 'body-and-briefing', 'body-only', 'options']

export interface SealedRow extends RowBase { pattern: 'sealed'; envelope: SealedEnvelope }
/** ONE LAUNCH INSIDE A STAGED JOB (A69-3). A stage is a sealed pass in its
 *  own right — its own rules, slice, gates, answer shape and budget — and it
 *  carries no toolbelt and no session, by type, exactly as a sealed row does.
 *  Splitting a job into stages must not be a way to smuggle one in.
 *
 *  `when` says whether the stage always runs, or only when the line the
 *  author said names an effect to translate (§4, the craft plan). A stage
 *  that does not run is recorded on the receipt as not having run, never
 *  omitted — a stage nobody can see is a stage nobody can audit. */
export interface Stage {
  id: string
  when: 'always' | 'line-names-effect'
  rules: string
  slice: SliceSpec
  gates: readonly GateId[]
  answer: AnswerShape
  budget: { outputTokens: number; wallClockMs: number; inputTokens?: number }
  /** the recorded briefs under `fixtures/<stage key>/`. A stage's list is its
   *  own: the reading that decides a destination has nothing a validator can
   *  refuse, and requiring the row's list of every stage would drop a rowed
   *  job back to `designed` the day it grows a second stage (A69-3). */
  fixtures: readonly string[]
}

export interface StagedRow extends RowBase { pattern: 'staged'; envelope: SealedEnvelope; stages: readonly Stage[] }

/** WHAT THE SEAM IS HANDED FOR ONE STAGE OF A STAGED JOB (A81-2): the stage's
 *  own gates, answer and budget, under the ROW's cell, withholding, envelope
 *  and floor. One function, because four passes used to spread these by hand
 *  and two of them left the floor out — which a row gaining `answer-whole` on
 *  that stage would have met as a gate with nothing to measure against
 *  (A75-2). The stage's id is the cell's stage, so `rowKey` names its
 *  fixture directory. */
export const stageLaunch = (row: StagedRow, stage: Stage): LaunchSpec & Stage => ({
  ...stage,
  job: row.job, scope: row.scope, mode: row.mode, depth: row.depth, stage: stage.id,
  withholding: row.withholding, withheld: row.withheld, envelope: row.envelope,
  minShareOfSubject: row.minShareOfSubject,
})

/** Does this stage run for this request? The one place `when` is read.
 *
 *  Whether a line "names an effect" is not something code can tell — that is
 *  the reading's own judgement, and the reading is what we have. So a line
 *  said now is reason enough to run it, and the author's *drop* is the way
 *  out. No line, no stage. */
export function stageRuns(stage: Stage, said: string): boolean {
  switch (stage.when) {
    case 'always': return true
    case 'line-names-effect': return said.trim().length > 0
  }
}
export interface FanOutRow extends RowBase { pattern: 'fan-out'; envelope: SealedEnvelope; stages: readonly string[]; reduce: string }
export interface InvestigationRow extends RowBase {
  pattern: 'investigation'
  envelope: InvestigationEnvelope
  /** one pool for the whole tree */
  pool: { steps: number; subagents: number; subagentDepth: 1; wallClockMs: number }
}
export interface RecordAgentRow extends RowBase { pattern: 'record-agent'; envelope: RecordAgentEnvelope; claim: string }

/** What the runner needs of whatever it is launching: a sealed row, or one
 *  stage of a staged job (A69-3). Both are sealed launches — a gate list, an
 *  answer shape, a budget — and both run inside the JOB's envelope, which is
 *  the row's and never a stage's: splitting a job into stages must not be a
 *  way for one of them to run under different rules.
 *
 *  It carries the CELL because a stage has its own fixture directory: the
 *  write stage of a draft and the reading that precedes it are two different
 *  briefs, and `rowKey` is what tells them apart. */
export type LaunchSpec = Cell & Pick<SealedRow, 'withholding' | 'withheld' | 'gates' | 'answer' | 'budget' | 'envelope' | 'minShareOfSubject'>

export type Row = SealedRow | StagedRow | FanOutRow | InvestigationRow | RecordAgentRow

/** The row's key: job.scope.mode, with the DEPTH when it is not the standard
 *  one, and the stage when it has one. Names its fixture directory and its
 *  line on the receipt.
 *
 *  Depth is in the key because two registers of one job are two rows (§3),
 *  and two rows must not share a fixture directory: U2's minimal revision and
 *  U3's clean pass are both `revise · scene · one-shot` and both have a
 *  `write` stage, so without it one row's recorded answers would silently
 *  stand in for the other's (A69-9). `standard` is left out so every key
 *  written before this stays exactly what it was — the same rule
 *  `resolveRequest` already uses when it names a cell for the author. */
export type RowKey = string
export const rowKey = (r: Cell): RowKey =>
  `${r.job}.${r.scope}.${r.mode}${r.depth && r.depth !== 'standard' ? `.${r.depth}` : ''}${r.stage ? `.${r.stage}` : ''}`

// ---- the writing slice (A69-2) --------------------------------------------

/** THE SLICE EVERY PROSE-WRITING ROW DECLARES (§4, "What a writing slice
 *  holds"). The layers are §4's eleven and the lock notice, twelve;
 *  `slice.ts` assembles them.
 *
 *  THE FLOOR is §4's floor sentence, exactly: the contract, the withholds,
 *  the LOCK NOTICE, the handoff, and the canon the scene's bindings name. The
 *  lock notice is the twelfth layer — §4's table lists eleven and its floor
 *  sentence names this one — and it is floor because a pass told nothing
 *  about locked prose rewrites it, and the gate then refuses an answer that
 *  cost the author a pass to produce. A pass that cannot be told what the
 *  scene must do, what it must not reveal, where the story stands and what is
 *  true is not a pass that should run — it is a question for the author.
 *
 *  THE DROP ORDER is least costly first. Position goes before what is live
 *  here, which goes before voice, which goes before the author's own notes —
 *  and the style contract goes last, because a draft in the wrong voice is
 *  work the author has to undo rather than work they have to finish. Every
 *  layer that is not floor is listed here: a layer in neither list would
 *  behave as floor without ever having been declared one, and the assembler
 *  refuses a row shaped that way. */
/** Q3, decided by the author 2026-09-24 for the writing rows: a CEILING on
 *  the assembled brief, not an operating point. Provisional, to be reset from
 *  the first ten receipts. */
export const WRITING_INPUT_TOKENS = 40_000

/** What a draft's answer is checked against.
 *
 *  No overlap and no coverage tail: there is no current wording to measure
 *  against and no route to cover. No locks and no withheld literals either,
 *  and for the same reason — the scene does not exist yet, so there is
 *  nothing in it the author has settled and no contract it could have
 *  withheld from. Those gates arrive with U3, which rewrites a scene that is
 *  already there. What is left is the story's own validator and the two
 *  countable style rules. */
export const DRAFT_GATES: readonly GateId[] = ['validator', 'leaned-on', 'and-chain', 'sentence-length']

export const WRITING_SLICE: SliceSpec = {
  id: 'writing',
  layers: [
    'intent', 'contract', 'handoff', 'dramatic-condition', 'canon',
    'position', 'voice', 'research', 'notes', 'promoted-rules', 'withholds', 'locks',
  ],
  dropOrder: ['research', 'position', 'intent', 'dramatic-condition', 'voice', 'notes', 'promoted-rules'],
  floor: ['contract', 'withholds', 'handoff', 'canon', 'locks'],
  // A season. Provisional, like every other figure on this row: reset from
  // the first ten receipts. The example's keeper has a year-precision
  // snapshot against a November scene, so the first draft on the example
  // leans on an aged fact and says so.
  freshness: 90,
}

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
const ROUTE_GATES: readonly GateId[] = ['leak', 'locks', 'lock-order', 'withhold-literals', 'and-chain', 'sentence-length', 'overlap', 'coverage-tail', 'answer-whole']

/** A ROUTE IS A WHOLE SCENE (A75-1): one that came back at under three
 *  tenths of the words of the scene it re-imagines is a fragment, whatever
 *  else its gates say. A deliberately spare route still clears it — a late
 *  entry at half the length holds. */
export const ROUTE_MIN_SHARE_OF_SUBJECT = 0.3

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
  minShareOfSubject: ROUTE_MIN_SHARE_OF_SUBJECT,
  // The recorded answers this row is testable against. The leak scenario
  // has none on purpose: its gate refuses the brief before the send, so
  // there is never an answer to record (A67-7).
  fixtures: ['lands', 'overlap', 'coverage-drop', 'truncated'],
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
  // Measured against the manuscript scene, not the route this rewrites — on
  // purpose: a fragment's rewrite must not pass as whole by matching it.
  minShareOfSubject: ROUTE_MIN_SHARE_OF_SUBJECT,
  fixtures: ['lands', 'overlap', 'coverage-drop'],
}

// ---- U1 · Draft · scene · one-shot ----------------------------------------

/** The drafting pass's rules — the first slot of its brief. They live on the
 *  row because the row is the job's ONE definition (§11's drift rule): the
 *  text, the slice, the gates and the budget move together or the pass has
 *  two addresses. */
export const DRAFT_RULES = `You are arc's DRAFTING PASS. The author asked you to draft ONE scene of
their novel, and you are writing it from their record.

YOU HAVE NO TOOLS. Nothing is fetched, nothing is read, nothing is written by
you. Everything you are allowed to know is in this brief, under the headings
below, and what you answer with is the whole of what arc receives.

THE SCENE FILE (conventions §10). Your answer opens with the file, and the
file opens with its frontmatter fence:
- \`scene\` (the id you are given), \`chapter\`, \`status: proposed\`, \`pov\` (the
  chapter's POV where one exists), \`events\` (the chapter events this scene
  actually depicts), \`facts\` (the entity and relationship ids the prose rests
  on), and a \`contract\` block stating the intent you drafted to — \`purpose\`,
  \`must_establish\`, \`must_withhold\` at minimum.
- EVERY ID MUST RESOLVE. The record below lists the ids available to you, each
  with the reason it is here. Do not invent one. An id that does not resolve
  fails the story's own validator, the draft is refused, and nothing is
  written.
- A fact marked \`proposed\` or \`material\` may be REFERENCED and may not be
  rested on: the author has not ratified it. The record below tags every
  item; the weight rule at its head is binding.

THE PROSE (binding rules, in priority order):
1. The style contract below is law. Run its pre-draft checklist before
   writing; a scene that breaks the POV or tense contract, the no-comment law,
   or the sensory rules is a failed draft even where the plot is right.
2. The payoff fence: anything under "do not reveal" is known to the record and
   NOT to this scene. Nothing may foreshadow it knowingly.
3. POV knowledge: the scene knows only what its POV could know at this moment.
   Events after it must not leak. People not living then appear only as
   memory.
4. The anachronism boundary: nothing — object, phrase, attitude — that
   postdates the scene's span.
5. Canon is truth: contradict nothing in the record below. Where it is silent
   you may invent texture — a minor sensory detail, an unnamed passer-by — but
   any invention that deserves a record goes in your briefing's "to verify"
   list, never silently into the prose.
6. Length: a full dramatic scene, typically 700–1200 words, unless the
   author's line says otherwise.

ANSWER IN TWO PARTS, separated by a line that is exactly:
=== BRIEFING ===
Part one: the complete scene file and nothing else — the \`---\` frontmatter
fence, then the prose body. No preamble, no commentary, no code fences.
Part two, the briefing, in the ARGUED register (claims for the author to
judge, never verdicts):
1. What the scene does, and the contract you drafted to.
2. The style checklist, item by item: held, or knowingly bent and why.
3. To verify — inventions and borderline claims a person should confirm.
4. LEANS ON — the entity, event and relationship ids the prose RESTS ON as
   settled, one per line, in a fenced block that opens with exactly
   \`\`\`leans-on and closes with \`\`\`. Only an id tagged \`canon\` belongs
   here, and so does every id in the file's own \`facts\` and \`events\` —
   binding an id IS resting on it. An id tagged \`proposed\` or \`material\`
   may be mentioned in the prose and must be neither bound nor listed: that
   says the scene would fall if the author decided against it, and a gate
   refuses the draft on it. The block is required; a briefing without it is
   refused.
`

/** The craft-plan reading's rules. A cheap sealed pass that settles the
 *  destination before the expensive one runs — the same shape as U2's
 *  conflict reading. */
export const CRAFT_PLAN_RULES = `You are arc's CRAFT PLAN pass. The author said one line about the scene they
are about to have drafted. Your whole job is to turn what they want the
READER to feel into CRAFT the writing pass can act on.

The writing pass will never see their line. It sees your plan. This is
deliberate: a pass told to write "more dread" writes about dread, which is
the one thing prose cannot do — it produces the comment instead of the
experience. A pass told to cut the distance by half, give the reader only
what the ears reach, and withhold the thing in the next room produces dread.

CHOOSE ONLY FROM THESE MOVES. Use the id exactly as written:
${Object.entries(CRAFT_MOVES).map(([id, what]) => `  ${id} — ${what}`).join('\n')}

Choose the FEWEST that carry the line. Two or three is usually right; six is
almost always someone avoiding a decision. A move you cannot say something
specific about is a move you should not have chosen.

Each move gets ONE clause saying what to do. It must be an INSTRUCTION A
WRITER COULD FOLLOW without knowing anything you were not told: you are shown
the author's line and, when the scene already exists, its contract. You are
NOT shown the story, the people in it or the prose, so do not write as though
you were — a clause that names a character or a place is a clause you invented.
"cut the distance: stay in what the body registers" is a clause;
"increase the tension" is not, and neither is "put her hand on the rail".

NEVER NAME THE EFFECT. The words the author used, and any synonym for the
feeling they asked for, must not appear in your answer.

ANSWER WITH ONE FENCED JSON BLOCK AND NOTHING ELSE:
\`\`\`json
{"moves": [{"move": "<id from the list above>", "how": "<one clause>"}]}
\`\`\``

/** What the craft plan is shown. The contract WITH its reader-effect fields —
 *  translating them is this stage's only purpose — and the line said now.
 *  Nothing else: it is a reading, not a writing, and every layer it does not
 *  need is a layer it could quote back. */
export const CRAFT_PLAN_SLICE: SliceSpec = {
  id: 'craft-plan',
  layers: ['contract', 'intent'],
  dropOrder: [],
  floor: ['contract', 'intent'],
}

/** U1 · Draft · scene · one-shot. Staged, because §4 puts the craft-plan
 *  stage in front of every row that writes prose; it arrives with the stage
 *  that translates a line into craft (A69-4) and today carries the write
 *  stage alone.
 *
 *  NOT withholding: a draft is written from the record, and there is no
 *  current prose to keep from it — the scene does not exist yet. */
export const ROW_DRAFT_SCENE: StagedRow = {
  job: 'draft', scope: 'scene', mode: 'one-shot', depth: 'standard', stage: null,
  pattern: 'staged',
  withholding: false,
  slice: WRITING_SLICE,
  envelope: ROUTE_ENVELOPE,
  gates: DRAFT_GATES,
  answer: 'scene-file',
  budget: { outputTokens: ROUTE_OUTPUT_TOKENS, wallClockMs: ROUTE_WALL_CLOCK_MS, inputTokens: WRITING_INPUT_TOKENS },
  rules: DRAFT_RULES,
  noAnswerWhole: 'a new scene has no prose before it to measure a share of, and its answer carries no coverage claims to check against its paragraphs',
  // A STAGED ROW'S FIXTURES ARE ITS STAGES'. Each stage is a launch with its
  // own brief and its own recorded answers, and `fixturesRecorded` reads them
  // there — a second list here would be a copy nobody consults and everybody
  // trusts.
  fixtures: [],
  stages: [
    {
      // Runs only when the line the author said names an effect. When it
      // names none there is nothing to translate, no token is spent, and the
      // receipt records the stage as having had nothing to do.
      id: 'craft-plan',
      when: 'line-names-effect',
      rules: CRAFT_PLAN_RULES,
      slice: CRAFT_PLAN_SLICE,
      gates: ['plan-vocabulary'],
      answer: 'craft-plan',
      // A reading, not a writing: it costs a fraction of a scene.
      budget: { outputTokens: 1_000, wallClockMs: 5 * 60 * 1000, inputTokens: 4_000 },
      fixtures: ['plan-dread'],
    },
    {
      id: 'write',
      when: 'always',
      rules: DRAFT_RULES,
      slice: WRITING_SLICE,
      gates: DRAFT_GATES,
      answer: 'scene-file',
      budget: { outputTokens: ROUTE_OUTPUT_TOKENS, wallClockMs: ROUTE_WALL_CLOCK_MS, inputTokens: WRITING_INPUT_TOKENS },
      fixtures: ['lands', 'lands-from-plan', 'validator-refused', 'leans-on-proposed'],
    },
  ],
}

/** THE CLEAN PASS'S RULES (U3; A69-8). Moved here from redraft.ts, where the
 *  pass composed its own brief and called the seam bare, and rewritten for
 *  the sealed pass it now describes: no tools, the brief is everything, the
 *  current prose is one attempt, the answer is two parts and the briefing
 *  owes its leans-on block. The row is the job's one definition. */
export const REDRAFT_RULES = `You are arc's CLEAN PASS. The author asked for a rebuild of prose of their
own novel — a whole scene, or one passage of it. What you are shown under
THE SCENE AS IT STANDS or THE PASSAGE TO REDRAFT is ONE ATTEMPT, NOT A
FLOOR: order, images, paragraph boundaries and sentence architecture are all
yours to rebuild. Keep what already earns its place; a redraft that preserves
a weak structure out of politeness has failed, and so has one that discards a
strong line to prove it was here.

YOU HAVE NO TOOLS. Nothing is fetched, nothing is read, nothing is written by
you. Everything you are allowed to know is in this brief, under the headings
below, and what you answer with is the whole of what arc receives.

WHAT MUST SURVIVE, exactly:
1. The scene's meaning. Every event and fact the scene binds still happens
   here; character state at this moment in the story is unchanged.
2. The scene contract — purpose, must_establish, must_withhold, motifs,
   constraints. Withholding is deliberate: do not "fix" it.
3. The style contract. It is the author's voice and it is law; run its
   pre-draft checklist before answering.
4. POV, tense, and the anachronism boundary.
5. Locked paragraphs, VERBATIM, word for word and in their order, wherever
   the brief marks them. A locked paragraph is the author's settled prose;
   an answer that touches one is refused whole.
6. Canon is truth. The record below tags every item; a fact tagged
   \`proposed\` or \`material\` may be mentioned and may not be rested on.
   Never invent a fact the record would have to carry — a new person, date
   or place is a proposal for the author, named in your briefing, never made
   in the prose.
7. A passage's seams. When you are handed a passage, answer with the passage
   alone — never the paragraphs above or below it, which you may not change.

ANSWER IN TWO PARTS, separated by a line that is exactly:
=== BRIEFING ===
Part one: the rebuilt prose alone — no frontmatter, no commentary, no
fences. Part two, the briefing, in the ARGUED register (claims for the author
to judge, never verdicts):
1. The style checklist item by item: held, or knowingly bent and why.
2. Whether each must_establish lands and where; motifs carried; POV and
   tense held; anything withheld that risks leaking by implication.
3. To verify — any fact you needed that canon does not hold.
4. LEANS ON — the entity, event and relationship ids the prose RESTS ON as
   settled, one per line, in a fenced block that opens with exactly
   \`\`\`leans-on and closes with \`\`\`. Only an id tagged \`canon\` belongs
   here; an id tagged \`proposed\` or \`material\` may be mentioned in the
   prose and must not be listed. The block is required; a briefing without
   it is refused.
`

/** What a clean pass's answer is checked against: the locks, because the
 *  scene exists and the author may have settled parts of it; the story's
 *  own validator over the rebuilt file; the contract's quoted withholds; the
 *  ids the prose rests on; and the two countable style rules. No overlap
 *  gate — a rebuild is allowed to keep every line that earns its place — and
 *  no coverage tail, because there is no route. */
export const CLEAN_PASS_GATES: readonly GateId[] = [
  'locks', 'lock-order', 'validator', 'withhold-literals', 'leaned-on', 'and-chain', 'sentence-length',
  // A75-2: a rebuild is the whole of what it rebuilds. Its subject is the
  // scene, or at selection scope the passage, as the pass was handed it.
  // Only the floor measures here: the answer carries no coverage claims, so
  // the paragraph proof has nothing to read and holds.
  'answer-whole',
]

/** U3's two rows (A69-8): the clean pass over a scene, and over a selection
 *  — a paragraph range whose surroundings are preserved byte for byte by
 *  construction. Staged like the draft: the craft-plan reading first when
 *  the author said a line, then the write. NOT withholding: the pass is
 *  handed the prose it is rebuilding, as one attempt. */
const cleanPassRow = (scope: 'scene' | 'selection'): StagedRow => ({
  job: 'revise', scope, mode: 'one-shot', depth: 'standard', stage: null,
  pattern: 'staged',
  withholding: false,
  slice: WRITING_SLICE,
  envelope: ROUTE_ENVELOPE,
  gates: CLEAN_PASS_GATES,
  answer: 'body-and-briefing',
  budget: { outputTokens: ROUTE_OUTPUT_TOKENS, wallClockMs: ROUTE_WALL_CLOCK_MS, inputTokens: WRITING_INPUT_TOKENS },
  rules: REDRAFT_RULES,
  // The author's bar (2026-11-14): the route's, wherever a row has a subject.
  minShareOfSubject: ROUTE_MIN_SHARE_OF_SUBJECT,
  fixtures: [],
  stages: [
    {
      id: 'craft-plan',
      when: 'line-names-effect',
      rules: CRAFT_PLAN_RULES,
      slice: CRAFT_PLAN_SLICE,
      gates: ['plan-vocabulary'],
      answer: 'craft-plan',
      budget: { outputTokens: 1_000, wallClockMs: 5 * 60 * 1000, inputTokens: 4_000 },
      fixtures: ['plan-dread'],
    },
    {
      id: 'write',
      when: 'always',
      rules: REDRAFT_RULES,
      slice: WRITING_SLICE,
      gates: CLEAN_PASS_GATES,
      answer: 'body-and-briefing',
      budget: { outputTokens: ROUTE_OUTPUT_TOKENS, wallClockMs: ROUTE_WALL_CLOCK_MS, inputTokens: WRITING_INPUT_TOKENS },
      // The selection row's lock-touched case is refused at intake — a lock
      // inside the range the author asked to rebuild — so it sends no brief
      // and records no answer, as the leak scenario does (A69-8).
      // `truncated` (A75-2): a rebuild that came back a fifth of the scene.
      fixtures: scope === 'scene' ? ['lands', 'lock-touched', 'truncated'] : ['lands'],
    },
  ],
})
export const ROW_REVISE_SCENE: StagedRow = cleanPassRow('scene')
export const ROW_REVISE_SELECTION: StagedRow = cleanPassRow('selection')

/** THE NOTE CONFLICT READING'S RULES (U2; A69-9). Moved here from revise.ts,
 *  where the pass composed its own brief and called the seam bare. It is the
 *  same shape as the craft plan and U15's contract stage (§4): a cheap
 *  reading that settles the destination before the expensive pass. */
export const CONFLICT_RULES = `You are arc's NOTE CONFLICT PASS. The author left these notes on their own
manuscript at different times. Some may pull in opposite directions.

Find only GENUINE tensions: two notes that cannot both be satisfied, or that
ask for opposite movement on the same thing. "Make him seem more suspicious
here" and "the reveal feels too obvious" are a real tension. Two notes about
different characters are not, however near each other they sit.

You are NOT resolving anything. You are telling the author what they will have
to decide. Do not suggest which note should win.

Answer with a JSON array and nothing else:
  [{"between": ["note.001", "note.007"], "tension": "one sentence"}]
An empty array is the common answer and a good one.`

/** THE MINIMAL REVISION'S RULES (U2; A69-9). Moved here from revise.ts and
 *  rewritten for the sealed pass it now describes: no tools, the brief is
 *  everything, and the register is the whole point — the notes are
 *  INSTRUCTIONS here, and prose nobody asked about does not move. */
export const REVISE_RULES = `You are arc's REVISION WORKER. The author left notes on one scene of their
own novel. Revise the prose so the notes are answered.

THE CONTRACT BELOW IS BINDING — this is the author's book and their voice, and
a revision that improves the prose by breaking a stated rule is a failure.

YOU HAVE NO TOOLS. Nothing is fetched, nothing is read, nothing is written by
you. Everything you are allowed to know is in this brief, and what you answer
with is the whole of what arc receives.

CHANGE AS LITTLE AS THE NOTES REQUIRE. You are not rewriting the scene; you
are answering what was asked about it. Prose you were not asked about stays
exactly as it is, to the character. A paragraph no note points at is a
paragraph you return unchanged, word for word.

Locked paragraphs survive VERBATIM, word for word and in their order,
wherever the brief marks them. An answer that touches one is refused whole.

Never invent a fact about the world. The record below tags every item; a fact
tagged \`proposed\` or \`material\` may be mentioned and may not be rested on.
If a note implies something the record would have to carry — a new person, a
date, a place — do NOT write it in. Leave that passage alone; it is a
proposal for the author, not yours to make.

Answer with ONLY the revised scene body. No frontmatter, no commentary, no
fences, no briefing.`

/** What a minimal revision's answer is checked against. The clean pass's
 *  list, less the two the register makes meaningless — there is no briefing,
 *  so nothing owes a leans-on block — plus the one that defines "minimal".
 *
 *  `blast-radius` is BUILT (A72-6, 2026-10-15): the answer's changes are
 *  attributed paragraph by paragraph to the scene the pass was handed and
 *  judged against what the author's notes license. It was declared here
 *  before it was built so every receipt said "minimal" was not yet checked;
 *  now the receipt records the licensed scope and the measured changes. */
export const MINIMAL_REVISION_GATES: readonly GateId[] = [
  'locks', 'lock-order', 'validator', 'withhold-literals', 'blast-radius', 'and-chain', 'sentence-length',
  // A75-2: the CHANGE is minimal, the answer is not — the pass returns the
  // whole scene body, every paragraph no note points at word for word, so a
  // body that came back as only the paragraphs it changed is a fragment.
  // blast-radius would read the missing paragraphs as deletions outside the
  // notes; this says what actually happened, by count.
  'answer-whole',
]

/** U2's row (A69-9): work the author's open notes into one scene, as little
 *  as they require. Staged — the conflict reading FIRST, because two notes
 *  that pull opposite ways are the author's decision and not a model's, then
 *  the craft plan when a line is said, then one write per note cluster.
 *
 *  WHY `depth: 'quick'`, AND WHY THAT IS A QUESTION FOR THE AUTHOR. The
 *  registry is keyed by (job, scope, mode) (§4), and U3's clean pass already
 *  holds `revise · scene · one-shot · standard` (A69-8). U2 is the same job
 *  at the same scope in the same mode — §3's own coverage table lists both
 *  under one line — and the only axis left in the cell is depth, whose
 *  governing sentence is that two registers of one job "must not resolve to
 *  the same row". So the minimal revision is the QUICK pass over a scene and
 *  the rebuild is the STANDARD one, which is also how an author would say
 *  it. What this makes false is §3's aside that only Inspect is plural in
 *  depth; the epic groomed two cards that both claimed this cell, and
 *  nothing in §3 or §4 resolves it. Recorded on A69-9 for the author. */
export const ROW_REVISE_SCENE_STAGED: StagedRow = {
  job: 'revise', scope: 'scene', mode: 'one-shot', depth: 'quick', stage: null,
  pattern: 'staged',
  withholding: false,
  slice: WRITING_SLICE,
  envelope: ROUTE_ENVELOPE,
  gates: MINIMAL_REVISION_GATES,
  answer: 'body-only',
  budget: { outputTokens: ROUTE_OUTPUT_TOKENS, wallClockMs: ROUTE_WALL_CLOCK_MS, inputTokens: WRITING_INPUT_TOKENS },
  rules: REVISE_RULES,
  // Against the scene as the pass was handed it (pending edits included).
  minShareOfSubject: ROUTE_MIN_SHARE_OF_SUBJECT,
  fixtures: [],
  stages: [
    {
      // BEFORE ANY WRITE, ALWAYS. A reading that finds a tension stops the
      // job and hands the decision back; a reading that fails stops it too
      // (P2 fails closed), and never becomes a licence to write blindly.
      id: 'conflict',
      when: 'always',
      rules: CONFLICT_RULES,
      slice: { id: 'conflict', layers: ['notes'], floor: ['notes'], dropOrder: [] },
      gates: [],
      answer: 'conflicts',
      budget: { outputTokens: 1_000, wallClockMs: 5 * 60 * 1000, inputTokens: 8_000 },
      fixtures: ['conflict-none', 'conflict-found'],
    },
    {
      id: 'craft-plan',
      when: 'line-names-effect',
      rules: CRAFT_PLAN_RULES,
      slice: CRAFT_PLAN_SLICE,
      gates: ['plan-vocabulary'],
      answer: 'craft-plan',
      budget: { outputTokens: 1_000, wallClockMs: 5 * 60 * 1000, inputTokens: 4_000 },
      fixtures: ['plan-dread'],
    },
    {
      id: 'write',
      when: 'always',
      rules: REVISE_RULES,
      slice: WRITING_SLICE,
      gates: MINIMAL_REVISION_GATES,
      answer: 'body-only',
      budget: { outputTokens: ROUTE_OUTPUT_TOKENS, wallClockMs: ROUTE_WALL_CLOCK_MS, inputTokens: WRITING_INPUT_TOKENS },
      fixtures: ['lands'],
    },
  ],
}

/** THE WRITER'S MENU (A69-10). Two passes that offer wordings and write
 *  NOTHING: rephrase, which answers the author's own style contract, and
 *  synonyms, which answers their book's period and register. Sealed, not
 *  staged — a craft plan translates an effect into craft for a pass that is
 *  about to write prose, and neither of these is; §4 names the craft plan on
 *  U1-U6 and U15, and the menu is none of them.
 *
 *  Their rules moved here from suggest.ts, where the pass composed its own
 *  brief and called the seam bare. Rewritten for the sealed passes they now
 *  describe: no tools, the brief is everything.
 */
export const REPHRASE_RULES = `You are arc's REPHRASE pass. The author selected a passage of their novel
and wants alternatives — in THEIR voice, not yours.

THE CONTRACT BELOW IS BINDING. Every alternative must obey the author's own
style rules; an alternative that "improves" the line by breaking a rule is
worthless, and arc will drop it before the author ever sees it. Match the
passage's tense and point of view. Keep roughly its length unless the rules
demand tighter.

YOU HAVE NO TOOLS. Nothing is fetched, nothing is read, nothing is written by
you — not even the option the author picks, which is theirs to place. What
you answer with is the whole of what arc receives.

Offer 3 to 5 alternatives, each a complete drop-in replacement for the
selection alone — never the surrounding text. No commentary, no ranking,
no explanation.

Answer with a JSON array of strings and nothing else.`

export const SYNONYM_RULES = `You are arc's SYNONYM pass. The author selected a word or short phrase and
wants alternatives, the way a thesaurus offers them — but one that knows
their book.

YOU HAVE NO TOOLS. Nothing is fetched, nothing is read, nothing is written by
you. What you answer with is the whole of what arc receives.

Offer 3 to 6 alternatives. Each entry is the replacement, then " — ", then
ONE clause of nuance: what shade this choice carries. If a word would break
the story's period or register (the scene context below tells you when and
where the book lives), either omit it or say so in the nuance clause.

The replacement before the " — " must be a drop-in for the selection: same
part of speech, same case.

Answer with a JSON array of strings and nothing else.`

/** What the menu is shown: the author's ratified contract, and nothing else
 *  of the record. The selection, the paragraph it sits in and the scene's
 *  own line are the ASK — what the author pointed at a moment ago — and they
 *  travel in the assignment, where a gesture belongs (A69-8's assignment
 *  does the same with a passage and its seams). Nothing here drops: a menu
 *  with no contract is a generic "improve this" button, which is the one
 *  thing these passes exist not to be. */
const MENU_SLICE: SliceSpec = { id: 'menu', layers: ['promoted-rules'], floor: ['promoted-rules'], dropOrder: [] }

/** WHAT A REPHRASE'S OPTIONS ARE CHECKED AGAINST: that there are between
 *  three and six of them with something in each, and then the two countable
 *  rules the author ratified — run over EACH OPTION, so one that breaks a
 *  rule is DROPPED and counted rather than refusing the whole menu. Five
 *  wordings of which one runs long is four good wordings and a near miss,
 *  and throwing the four away to punish the one helps nobody.
 *
 *  Synonyms carry the shape gate alone: a replacement word plus a clause of
 *  nuance is not a sentence of the book, and measuring it against a sentence
 *  rule would drop every entry the moment a contract states one. */
const REPHRASE_GATES: readonly GateId[] = ['options-shape', 'and-chain', 'sentence-length']
const SYNONYM_GATES: readonly GateId[] = ['options-shape']

/** Three to six wordings, cheap and fast: the author is waiting with a
 *  selection highlighted, and nothing is written whatever comes back. */
const MENU_BUDGET = { outputTokens: 1_500, wallClockMs: 5 * 60 * 1000, inputTokens: 16_000 }

/** U-the-menu's two rows (A69-10). Sealed, not withholding: the pass is
 *  handed the very words it is rephrasing, so there is nothing to withhold
 *  and nothing to abbreviate in the contract (A69-2's rule).
 *
 *  WHY `depth: 'quick'` ON REPHRASE, AND WHY THAT IS A QUESTION FOR THE
 *  AUTHOR. `revise · selection · one-shot · standard` is already U3's clean
 *  pass over a passage (A69-8), and rephrase is the same job at the same
 *  scope in the same mode. Depth is the only axis left, and A69-9 met the
 *  same collision between U2 and U3 and answered it the same way: the
 *  lighter register is the QUICK pass and the rebuild is the STANDARD one.
 *  So the three registers of Revise over a passage now read as one ladder —
 *  offer me wordings, work my notes, rebuild it — which is how an author
 *  would rank them. What it leans on is that "quick" means LIGHTER rather
 *  than FASTER; a rephrase is both, but A69-9's minimal revision is only the
 *  first. Recorded on A69-10 for the author, beside A69-9's. Synonyms need
 *  none of this: `explore · selection · one-shot` collides with nothing. */
// ---- U9 · Inspect · scene · the pending diff -------------------------------

/** U9's rules. The reading that already existed as a prompt (`ANALYZE_RULES`,
 *  removed with its bare seam call in A72-10), now answering in a shape arc
 *  can check: findings that cite what they rest on. */
export const INSPECT_RULES = `You are arc's READING PASS. The author has a pending change to ONE scene —
prose they have not yet accepted into their book — and wants to know what it
would do to the story BEFORE they decide.

YOU HAVE NO TOOLS. Nothing is fetched, nothing is read, nothing is written by
you. Everything you may know is in this brief.

YOU WRITE NOTHING AND PROPOSE NOTHING. You do not rewrite the prose, suggest
replacements, or file anything to the record. You produce one reading. The
author may ignore every word of it and accept the change anyway.

THE REGISTER RULE (binding, conventions §11): everything you say is an ARGUED
claim — a reading of prose, offered with its evidence, for a human to judge.
Never state a claim with the confidence of a proven fact. Where you are
unsure, say so plainly rather than hedging into vagueness. If the prose is
clean on a dimension, say nothing about it: do not manufacture findings.

EVERY CLAIM CITES, OR IT IS DROPPED. Arc resolves your citations against what
this brief carried. A claim whose citations arc cannot place is dropped from
the reading and the author is told how many were dropped. You may cite:
- an id from the record below, exactly as it is written there (\`char.ines\`,
  \`event.the-wreck\`, \`place.whitcombe-light\`);
- a paragraph of the pending scene, as \`¶3\` — counting the blank-line
  separated paragraphs of the scene as this change proposes it.

ANSWER WITH ONE FENCED JSON ARRAY AND NOTHING ELSE. Each element:
{"section": "...", "claim": "one or two sentences", "cites": ["¶3", "char.ines"]}

\`section\` is one of, in this order:
- "what this changed" — the canon this prose would propose if accepted: facts
  established, state changes, relationship shifts, events depicted. Say what
  is STATED on the page rather than what is merely implied.
- "contract" — each must_establish the scene's contract names: met, partly
  met, or not met, citing the line that does it. Each must_withhold: honored,
  or leaked, citing the leak.
- "conflicts" — anything in the prose that contradicts the record below:
  dates, locations, who was present, what a character could know at that
  moment. Cite both sides: the paragraph and the record id.
- "to verify" — period or historical assertions a human should check, and
  inventions the prose introduces that the record does not know about.
- "style" — how the prose holds against the author's own style contract
  below, item by item. Their contract, not generic craft advice.

An empty array is a real answer and a good one: it says this change does
nothing the author needs to know about before deciding.`

/** U9's slice: the record a reading is judged against, and nothing it could
 *  write from. The pending diff itself is the subject and comes with the ask,
 *  not from the assembler. */
export const INSPECT_SLICE: SliceSpec = {
  id: 'inspect',
  layers: ['contract', 'canon', 'promoted-rules', 'locks'],
  dropOrder: ['locks', 'promoted-rules'],
  floor: ['contract', 'canon'],
}

/** U9 · Inspect · scene · one-shot (A72-10). The ceilings are A69's, declared
 *  on the row: a reading is one pass over one scene and the record behind it.
 *  It is NOT withholding — the pending prose is its subject, and a leak gate
 *  over the thing you are asked to read would refuse every honest brief. */
export const ROW_INSPECT_SCENE: SealedRow = {
  job: 'inspect', scope: 'scene', mode: 'one-shot', depth: 'standard', stage: null,
  pattern: 'sealed',
  withholding: false,
  slice: INSPECT_SLICE,
  envelope: ROUTE_ENVELOPE,
  gates: ['citations'],
  answer: 'reading',
  budget: { outputTokens: 12_000, wallClockMs: 20 * 60 * 1000, inputTokens: 40_000 },
  rules: INSPECT_RULES,
  fixtures: ['lands', 'drops'],
}

// ---- U7 · Update record · scene · triggered (A74-1) -------------------------

/** U7's rules: what the record should learn from prose the author has
 *  accepted. It replaces CAPTURE_RULES, which filed records itself through a
 *  write tool; this pass has no tools and files nothing — it answers with
 *  proposals as data and code does the rest. */
export const UPDATE_RECORD_RULES = `You are arc's RECORD READER. The author has ACCEPTED a change to ONE scene of
their novel into the book. You read what the accepted change establishes and
say what the record should learn from it. Nothing you say binds: the author
decides, later, on each thing you propose.

YOU HAVE NO TOOLS. You write no file, mint no id, and invent nothing the
text does not state or strongly imply. Everything you may know is in this
brief.

THE RECORD you are given is the scene's canon bindings and a name index of
every person, place, faction and object the record already holds, each with
its id and names. A thing in that index is KNOWN: never propose it as new.

WHAT TO PROPOSE, only from the accepted change (the paragraphs marked
changed, new or removed — the unchanged ones are context, never evidence):
- a NEW person, place, faction or object the change introduces by name;
- a RETRACTION: a fact in the record whose only support the change removed.
  A retraction names the record id and what would go. It removes nothing.
- a CHANGE to what the record holds, as a new record beside it: a
  relationship that begins or shifts between two things the record holds, or
  an event the change adds among things it holds (an object changing hands is
  one). The record you are given stays exactly as it is, and the author
  decides on the new one later. A fact that would only alter a field of a
  held record (a want, a location, a condition) has no record of its own:
  leave it out.

SUPPRESSION (the binding rule): the scene contract's must_withhold and the
narrative notes of its events are deliberate silences. Never propose a name,
place or fact they withhold, and never a thing the prose leaves deliberately
unnamed. When unsure whether something deserves a record, leave it out: a
wrong proposal costs the author's trust, an omission costs nothing.

CLASS each proposal:
- "stated"    the page says it outright;
- "implied"   the page strongly implies it without saying it;
- "retracted" the change removed the only support for a fact in the record.

EVERY PROPOSAL CITES. Cite the paragraphs of the accepted change it rests
on, exactly as the brief marks them: \`¶3\` for a paragraph the book now
holds, \`-¶3\` for one the change removed. A proposal citing nothing arc can
place is dropped. Never quote the prose: arc renders the sentence itself.

If a proposal sits against something the record says, name the record id in
"conflicts_with". It is your judgement, offered for the author to weigh.

ANSWER WITH ONE FENCED JSON ARRAY AND NOTHING ELSE. Each element:
{"class": "stated", "subject": "new", "type": "place", "field": "name",
 "value": "the name as the prose gives it", "evidence": ["¶3"],
 "kind": "landmark", "note": "one sentence: who or what it is", "conflicts_with": "place.x"}
- subject: an id the record holds, or "new". A new subject has field "name".
- type: character, place, faction or object for a new subject. (A retraction
  uses the type of the record it names, field "name" and the name as value.)
  For a change to what the record holds: "relationship" or "event".
- a relationship: subject and value are two ids the record holds, field is
  the kind (family, owner-pet, companion-animal, guardian, mentor, friend,
  member-of, controls, employs, ally, enemy, rival or successor-of). It may
  also carry "when", only when the page states it.
  {"class": "stated", "subject": "char.ines", "type": "relationship",
   "field": "ally", "value": "char.wren", "evidence": ["¶4"]}
- an event: subject is an id that takes part, field is "event", value is a
  short title. Optional: "with" (other ids that take part), "where" (a place
  id), "when" (a date such as 1910-11-02, only when the page states it, and
  only inside the scene's own dates; arc dates the event by the scene
  otherwise). For an object that
  changes hands, subject is the object and "transfer" names who receives it
  and, only when the page says so, who gave it up.
  {"class": "stated", "subject": "obj.x", "type": "event", "field": "event",
   "value": "The photograph passes to Elena", "evidence": ["¶2"],
   "transfer": {"to": "char.elena", "from": "char.carlos"}}
- kind: required for a NEW place (country, region, city, district, street,
  building, landmark or waterfront), a NEW faction (faction, organization,
  government, movement, pack or family) and a NEW character (their species).
- note: one sentence saying who or what it is, from the text alone.
An empty array is a real answer and a good one: the change taught the record
nothing.`

/** U7's slice: the scene's bindings and what lies around them, the contract
 *  and its withholds (the suppression rule reads them), and the lock notice.
 *  The accepted diff is the subject and comes with the ask. THE WITHHOLDS
 *  ARE FLOOR beside the canon: a pass that is not told what the scene keeps
 *  silent is the pass most likely to break the silence. */
export const RECORD_SLICE: SliceSpec = {
  id: 'record',
  layers: ['contract', 'canon', 'withholds', 'locks'],
  dropOrder: ['locks', 'contract'],
  // The narrative notes of what the scene binds are appended to the slice by
  // the pass (update-record.ts `narrativeNotes`) beside the name index: they
  // are never dropped, and they are not an assembler layer.
  floor: ['canon', 'withholds'],
}

/** U7 · Update record · scene · triggered (A74-1). Not withholding: its
 *  subject IS the accepted prose. Four gates carry the card — validator,
 *  evidence-resolves, duplicate, contradiction — and `withhold-literals`
 *  runs FIRST, so a contract's quoted silence is proven kept before anything
 *  is judged, let alone written under .arc/validate/. `contradiction` has no threshold, so it has no fixture of its
 *  own: the rest ('lands', 'drops', 'duplicate') are one that lands and one
 *  per gate that drops or refuses. */
export const ROW_UPDATE_RECORD_SCENE: SealedRow = {
  job: 'update-record', scope: 'scene', mode: 'triggered', depth: 'standard', stage: null,
  pattern: 'sealed',
  withholding: false,
  slice: RECORD_SLICE,
  envelope: ROUTE_ENVELOPE,
  gates: ['withhold-literals', 'validator', 'evidence-resolves', 'duplicate', 'contradiction'],
  answer: 'proposals',
  budget: { outputTokens: 12_000, wallClockMs: 20 * 60 * 1000, inputTokens: 40_000 },
  rules: UPDATE_RECORD_RULES,
  fixtures: ['lands', 'drops', 'duplicate', 'shift', 'hands', 'scalar'],
  // the number epic D1 asks the author to confirm: ten minutes with no decision
  episode: { idleMs: 10 * 60 * 1000 },
}

export const LEARN_RULES = `You are arc's STYLE LEARNING pass. The author accepted prose, editing on
the way in. Below are numbered EDIT pairs of two kinds, labelled:

- ARC WROTE / AUTHOR KEPT — arc drafted the paragraph; the author reworked
  it. The edit says how arc should have written it.
- AUTHOR HAD / REVISED TO — the author's own accepted prose, rewritten by
  their own hand. Nobody corrected anybody: this is the author's preference
  showing directly, the strongest voice signal in this table.
- THE BOOK HAD / IT MOVED TO — two successive ACCEPTED states of the
  manuscript. The author ratified the movement, but either side may have been
  machine-drafted on their behalf, so this is the weakest evidence here:
  weight it below a direct edit, and never below-the-line alone.
- ARC WROTE / AUTHOR REFUSED, KEEPING — arc offered this and the author said
  no; the right-hand side is what stands instead. A refusal is only evidence
  about FORM when the two sides differ in how they are written. Many refusals
  turn on fact, continuity, or what a character would do — those say nothing
  about the author's sentences, and you must ignore them here rather than
  reach for a style rule to explain them.
- AUTHOR NOTED / AS NOTED / IT BECAME — the author wrote a note ON the
  passage, in their own words, and later resolved it with the passage
  changed. The only pair here where the requirement is STATED rather than
  inferred — but the note may be about fact or continuity rather than form,
  and the after-side may have been machine-drafted on their behalf before
  they accepted it. Treat the note's words as the author's intent, judge
  FORM only from what actually changed, and apply the same discipline as
  everywhere else: ignore the pair entirely when the change is not about
  how the sentences are written.

An empty right-hand side means the paragraph was cut entirely.

A pair may carry a PLAN line: the craft the author asked for when the passage
was drafted. A plan the author keeps asking for is evidence of how they want
the prose to behave — weigh it with the edits, and never cite a plan alone.

Your job is to name the FORM rules those edits imply — how this author's
sentences behave. Diction, rhythm, sentence length, punctuation, register,
what they refuse to spell out. NEVER a rule about fact, plot, character, or
canon: those belong to the story record, not the style contract.

DISCIPLINE:
- Propose a rule only when the same pattern shows in TWO OR MORE INDEPENDENT
  edits — different paragraphs, and better still different scenes. Two passes
  at the same paragraph are one example, not two. One coincidence is never a
  rule, however unmistakable it looks.
- Never propose a rule the contract below already states, in any wording.
- Never propose a rule the author declined (the list below, when there is one),
  in any wording.
- Write each rule the way the contract is written: imperative, one or two
  sentences, addressed to whoever drafts next.
- Do NOT quote the prose. Cite edit NUMBERS only — arc attaches the quotes
  itself, from its own diff.
- If nothing generalizes, answer with an empty array. That is a good answer
  and the common one.

WHICH LAYER a rule belongs to, as your recommendation and nothing more — the
author decides where it is written:
- "story" — how THIS book's sentences behave. Almost everything. A rule drawn
  from one book's prologue is a rule about that book.
- "author" — a habit that would hold in any book this writer wrote. Only for
  a pattern showing across two or more different scenes, and only when it is
  about the writer rather than the material.

Answer with a JSON array and nothing else:
[{"rule": "...", "section": "Sentences" | null, "layer": "story" | "author", "edits": [1, 4]}]`

/** Two different places in the manuscript, or it is not a rule. The author's
 *  instruction, and the reason it is a number here rather than only a line in
 *  the prompt: their edits are evidence, not a licence to generalize from one
 *  example. */
export const MIN_INDEPENDENT_EXAMPLES = 2

/** U12's slice: the record a rule is judged against — the promoted contract
 *  and the rules the author declined. The pending queue is NOT a layer:
 *  docs/style.proposed.md is read by no prompt (rule 3), so the `not-in-contract`
 *  gate holds the queue in code instead. The numbered
 *  edit pairs are the subject and come with the ask, built by code. The
 *  contract is FLOOR: a learner not shown it re-proposes the law. */
export const LEARN_SLICE: SliceSpec = {
  id: 'learn',
  layers: ['promoted-contract', 'declined'],
  dropOrder: ['declined'],
  floor: ['promoted-contract'],
}

/** U12 · Learn · manuscript · triggered (A74-6). What the author's edits say
 *  about the style contract. Not withholding: its subject IS the accepted
 *  prose. Three gates, each a typed record, each dropping a RULE and never
 *  the answer. It shares the review episode with U7 (A74-3), so the interval
 *  is read from U7's row, where it is declared once. */
export const ROW_LEARN_MANUSCRIPT: SealedRow = {
  job: 'learn', scope: 'manuscript', mode: 'triggered', depth: 'standard', stage: null,
  pattern: 'sealed',
  withholding: false,
  slice: LEARN_SLICE,
  envelope: ROUTE_ENVELOPE,
  gates: ['two-examples', 'not-in-contract', 'not-declined'],
  answer: 'rules',
  // the pairs are bounded in code (MAX_PAIRS) and the layers are not
  // assembler-built, so — as ROW_EXPLORE_SCENE does — no input ceiling it
  // could not honour is declared
  budget: { outputTokens: 12_000, wallClockMs: 20 * 60 * 1000 },
  rules: LEARN_RULES,
  fixtures: ['proposes', 'declined'],
  episode: ROW_UPDATE_RECORD_SCENE.episode,
  minIndependentExamples: MIN_INDEPENDENT_EXAMPLES,
}

/** U12's other trigger · Learn · manuscript · one-shot (A74-7): the style
 *  bootstrap — what the prose's own git history says about the contract, for
 *  a book whose loop arrived late. The same slice, rules and gates as the
 *  triggered row; it differs in having no episode (the author asks for it
 *  once, by hand) and in its subject (successive accepted states of the prose).
 *
 *  `withholding: false` is deliberate. PASS_REGISTRY.bootstrap said
 *  `withholding: true`; that older flag meant "tools off", which
 *  ROUTE_ENVELOPE already guarantees. A row's `withholding` means "the slice
 *  holds none of the current prose" — and the bootstrap's subject IS prose
 *  history, so it is false here, as it is on the triggered row. */
export const ROW_LEARN_MANUSCRIPT_FROM_PROSE: SealedRow = {
  job: 'learn', scope: 'manuscript', mode: 'one-shot', depth: 'standard', stage: null,
  pattern: 'sealed',
  withholding: false,
  slice: LEARN_SLICE,
  envelope: ROUTE_ENVELOPE,
  gates: ['two-examples', 'not-in-contract', 'not-declined'],
  answer: 'rules',
  budget: { outputTokens: 12_000, wallClockMs: 20 * 60 * 1000 },
  rules: LEARN_RULES,
  fixtures: ['bootstraps'],
  minIndependentExamples: MIN_INDEPENDENT_EXAMPLES,
}

export const ROW_REPHRASE: SealedRow = {
  job: 'revise', scope: 'selection', mode: 'one-shot', depth: 'quick', stage: null,
  pattern: 'sealed',
  withholding: false,
  slice: MENU_SLICE,
  envelope: ROUTE_ENVELOPE,
  gates: REPHRASE_GATES,
  answer: 'options',
  budget: MENU_BUDGET,
  rules: REPHRASE_RULES,
  noAnswerWhole: 'it offers drop-in wordings of one selection and writes none of them, and a wording shorter than the selection is a tightening, not a fragment',
  fixtures: ['lands'],
}

export const ROW_SYNONYMS: SealedRow = {
  job: 'explore', scope: 'selection', mode: 'one-shot', depth: 'standard', stage: null,
  pattern: 'sealed',
  withholding: false,
  slice: MENU_SLICE,
  envelope: ROUTE_ENVELOPE,
  gates: SYNONYM_GATES,
  answer: 'options',
  budget: MENU_BUDGET,
  rules: SYNONYM_RULES,
  noAnswerWhole: 'it offers single words for one selection and writes none of them, so there is no whole to come back',
  fixtures: ['lands'],
}

// ---- the table ---------------------------------------------------------------

export const ROWS: readonly Row[] = [
  ROW_EXPLORE_SCENE, ROW_EXPLORE_ROUTE, ROW_DRAFT_SCENE,
  // The clean pass first, so a gesture that says nothing about depth gets
  // the standard register rather than a lighter one.
  ROW_REVISE_SCENE, ROW_REVISE_SELECTION, ROW_REVISE_SCENE_STAGED, ROW_REPHRASE,
  ROW_SYNONYMS,
  // The first row that writes nothing at all: a reading of the pending diff
  // (U9, A72-10).
  ROW_INSPECT_SCENE,
  // The first triggered row: what the record should learn from an accept (U7, A74-1).
  ROW_UPDATE_RECORD_SCENE,
  // The second triggered row: what the edits say about the style contract (U12, A74-6).
  ROW_LEARN_MANUSCRIPT,
  // The same job asked for once, by hand, over the prose's history (A74-7).
  ROW_LEARN_MANUSCRIPT_FROM_PROSE,
]

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
/** THE ROW A PROPOSAL NAMES, by the key it recorded (A72-5). A proposal
 *  carries `replay.row` — `rowKey` as it was at the landing — and comparing
 *  its recorded job fingerprint against this row's current one is what tells
 *  "the record moved" from "the pass that wrote this has changed". Undefined
 *  when arc no longer has a row by that key, which is the same fact stated
 *  more strongly. */
export function rowByKey(key: string): Row | undefined {
  return ROWS.find(r => rowKey(r) === key)
    ?? ROWS.find(r => 'stages' in r && (r as StagedRow).stages.some(st => rowKey({ ...r, stage: st.id }) === key))
}

export function jobFingerprint(row: Row): string {
  const withoutFixtures = JSON.stringify(row, (key, value) => (key === 'fixtures' || key === 'noAnswerWhole' ? undefined : value))
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
  // A STAGE IS A LAUNCH, so its fixtures live under its own key: the reading
  // that decides a destination and the writing that goes there are two
  // different briefs, and one directory for both would let a change to either
  // pass unnoticed. A job with one stage is the degenerate case, not an
  // exception (A69-3).
  const launches = row.pattern === 'staged' && row.stages.length
    ? row.stages.map(st => ({ key: rowKey({ ...row, stage: st.id }), names: st.fixtures }))
    : [{ key: rowKey(row), names: row.fixtures }]
  return launches.every(l =>
    l.names.length > 0 && l.names.every(name => recorded.some(f => f.row === l.key && f.name === name)))
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
