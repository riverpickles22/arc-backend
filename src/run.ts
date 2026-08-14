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
import { dump as yamlDump } from 'js-yaml'
import { STORY } from './config'
import type { Capability } from './capability'
import { fingerprints, storyRevision } from './records'

export type Source = 'ui' | 'claude-code' | 'cli' | 'external'

/** The immutable root, written the moment a run starts. `story_revision`
 *  answers "what version of the story did this begin against?" in one field —
 *  per-node fingerprints answer the finer question of what actually changed. */
export interface RunRoot {
  run_id: string
  source: Source
  raw_author_input: string
  started_at: string
  story_revision: string | null
}

export type NodeStatus = 'queued' | 'running' | 'completed' | 'stale' | 'needs_author' | 'failed'

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

export type EventName =
  | 'run.started'
  | 'intent.resolved'
  | 'task.started'
  | 'claim.expanded'
  | 'context.expanded'
  | 'task.completed'
  | 'task.stale'
  | 'judge.completed'
  | 'author.decision'

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

/** One message shape for everything the viewer watches, so it holds a single
 *  subscription. `run: null` is a story-level event with no run behind it —
 *  a file that changed outside any governed work, which arc must be able to
 *  say plainly rather than dress up (work-graph.md §10). */
export interface StreamMessage {
  run: string | null
  at: string
  event: string
  node?: string
  detail?: unknown
}

export type StreamListener = (message: StreamMessage) => void

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

  constructor(source: Source, rawAuthorInput: string, now: () => string = () => new Date().toISOString()) {
    this.now = now
    this.root = {
      run_id: claimRunId(),   // atomic: the directory is the claim
      source,
      raw_author_input: rawAuthorInput,
      started_at: now(),
      story_revision: storyRevision(),
    }
    fs.writeFileSync(path.join(runDir(this.root.run_id), 'root.json'), JSON.stringify(this.root, null, 2))
    this.emit('run.started', undefined, { source, story_revision: this.root.story_revision })
  }

  private now: () => string

  get id(): string {
    return this.root.run_id
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

export interface Receipt {
  run_id: string
  source: Source
  raw_author_input: string
  started_at: string
  decided_at: string
  story_revision: string | null
  story_revision_at_decision: string | null
  intent: unknown
  claims: { node: string; kind: string; claim: Capability }[]
  scope_expansions: { node: string; granted: string; at: string }[]
  context_manifest: { id: string; version: string }[]
  checks: unknown
  judgment: unknown
  author_decision: { decision: 'accepted' | 'rejected' | 'abandoned'; note?: string }
  result: { records: string[]; commit: string | null }
}

/** Write the receipt. Called on ANY terminal author decision — a rejected run
 *  is as informative as an accepted one, and the override metric needs both. */
export function writeReceipt(r: Receipt): string {
  fs.mkdirSync(historyDir(), { recursive: true })
  const file = path.join(historyDir(), `${r.run_id}.yaml`)
  fs.writeFileSync(file, yamlDump(r, { indent: 2, lineWidth: 100, noRefs: true, sortKeys: false }))
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
