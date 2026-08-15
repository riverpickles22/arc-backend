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
import { lockViolations, resolveLocks } from 'arc-canon-graph/annotations.ts'
import { STORY } from './config'
import { HttpError } from './http'
import { proseScenes } from './story'

const DIR = () => path.join(STORY, 'locks')

function sceneBodies(): (scene: string) => string | null {
  const byScene = new Map(proseScenes().map(s => [s.scene, s.body]))
  return scene => byScene.get(scene) ?? null
}

/** Every lock on disk, resolved against the prose as it stands. */
export function locks(): ResolvedLock[] {
  const dir = DIR()
  if (!fs.existsSync(dir)) return []
  const out: LockLike[] = []
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.yaml')) continue
    const item = yamlLoad(fs.readFileSync(path.join(dir, name), 'utf8')) as LockLike | null
    if (item && typeof item.id === 'string') out.push(item)
  }
  return resolveLocks(out, sceneBodies())
}

/** The locks that bind on one scene, resolved against a caller-supplied body
 *  — the body about to be overwritten, not whatever is on disk mid-write. */
export function locksOn(scene: string, body: string): ResolvedLock[] {
  const dir = DIR()
  if (!fs.existsSync(dir)) return []
  const mine: LockLike[] = []
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.yaml')) continue
    const item = yamlLoad(fs.readFileSync(path.join(dir, name), 'utf8')) as LockLike | null
    if (item && typeof item.id === 'string' && item.anchor?.scene === scene) mine.push(item)
  }
  return resolveLocks(mine, s => (s === scene ? body : null))
}

/** Refuse `next` if it changes any paragraph locked in `current`. One
 *  sentence per lock, naming it — the refusal is the interface. */
export function assertUnlocked(scene: string, current: string, next: string, who: string): void {
  const hits = lockViolations(current, next, locksOn(scene, current))
  if (!hits.length) return
  const one = hits[0]
  throw new HttpError(423,
    `${scene}: paragraph ${one.paragraph + 1} is locked (${hits.map(h => h.lock.id).join(', ')}) — ` +
    `the author marked it settled. ${who} must leave it verbatim, or the author unlocks it first.`)
}

const fileFor = (id: string) => path.join(DIR(), `${id.replace(/^lock\./, 'lock-')}.yaml`)

function nextId(): string {
  const dir = DIR()
  const used = fs.existsSync(dir)
    ? fs.readdirSync(dir).map(n => Number(n.match(/^lock-(\d+)\.yaml$/)?.[1] ?? 0))
    : []
  return `lock.${String(Math.max(0, ...used) + 1).padStart(3, '0')}`
}

export function createLock(input: { scene: string; paragraph: number; quote: string }): ResolvedLock {
  if (!input.quote.trim()) throw new HttpError(400, 'a lock needs its quote — it is the durable anchor')
  const lock: LockLike = {
    id: nextId(),
    anchor: { scene: input.scene, paragraph: input.paragraph, quote: input.quote },
    created_at: new Date().toISOString(),
  }
  fs.mkdirSync(DIR(), { recursive: true })
  fs.writeFileSync(fileFor(lock.id), yamlDump(lock, { indent: 2, lineWidth: 100, noRefs: true, sortKeys: false }))
  return resolveLocks([lock], sceneBodies())[0]
}

export function removeLock(id: string): void {
  const file = fileFor(id)
  if (!fs.existsSync(file)) throw new HttpError(404, `no such lock: ${id}`)
  fs.unlinkSync(file)
}
