// The capability gate (work-graph.md §4): what a worker may read, change,
// propose, and create — enforced at the tool, never by the prompt.
//
// arc's write path already proves a change is well-formed: schema plus
// referential integrity, reverted on failure. This is the other half —
// proving the change was ALLOWED. A worker granted scene.01-2 cannot reach
// char.manuel, so an orchestrator never has to trust that it won't, which is
// what makes running several workers at once reasonable rather than reckless.
//
// Two kinds of grant, because creation cannot name what does not exist yet.
// Existing-resource authority names ids the story graph already holds.
// Creation authority names a TYPE and a constraint, and arc mints the id
// when a worker asks for one — the worker never invents a permanent id and
// reports it afterwards.
//
// The unit checked is the semantic delta, not the file. Rewriting
// relationships.yaml to change one edge needs authority over that edge, not
// over all forty. Canonical serialization (agent.ts) is what makes the
// member-by-member comparison reliable.
import { dump as yamlDump } from 'js-yaml'

/** Id prefixes by entity type — conventions §2. `*` in a grant means any. */
export const TYPE_PREFIX: Record<string, string> = {
  character: 'char',
  place: 'place',
  faction: 'faction',
  object: 'obj',
  event: 'event',
  era: 'era',
  timepoint: 'tp',
  relationship: 'rel',
  chapter: 'ch',
  theme: 'theme',
  material: 'mat',
}

export interface CreateGrant {
  /** An entity type from TYPE_PREFIX, or '*' for any. */
  type: string
  /** Narrows the grant for a human reader and for the audit record; not enforced. */
  related_to?: string
  window?: string
}

/** What one worker may do. Selectors are canon ids or story-relative paths,
 *  with `*` standing for any run of characters: 'char.*', 'docs/*', '*'. */
export interface Capability {
  reads: string[]
  /** May change in place, at any status. */
  writes: string[]
  /** May write only while the record stays `status: proposed`. */
  proposes: string[]
  creates: CreateGrant[]
}

/** Everything allowed — the author sitting in the chat, and the default for
 *  every call site that predates the gate. */
export const UNRESTRICTED: Capability = Object.freeze({
  reads: ['*'],
  writes: ['*'],
  proposes: ['*'],
  creates: [{ type: '*' }],
}) as Capability

/** Nothing allowed but reading — the shape every read-only worker takes
 *  (the analysis pass, and the editorial lenses of slice 2). */
export function readOnly(reads: string[]): Capability {
  return { reads, writes: [], proposes: [], creates: [] }
}

export function grant(partial: Partial<Capability>): Capability {
  return { reads: [], writes: [], proposes: [], creates: [], ...partial }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** `*` is the only metacharacter: it stands for any run of characters,
 *  separators included. Everything else matches literally. */
const rx = (selector: string) => new RegExp(`^${selector.split('*').map(escape).join('.*')}$`)

/** Does any selector cover this id or path? */
export function covered(selectors: string[], target: string): boolean {
  return selectors.some(s => rx(s).test(target))
}

export function typeOfId(id: string): string | undefined {
  const prefix = id.split('.')[0]
  return Object.keys(TYPE_PREFIX).find(t => TYPE_PREFIX[t] === prefix)
}

function grantsCreate(cap: Capability, type: string | undefined): boolean {
  return cap.creates.some(g => g.type === '*' || (type !== undefined && g.type === type))
}

// ---- what a canon file holds -------------------------------------------

export interface CanonRecord {
  id: string
  status?: string
  /** Canonical serialization of this record alone, for change detection. */
  body: string
}

const serialize = (v: unknown) => yamlDump(v, { indent: 2, lineWidth: 100, noRefs: true, sortKeys: false })

/** The records a parsed canon file holds. Three shapes exist: one entity per
 *  file (`id:` at top level), a collection under a single list key
 *  (relationships, chapters, themes, eras), and story.yaml, which is the
 *  story's own record and has no id of its own. */
export function recordsIn(parsed: unknown, relPath: string): CanonRecord[] {
  if (parsed === null || typeof parsed !== 'object') return []
  const obj = parsed as Record<string, unknown>

  if (typeof obj.id === 'string') return [{ id: obj.id, status: obj.status as string, body: serialize(obj) }]

  const out: CanonRecord[] = []
  for (const value of Object.values(obj)) {
    if (!Array.isArray(value)) continue
    for (const member of value) {
      if (member && typeof member === 'object' && typeof (member as any).id === 'string')
        out.push({ id: (member as any).id, status: (member as any).status, body: serialize(member) })
    }
  }
  if (out.length) return out

  // story.yaml and anything else with no ids of its own: the file is the record.
  return [{ id: relPath.endsWith('story.yaml') ? 'story' : relPath, status: 'canon', body: serialize(obj) }]
}

export interface Delta {
  added: CanonRecord[]
  modified: CanonRecord[]
  removed: CanonRecord[]
}

export function diffRecords(before: CanonRecord[], after: CanonRecord[]): Delta {
  const was = new Map(before.map(r => [r.id, r]))
  const now = new Map(after.map(r => [r.id, r]))
  return {
    added: after.filter(r => !was.has(r.id)),
    modified: after.filter(r => was.has(r.id) && was.get(r.id)!.body !== r.body),
    removed: before.filter(r => !now.has(r.id)),
  }
}

// ---- the check ----------------------------------------------------------

export interface ScopeCheck {
  ok: boolean
  /** Present when !ok: the SCOPE_EXCEEDED text the worker gets back. */
  message?: string
  /** Ids that failed, for the run record. */
  denied?: string[]
}

function grantedSummary(cap: Capability): string {
  const lines: string[] = []
  if (cap.reads.length) lines.push(`  read     ${cap.reads.join(', ')}`)
  if (cap.writes.length) lines.push(`  write    ${cap.writes.join(', ')}`)
  if (cap.proposes.length) lines.push(`  propose  ${cap.proposes.join(', ')}`)
  for (const g of cap.creates)
    lines.push(`  create   ${g.type}${g.related_to ? ` related_to:${g.related_to}` : ''}${g.window ? ` window:${g.window}` : ''}`)
  return lines.length ? lines.join('\n') : '  (nothing)'
}

/** How to get unstuck — the difference between a wall and a door. */
function expansionHint(id: string, cap: Capability, isNew: boolean): string {
  const type = typeOfId(id)
  if (isNew && grantsCreate(cap, type))
    return `  mint_id type:${type ?? '<type>'} hint:<slug>   (arc allocates the id and grants PROPOSE on it)`
  if (isNew) return `  CREATE ${type ?? '<type>'}   (ask the planner to widen the claim)`
  return `  WRITE ${id}   (ask the planner to widen the claim)`
}

function scopeError(attempted: string[], cap: Capability, hints: string[]): string {
  return [
    'SCOPE_EXCEEDED — nothing was written.',
    '',
    `attempted:\n${attempted.map(a => `  ${a}`).join('\n')}`,
    '',
    `granted:\n${grantedSummary(cap)}`,
    '',
    `expand:\n${[...new Set(hints)].join('\n')}`,
  ].join('\n')
}

/** May this worker land this delta? A record covered only by `proposes` must
 *  stay `status: proposed`; anything else needs `writes`. Missing status
 *  reads as canon, which is the safe direction for a gate. */
export function checkRecordWrite(cap: Capability, delta: Delta): ScopeCheck {
  const denied: string[] = []
  const attempted: string[] = []
  const hints: string[] = []

  const consider = (r: CanonRecord, verb: string, isNew: boolean) => {
    attempted.push(`${verb} ${r.id}`)
    if (covered(cap.writes, r.id)) return
    if (covered(cap.proposes, r.id) && (r.status ?? 'canon') === 'proposed') return
    denied.push(r.id)
    hints.push(expansionHint(r.id, cap, isNew))
  }

  delta.added.forEach(r => consider(r, 'create', true))
  delta.modified.forEach(r => consider(r, 'modify', false))
  delta.removed.forEach(r => consider(r, 'remove', false))

  if (!denied.length) return { ok: true }
  return { ok: false, denied, message: scopeError(attempted, cap, hints) }
}

/** Path-scoped writes (docs/) — no ids to check, so the path is the target. */
export function checkPathWrite(cap: Capability, relPath: string): ScopeCheck {
  if (covered(cap.writes, relPath)) return { ok: true }
  return {
    ok: false,
    denied: [relPath],
    message: scopeError([`write ${relPath}`], cap, [`  WRITE ${relPath}   (ask the planner to widen the claim)`]),
  }
}

/** Reads are checked against the path and against every id the file holds,
 *  so a claim can be stated in either vocabulary. */
export function checkRead(cap: Capability, relPath: string, ids: string[]): ScopeCheck {
  if (covered(cap.reads, relPath) || ids.some(id => covered(cap.reads, id))) return { ok: true }
  return {
    ok: false,
    denied: [relPath],
    message: scopeError([`read ${relPath}`], cap, [`  READ ${ids[0] ?? relPath}   (ask the planner to widen the claim)`]),
  }
}

// ---- minting ------------------------------------------------------------

export function slugify(hint: string): string {
  return hint
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // strip accents: Inés → ines
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Allocate a permanent id under conventions §2, collision-checked against
 *  what canon already holds. arc mints; the worker never invents. */
export function mintId(type: string, hint: string, taken: Set<string>): string {
  const prefix = TYPE_PREFIX[type]
  if (!prefix) throw new Error(`unknown type "${type}" — one of ${Object.keys(TYPE_PREFIX).join(', ')}`)
  const slug = slugify(hint)
  if (!slug) throw new Error(`hint "${hint}" produces no slug`)
  const base = `${prefix}.${slug}`
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}
