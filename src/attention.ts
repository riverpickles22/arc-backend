// The attention inbox: everything currently needing the author's review,
// aggregated from machinery that already runs — the cross-entity checks,
// the proposal queue, and payoffs planted but never fired. No new
// computation; this is the surface those computations were missing.
import { loadGraph } from 'arc-canon-graph'
import type { AttentionResponse, CanonDoc } from 'arc-canon-graph'
import { canonJson } from './canon'
import { orphaned } from './annotations'
import { materialItems, proseScenes } from './story'
import { splitSentences } from 'arc-canon-graph/sentences.ts'
import { paragraphsOf } from 'arc-canon-graph/annotations.ts'
import { proposalOrigins } from './ledger'
import type { LedgerEntry } from './ledger'
import { bodyAt } from './update-record'
import { unreadEpisodes } from './episodes'

type ProposedRecord = AttentionResponse['proposedRecords'][number]

const norm = (t: string): string => t.replace(/\s+/g, ' ').trim()

/** THE PASSAGE A PARAGRAPH ID POINTS AT, rendered by code (proven), from the
 *  BOOK — HEAD, never the working tree, so a pending draft changes nothing —
 *  and only when paragraph N at the commit the proposal was read from
 *  (`atOrigin`) still reads the same at HEAD (compared loosely, as the
 *  annotations do). Otherwise empty, and the viewer says the passage is no
 *  longer in the scene: an index is never reattached to whatever now sits at
 *  it (conventions §14). `-¶N` named a paragraph the change removed, which
 *  the book does not hold. `sentence` is the first sentence that says the
 *  record's name, and empty when none does. */
export function citedPassage(atOrigin: string | null, atHead: string | null, id: string, name: string | undefined): { passage: string; sentence: string } {
  const none = { passage: '', sentence: '' }
  const m = /^¶(\d+)$/.exec(id)
  if (!m || atOrigin === null || atHead === null) return none
  const at = Number(m[1]) - 1
  const was = paragraphsOf(atOrigin)[at]
  const now = paragraphsOf(atHead)[at]
  if (!was || !now || norm(was) !== norm(now)) return none
  const n = name?.trim().toLowerCase()
  const sentence = (n && splitSentences(now).map(x => x.text.trim()).find(t => t.toLowerCase().includes(n))) || ''
  return { passage: now, sentence }
}

const PREFIX_WORD: Record<string, string> = {
  char: 'a character', obj: 'an object', place: 'a place', faction: 'a faction', event: 'an event', rel: 'a relationship', ch: 'a chapter',
}

/** A conflict is stored with canon ids (ids are what code can check); the
 *  author reads names. Every id-shaped token that the record holds becomes
 *  that record's name — an entity's name, an event's or chapter's title, an
 *  edge's "A and B"; an id the record does not hold becomes its kind word. */
export function conflictForAuthor(text: string, doc: CanonDoc): string {
  const entityName = (id: string): string | undefined => doc.entities?.[id]?.name
  const nameOfId = (id: string): string | null => {
    const e = entityName(id); if (e) return e
    const ev = doc.events?.[id] as { title?: string } | undefined; if (ev?.title) return ev.title
    const ch = (doc.chapters ?? []).find(c => c.id === id) as { title?: string } | undefined; if (ch?.title) return ch.title
    const r = (doc.relationships ?? []).find(x => x.id === id)
    if (r) { const a = entityName(r.from), b = entityName(r.to); return a && b ? `${a} and ${b}` : 'a relationship' }
    return null
  }
  return text.replace(/\b([a-z]{2,8})\.[a-z0-9][a-z0-9-]*/g, (tok, pre: string) => nameOfId(tok) ?? PREFIX_WORD[pre] ?? tok)
}

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

  // Origins are the ledger's (A74-2): class, scene, run and the paragraphs a
  // proposal rests on. A status: proposed record with none was proposed
  // before arc kept a record — class, scene and run are null, never guessed.
  // The list is FLAT; the viewer groups it.
  const origins = new Map<string, LedgerEntry>()
  for (const o of proposalOrigins()) if (o.canon) origins.set(o.canon, o)
  const scenes = proseScenes()
  const proposed = (id: string, type: string, name?: string): ProposedRecord => {
    const o = origins.get(id)
    const file = o?.scene ? scenes.find(s => s.scene === o.scene)?.file : undefined
    const atOrigin = file && o?.range ? bodyAt(o.range.to, file) : null
    const atHead = file ? bodyAt('HEAD', file) : null
    const target = o?.about ? doc.entities?.[o.about] : undefined
    // who else the record concerns, read off the record itself: the other
    // end of an edge, the other participants of an event
    const edge = (doc.relationships ?? []).find(r => r.id === id)
    const event = doc.events?.[id]
    const others = (edge ? [edge.from, edge.to] : (event?.participants ?? []).map(q => q.entity))
      .filter(x => x !== o?.about)
      .map(x => ({ id: x, name: doc.entities?.[x]?.name ?? null }))
    // What approval would make canon, read from the record as it stands in
    // the file (exported canon), never from the ledger. Conflict is the
    // origin's: proven wins over argued.
    const rec = (doc.entities?.[id] ?? doc.events?.[id] ?? edge ?? (doc.chapters ?? []).find(c => c.id === id)) as { summary?: unknown; kind?: unknown; species?: unknown } | undefined
    const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
    const conflict: ProposedRecord['conflict'] = o?.proven_conflict ? { register: 'proven', text: conflictForAuthor(o.proven_conflict, doc) }
      : o?.argued_conflict ? { register: 'argued', text: conflictForAuthor(o.argued_conflict, doc) } : null
    return {
      id, type,
      summary: str(rec?.summary) ?? '', kind: str(rec?.kind) ?? str(rec?.species), conflict,
      about: o?.about ? { id: o.about, name: target?.name ?? null, type: target?.type ?? null, beside: o.beside ?? null, others } : null,
      class: o?.class ?? null, scene: o?.scene ?? null, run: o?.run ?? null,
      cites: (o?.evidence ?? []).map(paragraph => ({ paragraph, ...citedPassage(atOrigin, atHead, paragraph, name) })),
      since: o?.at ?? null,
    }
  }
  const proposedRecords = [
    ...Object.values(doc.entities ?? {}).filter(e => e.status === 'proposed').map(e => proposed(e.id, 'entity', e.name)),
    ...Object.values(doc.events ?? {}).filter(e => e.status === 'proposed').map(e => proposed(e.id, 'event', (e as { title?: string }).title)),
    ...(doc.relationships ?? []).filter(r => r.status === 'proposed').map(r => proposed(r.id, 'relationship', (r as { name?: string }).name)),
    ...(doc.chapters ?? []).filter(c => c.status === 'proposed').map(c => proposed(c.id, 'chapter', (c as { title?: string }).title)),
  ].sort((a, b) => a.id.localeCompare(b.id))

  // A note whose passage is gone is a proven finding: it is a fact that the
  // anchor does not resolve. Where the thought now belongs is the author's.
  const orphans = orphaned().map(n => ({
    id: n.id, body: n.body, scene: n.anchor.scene, quote: n.anchor.quote,
    why: n.resolution.note ?? 'the anchor no longer resolves',
  }))

  return {
    errors: findings.filter(f => f.severity === 'error').length,
    warnings: findings.filter(f => f.severity === 'warning').length,
    proposals: proposedRecords.length,
    payoffs: dangling.length,
    obligations: unmet.length,
    findings,
    proposedRecords,
    // The scenes arc has not yet read: the same function the re-entry
    // briefing uses, and like it a listing that never starts a read (A74-3).
    unread: unreadEpisodes(),
    danglingPayoffs: dangling,
    unmetObligations: unmet,
    orphanedNotes: orphans.length,
    orphanedAnnotations: orphans,
  }
}
