// Locks (A29): the author's "this passage is settled — work around it."
//
// A lock is an anchored record beside the annotations, resolved by the same
// rules on every read: it follows its prose when paragraphs shift, and
// orphans honestly when the passage is gone — an orphaned lock blocks
// nothing, because enforcing a lock whose text no longer exists would be
// locking a guess.
//
// The lock is real at the CHOKE POINT, not in the UI: every prose write
// funnels through proseWrite or the revision fan-out, and both refuse a
// change that fails lockViolations(). A grayed-out editor is decoration;
// the 423 is the lock.
//
// Stored in the story repo (locks/lock-NNN.yaml), not .arc: a lock is the
// author's recorded decision about their book, ratified by commit like any
// other story state.
import fs from 'node:fs'
import path from 'node:path'
import { dump as yamlDump, load as yamlLoad } from 'js-yaml'
import type { LockLike, ResolvedLock } from 'arc-canon-graph'
import { lockScope, lockViolations, resolveLocks } from 'arc-canon-graph/annotations.ts'
import { STORY } from './config'
import { HttpError } from './http'
import { proseScenes } from './story'

const DIR = () => path.join(STORY, 'locks')

function sceneBodies(): (scene: string) => string | null {
  const byScene = new Map(proseScenes().map(s => [s.scene, s.body]))
  return scene => byScene.get(scene) ?? null
}

/** Every lock record on disk, absorbed or not. One reader, so the two
 *  surfaces below cannot disagree about what exists. */
function readLocks(): LockLike[] {
  const dir = DIR()
  if (!fs.existsSync(dir)) return []
  const out: LockLike[] = []
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.yaml')) continue
    const item = yamlLoad(fs.readFileSync(path.join(dir, name), 'utf8')) as LockLike | null
    if (item && typeof item.id === 'string') out.push(item)
  }
  return out
}

/** The locks that currently DO anything: absorbed ones are excluded while
 *  their parent stands. The existence check is the whole of criterion 5 —
 *  a parent deleted by hand rather than through removeLock leaves its
 *  children pointing at nothing, and a lock absorbed by nothing enforces
 *  again, because the lock that was doing its work is gone. */
function activeLocks(all: LockLike[]): LockLike[] {
  const ids = new Set(all.map(l => l.id))
  return all.filter(l => !(l.absorbed_by && ids.has(l.absorbed_by)))
}

/** Every ACTIVE lock, resolved against the prose as it stands. An absorbed
 *  lock appears nowhere — the parent is one entry doing the work of many. */
export function locks(): ResolvedLock[] {
  return resolveLocks(activeLocks(readLocks()), sceneBodies())
}

/** The locks that bind on one scene, resolved against a caller-supplied body
 *  — the body about to be overwritten, not whatever is on disk mid-write. */
export function locksOn(scene: string, body: string): ResolvedLock[] {
  // A chapter lock covers every scene whose frontmatter names its chapter —
  // membership is the story's knowledge, read here, not the resolver's.
  const chapter = proseScenes().find(s => s.scene === scene)?.chapter ?? null
  const mine = activeLocks(readLocks()).filter(item =>
    item.anchor?.scene === scene || (chapter !== null && item.anchor?.chapter === chapter))
  return resolveLocks(mine, s => (s === scene ? body : null))
}

/** The refusal, in the author's terms: a paragraph number where one applies,
 *  the scope's own name where it does not (A40-1). One wording for every
 *  write path, so the 423 reads the same wherever it fires. */
export function describeViolation(scene: string, v: { lock: ResolvedLock; paragraph: number | null }): string {
  if (v.lock.scope === 'chapter') return `${scene}: this chapter is locked (${v.lock.id})`
  if (v.lock.scope === 'scene') return `${scene}: this section is locked (${v.lock.id})`
  return `${scene}: paragraph ${(v.paragraph ?? 0) + 1} is locked (${v.lock.id})`
}

/** Refuse `next` if it changes any paragraph locked in `current`. One
 *  sentence per lock, naming it — the refusal is the interface. */
export function assertUnlocked(scene: string, current: string, next: string, who: string): void {
  const hits = lockViolations(current, next, locksOn(scene, current))
  if (!hits.length) return
  throw new HttpError(423,
    `${describeViolation(scene, hits[0])} — the author marked it settled. ` +
    `${who} must leave it verbatim, or the author unlocks it first.`)
}

const fileFor = (id: string) => path.join(DIR(), `${id.replace(/^lock\./, 'lock-')}.yaml`)

function nextId(): string {
  const dir = DIR()
  const used = fs.existsSync(dir)
    ? fs.readdirSync(dir).map(n => Number(n.match(/^lock-(\d+)\.yaml$/)?.[1] ?? 0))
    : []
  return `lock.${String(Math.max(0, ...used) + 1).padStart(3, '0')}`
}

export function createLock(input: { scene?: string; chapter?: string; paragraph?: number; quote?: string }): ResolvedLock {
  const anchor: LockLike['anchor'] = {
    ...(input.scene != null ? { scene: input.scene } : {}),
    ...(input.chapter != null ? { chapter: input.chapter } : {}),
    ...(input.paragraph != null ? { paragraph: input.paragraph } : {}),
    ...(input.quote != null ? { quote: input.quote } : {}),
  }
  const scope = lockScope(anchor)
  if (scope === 'invalid') {
    throw new HttpError(400, 'a lock names a paragraph (with its quote), a scene, or a chapter — never a blend')
  }
  if (scope === 'paragraph' && !anchor.quote?.trim()) {
    throw new HttpError(400, 'a paragraph lock needs its quote — it is the durable anchor')
  }
  const lock: LockLike = { id: nextId(), anchor, created_at: new Date().toISOString() }
  fs.mkdirSync(DIR(), { recursive: true })
  fs.writeFileSync(fileFor(lock.id), yamlDump(lock, { indent: 2, lineWidth: 100, noRefs: true, sortKeys: false }))

  // A parent absorbs what it covers (A40-2): every narrower lock under it is
  // marked, stops enforcing, and stops rendering — the parent is doing its
  // work. Only the LINK is written; id, anchor, quote and created_at survive
  // untouched, because a paragraph lock is a decision the author made about a
  // specific passage and deleting six of those for one broad one would leave
  // them silently unlocked when the broad one lifts. A lock that is already
  // absorbed keeps its existing parent, so nesting unwinds layer by layer.
  if (scope === 'scene' || scope === 'chapter') {
    const covered = new Set(
      scope === 'scene'
        ? [input.scene!]
        : proseScenes().filter(sc => sc.chapter === input.chapter).map(sc => sc.scene))
    for (const other of readLocks()) {
      if (other.id === lock.id || other.absorbed_by) continue
      const otherScope = lockScope(other.anchor)
      const narrower = scope === 'chapter' ? (otherScope === 'scene' || otherScope === 'paragraph') : otherScope === 'paragraph'
      if (!narrower || !other.anchor.scene || !covered.has(other.anchor.scene)) continue
      fs.writeFileSync(fileFor(other.id),
        yamlDump({ ...other, absorbed_by: lock.id }, { indent: 2, lineWidth: 100, noRefs: true, sortKeys: false }))
    }
  }
  return resolveLocks([lock], sceneBodies())[0]
}

export function removeLock(id: string): void {
  const file = fileFor(id)
  if (!fs.existsSync(file)) throw new HttpError(404, `no such lock: ${id}`)
  fs.unlinkSync(file)
  // Lifting a parent gives its children back (A40-2): every lock it absorbed
  // enforces again exactly as it was — the record only ever carried the one
  // extra link, and removing it restores the original bytes.
  for (const other of readLocks()) {
    if (other.absorbed_by !== id) continue
    const restored = { ...other }
    delete restored.absorbed_by
    fs.writeFileSync(fileFor(other.id),
      yamlDump(restored, { indent: 2, lineWidth: 100, noRefs: true, sortKeys: false }))
  }
}
