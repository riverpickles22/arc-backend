// The attention inbox: everything currently needing the author's review,
// aggregated from machinery that already runs — the cross-entity checks,
// the proposal queue, and payoffs planted but never fired. No new
// computation; this is the surface those computations were missing.
import { loadGraph } from 'arc-canon-graph'
import type { AttentionResponse, CanonDoc } from 'arc-canon-graph'
import { canonJson } from './canon'
import { materialItems, proseScenes } from './story'

export function attention(): AttentionResponse {
  const doc = JSON.parse(canonJson()) as CanonDoc
  const g = loadGraph(doc)
  const findings = g.checks()
  const dangling = g.orphans().danglingLeadsTo

  // Material and prose bindings are arguments, not canon — material lives
  // beside canon, never in it (conventions §12).
  const obl = g.obligations(
    materialItems(),
    proseScenes().map(s => ({ scene: s.scene, chapter: s.chapter, satisfies: s.contract?.satisfies })),
  )
  const unmet = [
    ...obl.unowned.map(o => ({ ...o, klass: 'unowned' as const })),
    ...obl.unwritten.map(o => ({ ...o, klass: 'unwritten' as const })),
    ...obl.overdue.map(o => ({ ...o, klass: 'overdue' as const })),
  ].map(({ id, body, klass, satisfiers }) => ({ id, body, klass, satisfiers }))

  const proposedRecords = [
    ...Object.values(doc.entities ?? {}).filter(e => e.status === 'proposed').map(e => ({ id: e.id, type: 'entity' })),
    ...Object.values(doc.events ?? {}).filter(e => e.status === 'proposed').map(e => ({ id: e.id, type: 'event' })),
    ...(doc.relationships ?? []).filter(r => r.status === 'proposed').map(r => ({ id: r.id, type: 'relationship' })),
    ...(doc.chapters ?? []).filter(c => c.status === 'proposed').map(c => ({ id: c.id, type: 'chapter' })),
  ].sort((a, b) => a.id.localeCompare(b.id))

  return {
    errors: findings.filter(f => f.severity === 'error').length,
    warnings: findings.filter(f => f.severity === 'warning').length,
    proposals: proposedRecords.length,
    payoffs: dangling.length,
    obligations: unmet.length,
    findings,
    proposedRecords,
    danglingPayoffs: dangling,
    unmetObligations: unmet,
  }
}
