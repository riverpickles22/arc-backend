// A run: what arc is doing right now, and why it did it (work-graph.md §5, §9).
//
// Two records, deliberately separate.
//
//   .arc/runs/<id>/events.jsonl   transient telemetry. Noisy, live, gitignored,
//                                 safe to delete. This is what a UI tails.
//   history/<id>.yaml             the receipt. Written once the author decides
//                                 — accept OR reject, since a rejection is
//                                 exactly as informative — and committed.
//
// The invariant that keeps the receipt from rotting into a second version
// control system: IT HOLDS THE LINK, NEVER THE DIFF. Git holds what changed.
// The receipt holds why, under whose authority, against which revision.
//
// A consequence: receipts are append-only and are never validated against
// current canon. A receipt naming an entity later deleted is still a true
// record of a past run, so history/ must stay outside the validator's reach.
import fs from 'node:fs'
import path from 'node:path'
import { dump as yamlDump, load as yamlLoad } from 'js-yaml'
import type { RunEnding, StreamMessage } from 'arc-canon-graph'
import { STORY } from './config'
import type { Capability } from './capability'
import { fingerprints, sha16, storyRevision } from './records'

export type Source = 'ui' | 'claude-code' | 'cli' | 'external'

/** The immutable root, written the moment a run starts. `story_revision`
 *  answers "what version of the story did this begin against?" in one field —
 *  per-node fingerprints answer the finer question of what actually changed. */
interface RunRoot {
  run_id: string
  source: Source
  /** the run in the author's words — what the briefing and the runs list
   *  show; never the brief */
  raw_author_input: string
  started_at: string
  story_revision: string | null
  /** what the run is about — a scene, a route — when it has one */
  subject?: string
}

type NodeStatus = 'queued' | 'running' | 'completed' | 'stale' | 'needs_author' | 'failed'

export interface WorkNode {
  id: string
  kind: string
  claim: Capability
  /** What the AUTHOR meant, carried down unchanged. Never grows. */
  anchors: string[]
  /** What this node may retrieve. Declared before anything is fetched. */
  selectors: import('./context').Selector[]
  /** What it actually got, each item with the reason it is there. Derived per
   *  node and NEVER inherited: two nodes sharing an anchor still derive their
   *  own, because a shared pack means every node inherits one node's mistakes. */
  context_manifest: import('./context').ContextItem[]
  context_policy: import('./context').ContextPolicy
  /** Manifest ids the worker demonstrably used — the denominator's other half. */
  context_cited: string[]
  reads: string[]
  /** id → fingerprint at the moment it was read. The whole of staleness. */
  read_versions: Record<string, string>
  writes: string[]
  creates: string[]
  depends_on: string[]
  status: NodeStatus
  worker?: string
  result?: unknown
}

export interface WorkGraph {
  run_id: string
  intent: unknown
  nodes: WorkNode[]
}

type EventName =
  | 'run.started'
  | 'intent.resolved'
  | 'task.started'
  | 'claim.expanded'
  | 'context.expanded'
  | 'task.completed'
  | 'task.stale'
  | 'judge.completed'
  | 'author.decision'
  | 'run.ended'

export interface RunEvent {
  at: string
  event: EventName
  node?: string
  detail?: unknown
}

const runDir = (id: string) => path.join(STORY, '.arc', 'runs', id)
const historyDir = () => path.join(STORY, 'history')

/** Run ids are ordered and readable: run.0042. Numbering scans both the
 *  transient directory and the receipts, so a pruned .arc never reissues an
 *  id a receipt already claims. */
export function nextRunId(): string {
  const seen: number[] = []
  for (const dir of [path.join(STORY, '.arc', 'runs'), historyDir()]) {
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir)) {
      const m = name.match(/^run\.(\d+)/)
      if (m) seen.push(Number(m[1]))
    }
  }
  return `run.${String(Math.max(0, ...seen) + 1).padStart(4, '0')}`
}

/** Take the next id AND the directory that proves it is yours, in one step.
 *
 *  nextRunId alone is a read: two runs starting together both scan, both see
 *  the same highest number, and both claim it. The fix is to let the
 *  filesystem arbitrate — mkdir WITHOUT `recursive` fails with EEXIST if
 *  someone got there first, which is an atomic test-and-set on every platform
 *  arc runs on, and works across processes as well as within one. A loser
 *  simply rescans and tries the next number.
 *
 *  This matters more now than it did for the CLI: once runs can be created
 *  over HTTP, two requests landing together is ordinary rather than exotic. */
export function claimRunId(): string {
  fs.mkdirSync(path.join(STORY, '.arc', 'runs'), { recursive: true })
  for (let attempt = 0; attempt < 200; attempt++) {
    const id = nextRunId()
    try {
      fs.mkdirSync(runDir(id))          // no `recursive`: EEXIST is the signal
      return id
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
  throw new Error('could not allocate a run id after 200 attempts')
}

// ---- the event bus -------------------------------------------------------
//
// events.jsonl stays the record; this is a second listener, so a UI can watch
// a run live without polling a file. Subscribers are deliberately weak: one
// that throws, or a socket that died without saying so, must never fail the
// run that was only trying to report progress.

type StreamListener = (message: StreamMessage) => void

const listeners = new Set<StreamListener>()

export function subscribeRuns(fn: StreamListener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function publishStream(message: StreamMessage): void {
  for (const fn of listeners) {
    try {
      fn(message)
    } catch {
      // a broken listener is the listener's problem, never the run's
    }
  }
}

export class Run {
  readonly root: RunRoot
  readonly events: RunEvent[] = []
  readonly expansions: { node: string; granted: string; at: string }[] = []
  readonly contextExpansions: { node: string; added: string[]; because: string; at: string }[] = []

  constructor(source: Source, rawAuthorInput: string, opts: { now?: () => string; subject?: string } = {}) {
    const now = opts.now ?? (() => new Date().toISOString())
    this.now = now
    this.root = {
      run_id: claimRunId(),   // atomic: the directory is the claim
      source,
      raw_author_input: rawAuthorInput,
      started_at: now(),
      story_revision: storyRevision(),
      ...(opts.subject ? { subject: opts.subject } : {}),
    }
    fs.writeFileSync(path.join(runDir(this.root.run_id), 'root.json'), JSON.stringify(this.root, null, 2))
    this.emit('run.started', undefined, { source, story_revision: this.root.story_revision })
  }

  private now: () => string
  private ended: RunEnding | null = null

  get id(): string {
    return this.root.run_id
  }

  /** How the run ended, or null while it works. */
  get ending(): RunEnding | null {
    return this.ended
  }

  /** The run's one ending (invariant 9): written to the record once, and
   *  the first ending wins — a stop that lands while the child was already
   *  failing is still the stop the author asked for, and a later attempt
   *  to end an ended run changes nothing. */
  end(ending: RunEnding, detail?: unknown): void {
    if (this.ended) return
    this.ended = ending
    this.emit('run.ended', undefined, { ending, ...(detail === undefined ? {} : { detail }) })
  }

  /** Append one telemetry line. Never throws: losing a log line must never
   *  fail a run — the same discipline the generation ledger follows. */
  emit(event: EventName, node?: string, detail?: unknown): void {
    const rec: RunEvent = { at: this.now(), event, ...(node ? { node } : {}), ...(detail === undefined ? {} : { detail }) }
    this.events.push(rec)
    try {
      fs.appendFileSync(path.join(runDir(this.root.run_id), 'events.jsonl'), JSON.stringify(rec) + '\n')
    } catch {
      // telemetry only
    }
    publishStream({ run: this.root.run_id, ...rec })
  }

  recordExpansion(node: string, granted: string): void {
    this.expansions.push({ node, granted, at: this.now() })
    this.emit('claim.expanded', node, { granted })
  }

  /** A node asked for more context than its selectors gave it.
   *
   *  Recorded as its own event, and counted separately from claim expansion:
   *  the two diagnose opposite faults. Frequent claim widening means the
   *  planner is too tight about AUTHORITY; frequent context widening means
   *  the selectors are too narrow about KNOWLEDGE, and conflating them would
   *  hide both. */
  recordContextExpansion(node: string, added: string[], because: string): void {
    this.contextExpansions.push({ node, added, because, at: this.now() })
    this.emit('context.expanded', node, { added, because })
  }
}

// ---- what a run launched, and what it left behind -----------------------
//
// A run may launch several children — a seed, a repair — and each has a
// session and a transcript the runtime writes under its own directory. The
// run records every launch as it starts, so a run killed at any point still
// names its transcripts, and `arc doctor` and the delete route can find them
// by the run id alone.

export interface LaunchRecord {
  attempt: string
  session_id: string | null
  scratch_dir: string
  /** where the runtime will write the transcript, derived before the run;
   *  `transcript_path` is what it reported after */
  expected_transcript: string | null
  transcript_path?: string | null
  at: string
}

export function recordLaunch(runId: string, rec: LaunchRecord): void {
  try {
    fs.appendFileSync(path.join(runDir(runId), 'launches.jsonl'), JSON.stringify(rec) + '\n')
  } catch {
    // the record is the run's, and a run that cannot write it still runs
  }
}

export function launchesOf(runId: string): LaunchRecord[] {
  try {
    return fs.readFileSync(path.join(runDir(runId), 'launches.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l) as LaunchRecord)
  } catch {
    return []
  }
}

/** Remove every transcript a run's launches named. Returns what was there.
 *  The run record stays: what was asked and how it ended is the record;
 *  the transcript is the runtime's copy of the conversation. */
export function deleteTranscripts(runId: string): string[] {
  const removed: string[] = []
  for (const l of launchesOf(runId)) {
    for (const p of new Set([l.transcript_path, l.expected_transcript].filter((x): x is string => typeof x === 'string' && x.length > 0))) {
      try {
        if (fs.existsSync(p)) { fs.rmSync(p); removed.push(p) }
      } catch { /* a transcript that cannot be removed is reported by arc doctor */ }
    }
  }
  return removed
}

export interface UnfinishedRun { id: string; prompt: string; started_at: string }

/** Runs on disk that did not finish: arc launched a child for them and they
 *  never ended — no `run.ended`, no author decision, no receipt. That is
 *  what a backend killed mid-run leaves behind, and it is deliberately
 *  narrower than "has no ending":
 *
 *  - a run with no launch on record is one arc never executed — a session's
 *    own run, opened by the hook and observed rather than run (work-graph
 *    §10), or a run killed in the moment between its record and its first
 *    spawn. Nothing was left in flight, so naming it would be noise that
 *    grows with the author's own Claude Code usage;
 *  - a run this process is still WORKING is not unfinished, and the caller
 *    passes those ids in `live` so a briefing opened mid-route does not
 *    report the route in flight as one that did not finish.
 *
 *  Found at startup and listed by the briefing; never guessed from timing. */
export function unfinishedRuns(live: ReadonlySet<string> = new Set(), story: string = STORY): UnfinishedRun[] {
  const root = path.join(story, '.arc', 'runs')
  if (!fs.existsSync(root)) return []
  const out: UnfinishedRun[] = []
  for (const id of fs.readdirSync(root).sort()) {
    if (!/^run\.\d+$/.test(id) || live.has(id)) continue
    const dir = path.join(root, id)
    // Arc executed it: the cheapest test, and the one that says whether
    // anything could have been left in flight.
    if (!fs.existsSync(path.join(dir, 'launches.jsonl'))) continue
    let rootDoc: Partial<RunRoot> | null = null
    try { rootDoc = JSON.parse(fs.readFileSync(path.join(dir, 'root.json'), 'utf8')) as Partial<RunRoot> } catch { continue }
    if (!rootDoc) continue
    if (fs.existsSync(path.join(story, 'history', `${id}.yaml`))) continue
    let events = ''
    try { events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8') } catch { /* a run with no events is unfinished */ }
    if (/"event":"(run\.ended|author\.decision)"/.test(events)) continue
    out.push({ id, prompt: rootDoc.raw_author_input ?? '', started_at: rootDoc.started_at ?? '' })
  }
  return out
}

/** What a run on disk ended as, read from its events; null when it never
 *  ended — which after a restart means it did not finish. */
export function endingOnDisk(runId: string): RunEnding | 'decided' | null {
  try {
    const lines = fs.readFileSync(path.join(runDir(runId), 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
    for (const line of lines.reverse()) {
      const e = JSON.parse(line) as RunEvent
      if (e.event === 'run.ended') return ((e.detail as { ending?: RunEnding } | undefined)?.ending) ?? 'unfinished'
      if (e.event === 'author.decision') return 'decided'
    }
  } catch { /* no events */ }
  return null
}

/** What a node actually read, fingerprinted — call at the moment of reading. */
export function snapshotReads(ids: string[]): Record<string, string> {
  const fp = fingerprints()
  const out: Record<string, string> = {}
  for (const id of ids) {
    const v = fp.get(id)
    if (v) out[id] = v
  }
  return out
}

/** Anything a node read that has changed since it read it. A node with a
 *  non-empty result here is stale — no model is consulted (work-graph.md §6). */
export function staleReads(node: WorkNode): string[] {
  const fp = fingerprints()
  return Object.entries(node.read_versions)
    .filter(([id, was]) => fp.get(id) !== was)
    .map(([id]) => id)
}

// ---- the receipt --------------------------------------------------------
//
// One type, two homes (work-graph §9; agent-workflows §4, "The receipt"):
//
//   .arc/runs/<id>/receipt.yaml   the WORKING receipt, beside the rendered
//                                 brief, the raw answers, the refused text
//                                 and the event log. Gitignored, deleted
//                                 with the transcript. It may name paths and
//                                 hold measurements; it never holds prose.
//   history/<id>.yaml             the RECORD receipt, appended at the
//                                 author's decision and committed. Ids,
//                                 hashes and links only: no prose, no
//                                 absolute path (toRecordReceipt strips
//                                 both, and a test greps for them).
//
// The receipt is written by arc from the slice manifest and the envelope. No
// model writes its own receipt, and nothing a model returned is copied into
// history/ — an answer is named by its fingerprint and kept with the run.

/** A gate that ran, as a typed record (§4, "The gates"). The gate runner
 *  writes these once it owns the child (A67-6); the passes write them now,
 *  so *held* and *did not run* never read alike. */
export interface GateRecord {
  gate: string
  verdict: 'held' | 'refused' | 'could not judge' | 'not applicable'
  /** the bar, and where it came from: a contract line, or a code constant */
  bar?: number | string | null
  bar_from?: string
  /** what was measured, and against what */
  measured?: number | string | null
  measured_against?: string[]
  /** 1 for the first answer, 2 for the one repair */
  attempt: number
  /** which launch of the run it was — `late-entry-1`, `rewrite-2` — so two
   *  seeds of one run never blur into one another on the receipt */
  launch?: string
  /** the stage a refusal happened at, when it never reached the engine */
  stage?: 'intake' | 'slice' | 'brief' | 'launch' | 'answer' | 'write'
}

/** The cell a request resolved to, and the gesture the author made. */
export interface RequestRecord {
  /** the author's own gesture, in their words */
  gesture: string
  /** the cell it resolved to: job · scope · mode · depth (· stage) */
  cell: string
  /** the subject it was about — a scene, a route */
  subject?: string
}

/** What the model was given and what it was not — three separate readings,
 *  so "arc chose not to show it" never reads as "arc ran out of room". */
export interface SliceManifest {
  /** the layers the brief actually carried, by id */
  included: string[]
  /** withheld BY DESIGN — the row's withheld set */
  withheld_by_design: string[]
  /** dropped for room, in the row's drop order */
  dropped_for_budget: string[]
  /** what the runtime added on its own, observed rather than declared */
  runtime_added: string[]
}

/** The envelope as the runtime reported it, with each field's proof class
 *  (§4, rules 1–3). `declared` is the row's; `proven` is what the runtime's
 *  own init event asserted, each with where it came from; `recorded` is
 *  what no engine on subscription auth can withhold, each with where it was
 *  observed. A field that is neither proven nor recorded refuses the launch,
 *  and the refusal is here too. */
export interface EnvelopeObserved {
  declared: Record<string, unknown>
  /** one observation per LAUNCH of the run — two seeds and a repair each
   *  proved their own, and a refusal must not be erased by a later launch
   *  that was admitted */
  observed?: {
    attempt: string
    proven?: Record<string, { value: unknown; from: string }>
    recorded?: Record<string, { value: unknown; observed_in: string }>
    refused?: { field: string; declared: unknown; observed: unknown; sentence: string }
  }[]
}

interface Receipt {
  run_id: string
  /** the run this one is a member of; null for a job's own run */
  parent?: string | null
  source: Source
  raw_author_input: string
  started_at: string
  decided_at: string
  story_revision: string | null
  story_revision_at_decision: string | null

  // ---- the rowed fields (A67-4). Absent on the notes-work receipts that
  // predate them, which is why every one is optional.
  /** the request as the author made it, and the cell it resolved to */
  request?: RequestRecord
  /** job · scope · mode · depth · stage, from the row */
  cell?: { job: string; scope: string; mode: string; depth: string; stage: string | null }
  /** the brief's slots as block ids and fingerprints — never rendered text.
   *  One entry per block per LAUNCH: a run with two seeds and a repair
   *  rendered several briefs, and each is kept beside the run under the
   *  fingerprint named here. */
  brief?: { attempt: string; id: string; fingerprint: string; cached: boolean }[]
  slice?: SliceManifest
  envelope?: EnvelopeObserved
  gates?: GateRecord[]
  /** every answer the run received, by fingerprint; the text lives with the
   *  run, never here */
  answers?: { attempt: string; fingerprint: string; landed: boolean }[]
  /** claims the answer made and what was dropped, by reason */
  evidence?: { returned: number; dropped: { reason: string; count: number }[] }
  /** the model and runtime as THEY reported, never as arc assumed. One
   *  engine answers a whole run, so this is the run's; the per-launch
   *  session ids are in `launches.jsonl`. */
  engine?: { engine: string; model: string | null; runtime: string | null }
  /** summed over every launch of the run — estimated before each send,
   *  actual as each engine reported it */
  tokens?: { estimated: { input: number; output: number } | null; actual: { input: number; output: number } | null }
  wall_clock_ms?: number
  /** time spent waiting on the author — never budget */
  waiting_on_author_ms?: number
  /** how it ended, from the closed set */
  ending?: RunEnding
  /** what produced it: the arc commit and the job fingerprint over the row,
   *  its rules, its slice and its gates */
  produced_by?: { arc_commit: string | null; job_fingerprint: string | null }

  intent: unknown
  claims: { node: string; kind: string; claim: Capability }[]
  scope_expansions: { node: string; granted: string; at: string }[]
  context_manifest: { id: string; version: string }[]
  checks: unknown
  judgment: unknown
  author_decision?: { decision: 'accepted' | 'rejected' | 'abandoned'; note?: string }
  result: { records: string[]; commit: string | null }
}

/** What each gate is, in the author's words. A gate id is arc's vocabulary;
 *  a sentence the author reads must not be. Unknown ids fall back to the id,
 *  which is honest rather than wrong. */
const GATE_WORDS: Record<string, string> = {
  shape: 'the answer did not come back in the two parts it was asked for',
  engine: 'the pass could not be run at all',
  leak: 'the scene\u2019s own prose reached the brief',
  locks: 'a locked passage was not kept as it stands',
  'lock-order': 'the locked passages came back out of order',
  'withhold-literals': 'a phrase the scene contract withholds came back in the prose',
  'and-chain': 'the sentences chained on "and" past what the style contract allows',
  'sentence-length': 'the sentences ran longer than the style contract allows',
  overlap: 'it reused too much of the original wording',
  'coverage-tail': 'the answer did not say where the beats land',
  validator: 'the answer did not validate',
}

/** WHAT A GATE CHECKS, as a name rather than as a failure. `GATE_WORDS` above
 *  says what went wrong and belongs in a refusal; a receipt lists gates that
 *  mostly HELD, and "a locked passage was not kept: held" reads as its own
 *  opposite. A gate id is arc's vocabulary and must not reach a page beside
 *  the prose either way (rule 9), so an unknown id falls back to a phrase and
 *  never to the bare id. */
const GATE_NAMES: Record<string, string> = {
  leak: 'the scene\u2019s own prose kept out of the brief',
  locks: 'locked passages kept as they stand',
  'lock-order': 'locked passages in their order',
  'withhold-literals': 'the contract\u2019s withheld phrases kept out',
  'and-chain': 'chains on \u201cand\u201d',
  'sentence-length': 'sentence length',
  overlap: 'wording reused from the scene',
  'coverage-tail': 'where the beats land',
  validator: 'the answer validates',
  shape: 'the answer came back in two parts',
  engine: 'the pass ran',
}
export const gateName = (gate: string): string => GATE_NAMES[gate] ?? `the ${gate} check`

/** Why one gate refused, rendered from its record — never from the answer's
 *  own words, which a model wrote. */
function gateSentence(g: GateRecord): string {
  const what = GATE_WORDS[g.gate] ?? `the ${g.gate} check did not hold`
  const measured = g.measured === null || g.measured === undefined ? ''
    : g.bar === null || g.bar === undefined ? ` (${g.measured})`
    : ` (${g.measured} against ${g.bar})`
  return what + measured
}

/** ONE SENTENCE FOR A RUN THAT DID NOT LAND (A67-11, criterion 4), rendered
 *  by code from the ending and the gate records, ending in the keystroke
 *  that comes next. A model never phrases this: the answer that was refused
 *  is the thing being reported on, so quoting it back would let a refused
 *  answer write arc’s own copy. Returns null for a run that landed.
 *
 *  No git word, no runtime word, no file path: this is read beside the prose,
 *  above the fold rather than inside it. */
export function outcomeSentence(r: { ending?: RunEnding; gates?: GateRecord[] }): string | null {
  if (!r.ending || r.ending === 'landed') return null
  // The sentence is only ever shown where no route was produced — a route
  // that is on disk landed, whatever else the run did — so the keystroke it
  // names is the one that IS on the page. Naming a cancel for a route that
  // does not exist sends the author looking for a control that is not there.
  const next = 'ask again to try from where the scene stands now'
  const refused = (r.gates ?? []).filter(g => g.verdict === 'refused').at(-1)
  // WHAT ACTUALLY HAPPENED, and not a stock phrase. A gate that refused at
  // the BRIEF stopped the pass before anything was sent — there was no answer
  // to read back, and saying there was tells the author arc spent something
  // it did not, on a sentence that is supposed to be the proven register.
  const beforeTheSend = refused ? refused.stage !== 'answer' && refused.stage !== undefined : false
  const read = beforeTheSend
    ? 'arc would not send it'
    : 'arc read the answer back and would not keep it'
  const why: Record<RunEnding, string> = {
    landed: '',
    refused: refused ? `${read}: ${gateSentence(refused)}` : read,
    'could not run': 'arc could not start this one',
    'timed out': 'it ran past the time this kind of work is given',
    budget: 'it ran past the room this kind of work is given',
    unreadable: 'the answer came back in a shape arc could not read',
    cancelled: 'you stopped it before it landed',
    unfinished: 'arc was closed while it was working, so nothing landed',
  }
  return `${why[r.ending]} \u2014 ${next}.`
}

export type { Receipt, RunRoot }

/** The empty shape every receipt starts from, so a rowed run and a
 *  notes-work run write the same record with different fields filled. */
export function emptyReceipt(run: Run): Receipt {
  return {
    run_id: run.id,
    parent: null,
    source: run.root.source,
    raw_author_input: run.root.raw_author_input,
    started_at: run.root.started_at,
    decided_at: '',
    story_revision: run.root.story_revision,
    story_revision_at_decision: null,
    intent: null,
    claims: [],
    scope_expansions: [],
    context_manifest: [],
    checks: null,
    judgment: null,
    result: { records: [], commit: null },
  }
}

const yaml = (r: unknown): string => yamlDump(r, { indent: 2, lineWidth: 100, noRefs: true, sortKeys: false })

/** The WORKING receipt: everything, beside the run's own working files. */
export function writeWorkingReceipt(r: Receipt): string {
  const file = path.join(runDir(r.run_id), 'receipt.yaml')
  try {
    fs.mkdirSync(runDir(r.run_id), { recursive: true })
    fs.writeFileSync(file, yaml(r))
  } catch { /* a receipt that cannot be written must not fail the run */ }
  return file
}

export function readWorkingReceipt(runId: string): Receipt | null {
  try {
    return yamlLoad(fs.readFileSync(path.join(runDir(runId), 'receipt.yaml'), 'utf8')) as Receipt
  } catch {
    return null
  }
}

/** What the run kept beside its receipt: the rendered brief, the answers it
 *  received, the text a gate refused. Named by fingerprint, so the receipt
 *  can point at them without copying a word into the record. */
export function keepWithRun(runId: string, kind: 'brief' | 'answer' | 'refused', text: string): string {
  const fp = sha16(text)
  try {
    const dir = path.join(runDir(runId), kind === 'brief' ? 'briefs' : kind === 'answer' ? 'answers' : 'refused')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${fp}.txt`), text)
  } catch { /* working state; the fingerprint is still the name */ }
  return fp
}

export const runFilePath = (runId: string, kind: 'brief' | 'answer' | 'refused', fingerprint: string): string =>
  path.join(runDir(runId), kind === 'brief' ? 'briefs' : kind === 'answer' ? 'answers' : 'refused', `${fingerprint}.txt`)

/** The RECORD receipt: the working one with every path and every prose
 *  field removed. Ids, hashes and links only — what a receipt may carry
 *  into a committed repository (work-graph §9). */
export function toRecordReceipt(r: Receipt): Receipt {
  const strip = (v: unknown): unknown => {
    if (typeof v === 'string') return v.startsWith('/') ? '(a path, kept with the run)' : v
    if (Array.isArray(v)) return v.map(strip)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, strip(x)]))
    return v
  }
  // Every field, not only the envelope: a note, a record or a field added
  // later must not be the one that carries this machine's home directory
  // into a committed repository.
  const out = strip(r) as Receipt
  // AND NO PROSE. `measured_against` is the one field of a gate record that
  // can hold free text rather than ids — the leak gate records the passage it
  // found, which is by definition a run of the withheld manuscript. That
  // belongs in the working receipt, which is gitignored and is what the
  // author reads; a committed record holds ids, hashes and links. An id never
  // contains a space, so a phrase is the test.
  if (out.gates) out.gates = out.gates.map(g => (
    g.measured_against?.some(m => /\s/.test(m))
      ? { ...g, measured_against: [`(${g.measured_against.length} passage${g.measured_against.length === 1 ? '' : 's'}, kept with the run)`] }
      : g
  ))
  return out
}

/** Fill in the commit on a record receipt already in history/ — the accept
 *  that committed an adopted route happens after the decision that wrote
 *  it, and `result.commit` is the link between the two. */
export function stampReceiptCommit(runId: string, commit: string): boolean {
  const file = path.join(historyDir(), `${runId}.yaml`)
  try {
    const r = yamlLoad(fs.readFileSync(file, 'utf8')) as Receipt
    if (!r || r.result?.commit) return false
    r.result = { ...r.result, commit }
    fs.writeFileSync(file, yaml(r))
    return true
  } catch {
    return false
  }
}

/** Write the RECORD receipt. Called at the author's decision on any ending —
 *  a refused run is as informative as a landed one, and the override metric
 *  needs both. */
export function writeReceipt(r: Receipt): string {
  fs.mkdirSync(historyDir(), { recursive: true })
  const file = path.join(historyDir(), `${r.run_id}.yaml`)
  fs.writeFileSync(file, yaml(toRecordReceipt(r)))
  return path.relative(STORY, file)
}

export function buildReceipt(
  run: Run,
  graph: WorkGraph,
  parts: {
    checks: unknown
    judgment: unknown
    decision: 'accepted' | 'rejected' | 'abandoned'
    note?: string
    records: string[]
  },
): Receipt {
  const manifest = new Map<string, string>()
  for (const n of graph.nodes) for (const [id, v] of Object.entries(n.read_versions)) manifest.set(id, v)
  return {
    run_id: run.id,
    source: run.root.source,
    raw_author_input: run.root.raw_author_input,
    started_at: run.root.started_at,
    decided_at: new Date().toISOString(),
    story_revision: run.root.story_revision,
    story_revision_at_decision: storyRevision(),
    intent: graph.intent,
    claims: graph.nodes.map(n => ({ node: n.id, kind: n.kind, claim: n.claim })),
    scope_expansions: run.expansions,
    context_manifest: [...manifest].map(([id, version]) => ({ id, version })),
    checks: parts.checks,
    judgment: parts.judgment,
    author_decision: { decision: parts.decision, ...(parts.note ? { note: parts.note } : {}) },
    // No commit: slice 1 stops at the author's decision. The two revisions
    // above already bracket the run, and the diff itself belongs to git.
    result: { records: parts.records, commit: null },
  }
}
