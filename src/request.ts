// The request: an author gesture, resolved by code to a cell and then a row
// (A67-8; agent-workflows §4, "The request").
//
// Every job begins as something the author did — pressed the route button on
// a scene, chose *rewrite from these notes* on a route — and the first thing
// arc does is resolve that into a cell: job, scope, mode, depth. A gesture
// resolves BY CODE: the surface and the selected object name the job and the
// scope, the control names the mode, and the only thing that can change
// depth is a word the author said.
//
// This lives where the gesture arrives — the route handlers — and grows a
// phrase path only in slices 7+, when the terminal takes a typed sentence.
//
// Two refusals, both in the author's words and both before any token:
// a cell the rows do not list (invariant 10), and a depth word the rows do
// not carry — never silently mapped to standard.
import { HttpError } from './http'
import { findRow, type Depth, type Job, type Mode, type Row, type Scope } from './registry'

/** What the author did, as the surface reports it. */
export interface Gesture {
  /** the author's own words for what they asked for */
  said: string
  job: Job
  scope: Scope
  mode: Mode
  /** a word the author used, if any — *quickly*, *thoroughly* */
  depth?: string
  /** what it was about: a scene id, a route id */
  subject: string
}

export interface ResolvedRequest {
  /** the gesture as the author made it — what the receipt records */
  gesture: string
  /** the cell it resolved to, as words */
  cell: string
  row: Row
  subject: string
}

const DEPTHS: Record<string, Depth> = {
  quick: 'quick', quickly: 'quick',
  standard: 'standard',
  full: 'full', thorough: 'full', thoroughly: 'full',
}

/** The depth a word means, or a refusal. Absent, the row's own depth stands
 *  — a gesture with no word said nothing about depth. */
export function resolveDepth(word: string | undefined): Depth | undefined {
  // Saying nothing — including sending an empty field — says nothing about
  // depth, and the row's own stands.
  if (!word?.trim()) return undefined
  const depth = DEPTHS[word.trim().toLowerCase()]
  if (!depth) {
    throw new HttpError(400, `arc does not know how to work "${word.trim()}" — it can go quickly, or take a standard pass, or go through thoroughly. Say one of those, or leave it out.`)
  }
  return depth
}

/** Resolve a gesture to the row that admits it, or refuse in the author's
 *  words. No row, no launch (invariant 10). */
export function resolveRequest(g: Gesture): ResolvedRequest {
  const depth = resolveDepth(g.depth)
  const row = findRow({ job: g.job, scope: g.scope, mode: g.mode, depth })
  if (!row) {
    const asked = depth ? `${describe(g)}, ${depth}` : describe(g)
    throw new HttpError(400, `arc cannot ${asked} yet — nothing was written. ${nearest(g, depth)}`)
  }
  return {
    gesture: g.said,
    cell: `${row.job} · ${row.scope} · ${row.mode}${row.depth === 'standard' ? '' : ` · ${row.depth}`}`,
    row,
    subject: g.subject,
  }
}

const describe = (g: Gesture): string => `${g.job} a ${g.scope}${g.mode === 'one-shot' ? '' : ` in ${g.mode}`}`

/** What the author can ask for instead, from the rows that DO exist — never
 *  a silent substitution, always their next keystroke. */
function nearest(g: Gesture, depth: Depth | undefined): string {
  // The advice must be about THIS cell: a row at another mode is not
  // something the author can reach by dropping the depth word.
  const sameCell = findRow({ job: g.job, scope: g.scope, mode: g.mode })
  if (sameCell && depth && depth !== sameCell.depth) {
    return `It can take a ${sameCell.depth} pass at that. Ask again without the word.`
  }
  return 'Ask for something it can do, or leave this one for a later arc.'
}
