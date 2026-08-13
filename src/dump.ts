// The brain dump: the author's front door to the work graph.
//
// Everything under this is already built. orchestrate.runIntent runs intake,
// derives the claim, runs the capability-gated material worker, judges the
// result and leaves the run awaiting a decision — it has simply never been
// reachable from anything but a terminal. This module adds the two things a
// viewer needs: somewhere the raw words land immediately, and a pending run
// that survives between the filing request and the author's answer.
//
// RAW FIRST. The dump is written to disk before intake is even called. A pass
// that fails, an engine that hangs, a tab that closes mid-wait — none of them
// may cost the author the sentence they just thought of. That is the whole
// reason this module exists rather than the route calling runIntent directly.
import fs from 'node:fs'
import path from 'node:path'
import { load as yamlLoad } from 'js-yaml'
import { STORY } from './config'
import { HttpError } from './http'
import { currentEngine } from './engine'
import { decide, runIntent, type RunOutcome } from './orchestrate'
import type { Judgment } from './judge'

/** Where raw dumps land. Beside the run telemetry, because that is what this
 *  is — the input to a run, kept for as long as the run is interesting. The
 *  durable record of an ACCEPTED dump is its material file and its receipt. */
const dumpDir = (): string => path.join(STORY, '.arc', 'dumps')

export interface FiledItem { path: string; id: string; type: string; status: string; body: string }

export interface DumpResult {
  run: string
  filed: FiledItem[]
  /** The judge's reading. Wholly argued (conventions §11) — claims with
   *  evidence, and creative questions arc raises but never answers. */
  verdict: Judgment['verdict']
  argued: Judgment['argued']
  asked: Judgment['asked']
  /** What the worker said it did, in its own words. */
  reply: string
  /** Where the raw words were saved, so a failure can point at them. */
  saved: string
}

/** Write the author's words down, immediately and unconditionally. Returns the
 *  path so a later failure can tell them exactly where their text is. Never
 *  throws for a reason the author can do nothing about: a dump that cannot be
 *  saved must still be allowed to run. */
export function saveRaw(text: string, at: string): string {
  const rel = path.join('.arc', 'dumps', `${at.replace(/[:.]/g, '-')}.md`)
  try {
    fs.mkdirSync(dumpDir(), { recursive: true })
    fs.writeFileSync(path.join(STORY, rel), `${at}\n\n${text}\n`)
    return rel
  } catch (e) {
    console.error('[warn] could not save the raw dump (the run still goes ahead):', e)
    return ''
  }
}

export interface RawDump { file: string; at: string; text: string }

/** Every raw dump still on disk, newest first.
 *
 *  These are what the author actually typed, saved before any model ran. They
 *  are deliberately transient — under .arc/, gitignored — and exist so a
 *  failed pass costs a retry rather than a thought. */
export function listDumps(): RawDump[] {
  let names: string[]
  try {
    names = fs.readdirSync(dumpDir()).filter(n => n.endsWith('.md'))
  } catch {
    return []
  }
  const out: RawDump[] = []
  for (const file of names) {
    try {
      const body = fs.readFileSync(path.join(dumpDir(), file), 'utf8')
      // saveRaw writes "<iso>\n\n<text>\n" — split on the first blank line so
      // a dump that itself contains blank lines survives intact.
      const gap = body.indexOf('\n\n')
      const at = gap > 0 ? body.slice(0, gap).trim() : ''
      out.push({ file, at, text: (gap > 0 ? body.slice(gap + 2) : body).trimEnd() })
    } catch { /* a dump that cannot be read is not worth failing the list over */ }
  }
  return out.sort((a, b) => b.file.localeCompare(a.file))
}

/** Delete one raw dump.
 *
 *  Real deletion, unlike material — and the difference is principled. A raw
 *  dump is transient telemetry that has already done its job once the thought
 *  is filed; a material item is a record of intent, and conventions §12 keeps
 *  those ("dropped beats deletion — intent history is story history").
 *
 *  Takes a NAME, never a path: the traversal question does not arise if the
 *  caller was never able to ask it. */
export function deleteDump(file: string): void {
  if (!file || file.includes('/') || file.includes('\\') || file.includes('..') || !file.endsWith('.md')) {
    throw new HttpError(400, 'not a dump file name')
  }
  const abs = path.join(dumpDir(), file)
  if (!fs.existsSync(abs)) throw new HttpError(404, 'no such dump — it may already be gone')
  fs.unlinkSync(abs)
}

/** What the worker actually put on disk, read back from the files themselves
 *  rather than from anything the model said it did. The viewer shows the
 *  author what arc understood, so it has to be the record, not the claim. */
export function describeFiled(produced: { path: string; content: string }[]): FiledItem[] {
  return produced.map(p => {
    let item: Record<string, unknown> = {}
    try {
      item = (yamlLoad(p.content) ?? {}) as Record<string, unknown>
    } catch { /* an unparseable file is still worth naming */ }
    return {
      path: p.path,
      id: typeof item.id === 'string' ? item.id : path.basename(p.path, '.yaml'),
      type: typeof item.type === 'string' ? item.type : 'unknown',
      status: typeof item.status === 'string' ? item.status : 'unplaced',
      body: typeof item.body === 'string' ? item.body.trim() : '',
    }
  })
}

/** Runs filed but not yet answered.
 *
 *  slice 1's decide() takes the live RunOutcome, so the two HTTP requests have
 *  to be joined by something. A map is the honest amount of machinery: a
 *  restart loses the PENDING DECISION, never the work — the material files are
 *  already written and the raw dump is saved. Bounded so a long session cannot
 *  grow it without limit. */
const pending = new Map<string, RunOutcome>()
const MAX_PENDING = 32

export const pendingCount = (): number => pending.size

export async function fileDump(text: string): Promise<DumpResult> {
  const raw = text.trim()
  if (!raw) throw new HttpError(400, 'nothing to file')

  // Before anything that can fail.
  const saved = saveRaw(raw, new Date().toISOString())

  if (!currentEngine()) {
    throw new HttpError(503, `No generation engine available — your words are saved at ${saved || 'nowhere: the disk refused'} and nothing else ran.`)
  }

  const outcome = await runIntent(raw, 'ui')

  if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value as string)
  pending.set(outcome.run.id, outcome)

  return {
    run: outcome.run.id,
    filed: describeFiled(outcome.produced),
    verdict: outcome.judgment.verdict,
    argued: outcome.judgment.argued,
    asked: outcome.judgment.asked,
    reply: outcome.workerReply,
    saved,
  }
}

/** The author's answer. Keep leaves the material unplaced; discard marks each
 *  item dropped rather than deleting it — "dropped beats deletion — intent
 *  history is story history" (conventions §12). Either way a receipt lands. */
export async function decideDump(runId: string, keep: boolean, note?: string): Promise<{ receipt: string; dropped: string[] }> {
  const outcome = pending.get(runId)
  if (!outcome) {
    throw new HttpError(404, 'that run is no longer awaiting a decision — it was already answered, or the backend restarted. The material it filed is on disk either way.')
  }
  pending.delete(runId)
  return decide(outcome, keep ? 'accepted' : 'rejected', note)
}
