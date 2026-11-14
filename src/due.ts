// WHAT IS DUE (A69-6), as the briefing panel and the writing slice both read
// it: the graph's obligations, filed by class, windowed to a chapter. Pure
// over the canon, the material and the scenes it is handed. It lived in
// briefing.ts, which also reaches the routes and the episodes; the slice
// assembler reads it from here so it reaches no pass (A80-1).
import { loadGraph } from 'arc-canon-graph'
import type { BriefingResponse, CanonDoc, MaterialItem, ProseScene } from 'arc-canon-graph'

/** Unmet obligations whose window touches `chapter`. A bound naming no
 *  chapter, or a chapter the canon does not order, leaves that side open. */
export function dueIn(
  chapter: string,
  order: Map<string, number>,
  unmet: { id: string; body: string; klass: 'unowned' | 'unwritten' | 'overdue'; window?: { from?: string; to?: string } }[],
): NonNullable<BriefingResponse['due']> {
  const cur = order.get(chapter)
  if (cur === undefined) return []
  const out: NonNullable<BriefingResponse['due']> = []
  const seen = new Map<string, number>()
  for (const o of unmet) {
    if (!o.window) continue   // an obligation with no window is owed nowhere in particular
    const from = o.window.from !== undefined ? (order.get(o.window.from) ?? Number.NEGATIVE_INFINITY) : Number.NEGATIVE_INFINITY
    const to = o.window.to !== undefined ? (order.get(o.window.to) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY
    if (cur < from || cur > to) continue
    const row = { id: o.id, body: o.body, klass: o.klass, window: o.window }
    const at = seen.get(o.id)
    // One row per obligation; overdue outranks the class it was also filed under.
    if (at === undefined) { seen.set(o.id, out.length); out.push(row) }
    else if (o.klass === 'overdue') out[at] = row
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/** WHAT IS DUE, with who claims it (A69-6). One pipeline for the briefing
 *  panel and the writing slice, so the pass is never told a different debt
 *  than the author: the graph's obligations, filed by class, windowed to the
 *  chapter, each row keeping its satisfiers. */
export function dueRows(
  canon: CanonDoc, chapter: string, material: MaterialItem[], scenes: ProseScene[],
): (NonNullable<BriefingResponse['due']>[number] & { satisfiers: string[] })[] {
  const order = new Map((canon.chapters ?? []).map(c => [c.id, c.order ?? 0]))
  const obl = loadGraph(canon).obligations(
    material,
    scenes.map(s => ({ scene: s.scene, chapter: s.chapter, satisfies: s.contract?.satisfies })),
  )
  const rows = [
    ...obl.unowned.map(o => ({ ...o, klass: 'unowned' as const })),
    ...obl.unwritten.map(o => ({ ...o, klass: 'unwritten' as const })),
    ...obl.overdue.map(o => ({ ...o, klass: 'overdue' as const })),
  ]
  const satisfiers = new Map(rows.map(o => [o.id, o.satisfiers]))
  return dueIn(chapter, order, rows).map(o => ({ ...o, satisfiers: satisfiers.get(o.id) ?? [] }))
}
