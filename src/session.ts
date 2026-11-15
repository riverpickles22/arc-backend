// THE SESSION TIMER (A76-4): the author's own count of where their time goes.
//
// The record-maintenance burden is minutes keeping the record over minutes
// writing. Nothing in the record can see minutes, so the author counts them:
// a control in the viewer's header starts the count as writing or as the
// record, switches between the two, and stops. Nothing counts until the
// author starts it.
//
// THE STORE is working state in the story's .arc/, never committed and never
// in the commit lane (it touches no tracked file):
//   .arc/sessions.jsonl  one closed interval per line: {kind, start, end, ended}
//   .arc/session.json    the interval running now: {kind, start, active}
//   .arc/session.closed.json  the count arc last closed on its own, {kind, at},
//                        until the next press — kept apart from the intervals
//                        because a count closed with no activity after its
//                        start has no length and writes no line, and the
//                        author must still be told it stopped
// Starting one kind ends the other ('switched'); stop ends it ('stopped').
//
// A COUNT STAYS OPEN ONLY WHILE SOMETHING HAPPENS. Two signals say so, and
// either is enough:
//   - input in the viewer: while a count runs the viewer checks in once a
//     minute with the time of the author's last keystroke, click or scroll;
//   - a change to the story's files: the newest modification time under the
//     directories the prose and the record live in (STORY_DIRS) — read by
//     stat alone, never the contents — which is what proves the author
//     writing in their own editor with the viewer shut or asleep in a tab.
// When neither has shown anything for IDLE_MINUTES, the count is closed at
// the last activity, marked 'idle'. The check is lazy — it runs on the next
// read or write of the timer, whenever that is — and because file times are
// on disk, a check-in that arrives late (a suspended tab) or never cannot
// lose writing time the files prove: the activity is the latest of every
// signal, and only ever moves forward. arc's own writes into the prose (a
// draft landing in the working tree) change those files too, and are counted
// as activity; the record of a run is in .arc/, which is not read.
import fs from 'node:fs'
import path from 'node:path'
import type { SessionInterval, SessionKind, SessionState } from 'arc-canon-graph/api-types.ts'
import { STORY } from './config'

/** Nothing for this long, and the count is closed at the last thing that
 *  happened. The measure caps an inferred gap between commits at the same. */
export const IDLE_MINUTES = 30

/** WHERE THE AUTHOR'S WORK LIVES, ONE LIST FOR THE TWO THAT COUNT TIME (A81-3). The prose is writing;
 *  the canon, the notes, the docs (the style contract among them), the
 *  annotations, the locks and the material are the record. The timer reads
 *  a change under any of them as activity, and the measure's fallback reads
 *  a commit's files by the same two names (`kindOfCommit`) — one list, so a
 *  directory the timer counts and the fallback has never heard of cannot
 *  exist. Everything else in a story (history/, .arc/) is arc's own, and
 *  research/ and assets/ are counted by neither. `watch.ts` keeps its own
 *  list of what the viewer reloads on, which is a different question and
 *  leaves the locks out. */
export const PROSE_DIR = 'prose'
export const RECORD_DIRS: readonly string[] = ['canon', 'notes', 'docs', 'annotations', 'locks', 'material']
export const STORY_DIRS: readonly string[] = [PROSE_DIR, ...RECORD_DIRS]

/** Which kind of author time a path in the story is, or null for arc's own. */
export function kindOfPath(rel: string): SessionKind | null {
  // A path INSIDE one of the directories: a file at the story's root that
  // happens to be named for one is not in it.
  const slash = rel.indexOf('/')
  if (slash < 0) return null
  const top = rel.slice(0, slash)
  return top === PROSE_DIR ? 'writing' : RECORD_DIRS.includes(top) ? 'record' : null
}

export const SESSIONS_REL = path.join('.arc', 'sessions.jsonl')
const OPEN_REL = path.join('.arc', 'session.json')
const CLOSED_REL = path.join('.arc', 'session.closed.json')

function readClosedOnItsOwn(story: string): { kind: SessionKind; at: string } | null {
  try {
    const c = JSON.parse(fs.readFileSync(file(story, CLOSED_REL), 'utf8')) as { kind?: unknown; at?: unknown }
    return isSessionKind(c.kind) && typeof c.at === 'string' ? { kind: c.kind, at: c.at } : null
  } catch { return null }
}
const forgetClosed = (story: string): void => fs.rmSync(file(story, CLOSED_REL), { force: true })

interface Open { kind: SessionKind; start: string; active: string }

export const isSessionKind = (k: unknown): k is SessionKind => k === 'writing' || k === 'record'

const file = (story: string, rel: string): string => path.join(story, rel)

function readOpen(story: string): Open | null {
  try {
    const o = JSON.parse(fs.readFileSync(file(story, OPEN_REL), 'utf8')) as Partial<Open>
    return isSessionKind(o.kind) && typeof o.start === 'string' && typeof o.active === 'string' ? o as Open : null
  } catch { return null }
}

function writeOpen(story: string, o: Open | null): void {
  const p = file(story, OPEN_REL)
  if (!o) { fs.rmSync(p, { force: true }); return }
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(o) + '\n')
  fs.renameSync(tmp, p)
}

function readClosed(story: string): SessionInterval[] {
  let text = ''
  try { text = fs.readFileSync(file(story, SESSIONS_REL), 'utf8') } catch { return [] }
  return text.split('\n').filter(Boolean).flatMap(line => {
    try {
      const i = JSON.parse(line) as SessionInterval
      return isSessionKind(i.kind) && Date.parse(i.end) > Date.parse(i.start) ? [i] : []
    } catch { return [] }
  })
}

function close(story: string, o: Open, end: string, ended: SessionInterval['ended']): void {
  // a stretch with no length counted nothing; it is not worth a line
  if (Date.parse(end) > Date.parse(o.start)) {
    const p = file(story, SESSIONS_REL)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.appendFileSync(p, JSON.stringify({ kind: o.kind, start: o.start, end, ended } satisfies SessionInterval) + '\n')
  }
  if (ended === 'idle') {
    const c = file(story, CLOSED_REL)
    fs.mkdirSync(path.dirname(c), { recursive: true })
    fs.writeFileSync(c, JSON.stringify({ kind: o.kind, at: end }) + '\n')
  }
  writeOpen(story, null)
}

/** The newest modification time under the story's prose and record, in ms;
 *  0 when there is none. Stat only. */
export function newestChange(story = STORY): number {
  let newest = 0
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) { walk(abs); continue }
      try { newest = Math.max(newest, fs.statSync(abs).mtimeMs) } catch { /* gone */ }
    }
  }
  for (const d of STORY_DIRS) walk(path.join(story, d))
  return newest
}

/** The last activity a running count can show: its start, the viewer's last
 *  input, or the newest change to the files — whichever is latest, and never
 *  later than now. */
function lastActivity(story: string, o: Open, now: Date): number {
  return Math.min(now.getTime(), Math.max(Date.parse(o.start), Date.parse(o.active), newestChange(story)))
}

/** Close a running count nothing has happened in for the idle bound. */
function settle(story: string, now: Date): Open | null {
  const o = readOpen(story)
  if (!o) return null
  const last = lastActivity(story, o, now)
  if (now.getTime() - last > IDLE_MINUTES * 60_000) {
    close(story, o, new Date(last).toISOString(), 'idle')
    return null
  }
  return o
}

function stateOf(story: string, o: Open | null): SessionState {
  if (o) return { running: { kind: o.kind, since: o.start }, closed: null }
  const c = readClosedOnItsOwn(story)
  return { running: null, closed: c ? { ...c, idleMinutes: IDLE_MINUTES } : null }
}

export function sessionState(now = new Date(), story = STORY): SessionState {
  return stateOf(story, settle(story, now))
}

/** Start counting as `kind`. The other kind, running, ends here; the same
 *  kind, running, carries on — so a second press is harmless. */
export function startSession(kind: SessionKind, now = new Date(), story = STORY): SessionState {
  const at = now.toISOString()
  const o = settle(story, now)
  forgetClosed(story)
  if (o?.kind === kind) { const kept = { ...o, active: at }; writeOpen(story, kept); return stateOf(story, kept) }
  if (o) close(story, o, at, 'switched')
  const next = { kind, start: at, active: at }
  writeOpen(story, next)
  return stateOf(story, next)
}

export function stopSession(now = new Date(), story = STORY): SessionState {
  const o = settle(story, now)
  if (o) close(story, o, now.toISOString(), 'stopped')
  forgetClosed(story)
  return stateOf(story, null)
}

/** The viewer checks in, with the time of the author's last input in it. A
 *  late check-in never moves the activity back. */
export function pingSession(input: string | null, now = new Date(), story = STORY): SessionState {
  const o = settle(story, now)
  if (!o) return stateOf(story, null)
  const at = input && !Number.isNaN(Date.parse(input)) ? Math.min(Date.parse(input), now.getTime()) : 0
  const next = at > Date.parse(o.active) ? { ...o, active: new Date(at).toISOString() } : o
  if (next !== o) writeOpen(story, next)
  return stateOf(story, next)
}

/** Every counted interval, oldest first — READ ONLY, for the measure: the
 *  closed ones, and a running one up to its last activity. */
export function countedIntervals(story = STORY, now = new Date()): SessionInterval[] {
  const out = readClosed(story)
  const o = readOpen(story)
  if (o) {
    const last = lastActivity(story, o, now)
    if (last > Date.parse(o.start)) out.push({ kind: o.kind, start: o.start, end: new Date(last).toISOString(), ended: 'idle' })
  }
  return out.sort((a, b) => a.start.localeCompare(b.start))
}
