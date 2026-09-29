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
}

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
export type LaunchSpec = Cell & Pick<SealedRow, 'withholding' | 'withheld' | 'gates' | 'answer' | 'budget' | 'envelope'>

export type Row = SealedRow | StagedRow | FanOutRow | InvestigationRow | RecordAgentRow

/** The row's key: job.scope.mode, with the stage when it has one. Names
 *  its fixture directory and its line on the receipt. */
export type RowKey = string
export const rowKey = (r: Cell): RowKey => `${r.job}.${r.scope}.${r.mode}${r.stage ? `.${r.stage}` : ''}`

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
      fixtures: scope === 'scene' ? ['lands', 'lock-touched'] : ['lands'],
    },
  ],
})
export const ROW_REVISE_SCENE: StagedRow = cleanPassRow('scene')
export const ROW_REVISE_SELECTION: StagedRow = cleanPassRow('selection')

// ---- the table ---------------------------------------------------------------

export const ROWS: readonly Row[] = [ROW_EXPLORE_SCENE, ROW_EXPLORE_ROUTE, ROW_DRAFT_SCENE, ROW_REVISE_SCENE, ROW_REVISE_SELECTION]

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
