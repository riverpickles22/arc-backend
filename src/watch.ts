// arc's own watcher: what actually happened on disk.
//
// Hooks say what an agent MEANT to do. The watcher says what happened, and it
// is the only one of the two that also sees VS Code, a shell script, a git
// checkout, or the author's own editor. Claude Code's FileChanged hook cannot
// substitute — its matcher accepts only letters, digits, underscore and pipe,
// so it cannot express canon/**/*.yaml, and it only ever sees Claude's writes.
//
// THE HONESTY RULE (work-graph.md §10). A change inside an active run's write
// set belongs to that run. Everything else is EXTERNAL, and must be surfaced
// as such. The failure to avoid is not missing an attribution — it is claiming
// one: a run credited with a change it did not make turns the receipt from a
// record into a guess. So attribution is deliberately conservative, and
// anything ambiguous is reported external.
import fs from 'node:fs'
import path from 'node:path'
import { STORY } from './config'
import { publishStream } from './run'
import { claimantOf } from './runs'

/** The story's own record and its prose. Notably NOT .arc/, which is machine
 *  working state (conventions §9) and changes constantly for reasons no author
 *  needs to see. `notes/` is watched because an author editing their notebook
 *  in another editor is exactly the kind of change worth knowing about. */
const WATCHED = ['canon', 'material', 'docs', 'prose', 'annotations', 'notes']

const IGNORED = ['.arc', '.git', 'node_modules', '.DS_Store']

/** Long enough that a save and its editor's temp-file shuffle land together,
 *  short enough that the viewer feels live. */
const DEBOUNCE_MS = 250

interface FileChange { path: string; run: string | null }

const isWatched = (rel: string): boolean =>
  WATCHED.some(d => rel === d || rel.startsWith(d + path.sep)) &&
  !IGNORED.some(bad => rel.split(path.sep).includes(bad))

/** The attribution rule itself, as one function: which run, if any, owns each
 *  path. `flush` is its only caller in production and the tests are the other,
 *  which is the point — a rule the tests exercise and the watcher re-implements
 *  is a rule that can pass its tests while drifting. */
export const classify = (paths: string[]): FileChange[] =>
  paths.filter(isWatched).map(p => ({ path: p, run: claimantOf(p) }))

let watcher: fs.FSWatcher | null = null
let pending = new Set<string>()
let timer: NodeJS.Timeout | null = null

/** Flush what changed, attributing each path once, and say so on the stream.
 *
 *  Attribution happens HERE rather than at the moment of the event because the
 *  debounce window is also the window a run needs to record its claim — a
 *  material write and the claim expansion that authorised it are milliseconds
 *  apart, and evaluating too early would call arc's own work external. */
function flush(): void {
  const paths = [...pending].sort()
  pending = new Set()
  if (!paths.length) return

  const changes = classify(paths)
  const external = changes.filter(c => c.run === null)

  // One message per run that owned something, so a subscriber can attribute
  // without re-deriving anything...
  const byRun = new Map<string, string[]>()
  for (const c of changes) {
    if (c.run) byRun.set(c.run, [...(byRun.get(c.run) ?? []), c.path])
  }
  for (const [run, files] of byRun) {
    publishStream({ run, at: new Date().toISOString(), event: 'files.changed', detail: { files } })
  }

  // ...and one for everything nobody claimed, which is the honest half.
  if (external.length) {
    publishStream({
      run: null,
      at: new Date().toISOString(),
      event: 'files.external',
      detail: { files: external.map(c => c.path) },
    })
  }
}

/** Start watching. Idempotent, and never fatal: a story without a watchable
 *  tree is a story arc still serves — losing live updates is a smaller harm
 *  than refusing to start. */
export function startWatcher(): void {
  if (watcher) return
  try {
    watcher = fs.watch(STORY, { recursive: true }, (_event, filename) => {
      if (!filename) return
      const rel = filename.toString()
      if (!isWatched(rel)) return
      pending.add(rel)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        try {
          flush()
        } catch (e) {
          // An unreadable or vanishing path must never take the server with it.
          console.error('[warn] watcher flush failed:', e)
        }
      }, DEBOUNCE_MS)
    })
    watcher.on('error', e => {
      console.error('[warn] watcher error (continuing without live file events):', e)
    })
  } catch (e) {
    console.error('[warn] could not start the file watcher (arc runs fine without it):', e)
    watcher = null
  }
}

export function stopWatcher(): void {
  if (timer) { clearTimeout(timer); timer = null }
  watcher?.close()
  watcher = null
  pending = new Set()
}

export const watchedPrefixes = (): string[] => [...WATCHED]
