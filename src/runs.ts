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
//
// A run's STATE is from the closed set (api-types RunState; A67-3): queued ·
// paused · running · waiting for you · refused · failed · cancelled · done.
// It holds the launches the run has in flight, so a stop reaches the child
// (stopRun), and every way a run ends goes through endRun, which writes the
// ending to the record.
import fs from 'node:fs'
import path from 'node:path'
import { STORY } from './config'
import type { Launch } from './engine'
import { HttpError } from './http'
import { Run, deleteTranscripts, endingOnDisk, readWorkingReceipt, subscribeRuns, writeWorkingReceipt, type RunEvent, type RunRoot, type Source } from './run'
import type { RunOutcome } from './orchestrate'
import type { DeleteTranscriptResponse, RunEnding, RunState, RunSummary } from 'arc-canon-graph'

interface Entry {
  run: Run
  state: RunState
  decision?: RunSummary['decision']
  /** Present once a pipeline has produced something to decide about. */
  outcome?: RunOutcome
  /** the children in flight — what a stop kills */
  launches: Set<Launch>
}

/** The states a run is over in. */
export const OVER: ReadonlySet<RunState> = new Set<RunState>(['refused', 'failed', 'cancelled', 'done'])

/** The state an ending leaves a run in. */
export function stateOfEnding(ending: RunEnding): RunState {
  switch (ending) {
    case 'landed': return 'done'
    case 'refused': return 'refused'
    case 'cancelled': return 'cancelled'
    default: return 'failed'
  }
}

/** Live runs, newest last. Bounded: a long session must not grow this without
 *  limit, and a finished run's durable record is its receipt, not this. */
const live = new Map<string, Entry>()
const MAX_LIVE = 64

function remember(entry: Entry): void {
  if (live.size >= MAX_LIVE) {
    // Evict the oldest OVER run; never evict one still working or waiting.
    const victim = [...live.entries()].find(([, e]) => OVER.has(e.state))
    if (victim) live.delete(victim[0])
  }
  live.set(entry.run.id, entry)
}

const summarise = (e: Entry): RunSummary => ({
  id: e.run.id,
  touching: [...(touched.get(e.run.id) ?? [])],
  source: e.run.root.source,
  prompt: e.run.root.raw_author_input,
  started_at: e.run.root.started_at,
  state: e.state,
  events: e.run.events.length,
  ...(e.run.ending ? { ending: e.run.ending } : {}),
  ...(e.run.root.subject ? { subject: e.run.root.subject } : {}),
  ...(e.decision ? { decision: e.decision } : {}),
})

export const listRuns = (): RunSummary[] => [...live.values()].map(summarise).reverse()

/** The registry's state for a run, or null when it holds none. */
export const stateOf = (id: string): RunState | null => live.get(id)?.state ?? null

export function getRun(id: string): { run: RunSummary; events: RunEvent[] } {
  const e = live.get(id)
  if (e) return { run: summarise(e), events: e.run.events }

  // Not in memory: it may still be on disk from an earlier boot. The events
  // log is the record, so read it rather than pretending the run never was.
  const dir = path.join(STORY, '.arc', 'runs', id)
  if (!/^run\.\d+$/.test(id) || !fs.existsSync(dir)) throw new HttpError(404, `no such run: ${id}`)
  let root: Partial<{ source: Source; raw_author_input: string; started_at: string; subject: string }> = {}
  try {
    root = JSON.parse(fs.readFileSync(path.join(dir, 'root.json'), 'utf8'))
  } catch { /* a run without a readable root is still worth listing its events */ }
  let events: RunEvent[] = []
  try {
    events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l) as RunEvent)
  } catch { /* no events yet */ }

  // How it ended is on the record; a run with no ending after a restart did
  // not finish, and says so rather than reading as closed.
  const ended = endingOnDisk(id)
  const ending: RunEnding | undefined = ended === 'decided' ? undefined : (ended ?? 'unfinished')
  const state: RunState = ended === 'decided' ? 'done' : stateOfEnding(ending ?? 'unfinished')
  return {
    run: {
      id,
      source: root.source ?? 'external',
      prompt: root.raw_author_input ?? '',
      started_at: root.started_at ?? '',
      state,
      ...(ending ? { ending } : {}),
      ...(root.subject ? { subject: root.subject } : {}),
      events: events.length,
      touching: [],
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
  const entry: Entry = { run: new Run(source, text), state: 'running', launches: new Set() }
  remember(entry)
  return summarise(entry)
}

/** Register a run created elsewhere — a route run, a lens fan-out — so it is
 *  listed, streamed, joinable by the hook and stoppable while it works. */
export function registerRun(run: Run): void {
  remember({ run, state: 'running', launches: new Set() })
}

/** Adopt a run created by a pipeline (a note being worked in, say) so it is
 *  visible and decidable over HTTP like any other. */
export function adoptRun(outcome: RunOutcome): void {
  remember({ run: outcome.run, state: 'waiting for you', outcome, launches: new Set() })
}

/** The outcome a decision needs, or a 404 that explains itself. */
export function pendingOutcome(id: string): RunOutcome {
  const e = live.get(id)
  if (!e?.outcome || e.state !== 'waiting for you') {
    throw new HttpError(404, 'that run is not awaiting a decision — it was already answered, or the backend restarted. Anything it produced is on disk either way.')
  }
  return e.outcome
}

/** A child the run has in flight. Detach when it has answered, so a stop
 *  after that kills nothing. */
export function attachLaunch(id: string, launch: Launch): () => void {
  const e = live.get(id)
  if (!e) return () => {}
  // A child spawned after the run ended — a repair that was already in the
  // air when the author stopped it — is stopped now rather than left
  // running with nothing holding it.
  if (OVER.has(e.state)) { launch.stop(); return () => {} }
  e.launches.add(launch)
  return () => { e.launches.delete(launch) }
}

/** End a run with its ending (invariant 9): the state follows the ending,
 *  the record gets `run.ended`, and any child still in flight is killed —
 *  no run ends with a process it does not know about. */
export function endRun(id: string, ending: RunEnding, detail?: unknown): RunSummary | null {
  const e = live.get(id)
  if (!e) return null
  // The first ending wins, here as in the record: a failure on the way out
  // of a run the author already stopped does not relabel it.
  if (OVER.has(e.state)) return summarise(e)
  for (const l of e.launches) l.stop()
  e.launches.clear()
  e.state = stateOfEnding(ending)
  e.run.end(ending, detail)
  return summarise(e)
}

/** The author's decision closes a run: accepted and rejected are decisions
 *  and the run is done; abandoned ends it cancelled. Reaches any child
 *  still working — never an in-memory state change alone. */
export function closeRun(id: string, decision: RunSummary['decision']): void {
  const e = live.get(id)
  if (!e) return
  e.decision = decision
  // The ENDING says how the run ended; the DECISION says what the author
  // did with what it produced. A rejected proposal still landed — the pass
  // produced something that passed its gates and reached the author — and
  // the two words sit side by side on the summary rather than one standing
  // in for the other. Abandoned is the author cancelling the work itself.
  endRun(id, decision === 'abandoned' ? 'cancelled' : 'landed', { decision })
  // The decision is made; stop holding the graph.
  e.outcome = undefined
}

/** Stop a run now: every child it has in flight is killed, what landed
 *  stays, and the run ends `cancelled`. A run that is already over is left
 *  as it ended — a stop is not a second ending. */
export function stopRun(id: string): RunSummary {
  const e = live.get(id)
  if (!e) throw new HttpError(404, `no such active run: ${id} — it is not running, or the backend restarted`)
  if (OVER.has(e.state)) return summarise(e)
  const waiting = e.outcome
  const out = endRun(id, 'cancelled', { stopped_by: 'author', while: e.state })!
  // What already passed its gates stays: a run stopped while it waited for
  // the author keeps the proposal it was holding, and the author can still
  // decide it.
  e.outcome = waiting
  return out
}

/** Remove the transcripts a run's launches named, by id — the run record
 *  stays. Works for a run this process never held: the record is on disk. */
export function deleteRunTranscripts(id: string): DeleteTranscriptResponse {
  if (!/^run\.\d+$/.test(id) || !fs.existsSync(path.join(STORY, '.arc', 'runs', id))) throw new HttpError(404, `no such run: ${id}`)
  const state = stateOf(id)
  if (state && !OVER.has(state)) {
    throw new HttpError(409, `${id} is still ${state} — stop it first, or wait; a transcript deleted under a live child is a file the runtime keeps writing to and nobody can read`)
  }
  const removed = deleteTranscripts(id)
  // INVARIANT 9: EVERY RUN ENDS WITH A RECEIPT. A run killed with the backend
  // has none — nobody was there to write it — and it sits in `arc doctor`'s
  // count as a run record with no receipt. Deleting its transcript by id is
  // the author saying they are done with it, and it is the first moment arc
  // can honestly close it: `unfinished` is exactly what happened, and it is
  // in the ending set for this reason (A67-12).
  closeUnfinished(id)
  return { run: id, removed }
}

/** Put the ending on a run that was killed before it could finish its own
 *  record. The receipt is written before the first token, so what a kill
 *  leaves is an OPEN receipt — everything the run had got as far as recording,
 *  with no ending on it. That record is kept exactly as it stands and only the
 *  ending is added; a receipt that already has one is never touched. */
function closeUnfinished(id: string): void {
  const dir = path.join(STORY, '.arc', 'runs', id)
  const at = new Date().toISOString()
  const open = readWorkingReceipt(id)
  // BOTH RECORDS, EVERY TIME. A receipt that already ended is never written
  // over — but its event log may still be missing the `run.ended` that the
  // briefing reads, and a run that is closed in one record and open in the
  // other is a row the author can press forever. So the ending is written
  // where it is missing, in either record, and nowhere it is not.
  if (open?.ending) { if (!endingOnDisk(id)) endedEvent(dir, at, open.ending) ; return }
  if (open) {
    writeWorkingReceipt({ ...open, ending: 'unfinished', decided_at: open.decided_at || at })
    if (!endingOnDisk(id)) endedEvent(dir, at)
    return
  }
  // `raw_author_input` is what the root record calls it, and it is the one
  // field that says what the AUTHOR asked for — reading it under any other
  // name closes the run with that field blank, every time.
  let root: RunRoot | null = null
  try { root = JSON.parse(fs.readFileSync(path.join(dir, 'root.json'), 'utf8')) as RunRoot } catch { /* a run with no root is closed on what we have */ }
  writeWorkingReceipt({
    run_id: id,
    source: root?.source ?? 'ui',
    raw_author_input: root?.raw_author_input ?? '',
    started_at: root?.started_at ?? at,
    decided_at: at,
    story_revision: null,
    story_revision_at_decision: null,
    ending: 'unfinished',
    intent: null,
    claims: [],
    scope_expansions: [],
    context_manifest: [],
    checks: null,
    judgment: null,
    result: { records: [], commit: null },
  })
  if (!endingOnDisk(id)) endedEvent(dir, at)
}

/** The run's own event log says it ended too. TWO READERS ASK THE SAME
 *  QUESTION — the briefing reads `events.jsonl` for a `run.ended`, `arc
 *  doctor` reads the receipt for an ending — and a close that wrote only one
 *  of them would leave the briefing offering a gesture that had already been
 *  made, forever. Where two records answer one question, both are written or
 *  neither is. */
function endedEvent(dir: string, at: string, ending: RunEnding = 'unfinished'): void {
  try {
    fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({
      at, event: 'run.ended',
      detail: { ending, detail: { closed_by: 'author', while: 'its working notes were let go' } },
    }) + '\n')
  } catch { /* working state; the receipt is the record */ }
}

/** A run arc OBSERVED rather than executed — a Claude Code session's own
 *  prompt (work-graph §10) — is over when the session stops answering. It
 *  gets no ending: arc did not run it and has no receipt to close. */
export function finishObserved(id: string): void {
  const e = live.get(id)
  if (!e || OVER.has(e.state)) return
  e.state = 'done'
}

/** The ids the registry still holds as not over — what the briefing must
 *  not report as runs that did not finish. */
export const liveIds = (): Set<string> =>
  new Set([...live.entries()].filter(([, e]) => !OVER.has(e.state)).map(([id]) => id))

/** Record something that happened outside arc's own execution — a tool a
 *  Claude session ran, for instance. Observed, never planned: arc reports what
 *  has happened and never claims to know what comes next (work-graph.md §10). */
export function observe(id: string, detail: unknown): void {
  const e = live.get(id)
  if (!e) throw new HttpError(404, `no such active run: ${id}`)
  e.run.emit('task.completed', undefined, detail)
}

// ---- attribution: whose change was that? ---------------------------------
//
// The watcher needs to know, for a path that just changed, whether a run
// authorised it. The answer has to be available WHILE the run works, not after
// it finishes — a material write and the claim expansion that authorised it
// are milliseconds apart, and a run that has not yet been adopted is still a
// run doing governed work.
//
// So the table is built from the bus. Every widening emits `claim.expanded`
// naming what was granted, which is exactly the statement "this run is about
// to write this". Nothing here needs the Run object, so nothing here needs a
// dependency on how runs are executed.

interface Claimed { run: string; at: number }

const claims = new Map<string, Claimed>()

/** runId → the ids it holds write or propose over. What the viewer marks. */
const touched = new Map<string, Set<string>>()

/** How long a claim keeps explaining a change. Long enough to cover a slow
 *  worker, short enough that a finished run stops taking credit for an edit
 *  the author made afterwards in their own editor. */
const CLAIM_TTL_MS = 5 * 60_000

/** `mat.hog-hunters` is written to `material/hog-hunters.yaml` — the minting
 *  convention, and the only id→path mapping arc actually makes. Anything that
 *  already looks like a path is taken as one. */
function pathsFor(granted: string): string[] {
  const token = granted.replace(/^(WRITE|CREATE|PROPOSE)\s+/i, '').trim()
  if (token.includes('/')) return [token]
  if (token.startsWith('mat.')) return [`material/${token.slice('mat.'.length)}.yaml`]
  return []
}

subscribeRuns(msg => {
  if (!msg.run) return
  if (msg.event === 'claim.expanded') {
    const granted = (msg.detail as { granted?: string } | undefined)?.granted ?? ''
    for (const p of pathsFor(granted)) claims.set(p, { run: msg.run, at: Date.now() })

    // The id itself, for the viewer. Only WRITE and PROPOSE — a read is not a
    // claim on the world and must never light a node up.
    const m = /^(WRITE|PROPOSE)\s+(\S+)/i.exec(granted.trim())
    if (m) {
      const set = touched.get(msg.run) ?? new Set<string>()
      set.add(m[2])
      touched.set(msg.run, set)
    }
  }
  if (msg.event === 'author.decision') touched.delete(msg.run)
})

/** The run that authorised this change, or null when nothing did.
 *
 *  Conservative on purpose: an unclaimed path is EXTERNAL, and being wrong in
 *  that direction costs a truthful "changed outside a run" where being wrong
 *  the other way credits a run with work it never did. */
export function claimantOf(relPath: string): string | null {
  const hit = claims.get(relPath)
  if (!hit) return null
  if (Date.now() - hit.at > CLAIM_TTL_MS) { claims.delete(relPath); return null }
  return hit.run
}

/** Test seam: a fresh table, so one test's claims cannot explain another's. */
export const _resetClaims = (): void => { claims.clear(); touched.clear() }
