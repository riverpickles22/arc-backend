// WHAT A READING MAY REST ON (A72-10, split out in A72-11's wake).
//
// The pure half of U9: parsing the findings a reading answers with, and
// placing each citation against WHAT THE BRIEF ACTUALLY CARRIED. Its own
// module because the gate runner needs it and the pass needs the runner —
// one import each way is a cycle, and a cycle that works only because both
// ends are hoisted is a cycle waiting to stop working.
import type { InspectFinding, InspectSection } from 'arc-canon-graph'
import { paragraphsOf } from './blast-radius'

/** The five sections the reading answers in — a closed set, so the page can
 *  order them and a model cannot invent a sixth. */
export const INSPECT_SECTIONS: readonly InspectSection[] = [
  'what this changed', 'contract', 'conflicts', 'to verify', 'style',
]

/** THE READING, PARSED. One fenced JSON array of findings; `null` when the
 *  answer could not be read at all — which is not the same as a reading that
 *  found nothing, and only the second is an answer (§5, P2 fails closed). */
export function readFindings(text: string): InspectFinding[] | null {
  const raw = text.replace(/```[a-z]*\n?/gi, '')
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end < start) return null
  let parsed: unknown
  try { parsed = JSON.parse(raw.slice(start, end + 1)) } catch { return null }
  if (!Array.isArray(parsed)) return null
  const out: InspectFinding[] = []
  for (const x of parsed) {
    const f = x as Partial<InspectFinding>
    if (typeof f.claim !== 'string' || !f.claim.trim()) continue
    // A SECTION OUTSIDE THE CLOSED SET is not filed under another one: an
    // invented heading would become a claim about something it is not. It
    // comes back with no citations, which is what drops it, counted.
    const known = INSPECT_SECTIONS.includes(f.section as InspectSection)
    const cites = known && Array.isArray(f.cites) ? (f.cites as unknown[]).filter((c): c is string => typeof c === 'string' && !!c.trim()) : []
    out.push({ section: known ? f.section as InspectSection : 'what this changed', claim: f.claim.trim(), cites })
  }
  return out
}

/** WHAT A CITATION MAY NAME: an id the brief actually carried, or a
 *  paragraph of the scene the reading was given. Nothing else resolves —
 *  arc will not look a claim up somewhere the pass was never shown. */
export interface CiteScope { ids: Set<string>; paragraphs: number }

const PARA = /^(?:¶|p|paragraph\s*)(\d+)$/i

/** Resolve one citation against the scope. Returns null when it resolves,
 *  or the reason it does not, in the author's words. */
export function resolveCite(cite: string, scope: CiteScope): string | null {
  const c = cite.trim()
  const m = PARA.exec(c)
  if (m) {
    const n = Number(m[1])
    return n >= 1 && n <= scope.paragraphs ? null : `it points at paragraph ${n}, and the scene has ${scope.paragraphs}`
  }
  if (scope.ids.has(c)) return null
  return `arc was not shown anything called ${c}`
}

/** DROP WHAT DOES NOT REST ON ANYTHING. A finding with no citation at all is
 *  a claim with no evidence, which is what the register rule forbids; one
 *  whose citations arc cannot place is the same thing wearing a reference.
 *  Both go, and both are counted — the author reads how much was dropped,
 *  never silently less. */
export function resolveCitations(findings: InspectFinding[], scope: CiteScope): {
  kept: InspectFinding[]
  dropped: { claim: string; why: string }[]
} {
  const kept: InspectFinding[] = []
  const dropped: { claim: string; why: string }[] = []
  for (const f of findings) {
    if (!f.cites.length) { dropped.push({ claim: f.claim, why: 'it cites nothing' }); continue }
    const bad = f.cites.map((c: string) => resolveCite(c, scope)).filter((w): w is string => w !== null)
    if (bad.length === f.cites.length) { dropped.push({ claim: f.claim, why: bad[0] }); continue }
    // A claim that rests on something stands, carrying only the citations
    // that resolve: a reference arc cannot place must not render as one it can.
    kept.push({ ...f, cites: f.cites.filter((c: string) => resolveCite(c, scope) === null) })
  }
  return { kept, dropped }
}


/** WHAT THE BRIEF CARRIED, read off the rendered brief itself rather than
 *  off the manifest's declared ids. The two are not the same: the canon
 *  layer's text is a traversal pack, and its `ids` are the scene's own
 *  frontmatter — so a manifest bar would admit ids the pass was never shown
 *  AND reject ones it was, dropping a supported finding in the proven
 *  register. The honest bar is the one thing arc can prove: the id appears
 *  in the words the pass read. */
export const citedScope = (renderedBrief: string, pendingBody: string): CiteScope => ({
  ids: new Set((renderedBrief.match(/\b[a-z][a-z0-9]*(?:\.[a-z0-9][a-z0-9-]*)+\b/g) ?? [])
    .filter(id => !/\.(?:md|ts|py|yaml|yml|json|jsonl|html)$/.test(id))),
  // the scene's PARAGRAPHS, the same numbering notes and locks use — the
  // body, never the file, so ¶3 means what it means everywhere else
  paragraphs: paragraphsOf(pendingBody).length,
})
