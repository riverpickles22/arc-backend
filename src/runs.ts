// The run registry: what arc is doing right now, on the wire.
//
// The run machinery has existed since A13-2 and has been reachable only from a
// terminal — run.ts's own header says events.jsonl is "what a UI tails", and
// nothing has ever tailed it. This module is the registry that makes a run
// addressable: created before intake has decided anything, readable while it
// works, and closed by the author's decision.
//
// It also absorbs the map work.ts was keeping. That map existed for exactly
// one reason — decide() needs the live RunOutcome, and the two HTTP requests
// had to be joined by something — which is this, built properly.
import fs from 'node:fs'
import path from 'node:path'
import { STORY } from './config'
import { HttpError } from './http'
import { Run, type RunEvent, type Source } from './run'
import type { RunOutcome } from './orchestrate'

export interface RunSummary {
  id: string
  source: Source
  prompt: string
  started_at: string
  /** Where the run has got to. `awaiting` means it is the author's move. */
  state: 'working' | 'awaiting' | 'closed'
  events: number
  /** Set once the author has answered. */
  decision?: 'accepted' | 'rejected' | 'abandoned'
}

interface Entry {
  run: Run
  state: RunSummary['state']
  decision?: RunSummary['decision']
  /** Present once a pipeline has produced something to decide about. */
  outcome?: RunOutcome
}

/** Live runs, newest last. Bounded: a long session must not grow this without
 *  limit, and a closed run's durable record is its receipt, not this. */
const live = new Map<string, Entry>()
const MAX_LIVE = 64

function remember(entry: Entry): void {
  if (live.size >= MAX_LIVE) {
    // Evict the oldest CLOSED run; never evict one still awaiting an answer.
    const victim = [...live.entries()].find(([, e]) => e.state === 'closed')
    if (victim) live.delete(victim[0])
  }
  live.set(entry.run.id, entry)
}

const summarise = (e: Entry): RunSummary => ({
  id: e.run.id,
  source: e.run.root.source,
  prompt: e.run.root.raw_author_input,
  started_at: e.run.root.started_at,
  state: e.state,
  events: e.run.events.length,
  ...(e.decision ? { decision: e.decision } : {}),
})

export const listRuns = (): RunSummary[] => [...live.values()].map(summarise).reverse()

export function getRun(id: string): { run: RunSummary; events: RunEvent[] } {
  const e = live.get(id)
  if (e) return { run: summarise(e), events: e.run.events }

  // Not in memory: it may still be on disk from an earlier boot. The events
  // log is the record, so read it rather than pretending the run never was.
  const dir = path.join(STORY, '.arc', 'runs', id)
  if (!/^run\.\d+$/.test(id) || !fs.existsSync(dir)) throw new HttpError(404, `no such run: ${id}`)
  let root: Partial<{ source: Source; raw_author_input: string; started_at: string }> = {}
  try {
    root = JSON.parse(fs.readFileSync(path.join(dir, 'root.json'), 'utf8'))
  } catch { /* a run without a readable root is still worth listing its events */ }
  let events: RunEvent[] = []
  try {
    events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l) as RunEvent)
  } catch { /* no events yet */ }

  return {
    run: {
      id,
      source: root.source ?? 'external',
      prompt: root.raw_author_input ?? '',
      started_at: root.started_at ?? '',
      state: 'closed',
      events: events.length,
    },
    events,
  }
}

/** Open a run from a raw prompt and return immediately.
 *
 *  Nothing about this waits for a model. That is the point: the hook that
 *  calls it (A14-2) is synchronous with a thirty-second budget, while intake
 *  alone measured ~9s and the judge ~50s. So the run exists, carrying the
 *  author's own words, and the structured reading fills in later. */
export function openRun(prompt: string, source: Source = 'external'): RunSummary {
  const text = prompt.trim()
  if (!text) throw new HttpError(400, 'prompt required')
  const entry: Entry = { run: new Run(source, text), state: 'working' }
  remember(entry)
  return summarise(entry)
}

/** Adopt a run created by a pipeline (a note being worked in, say) so it is
 *  visible and decidable over HTTP like any other. */
export function adoptRun(outcome: RunOutcome): void {
  remember({ run: outcome.run, state: 'awaiting', outcome })
}

/** The outcome a decision needs, or a 404 that explains itself. */
export function pendingOutcome(id: string): RunOutcome {
  const e = live.get(id)
  if (!e?.outcome || e.state !== 'awaiting') {
    throw new HttpError(404, 'that run is not awaiting a decision — it was already answered, or the backend restarted. Anything it produced is on disk either way.')
  }
  return e.outcome
}

export function closeRun(id: string, decision: RunSummary['decision']): void {
  const e = live.get(id)
  if (!e) return
  e.state = 'closed'
  e.decision = decision
  e.outcome = undefined            // the decision is made; stop holding the graph
}

/** Record something that happened outside arc's own execution — a tool a
 *  Claude session ran, for instance. Observed, never planned: arc reports what
 *  has happened and never claims to know what comes next (work-graph.md §10). */
export function observe(id: string, detail: unknown): void {
  const e = live.get(id)
  if (!e) throw new HttpError(404, `no such active run: ${id}`)
  e.run.emit('task.completed', undefined, detail)
}
