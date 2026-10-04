// THE COMMIT LANE (A72-2). One short mutation transaction at a time over the
// story repository, and the only place arc runs `git commit` in it.
//
// What this is for. A decision is not one call: it reads the current state,
// checks it, writes the scene, records the judgment, stages, commits, and puts
// the author's unaccepted words back. Every one of those steps was reachable
// from a route handler on its own, and `restoreWorking` runs in a `finally`
// after a commit — a window another request could be staging into. Nothing in
// arc said that sequence was indivisible, so nothing could keep it so.
//
// WHAT THE LANE IS, EXACTLY (invariant 11, and the boundary §7 of A72-2 asks
// to be stated rather than implied):
//  · It is PROCESS-LOCAL mutation exclusion. One arc process runs one
//    transaction at a time, and a transaction may not yield while it holds the
//    lane — which is why `inLane` refuses a thenable: an `await` inside a
//    transaction would reopen the window it exists to close.
//  · It is NOT a work queue. Slice 6 owns queueing, leases and unattended
//    work; a second request does not wait here, it is answered.
//  · It is NOT a claim over the files. The author's editor, a second arc, a
//    shell — none of them pass through here, and nothing in arc may say or
//    imply that they do. What arc can do about them is what it does: refuse
//    when it SEES a conflict (a foreign `index.lock`, a file that moved under
//    a restoration) rather than write over it.
//
// What a failure leaves behind: nothing. A transaction remembers the bytes it
// is about to change and the index entries it is about to stage, and puts both
// back if it does not reach its commit — so a refused decision records no
// verdict, stages nothing, and the next request works.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { STORY } from './config'
import { HttpError } from './http'

/** The story repository's git. Reading is free and needs no lane; every
 *  MUTATION belongs inside one (see `test/commit-lane.test.ts`, which
 *  enumerates the call sites). */
export function git(...args: string[]): string {
  return execFileSync('git', ['-C', STORY, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
}

/** What the author reads when something outside arc holds the story's index.
 *  Not a git word in it, and it ends in the next thing they can do (rule 9). */
const BUSY = 'Something else is writing to this story right now, so arc did not touch it. Wait a moment and try again.'

const gitDir = (): string => git('rev-parse', '--absolute-git-dir').trim()

/** The lock a git process holds while it writes the index. It is NEVER
 *  arc's to remove: a stale one means a crashed git, and only the person at
 *  the keyboard can tell that from a running one. */
function refuseForeignLock(): void {
  let lock: string
  try { lock = path.join(gitDir(), 'index.lock') } catch { return }   // not a repo: nothing to hold
  if (fs.existsSync(lock)) {
    console.error(`[lane] refused: ${lock} is held by something outside arc`)
    throw new HttpError(409, BUSY)
  }
}

/** A failure that is really the foreign lock, arriving after the preflight —
 *  git takes it at the moment it writes, not when we looked. The author reads
 *  the same sentence either way; the machine's words go to the log. */
function asAuthorError(e: unknown): unknown {
  if (e instanceof HttpError) return e
  const err = e as { stderr?: string | Buffer; message?: string }
  const text = String(err.stderr ?? '') + '\n' + String(err.message ?? '')
  if (/index\.lock|Another git process seems to be running/.test(text)) {
    console.error('[lane] the index was taken while a decision was being written:', text.trim())
    return new HttpError(409, BUSY)
  }
  return e
}

/** One index entry, as `git ls-files --stage` prints it. */
const entryPath = (line: string): string => line.slice(line.indexOf('\t') + 1)

export interface Tx {
  /** Remember these files' exact bytes (or their absence) before changing
   *  them, so a failure puts them back. Absolute paths. */
  keep(...absPaths: string[]): void
  /** What this transaction just wrote to a kept file. A rollback puts the
   *  old bytes back only if this is still what is on disk: if something
   *  outside arc has written since, that is an observed conflict and their
   *  words stay (the lane excludes arc from itself, not the author's
   *  editor). */
  wrote(abs: string, content: string): void
  /** Stage concrete paths, relative to the story root. `all` passes `-A`, so
   *  a scene the draft deletes stages its deletion. The index entries are
   *  remembered first; a failure restores exactly those. */
  stage(paths: string[], opts?: { all?: boolean }): void
  /** Commit ONLY what this transaction appended to an append-only record
   *  file (the evidence log), and put the rest back afterwards. The whole
   *  file would carry an earlier decision's verdict that was never committed
   *  — a different decision, and not this one's to ratify.
   *
   *  A path-scoped `git commit -- <paths>` takes the WORKING TREE's bytes and
   *  ignores the index, which is the mechanism the scene accepts already lean
   *  on: write what should land, commit, put the author's full file back. So
   *  this does the same rather than pretending the index decides.
   *
   *  The file must have been `keep`-ed first. False when there was nothing. */
  stageAppended(rel: string): boolean
  /** The commit. The ONE place arc runs `git commit` in the story. */
  commit(message: string, paths: string[]): void
}

interface TxInternal extends Tx { rollback(): void }

function newTx(): TxInternal {
  const kept = new Map<string, Buffer | null>()
  const expected = new Map<string, string>()
  const stagedPaths = new Set<string>()
  const indexBefore = new Map<string, string | null>()   // path → `ls-files --stage` line, or null
  const restoreAfterCommit = new Map<string, Buffer>()   // abs → the author's full file
  let committed = false

  const remember = (paths: string[]): void => {
    const unseen = paths.filter(p => !indexBefore.has(p))
    if (!unseen.length) return
    let lines: string[] = []
    try { lines = git('ls-files', '--stage', '--', ...unseen).split('\n').filter(Boolean) } catch { /* no index yet */ }
    const byPath = new Map(lines.map(l => [entryPath(l), l]))
    for (const p of unseen) indexBefore.set(p, byPath.get(p) ?? null)
  }

  return {
    keep(...absPaths: string[]): void {
      for (const abs of absPaths) {
        if (kept.has(abs)) continue
        try { kept.set(abs, fs.readFileSync(abs)) } catch { kept.set(abs, null) }
      }
    },

    wrote(abs: string, content: string): void {
      expected.set(abs, content)
    },

    stage(paths: string[], opts?: { all?: boolean }): void {
      if (!paths.length) return
      for (const p of paths) {
        if (p.startsWith('-')) throw new Error(`the lane stages paths, not flags: ${p}`)
      }
      remember(paths)
      for (const p of paths) stagedPaths.add(p)
      git('add', ...(opts?.all ? ['-A'] : []), '--', ...paths)
    },

    stageAppended(rel: string): boolean {
      const abs = path.join(STORY, rel)
      if (!kept.has(abs)) throw new Error(`${rel} must be kept before its delta can be committed`)
      const before = kept.get(abs)
      let now: Buffer
      try { now = fs.readFileSync(abs) } catch { return false }
      if (before && now.equals(before)) return false
      remember([rel])
      stagedPaths.add(rel)
      // Append-only is a property, not a hope: if what was there is no longer
      // a prefix of what is there, this transaction cannot tell its own
      // addition from someone else's rewrite, and says so by taking the file
      // whole — the old behaviour, with a line in the log.
      const appended = !before || now.subarray(0, before.length).equals(before)
      if (!appended) console.error(`[lane] ${rel} was rewritten, not appended to — committing it entire`)
      const added = before && appended ? now.subarray(before.length) : now
      if (!added.length) return false
      if (appended) {
        // What the book already holds, plus this decision's lines. The
        // earlier verdict goes back into the working tree after the commit,
        // still pending, still the author's to ratify with its own decision.
        let head = Buffer.alloc(0)
        try { head = execFileSync('git', ['-C', STORY, 'show', `HEAD:${rel}`], { maxBuffer: 16 * 1024 * 1024 }) } catch { /* not in the book yet */ }
        const landing = Buffer.concat([head, added])
        if (!landing.equals(now)) {
          fs.writeFileSync(abs, landing)
          expected.set(abs, landing.toString('utf8'))
          restoreAfterCommit.set(abs, now)
        }
      }
      git('add', '--', rel)
      return true
    },

    commit(message: string, paths: string[]): void {
      // `git commit -m msg --` with no pathspec commits the whole index —
      // which is every unrelated thing the author happened to have staged.
      // The lane commits what a decision NAMES, or it does not commit.
      if (!paths.length) throw new Error('the commit lane commits named paths, and this transaction named none')
      try {
        git('commit', '-m', message, '--', ...paths)
        committed = true
        // The pending lines this decision did not ratify, back where they
        // were — the same shape as a scene accept putting the author's
        // unaccepted words back once its own change is in the book.
        for (const [abs, full] of restoreAfterCommit) {
          try { fs.writeFileSync(abs, full) } catch (e2) { console.error(`[lane] could not put ${abs} back after the commit:`, e2) }
        }
      } catch (e) {
        // A refusal from the story's own commit gate is not an internal
        // error: it is the gate doing its job, and the author should read
        // what it said — the lock, the scene, and the way out.
        const err = e as { stderr?: string | Buffer; message?: string }
        const text = String(err.stderr ?? '') + '\n' + String(err.message ?? '')
        if (/lock-gate: refusing/.test(text)) {
          const lines = text.split('\n').filter(l => l.trim() && !/^\s*at /.test(l))
          const gate = lines.slice(lines.findIndex(l => /lock-gate: refusing/.test(l)))
            .filter(l => !/^(error|fatal):|Command failed/.test(l.trim()))
          throw new HttpError(423, gate.join(' ').replace(/\s+/g, ' ').trim())
        }
        throw e
      }
    },

    rollback(): void {
      if (committed) return   // past the commit there is nothing to undo here
      for (const [abs, bytes] of kept) {
        try {
          const want = expected.get(abs)
          if (want !== undefined) {
            let onDisk: string | null = null
            try { onDisk = fs.readFileSync(abs, 'utf8') } catch { onDisk = null }
            if (onDisk !== want) {
              console.error(`[lane] ${abs} changed outside arc while a decision was failing — left as it is`)
              continue
            }
          }
          if (bytes === null) fs.rmSync(abs, { force: true })
          else fs.writeFileSync(abs, bytes)
        } catch (e) { console.error(`[lane] could not put ${abs} back:`, e) }
      }
      const restore = [...indexBefore].filter(([p]) => stagedPaths.has(p))
      const back = restore.map(([, line]) => line).filter((l): l is string => l !== null)
      const gone = restore.filter(([, line]) => line === null).map(([p]) => p)
      try {
        if (back.length) execFileSync('git', ['-C', STORY, 'update-index', '--index-info'], { input: back.join('\n') + '\n' })
        if (gone.length) git('update-index', '--force-remove', '--', ...gone)
      } catch (e) { console.error('[lane] could not put the index back:', e) }
    },
  }
}

let held: string | null = null

/** Run one short mutation transaction over the story repo.
 *
 *  `what` is what arc is doing, in a few words, for the log and for the
 *  message a nested call would raise. The transaction MUST be synchronous:
 *  holding the lane across an `await` would reopen the window this exists to
 *  close, and no mutation arc makes needs to (a model never runs in here). */
export function inLane<T>(what: string, fn: (tx: Tx) => T): T {
  if (held) {
    // Not reachable from two requests — a transaction cannot yield — so this
    // is a transaction started inside another, which is arc's bug, not the
    // author's situation, and it is loud on purpose.
    throw new Error(`the commit lane is held by "${held}" and "${what}" tried to take it as well`)
  }
  refuseForeignLock()
  const tx = newTx()
  held = what
  let ok = false
  try {
    const out = fn(tx)
    if (out && typeof (out as { then?: unknown }).then === 'function') {
      throw new Error(`"${what}" returned a promise to the commit lane — a transaction must not yield while it holds it`)
    }
    ok = true
    return out
  } catch (e) {
    throw asAuthorError(e)
  } finally {
    if (!ok) tx.rollback()
    held = null
  }
}

/** Whether the lane is held, for a test that needs to prove it is released. */
export const laneHolder = (): string | null => held
