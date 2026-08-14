// Slice 1: one vertical path, end to end.
//
//   intent → claim → context → material worker → checks → judge → author
//
// One worker, no fan-out, no scheduler. The question this answers is not
// "does a fleet work" but the narrower and more important one: can arc take
// ambiguous author intent, derive a bounded piece of work, execute it under
// capability, widen authority explicitly when it must, judge the result, and
// keep the decision history — without an idea quietly becoming canon.
//
// The author's decision is a SEPARATE act (`decide` below). Nothing here
// ratifies anything: the run stops at needs_author, and the receipt is
// written when the author says accept or reject.
import fs from 'node:fs'
import path from 'node:path'
import { dump as yamlDump, load as yamlLoad } from 'js-yaml'
import type { ChatAction } from 'arc-canon-graph'
import { STORY } from './config'
import { validateStory } from './canon'
import { type Capability, grant, readOnly } from './capability'
import { type IntentEnvelope, runIntake } from './intent'
import { type Judgment, runJudge } from './judge'
import { buildWorkerContext, runMaterialWorker } from './material'
import {
  type Source,
  type WorkGraph,
  type WorkNode,
  Run,
  buildReceipt,
  snapshotReads,
  staleReads,
  writeReceipt,
} from './run'

/** The planner (work-graph.md §5). It derives the claim from the envelope and
 *  the story graph — it does not ask a model what the claim should be.
 *
 *  Conservative by construction, and deliberately so: read the anchors, write
 *  material, and hold creation authority for material alone. A worker that
 *  concludes canon should change hits the gate. That refusal is the
 *  measurement (§12), not a failure. */
export function deriveClaim(envelope: IntentEnvelope): Capability {
  const reads = ['canon/*', 'docs/*', 'material/*', ...envelope.anchors]

  // Authority gates CANON, not material. The first run of slice 1 proved the
  // blunter rule wrong: intake reads "maybe… I don't know where he appears
  // yet" as `exploratory` — correctly — and a claim granting nothing then
  // makes `capture` unperformable, which is the one operation thinking aloud
  // most needs. Material asserts no story truth and is never load-bearing
  // (conventions §12: capturing it must cost nothing), so capture is granted
  // at every authority. What `exploratory` withholds is canon.
  if (!envelope.operations.includes('capture')) return readOnly(reads)

  return grant({
    reads,
    writes: [],
    proposes: [],
    creates: [{ type: 'material', related_to: envelope.anchors[0] }],
  })
}

export function planGraph(runId: string, envelope: IntentEnvelope): WorkGraph {
  const claim = deriveClaim(envelope)
  const node: WorkNode = {
    id: 'capture',
    kind: 'material',
    claim,
    reads: envelope.anchors,
    read_versions: snapshotReads(envelope.anchors),
    writes: [],
    creates: ['mat.*'],
    depends_on: [],
    status: 'queued',
    worker: 'material',
  }
  return { run_id: runId, intent: envelope, nodes: [node] }
}

export interface RunOutcome {
  run: Run
  graph: WorkGraph
  envelope: IntentEnvelope
  actions: ChatAction[]
  workerReply: string
  produced: { path: string; content: string }[]
  checks: { proven: string; ok: boolean }
  judgment: Judgment
}

export async function runIntent(rawAuthorInput: string, source: Source = 'cli'): Promise<RunOutcome> {
  const run = new Run(source, rawAuthorInput)

  const envelope = await runIntake(rawAuthorInput, run.id)
  run.emit('intent.resolved', undefined, envelope)

  const graph = planGraph(run.id, envelope)
  const node = graph.nodes[0]

  node.status = 'running'
  run.emit('task.started', node.id, { kind: node.kind, claim: node.claim, reads: node.reads })

  const context = buildWorkerContext(envelope.anchors)
  const { reply, actions } = await runMaterialWorker(envelope, context, node.claim, run, node.id)

  const produced = actions
    .filter(a => a.ok && a.tool === 'write_material_file')
    .map(a => ({ path: a.path, content: readStoryFile(a.path) }))

  // Staleness is decided here, deterministically, by comparing what the node
  // actually read against the story as it now stands (work-graph.md §6).
  const stale = staleReads(node)
  if (stale.length) {
    node.status = 'stale'
    run.emit('task.stale', node.id, { changed: stale })
  } else {
    node.status = 'completed'
    run.emit('task.completed', node.id, { wrote: produced.map(p => p.path) })
  }

  const validation = validateStory()
  const checks = { proven: validation.output, ok: validation.ok }

  const judgment = await runJudge({
    envelope,
    rawAuthorInput,
    claim: node.claim,
    contextUsed: context,
    produced,
    checks,
    boundRules: [],   // the rules layer (§8) does not exist yet; saying so beats inventing rules
    workerReply: reply,
  })
  run.emit('judge.completed', node.id, judgment)

  node.status = 'needs_author'
  node.result = { produced: produced.map(p => p.path), verdict: judgment.verdict }

  return { run, graph, envelope, actions, workerReply: reply, produced, checks, judgment }
}

function readStoryFile(rel: string): string {
  try {
    return fs.readFileSync(path.join(STORY, rel), 'utf8')
  } catch {
    return '(unreadable)'
  }
}

/** The author's decision — the only thing that ends a run.
 *
 *  On reject the material item is marked `dropped` rather than deleted:
 *  "dropped beats deletion — intent history is story history" (conventions
 *  §12). Either way a receipt is written, because a rejected run is exactly
 *  as informative as an accepted one. */
export async function decide(
  outcome: RunOutcome,
  decision: 'accepted' | 'rejected' | 'abandoned',
  note?: string,
): Promise<{ receipt: string; dropped: string[] }> {
  const dropped: string[] = []
  if (decision === 'rejected') {
    for (const p of outcome.produced) {
      const abs = path.join(STORY, p.path)
      try {
        const item = yamlLoad(fs.readFileSync(abs, 'utf8')) as Record<string, unknown>
        item.status = 'dropped'
        fs.writeFileSync(abs, yamlDump(item, { indent: 2, lineWidth: 100, noRefs: true, sortKeys: false }))
        dropped.push(p.path)
      } catch {
        // the file is already gone or unparseable; the receipt still stands
      }
    }
  }

  outcome.run.emit('author.decision', undefined, { decision, note, dropped })
  outcome.graph.nodes.forEach(n => (n.status = decision === 'accepted' ? 'completed' : 'failed'))

  const receipt = writeReceipt(
    buildReceipt(outcome.run, outcome.graph, {
      checks: outcome.checks,
      judgment: outcome.judgment,
      decision,
      note,
      records: outcome.produced.map(p => p.path),
    }),
  )
  return { receipt, dropped }
}
