// WHAT A READING OF ACCEPTED PROSE MAY ASK THE RECORD TO LEARN (A74-1; U7).
//
// The pure half of the update-record pass: parsing the proposals a model
// answers with, naming what each one is about, and building — from the
// proposal alone, never from a model's file — the candidate record it would
// become. Its own module for the reason citations.ts is: the gate runner needs
// these and the pass needs the runner, and one import each way is a cycle.
//
// THE MODEL NEVER SUPPLIES A QUOTE OR A FILE. It says what the prose
// establishes as {class, subject, type, field, value, evidence}; code renders
// the sentence an evidence id points at, mints the id, and writes the record.
import { createHash } from 'node:crypto'
import { dump as yamlDump } from 'js-yaml'
import { dk } from 'arc-canon-graph'
import { mintId } from './capability'

export type ProposalClass = 'stated' | 'implied' | 'retracted'
export const PROPOSAL_CLASSES: readonly ProposalClass[] = ['stated', 'implied', 'retracted']

/** The kinds of record a NEW subject can become. A relationship or an event
 *  is never a new subject: it is filed against records that already exist
 *  (A74-12), and one named without them is dropped with that reason. */
export const NEW_ENTITY_TYPES = ['character', 'place', 'faction', 'object'] as const
export type NewEntityType = (typeof NEW_ENTITY_TYPES)[number]

/** The enum the place and faction schemas close `kind` over. */
export const PLACE_KINDS = ['country', 'region', 'city', 'district', 'street', 'building', 'landmark', 'waterfront'] as const
export const FACTION_KINDS = ['faction', 'organization', 'government', 'movement', 'pack', 'family'] as const

/** One proposal, as the model answers it. `kind` is the one field beyond the
 *  card's contract: a new place or faction cannot validate without one and a
 *  new character without a species, and guessing either would be inventing. */
export interface Proposal {
  class: ProposalClass
  /** an id the record already holds, or "new" */
  subject: string
  type: string
  field: string
  value: string
  /** paragraph ids of the accepted change: ¶3 (as the book now reads) or -¶3
   *  (a paragraph the change removed) */
  evidence: string[]
  conflicts_with?: string
  note?: string
  kind?: string
  /** A74-12 · what an event proposal about an EXISTING record may carry:
   *  the other ids that took part, the place it happened, the date, and —
   *  for an object that changed hands — who received it and who gave it.
   *  Ids the record holds; code checks every one. */
  with?: string[]
  where?: string
  when?: string
  transfer?: { to: string; from?: string }
  /** SET BY THE CONTRADICTION GATE, never by the model: where code showed
   *  that this proposal sits against the record */
  proven_conflict?: string
}

/** The proposals array, parsed — or null when it could not be read at all,
 *  which is not the same as a reading that proposed nothing (§5, P2 fails
 *  closed). An element missing what makes it a proposal is counted, not
 *  silently skipped. */
export function readProposals(text: string): { proposals: Proposal[]; malformed: number } | null {
  const raw = text.replace(/```[a-z]*\n?/gi, '')
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end < start) return null
  let parsed: unknown
  try { parsed = JSON.parse(raw.slice(start, end + 1)) } catch { return null }
  if (!Array.isArray(parsed)) return null
  const proposals: Proposal[] = []
  let malformed = 0
  for (const x of parsed) {
    const p = x as Partial<Proposal> | null
    const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
    if (!p || typeof p !== 'object' || !PROPOSAL_CLASSES.includes(p.class as ProposalClass)
      || !text(p.subject) || !text(p.type) || !text(p.field) || !text(p.value)) { malformed++; continue }
    proposals.push({
      class: p.class as ProposalClass,
      subject: p.subject.trim(), type: p.type.trim().toLowerCase(), field: p.field.trim().toLowerCase(), value: p.value.trim(),
      evidence: Array.isArray(p.evidence) ? p.evidence.filter((e): e is string => typeof e === 'string' && !!e.trim()).map(e => e.trim()) : [],
      ...(text(p.conflicts_with) ? { conflicts_with: p.conflicts_with.trim() } : {}),
      ...(text(p.note) ? { note: p.note.trim() } : {}),
      ...(text(p.kind) ? { kind: p.kind.trim().toLowerCase() } : {}),
      ...(Array.isArray(p.with) && p.with.some(text) ? { with: p.with.filter(text).map(id => id.trim().toLowerCase()) } : {}),
      ...(text(p.where) ? { where: p.where.trim().toLowerCase() } : {}),
      ...(text(p.when) ? { when: p.when.trim() } : {}),
      ...(p.transfer && typeof p.transfer === 'object' && text(p.transfer.to)
        ? { transfer: { to: p.transfer.to.trim().toLowerCase(), ...(text(p.transfer.from) ? { from: p.transfer.from.trim().toLowerCase() } : {}) } }
        : {}),
    })
  }
  return { proposals, malformed }
}

// ---- evidence ids ------------------------------------------------------------

const PARA = /^(-)?\s*(?:¶|p|paragraph\s*)(\d+)$/i

/** The one spelling of an evidence id — `¶3`, or `-¶3` for a paragraph the
 *  change removed — or null when the text is not a paragraph id at all. A
 *  model that writes `p3` or `paragraph 3` meant ¶3; one that writes a quote
 *  meant nothing arc can place. */
export function evidenceId(raw: string): string | null {
  const m = PARA.exec(raw.trim())
  if (!m) return null
  return `${m[1] ? '-' : ''}¶${Number(m[2])}`
}

// ---- the key (the identity of what is being proposed) ----------------------

/** Lower-cased, whitespace-collapsed: "The  Keeper's Log" and "the keeper's
 *  log" are one name. */
export const normName = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** WHAT A PROPOSAL IS ABOUT, as a key two proposals about the same thing
 *  share. sha16 over type · normalised name when the subject is new, so a
 *  person re-proposed under a fresh id still matches; over id · field · value
 *  when it is an existing record. (Defined here, beside the other pure helpers;
 *  the evidence log's `neverKeys` and the ledger's origins both carry it.) */
export function proposalKey(p: Pick<Proposal, 'subject' | 'type' | 'field' | 'value'>): string {
  // an event is about its subject whatever the model wrote in `field`
  const field = p.type === 'event' ? 'event' : p.field.trim().toLowerCase()
  const basis = p.subject === 'new'
    ? ['new', p.type, normName(p.value)].join('␟')
    : [p.subject.toLowerCase(), field, normName(p.value)].join('␟')
  return createHash('sha256').update(basis).digest('hex').slice(0, 16)
}

/** The key an entity ALREADY in the record answers to — by its name and each
 *  alias — so a proposal for it matches whether the record holds it as
 *  canon or as a pending proposal. */
export function entityKeys(e: { type?: string; name?: string; aliases?: string[] }): string[] {
  if (!e.type) return []
  return [e.name, ...(e.aliases ?? [])]
    .filter((n): n is string => typeof n === 'string' && !!n.trim())
    .map(n => proposalKey({ subject: 'new', type: e.type!, field: 'name', value: n }))
}

// ---- the candidate record -----------------------------------------------------

/** Where a new entity's file lives, and what it is called. */
export const ENTITY_DIR: Record<NewEntityType, string> = {
  character: 'characters', place: 'places', faction: 'factions', object: 'objects',
}

/** The reason a proposal that would alter a record that already exists gives
 *  (a scalar, a state snapshot: nothing the schema lets stand beside it), so
 *  the receipt counts those apart from every other drop. */
export const EXISTING_RECORD_WHY = 'it would change'

/** A record built from a proposal. `collection` marks an edge that is one
 *  more item in a file the schema keeps whole (canon/relationships.yaml): it
 *  is APPENDED to the end of that file, so every byte already there stays. */
export type Candidate =
  | {
    ok: true; id: string; file: string; record: Record<string, unknown>; article?: { file: string; text: string }; collection?: 'relationships'
    /** what building the record left out, for the receipt to count: a date
     *  the scene does not bear out, a note that lifted the scene's own words */
    trimmed?: ('date-outside-scene' | 'note-copied')[]
  }
  | { ok: false; why: string }
export type BuiltCandidate = Extract<Candidate, { ok: true }>

/** What building a record for an EXISTING subject needs to know about the
 *  book (A74-12). Absent, arc cannot check an id and files nothing. */
export interface BuildContext {
  scene: string
  era: string | null
  taken: Set<string>
  entities?: { id: string; type?: string }[]
  /** the scene's span as its frontmatter gives it. A date is the scene's only
   *  when start and end are the same; a date the prose states is kept only
   *  when it falls inside the span. */
  sceneSpan?: { start?: string; end?: string }
  /** does this text carry a run of the scene's own words? (the brief's
   *  eight-consecutive-words rule, supplied by the pass) */
  copiesScene?: (text: string) => boolean
  /** the text of canon/relationships.yaml, so an edge arc cannot add to
   *  safely is refused up front */
  relationshipsText?: string
}

/** The kinds of objective edge the relationship schema closes `kind` over,
 *  and which of them have a direction. */
export const RELATIONSHIP_KINDS = [
  'family', 'owner-pet', 'companion-animal', 'guardian', 'mentor', 'friend', 'member-of',
  'controls', 'employs', 'ally', 'enemy', 'rival', 'successor-of',
] as const
export const DIRECTED_KINDS: readonly string[] = ['owner-pet', 'guardian', 'mentor', 'member-of', 'controls', 'employs', 'successor-of']

/** Why an edge is refused when the file every edge lives in cannot be added to
 *  without guessing at its layout. */
export const UNSAFE_APPEND_WHY = 'the list of relationships in your record is written in a way arc cannot safely add to'
const DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/
const rest = (id: string): string => id.slice(id.indexOf('.') + 1)

/** The text of canon/relationships.yaml with one more edge at its end, or
 *  null when the list cannot be read safely enough to add to.
 *
 *  The bytes already there are an exact prefix of the result, with ONE
 *  exception that is spelled out here: `relationships: []` holds no record, so
 *  that single line is replaced by `relationships:` and the new item beneath
 *  it, indented two spaces. Otherwise the new item takes the indentation of
 *  the list's first existing item (read from the file, not assumed). Null
 *  when the file has no `relationships:` key, when the list is written in
 *  flow style with items in it, when its items cannot be found, or when
 *  anything but comments follows the list. */
export function withEdge(text: string, record: Record<string, unknown>): string | null {
  const key = /^relationships:[ \t]*(\[\s*\])?[ \t]*(#.*)?$/m.exec(text)
  if (!key) return null
  const after = text.slice(key.index + key[0].length)
  // nothing but list items (indented or flush), blank lines and comments may follow the key
  if (/^[^\s#-]/m.test(after)) return null
  const first = /^([ \t]*)-[ \t]/m.exec(after)
  const empty = !!key[1]
  if (empty && first) return null
  const indent = first?.[1] ?? '  '
  if (!empty && !first && /\S/.test(after.replace(/^[ \t]*#.*$/gm, ''))) return null
  const item = yamlDump([record], { indent: 2, lineWidth: 100, noRefs: true, sortKeys: false })
    .split('\n').filter(Boolean).map(l => `${indent}${l}`).join('\n')
  if (empty) return text.replace(key[0], () => `relationships:${key[2] ? ` ${key[2]}` : ''}\n${item}`)
  return `${text}${text.endsWith('\n') ? '' : '\n'}\n${item}\n`
}

/** The date a record may carry: the prose's own `when` only when the scene's
 *  span has both ends and the date falls wholly inside it; otherwise the
 *  scene's date when its span is ONE moment (start and end alike). An
 *  open-ended span is not a moment. */
export function datedBy(when: string | undefined, span: { start?: string; end?: string } | undefined): { date: string | null; trimmed: boolean } {
  const ok = (d: string | undefined): d is string => !!d && DATE.test(d)
  const { start, end } = span ?? {}
  const bounded = ok(start) && ok(end)
  if (when !== undefined && ok(when)) {
    if (ok(start) && ok(end) && dk(when) >= dk(start) && dk(when, true) <= dk(end, true)) return { date: when, trimmed: false }
    return { date: null, trimmed: true }
  }
  if (when !== undefined) return { date: null, trimmed: true }
  return { date: bounded && start === end ? start : null, trimmed: false }
}

/** The one-sentence summary a record carries: the model's note, unless it
 *  lifts a run of the scene's own words (then the generic line, counted). */
function summaryOf(p: Proposal, ctx: BuildContext, generic: string): { text: string; trimmed: boolean } {
  const note = p.note?.trim()
  if (!note) return { text: generic, trimmed: false }
  return ctx.copiesScene?.(note) ? { text: generic, trimmed: true } : { text: note, trimmed: false }
}

/** BUILD THE RECORD THIS PROPOSAL WOULD BECOME, from the proposal alone.
 *
 *  A NEW person, place, faction or object is built whole. A change to a
 *  record that already exists is never a patch to it (A74-12): where the
 *  schema gives the change a record of its own, that record is built —
 *  a relationship edge or an event, `status: proposed`, naming the existing
 *  ids it is about. A change with no such shape (a scalar on a record, a
 *  state snapshot, which lives inside the record's own file) is not built.
 *  A retraction is read, not built.
 *
 *  What a schema requires that the proposal does not carry (a place's kind,
 *  a character's species, an event's era) is REFUSED rather than guessed. */
export function buildCandidate(p: Proposal, ctx: BuildContext): Candidate {
  if (p.class === 'retracted') return { ok: false, why: 'a retraction names what the record would lose; it files nothing' }
  if (p.subject !== 'new') {
    if (p.type === 'relationship') return buildEdge(p, ctx)
    if (p.type === 'event') return buildEvent(p, ctx)
    return { ok: false, why: `${EXISTING_RECORD_WHY} ${p.subject}, a record that already exists — that stays your own edit` }
  }
  if (p.type === 'relationship' || p.type === 'event') {
    return { ok: false, why: `a ${p.type} is filed against a record that is already there, and this one names none` }
  }
  if (!(NEW_ENTITY_TYPES as readonly string[]).includes(p.type)) {
    return { ok: false, why: `arc cannot file a new ${p.type} from a single fact yet` }
  }
  const type = p.type as NewEntityType
  if (p.field !== 'name') return { ok: false, why: 'a new record is named by its name' }
  const name = p.value.trim()
  if (ctx.copiesScene?.(name)) return { ok: false, why: 'it copies the scene\'s own words rather than naming a thing' }
  const sum = summaryOf(p, ctx, `Named in ${ctx.scene}.`)
  const summary = sum.text
  const trimmed = sum.trimmed ? ['note-copied' as const] : []
  const id = mintId(type, name, ctx.taken)
  const base = { id, type, name, status: 'proposed' }
  const slug = id.slice(id.indexOf('.') + 1)
  const file = `canon/entities/${ENTITY_DIR[type]}/${slug}.yaml`
  // The story's validator wants every entity to have a docs article that
  // names it; a proposal carries the smallest honest one.
  const article = {
    file: `docs/entities/${ENTITY_DIR[type]}/${slug}.md`,
    text: [
      '---', `canon: ${id}`, '---', '',
      `# ${name}`, '',
      `> Canonical data: \`${file}\` — YAML wins on conflict.`, '',
      `> **Proposed, not canon.** Read from the accepted prose of ${ctx.scene}; the author has not decided on it.`, '',
      summary, '',
    ].join('\n'),
  }
  switch (type) {
    case 'object':
      return { ok: true, id, file, article, ...(trimmed.length ? { trimmed } : {}), record: { ...base, summary, significance: 'Established in accepted prose; what it means is not yet said.' } }
    case 'place':
    case 'faction': {
      const kinds: readonly string[] = type === 'place' ? PLACE_KINDS : FACTION_KINDS
      if (!p.kind || !kinds.includes(p.kind)) return { ok: false, why: `a new ${type} needs a kind arc can file it under` }
      return { ok: true, id, file, article, ...(trimmed.length ? { trimmed } : {}), record: { ...base, kind: p.kind, summary } }
    }
    case 'character': {
      if (!p.kind) return { ok: false, why: 'a new character needs a species' }
      if (!ctx.era) return { ok: false, why: 'the scene sits in no era the record names, so arc cannot place this person in time' }
      return { ok: true, id, file, article, ...(trimmed.length ? { trimmed } : {}), record: { ...base, species: p.kind, summary, states: [{ at: { era: ctx.era } }] } }
    }
  }
}

const heldType = (ctx: BuildContext, id: string): string | null => {
  const e = ctx.entities?.find(x => x.id === id)
  return e ? (e.type ?? 'record') : null
}

/** A relationship that begins or shifts: one NEW edge from the subject to the
 *  id in `value`, of the kind in `field`. The edge it shifts is left exactly
 *  as it is; the two sit side by side until the author decides. */
function buildEdge(p: Proposal, ctx: BuildContext): Candidate {
  if (!ctx.entities) return { ok: false, why: 'arc could not check the record this relationship is about' }
  const from = p.subject.toLowerCase()
  const to = p.value.trim().toLowerCase()
  if (!heldType(ctx, from)) return { ok: false, why: `it names ${p.subject}, which your record does not hold` }
  if (!heldType(ctx, to)) return { ok: false, why: `it names ${p.value}, which your record does not hold` }
  if (from === to) return { ok: false, why: 'a relationship is between two different things' }
  const kind = p.field.trim().toLowerCase()
  if (!(RELATIONSHIP_KINDS as readonly string[]).includes(kind)) return { ok: false, why: `${p.field} is not a kind of relationship arc can file` }
  if (ctx.relationshipsText !== undefined && withEdge(ctx.relationshipsText, {}) === null) {
    return { ok: false, why: UNSAFE_APPEND_WHY }
  }
  // a relationship begins only when the PROSE says when, inside the scene
  const when = p.when !== undefined ? datedBy(p.when, ctx.sceneSpan) : { date: null, trimmed: false }
  const dated = p.when !== undefined && !when.trimmed ? when.date : null
  const sum = summaryOf(p, ctx, `Read from the accepted prose of ${ctx.scene}.`)
  const trimmed = [...(when.trimmed ? ['date-outside-scene' as const] : []), ...(sum.trimmed ? ['note-copied' as const] : [])]
  const id = mintId('relationship', `${rest(from)} ${rest(to)} ${kind}`, ctx.taken)
  return {
    ok: true, id, file: 'canon/relationships.yaml', collection: 'relationships',
    ...(trimmed.length ? { trimmed } : {}),
    record: {
      id, type: 'relationship', kind, status: 'proposed', from, to,
      directed: DIRECTED_KINDS.includes(kind),
      ...(dated ? { span: { start: dated } } : {}),
      summary: sum.text,
    },
  }
}

/** An event the scene adds between things the record already holds: its
 *  subject and whoever is in `with` take part, `where` is a place the record
 *  holds, and an object that changed hands names who received it and who
 *  gave it. Placed in time by the scene's era and a date the prose or the
 *  scene's own span gives. */
function buildEvent(p: Proposal, ctx: BuildContext): Candidate {
  if (!ctx.entities) return { ok: false, why: 'arc could not check the record this event is about' }
  if (!ctx.era) return { ok: false, why: 'the scene sits in no era the record names, so arc cannot place this event in time' }
  const subject = p.subject.toLowerCase()
  const subjectType = heldType(ctx, subject)
  if (!subjectType) return { ok: false, why: `it names ${p.subject}, which your record does not hold` }
  const parts = new Map<string, string>()
  const add = (id: string, role: string): string | null => {
    if (!heldType(ctx, id)) return id
    if (!parts.has(id)) parts.set(id, role)
    return null
  }
  let missing: string | null
  if (p.transfer) {
    if (subjectType !== 'object') return { ok: false, why: 'only an object can change hands' }
    add(subject, 'passed')
    if ((missing = add(p.transfer.to, 'receives'))) return { ok: false, why: `it names ${missing}, which your record does not hold` }
    if (p.transfer.from && (missing = add(p.transfer.from, 'gives'))) return { ok: false, why: `it names ${missing}, which your record does not hold` }
  } else add(subject, 'participant')
  for (const id of p.with ?? []) if ((missing = add(id, 'participant'))) return { ok: false, why: `it names ${missing}, which your record does not hold` }
  if (p.where && heldType(ctx, p.where) !== 'place') return { ok: false, why: `${p.where} is not a place your record holds` }
  if (ctx.copiesScene?.(p.value)) return { ok: false, why: 'its title copies the scene\'s own words rather than naming the event' }
  const when = datedBy(p.when, ctx.sceneSpan)
  const date = when.date
  const sum = summaryOf(p, ctx, `Read from the accepted prose of ${ctx.scene}.`)
  const trimmed = [...(when.trimmed ? ['date-outside-scene' as const] : []), ...(sum.trimmed ? ['note-copied' as const] : [])]
  const id = mintId('event', p.value, ctx.taken)
  return {
    ok: true, id, file: `canon/events/story/${rest(id)}.yaml`,
    ...(trimmed.length ? { trimmed } : {}),
    record: {
      id, type: 'event', scope: 'story', status: 'proposed', title: p.value.trim(),
      when: { era: ctx.era, ...(date ? { date, precision: date.length === 4 ? 'year' : date.length === 7 ? 'month' : 'day' } : {}) },
      ...(p.where ? { where: p.where } : {}),
      participants: [...parts].map(([entity, role]) => ({ entity, role })),
      summary: sum.text,
      on_page: true,
    },
  }
}

/** The keys the record already answers to for relationships and events, so a
 *  proposal that only says what the book says is refused as a duplicate. An
 *  edge with no direction answers from both of its ends. */
export function recordKeys(canon: {
  relationships?: { from: string; to: string; kind: string; directed?: boolean }[]
  events?: Record<string, { title?: string; participants?: { entity: string }[] }>
}): string[] {
  const keys: string[] = []
  for (const r of canon.relationships ?? []) {
    keys.push(proposalKey({ subject: r.from, type: 'relationship', field: r.kind, value: r.to }))
    if (!r.directed) keys.push(proposalKey({ subject: r.to, type: 'relationship', field: r.kind, value: r.from }))
  }
  for (const e of Object.values(canon.events ?? {})) {
    if (!e.title) continue
    for (const q of e.participants ?? []) keys.push(proposalKey({ subject: q.entity, type: 'event', field: 'event', value: e.title }))
  }
  return keys
}

// ---- contradictions arc can show -----------------------------------------------

/** WHERE CODE CAN SHOW A PROPOSAL SITS AGAINST THE RECORD. Narrow on purpose:
 *  a NEW record whose name is already some other kind of thing in the book —
 *  a place called Wren where Wren is a person. Anything subtler is the
 *  model's `conflicts_with`, kept as argued and never promoted to proven. */
export function provenConflict(
  p: Proposal,
  entities: { id: string; type?: string; name?: string; aliases?: string[] }[],
): string | null {
  if (p.subject !== 'new') return null
  const want = normName(p.value)
  const hit = entities.find(e =>
    e.type !== p.type && [e.name, ...(e.aliases ?? [])].some(n => typeof n === 'string' && normName(n) === want))
  return hit ? `${p.value} is already the name of a ${hit.type} in your record` : null
}
