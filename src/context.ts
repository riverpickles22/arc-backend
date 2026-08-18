// Context derivation: what a node may retrieve, what it actually got, and why.
//
// THE VOCABULARY THIS LOCKS (work-graph.md §3, and the finding that forced it).
// Slice 1's first real run returned nine "anchors" for a request about one
// character — the café, the parents, the neighbourhood, three chapters, two
// eras. Every one was a reasonable thing for the worker to read. None of them
// was what the author was talking about. Three levels, and they do not share a
// name:
//
//   ANCHORS         what the author MEANT. Named by them, or resolved from
//                   what they said with no ambiguity. Precision, not recall.
//   SCOPE ROOTS     inferred structural starting points — temporal, location,
//                   surface. Where to begin traversal, never an assertion
//                   about meaning, so a wrong guess cannot corrupt the record
//                   of the instruction.
//   CONTEXT         per-node, derived, every item carrying the reason it is
//                   there. Never inherited by another node.
//
// The test is what arc can say later when asked why work happened. "Because
// the author was talking about Carlos" is an answer. "Because intake retrieved
// nine nearby entities" is not.
//
// INTAKE RESOLVES INTENT; WORKERS RESOLVE CONTEXT. Otherwise intake becomes a
// hidden retrieval system and every downstream node inherits its mistakes.
import type { CanonDoc } from 'arc-canon-graph'
import { canonJson } from './canon'
import type { IntentEnvelope } from './intent'

/** What a node MAY retrieve, declared before anything is fetched. A selector
 *  is a statement of permission and intent, not a result. */
export interface Selector {
  kind: 'anchor' | 'neighbours' | 'surface'
  /** The id or root this selector starts from. */
  of: string
  /** Why this selector exists, in words — the graph path it represents. */
  because: string
}

/** One item a node actually retrieved. `because` names the path that put it
 *  here, which is what makes the context auditable rather than plausible. */
export interface ContextItem {
  id: string
  because: string
  /** The selector that produced it, so an over-broad selector is visible. */
  via: string
}

/** What a node is allowed to pull. Exceeding it is REFUSED, never silently
 *  truncated: a quiet trim looks identical to a context that was simply
 *  small, and the author would never learn the worker was working blind. */
export interface ContextPolicy {
  max_primary_refs: number
  max_supporting_refs: number
  expand_on_demand: boolean
}

export const DEFAULT_POLICY: ContextPolicy = {
  max_primary_refs: 8,
  max_supporting_refs: 24,
  expand_on_demand: true,
}

export class ContextRefused extends Error {
  constructor(readonly wanted: number, readonly limit: number, readonly which: 'primary' | 'supporting') {
    super(`context refused: ${wanted} ${which} refs exceeds the node's limit of ${limit}. Narrow the selectors or request an expansion — nothing was silently dropped.`)
    this.name = 'ContextRefused'
  }
}

/** Derive what a node may read from what the author meant plus where the
 *  planner thinks traversal should start.
 *
 *  Anchors give primary selectors; scope roots give supporting ones. The
 *  difference matters: an anchor is the author's, a scope root is arc's guess,
 *  and only the first may ever be described as what they asked for. */
export function deriveSelectors(envelope: IntentEnvelope): Selector[] {
  const out: Selector[] = []
  for (const id of envelope.anchors) {
    out.push({ kind: 'anchor', of: id, because: 'the author named it' })
    out.push({ kind: 'neighbours', of: id, because: `one hop from ${id}, which the author named` })
  }
  const roots = envelope.scope_roots
  for (const id of roots.temporal) out.push({ kind: 'surface', of: id, because: `inferred temporal scope root (${id})` })
  for (const id of roots.location) out.push({ kind: 'surface', of: id, because: `inferred location scope root (${id})` })
  for (const surface of roots.surface) out.push({ kind: 'surface', of: surface, because: `inferred surface (${surface})` })
  return out
}

/** The record, or null when it cannot be read.
 *
 *  A story whose canon export is failing is a broken story — but it must not
 *  also become a story you cannot write a note about. Planning degrades to an
 *  empty manifest, loudly in the log and plainly in what the worker is told,
 *  rather than refusing to plan at all. The worker still has read_story_file
 *  under its claim, which is the same fallback it always had. */
function loadCanon(): CanonExport | null {
  try {
    return JSON.parse(canonJson()) as CanonExport
  } catch (e) {
    console.error('[warn] canon export unavailable — nodes will plan with an empty context manifest:', e)
    return null
  }
}

/** The export as this module reads it: every field optional, because an
 *  unreadable or partial export must degrade rather than throw. The shape
 *  itself is arc-canon-graph's CanonDoc — declaring a second one here is how
 *  `involves` (a field the event schema has never had) survived for as long
 *  as it did. */
type CanonExport = Partial<CanonDoc>

/** Resolve selectors into a manifest, refusing rather than truncating.
 *
 *  Every entry carries its reason at the moment it is added — the same
 *  include-with-reason discipline arc-core's context-pack library already
 *  uses, moved to where the NODE drives it rather than one fixed traversal. */
export function resolveContext(
  selectors: Selector[],
  policy: ContextPolicy = DEFAULT_POLICY,
  /** The record to derive against. Injectable so the derivation is a pure
   *  function of a graph rather than of a subprocess — this arithmetic is
   *  exactly the part that must be testable without a story on disk. */
  canon?: CanonExport,
): ContextItem[] {
  // An unreadable export means nothing can be DERIVED — but the author's
  // anchors are not derived, so they survive it. Bailing out here would have
  // discarded the one part of the manifest that never depended on the graph.
  const doc = canon ?? loadCanon() ?? {}
  const known = (id: string) => doc.entities?.[id] ?? doc.events?.[id]

  const primary = new Map<string, ContextItem>()
  const supporting = new Map<string, ContextItem>()

  const add = (into: Map<string, ContextItem>, id: string, because: string, via: string, always = false) => {
    // A DERIVED item must exist — manifesting a phantom would be arc inventing
    // context. An ANCHOR is different: it is the author's statement of what
    // they meant, and dropping it because it does not resolve to an entity
    // record would silently discard the one thing intake is authoritative
    // about. `story` is the obvious case, and there will be others.
    if (!always && !known(id)) return
    if (primary.has(id) || supporting.has(id)) return
    into.set(id, { id, because, via })
  }

  for (const sel of selectors) {
    if (sel.kind === 'anchor') {
      add(primary, sel.of, sel.because, `anchor:${sel.of}`, true)
    } else if (sel.kind === 'neighbours') {
      for (const r of doc.relationships ?? []) {
        if (r.from === sel.of) add(supporting, r.to, `${r.kind ?? 'related'} from ${sel.of}`, `neighbours:${sel.of}`)
        if (r.to === sel.of) add(supporting, r.from, `${r.kind ?? 'related'} to ${sel.of}`, `neighbours:${sel.of}`)
      }
      // Participant or witness — the same two edges canon-graph's neighbours()
      // walks. This read `e.involves` until A-sweep: a field the event schema
      // has never had, so the branch never fired and an entity's own events
      // never reached its neighbourhood.
      for (const e of Object.values(doc.events ?? {})) {
        const involved = (e.participants ?? []).some(p => p.entity === sel.of) || (e.witnesses ?? []).includes(sel.of)
        if (involved) add(supporting, e.id, `event involving ${sel.of}`, `neighbours:${sel.of}`)
      }
    } else {
      add(supporting, sel.of, sel.because, `surface:${sel.of}`)
    }
  }

  if (primary.size > policy.max_primary_refs) throw new ContextRefused(primary.size, policy.max_primary_refs, 'primary')
  if (supporting.size > policy.max_supporting_refs) throw new ContextRefused(supporting.size, policy.max_supporting_refs, 'supporting')

  return [...primary.values(), ...supporting.values()]
}

/** The context a worker is handed: the manifest, expanded, each with its
 *  reason attached to the record itself so the model sees WHY it was given
 *  every fact rather than a flat bundle it must trust. */
export function renderContext(manifest: ContextItem[], canon?: CanonExport): string {
  const doc = canon ?? loadCanon()
  if (!doc) {
    return JSON.stringify({
      context_manifest: [],
      note: 'The canon export is unavailable, so no context could be derived. Read what your claim allows with read_story_file, and do not assume the absence of a fact means it is untrue.',
    }, null, 2)
  }
  const records = manifest.map(m => ({
    id: m.id,
    included_because: m.because,
    via_selector: m.via,
    record: doc.entities?.[m.id] ?? doc.events?.[m.id],
  }))
  return JSON.stringify({
    story: doc.story,
    chapter_ids: (doc.chapters ?? []).map(c => c.id),
    context_manifest: records,
    note: 'Every item above names why it is here. Nothing else was retrieved; use read_story_file for anything else your claim allows.',
  }, null, 2)
}

/** Utilization: of what the node was handed, how much did it actually use?
 *
 *  Reported separately from claim expansion because they diagnose opposite
 *  faults — repeated expansion means selectors are too narrow, low
 *  utilization means they are too broad. One number cannot say both. */
export function utilization(manifest: ContextItem[], cited: string[]): number | null {
  // NULL, not 1. A node handed nothing has not used it perfectly — it has no
  // ratio at all, and reporting 1.00 makes an under-specified selector read
  // as the best-performing node in the table. Exposing that is the metric's
  // whole job (work-graph.md §12).
  if (!manifest.length) return null
  const used = new Set(cited.filter(id => manifest.some(m => m.id === id)))
  return Number((used.size / manifest.length).toFixed(3))
}

/** What a worker DEMONSTRABLY used: every manifest id appearing in what it
 *  wrote or said. Deterministic — no model is asked to self-report, because a
 *  worker's account of its own reasoning is exactly the thing arc cannot check.
 *
 *  The limit is deliberate and worth stating: a worker that reads a fact and
 *  acts on it WITHOUT naming the id reads here as not having used it. That is
 *  not a bug in the measure, it is the measure — arc can audit a citation and
 *  cannot audit an influence. A node whose utilization sits at zero while its
 *  output is plainly informed is telling you its output is unciteable, which
 *  is its own finding. */
export const citedIn = (manifest: ContextItem[], text: string): string[] =>
  manifest.filter(m => text.includes(m.id)).map(m => m.id)

/** A node needs something its selectors did not give it.
 *
 *  The same shape as claim expansion, deliberately: declare narrow, widen on
 *  demand, and record every widening. A node that keeps asking is a node whose
 *  selectors were wrong, and the record is what makes that visible instead of
 *  merely felt.
 *
 *  Refused when the policy forbids it, or when the widening would breach the
 *  limits — and refusal is the honest outcome, not a smaller silent answer. */
export function expandContext(
  manifest: ContextItem[],
  ids: string[],
  because: string,
  policy: ContextPolicy = DEFAULT_POLICY,
): ContextItem[] {
  if (!policy.expand_on_demand) {
    throw new ContextRefused(manifest.length + ids.length, manifest.length, 'supporting')
  }
  const have = new Set(manifest.map(m => m.id))
  const added = ids
    .filter(id => !have.has(id))
    .map(id => ({ id, because, via: 'expansion' }))

  const next = [...manifest, ...added]
  if (next.length > policy.max_primary_refs + policy.max_supporting_refs) {
    throw new ContextRefused(next.length, policy.max_primary_refs + policy.max_supporting_refs, 'supporting')
  }
  return next
}
