// THE MECHANICAL CHECKS OVER THE MANUSCRIPT (A77-1; its own module since A81-5).
//
// The proven channel: nothing here needs a model, which is the whole point —
// a doubled space or a sentence over the contract's number arrives as a
// fact, instantly and free, where every other reading the manuscript offers
// is a model's opinion. It reads the record and writes nothing; the route in
// server.ts only calls it.
import type { ProseCheckHit, ProseChecksResponse } from 'arc-canon-graph'
import { proseChecks } from 'arc-canon-graph'
import { countableChecks } from './countable'
import { lockResolver } from './locks'
import { proseScenes } from './story'
import { styleContract } from './style'

export function manuscriptChecks(): ProseChecksResponse {
  const findings: ProseCheckHit[] = []
  // The ratified contract, read once: the countable rules (A77-1) list a
  // sentence only over a number the contract states, through the gates'
  // own readers and counter. The proposed layer is never read here.
  const style = styleContract()
  const scenes = proseScenes()
  const locksFor = lockResolver(scenes)
  for (const sc of scenes) {
    const hits = proseChecks(sc.body)
    const standing = locksFor(sc.scene, sc.body).filter(l =>
      l.resolution.state === 'resolved' || l.resolution.state === 'drifted')
    // A finding inside settled prose names its lock — the author reads
    // "there is a typo, and you locked it" and decides; nothing repairs.
    const locked = new Map(standing
      .filter(l => l.resolution.paragraph !== null)
      .map(l => [l.resolution.paragraph!, l.id]))
    const wide = standing.find(l => l.scope === 'scene' || l.scope === 'chapter')
    for (const h of hits) {
      const lock = locked.get(h.paragraph) ?? wide?.id
      findings.push({ scene: sc.scene, file: sc.file, ...h, ...(lock ? { lock } : {}) })
    }
    // A count is never held against settled prose: a locked paragraph,
    // or every paragraph under a scene or chapter lock, is not counted.
    if (wide) continue
    for (const h of countableChecks(sc.body, style, (_p, i) => locked.has(i))) {
      findings.push({ scene: sc.scene, file: sc.file, ...h })
    }
  }
  return { findings }
}
