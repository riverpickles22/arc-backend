// Editorial lenses: the first fan-out, and deliberately the safe one.
//
// Several readings of the same scene at once, each getting a DIFFERENT
// projection of the graph rather than the same context four times. No lens
// holds write capability, so a bad lens costs tokens and nothing else — which
// is what makes this the right place to prove that the graph can derive
// specialised context and genuinely parallel work.
//
// THE STORY IS THE SCOPING, not the prompts. Each lens's claim names what it
// may read, and its findings cite the evidence that put a fact in its context.
// Four lenses sharing one anchor and sharing one context pack would prove
// nothing: they would all inherit the same retrieval, including its mistakes.
// So each derives its own manifest from its own selectors (A13-5), and the
// test is that the manifests demonstrably differ.
//
// Everything a lens produces is ARGUED (conventions §11): claims with
// citations, for a human to judge, never presented as proven. This is the
// scoped successor to the whole-canon analysis pass in analyze.ts.
import type Anthropic from '@anthropic-ai/sdk'
import { MODEL, STORY } from './config'
import { getClient } from './agent'
import { currentEngine, runCliPrompt, stripFences } from './engine'
import { readOnly, type Capability } from './capability'
import { DEFAULT_POLICY, citedIn, renderContext, resolveContext, utilization, type Selector } from './context'
import { snapshotReads, staleReads, type Run, type WorkNode } from './run'
import { styleContract } from './style'
import type { ProseScene } from 'arc-canon-graph'

export type LensName = 'character' | 'style' | 'historical' | 'continuity'

export interface LensFinding {
  lens: LensName
  /** What the finding is about — an id where one applies, else the aspect. */
  about: string
  claim: string
  /** What in the scene or the context supports it. A finding without this is
   *  an opinion, and the author has no way to judge it. */
  evidence: string
  register: 'argued'
}

interface LensSpec {
  name: LensName
  /** What this lens is for, in the prompt's own words. */
  rules: string
  /** What it may retrieve, derived from the scene alone. The differences here
   *  ARE the story: same anchor, four projections. */
  selectors: (scene: ProseScene) => Selector[]
  /** Whether it needs the style contract. Only one does, which is itself a
   *  demonstration that the projections are not the same bundle. */
  wantsStyle?: boolean
}

const isChar = (id: string) => id.startsWith('char.')
const isPlace = (id: string) => id.startsWith('place.')

export const LENSES: LensSpec[] = [
  {
    name: 'character',
    rules: `You are arc's CHARACTER LENS. Read the scene for the people in it: whether
each behaves as this record says they are, whether their wants are legible
from what they do, and whether anyone acts out of the state the record has
them in at this point.`,
    // Who is present, and one hop out from them.
    selectors: scene => [
      ...(scene.pov ? [{ kind: 'anchor' as const, of: scene.pov, because: 'the scene is told from their point of view' }] : []),
      ...scene.facts.filter(isChar).map(id => ({ kind: 'anchor' as const, of: id, because: 'the scene rests on this character' })),
      ...(scene.pov ? [{ kind: 'neighbours' as const, of: scene.pov, because: `relationships of the POV character ${scene.pov}` }] : []),
    ],
  },
  {
    name: 'style',
    rules: `You are arc's STYLE LENS. Read the scene against the author's own contract
and nothing else. You are not judging whether the prose is good; you are
judging whether it obeys the rules THIS author wrote for THIS book. A line
that reads well and breaks a stated rule is a finding.`,
    // Deliberately empty: voice is not a canon question. The sharpest proof
    // that these projections genuinely differ — this lens sees no entities.
    selectors: () => [],
    wantsStyle: true,
  },
  {
    name: 'historical',
    rules: `You are arc's HISTORICAL LENS. Read the scene for period plausibility: an
object, word, price, technology or turn of phrase that could not exist at
this moment in this place. Flag what is anachronistic or unverifiable, and
say which. You are not the style police and not the continuity checker.`,
    // Where and when, and nothing about who.
    selectors: scene => [
      { kind: 'surface', of: scene.chapter, because: 'the chapter fixes when this happens' },
      ...scene.facts.filter(isPlace).map(id => ({ kind: 'anchor' as const, of: id, because: 'the scene is set here' })),
    ],
  },
  {
    name: 'continuity',
    rules: `You are arc's CONTINUITY LENS. Read the scene against what the record says
has already happened. Flag anything that contradicts a prior event, assumes
something not yet established, or quietly establishes something the record
does not carry.`,
    // The events this scene claims, and what they touch. A scene that
    // declares none still gets its chapter: found on the first real run,
    // where sc.01-1 lists no events and this lens was handed nothing at all
    // yet still returned seven findings — a reading against no record, which
    // is precisely the unevidenced opinion the register forbids.
    selectors: scene => scene.events.length
      ? [
        ...scene.events.map(id => ({ kind: 'anchor' as const, of: id, because: 'the scene declares this event' })),
        ...scene.events.map(id => ({ kind: 'neighbours' as const, of: id, because: `what ${id} touches` })),
      ]
      : [
        { kind: 'anchor' as const, of: scene.chapter, because: 'the scene declares no events, so its chapter is the only continuity anchor there is' },
        { kind: 'neighbours' as const, of: scene.chapter, because: `what ${scene.chapter} touches` },
      ],
  },
]

/** One read-only node per lens, each with its OWN context.
 *
 *  Read-only by construction: readOnly() grants no writes, proposes or
 *  creates, so a lens that tries to change the story is refused by the gate
 *  rather than by good intentions. */
export function planLensGraph(scene: ProseScene): WorkNode[] {
  return LENSES.map(spec => {
    const selectors = spec.selectors(scene)
    const manifest = resolveContext(selectors, DEFAULT_POLICY)
    const reads = manifest.map(m => m.id)
    return {
      id: `lens:${spec.name}`,
      kind: 'lens',
      claim: readOnly(reads) as Capability,
      anchors: [scene.scene],
      selectors,
      context_manifest: manifest,
      context_policy: DEFAULT_POLICY,
      context_cited: [],
      reads,
      read_versions: snapshotReads(reads),
      writes: [],
      creates: [],
      depends_on: [],
      status: 'queued',
      worker: `lens:${spec.name}`,
    }
  })
}

const ANSWER_RULES = `Answer with a JSON array and nothing else. Each entry:

  {"about": "the id this concerns, or the aspect if no id applies",
   "claim": "one sentence, specific enough to act on",
   "evidence": "the words from the scene, or the record fact, that support it"}

Every finding is ARGUED, never proven: you are making a case a human will
judge. A finding you cannot evidence is an opinion — leave it out. An empty
array is a good answer and a common one.`

export function buildLensPrompt(spec: LensSpec, scene: ProseScene, context: string, style: string): string {
  return [
    spec.rules,
    spec.wantsStyle ? `=== THE AUTHOR'S STYLE CONTRACT (binding) ===\n${style}` : '',
    `=== YOUR CONTEXT (every item names why it is here; you have nothing else) ===\n${context}`,
    `=== THE SCENE (${scene.scene}, chapter ${scene.chapter}${scene.pov ? `, POV ${scene.pov}` : ''}) ===\n${scene.body}`,
    ANSWER_RULES,
  ].filter(Boolean).join('\n\n')
}

export function parseFindings(lens: LensName, text: string): LensFinding[] {
  const raw = stripFences(text)
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end < start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((x): LensFinding[] => {
    const f = x as Partial<LensFinding>
    if (typeof f.claim !== 'string' || !f.claim.trim()) return []
    // No evidence, no finding — the discipline the prompt states, enforced
    // here so a model that ignores it cannot smuggle an opinion through.
    if (typeof f.evidence !== 'string' || !f.evidence.trim()) return []
    return [{
      lens,
      about: typeof f.about === 'string' && f.about.trim() ? f.about.trim() : lens,
      claim: f.claim.trim(),
      evidence: f.evidence.trim(),
      register: 'argued',
    }]
  })
}

export interface LensResult {
  lens: LensName
  findings: LensFinding[]
  /** Per-lens measurements (work-graph.md §12). */
  context_supplied: number
  context_used: number
  context_utilization: number | null
  claim_expansions: number
  stale: string[]
  error?: string
}

async function askModel(prompt: string): Promise<string> {
  if (currentEngine() === 'claude-cli') return runCliPrompt(prompt, { cwd: STORY }).text
  const message = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  })
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')
}

/** Run one lens. Isolated: a lens that fails returns its failure and never
 *  takes the fan-out with it — the whole point of read-only work is that one
 *  bad reading costs nothing. */
async function runLens(spec: LensSpec, node: WorkNode, scene: ProseScene, run: Run): Promise<LensResult> {
  const base = {
    lens: spec.name,
    context_supplied: node.context_manifest.length,
    claim_expansions: 0,
    stale: [] as string[],
  }
  try {
    node.status = 'running'
    run.emit('task.started', node.id, { kind: node.kind, claim: node.claim, reads: node.reads })

    const text = await askModel(buildLensPrompt(spec, scene, renderContext(node.context_manifest), styleContract()))
    const findings = parseFindings(spec.name, text)

    node.context_cited = citedIn(node.context_manifest, text)
    const stale = staleReads(node)
    node.status = stale.length ? 'stale' : 'completed'
    if (stale.length) run.emit('task.stale', node.id, { changed: stale })
    else run.emit('task.completed', node.id, { findings: findings.length })

    return {
      ...base,
      findings,
      stale,
      context_used: node.context_cited.length,
      context_utilization: utilization(node.context_manifest, node.context_cited),
    }
  } catch (e) {
    node.status = 'failed'
    return {
      ...base,
      findings: [],
      context_used: 0,
      context_utilization: null,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

const SYNTHESIS_RULES = `You are arc's SYNTHESIS PASS. Four lenses have each read the same scene
through a different question and returned their findings. Merge them for the
author.

You have the FINDINGS ONLY. You do not have the scene, the record, or the
lenses' context, and you must not re-derive any of it — your job is to
organise what was found, not to find more. Inventing a finding here would be
the one failure this pass can commit.

Say which findings agree, which conflict, and which one thing you would look
at first. Three or four sentences. Everything you are summarising is argued,
never proven — do not upgrade it.`

export interface FanOutResult {
  scene: string
  lenses: LensResult[]
  findings: LensFinding[]
  synthesis: string
  /** Wall-clock of the concurrent fan-out, and the sum of its parts — the
   *  second is what running them in sequence would have cost. */
  wall_ms: number
  serial_ms: number
}

/** The fan-out: every lens at once, then a synthesis over what came back.
 *
 *  Concurrency is safe here by construction rather than by scheduling: every
 *  node's write set is empty, so no two nodes can contend. That is the
 *  property this slice exists to demonstrate before any write fan-out. */
export async function runLensFanOut(scene: ProseScene, run: Run): Promise<FanOutResult> {
  const nodes = planLensGraph(scene)
  const started = Date.now()
  const perLens: number[] = []

  const results = await Promise.all(LENSES.map(async (spec, i) => {
    const t0 = Date.now()
    const out = await runLens(spec, nodes[i], scene, run)
    perLens.push(Date.now() - t0)
    return out
  }))

  const wall_ms = Date.now() - started
  const findings = results.flatMap(r => r.findings)

  let synthesis = ''
  try {
    synthesis = findings.length
      ? (await askModel([
        SYNTHESIS_RULES,
        `=== THE FINDINGS ===\n${JSON.stringify(findings, null, 2)}`,
      ].join('\n\n'))).trim()
      : 'No lens found anything it could evidence.'
  } catch (e) {
    synthesis = `synthesis unavailable: ${e instanceof Error ? e.message : String(e)}`
  }

  run.emit('judge.completed', undefined, {
    lenses: results.map(r => ({
      lens: r.lens,
      findings: r.findings.length,
      context_supplied: r.context_supplied,
      context_utilization: r.context_utilization,
      claim_expansions: r.claim_expansions,
      stale: r.stale.length,
      error: r.error,
    })),
    wall_ms,
    serial_ms: perLens.reduce((a, b) => a + b, 0),
  })

  return {
    scene: scene.scene,
    lenses: results,
    findings,
    synthesis,
    wall_ms,
    serial_ms: perLens.reduce((a, b) => a + b, 0),
  }
}
