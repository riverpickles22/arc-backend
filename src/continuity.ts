// WHAT THE RECORD CAN PROVE ABOUT A PROPOSAL THAT CHANGES WHAT IT HOLDS
// (A74-12; the contradiction gate's second half).
//
// arc-core's graph already computes the continuity checks — a person at two
// places in overlapping time, an object in two hands, a person in an event
// before they exist, an edge that starts before its ends do. This does not
// write a second version of any of them. It asks the graph the one question
// the gate needs: "if this record were in the book, what would the graph say
// that it does not say today?" Whatever it says anew, about the new record,
// is a contradiction code can show; nothing else is claimed. The model's own
// `conflicts_with` stays argued and is never promoted.
//
// A HAND-OVER is how an object's change of hands reaches the graph's custody
// check, which reads character states, not events: for the question only,
// the receiver is given a snapshot at the event's date that holds the object,
// and the giver (when the proposal names one) a snapshot that no longer does.
// Nothing of this is filed. Without a date there is no moment to hold the
// object at, so no custody claim is made.
import { loadGraph, stateAt, timeRefKey } from 'arc-canon-graph'
import type { CanonDoc, EventLike, TimeRef } from 'arc-canon-graph'
import type { BuiltCandidate, Proposal } from './proposals'

type Held = { possessions?: string[]; at: TimeRef } & Record<string, unknown>

/** The first thing the graph says with this record in the book that it did
 *  not say without it, or null. */
export function continuityConflict(doc: CanonDoc, cand: BuiltCandidate, p: Proposal): string | null {
  const isEdge = cand.collection === 'relationships'
  // A claim about WHEN needs a date: an era-wide interval overlaps everything
  // in the era, and a finding resting on it would blame the proposal for the
  // calendar. No date, no claim.
  if (!isEdge && !(cand.record as { when?: { date?: string } }).when?.date) return null
  const subject = p.subject.toLowerCase()
  // Only what concerns THIS proposal: the graph also reports faults the book
  // already had, in other words once a snapshot is added; those are not the
  // proposal's.
  const asked = (c: { check: string; message: string; about: string[] }): boolean =>
    isEdge ? c.about.includes(cand.id)
      : (c.check === 'custody' || c.check === 'co-location' || c.check === 'lifespan')
        && (c.about.includes(cand.id) || c.about.includes(subject))
  const before = new Set(loadGraph(doc).checks().map(f => f.message))

  const next: CanonDoc = structuredClone(doc)
  if (isEdge) (next.relationships ??= []).push(cand.record as unknown as CanonDoc['relationships'][number])
  else {
    const ev = cand.record as unknown as EventLike
    ;(next.events ??= {})[cand.id] = ev
    if (p.transfer && ev.when.date) handOver(next, p.subject.toLowerCase(), p.transfer, ev.when)
  }
  const found = loadGraph(next).checks().find(f => !before.has(f.message) && asked(f))
  return found ? found.message : null
}

function handOver(doc: CanonDoc, object: string, t: { to: string; from?: string }, when: TimeRef): void {
  const eras = doc.timeline?.eras ?? []
  const key = timeRefKey(when, eras)
  const snapshot = (id: string, change: (held: string[]) => string[]): void => {
    const ent = doc.entities?.[id]
    if (!ent || ent.type !== 'character') return
    const prior = stateAt(ent as { states?: Held[] }, key, eras)
    const states = (ent.states ??= []) as Held[]
    states.push({ ...(prior ?? {}), at: { era: when.era, date: when.date }, possessions: change(prior?.possessions ?? []) } as Held)
  }
  snapshot(t.to, held => [...new Set([...held, object])])
  if (t.from) snapshot(t.from, held => held.filter(x => x !== object))
}
