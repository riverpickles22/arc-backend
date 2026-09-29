// THE SIBLING LADDER (A69-7; agent-workflows §4, "Position"). The other
// scenes of a chapter reach a writing pass on a rung each — full prose, then
// the contract with its reader_after and its last locked paragraph, then the
// summary line — chosen by how far each sits from the scene being written,
// and lowered a rung at a time before the layer is dropped for room. The
// rung is named on the receipt, so "arc showed the pass the whole of the
// scene before" and "arc showed it one line" are two different facts the
// author can read.
//
// ONE DEFINITION. The route rows (U4, U5) hand their pass the chapter's other
// scenes too, and read this same ladder: two ladders would let the brief a
// draft is written from and the brief a route is written from name the same
// scene at two different rungs while both receipts said "siblings". The
// redraft pass still composes its own siblings block until its row lands
// (A69-8), and that is the last of them.
import type { ProseScene, ResolvedLock } from 'arc-canon-graph'
import { splitSentences } from 'arc-canon-graph'
import { paragraphsOf } from 'arc-canon-graph/annotations.ts'
import { lockResolver } from './locks'

export type Rung = 'full' | 'contract' | 'summary'
export const RUNGS = ['full', 'contract', 'summary'] as const

/** One sibling on the ladder, as the receipt names it. */
export interface SiblingRung { scene: string; rung: Rung; distance: number }

export interface Ladder {
  /** every sibling with the rung it stands on now, nearest first */
  readonly rungs: readonly SiblingRung[]
  /** the layer as the brief carries it; empty when the chapter has no other scene */
  text(): string
  /** the rungs in the author's words — `sc.01-1 at full; sc.01-3 at contract` */
  note(): string
  /** Lower ONE sibling one rung — the farthest that can still go down —
   *  and say whether anything moved. The nearest scene is the last to lose
   *  its prose, because it is the one the writing must not retell. */
  lower(): boolean
}

/** A chapter's scenes in the order the book reads them: file order within
 *  the chapter (conventions §10), which is the order `proseScenes()` hands
 *  them over in. Ids are permanent and a scene inserted later may carry any
 *  tail the schema allows — `sc.01-2b` between 2 and 3 — so the number in
 *  the id never orders them. */
export function chapterScenes(chapter: string, scenes: ProseScene[]): ProseScene[] {
  return scenes.filter(s => s.chapter === chapter)
}

/** Where a subject sits in its chapter: its index when it is on disk, and
 *  one past the last scene when it is not yet written — a draft is the
 *  chapter's next scene. */
export function placeInChapter(
  subject: { chapter: string; sceneId?: string }, scenes: ProseScene[],
): { chapter: ProseScene[]; at: number } {
  const chapter = chapterScenes(subject.chapter, scenes)
  const i = subject.sceneId ? chapter.findIndex(s => s.scene === subject.sceneId) : -1
  return { chapter, at: i >= 0 ? i : chapter.length }
}

/** The rung a sibling starts on, by distance: the scene either side in full,
 *  the next at its contract, the rest as one line. Provisional, like every
 *  figure on a row — reset from the first ten receipts. */
export function rungFor(distance: number): Rung {
  return distance <= 1 ? 'full' : distance === 2 ? 'contract' : 'summary'
}

/** The subject's siblings — the other scenes of its chapter — nearest first,
 *  and among equals the earlier scene first. */
export function siblingsOf(
  subject: { chapter: string; sceneId?: string }, scenes: ProseScene[],
): { scene: ProseScene; distance: number }[] {
  const { chapter, at } = placeInChapter(subject, scenes)
  return chapter
    .map((scene, i) => ({ scene, distance: Math.abs(i - at), i }))
    .filter(x => x.scene.scene !== subject.sceneId)
    .sort((a, b) => a.distance - b.distance || a.i - b.i)
    .map(({ scene, distance }) => ({ scene, distance }))
}

const oneLine = (s: string | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim()
/** The first sentence by the graph's own splitter — the one that knows an
 *  abbreviation from a full stop, so "Show Mr. Ortega refusing" is not cut
 *  at the title. */
const firstSentence = (s: string): string => (splitSentences(s)[0]?.text ?? s).trim()

type LockReader = (scene: string, body: string) => ResolvedLock[]

/** One sibling at one rung, as text. The lock reader is shared across a
 *  ladder so the lock directory is read once, not once per sibling. */
export function renderRung(s: ProseScene, rung: Rung, locks: LockReader = lockResolver([s])): string {
  const head = `${s.scene} (${rung}) — ${s.file}`
  if (rung === 'full') return `${head}\n${s.body.trim()}`
  const c = s.contract
  if (rung === 'summary') {
    return c?.purpose ? `${s.scene} (summary): ${firstSentence(oneLine(c.purpose))}` : `${s.scene} (summary): no contract recorded, so no summary line`
  }
  const lines = [head]
  if (!c) lines.push('  no contract recorded')
  else {
    if (c.purpose) lines.push(`  purpose: ${oneLine(c.purpose)}`)
    if (c.reader_after) lines.push(`  reader_after: ${oneLine(c.reader_after)}`)
  }
  const paras = paragraphsOf(s.body)
  const locked = locks(s.scene, s.body)
    .filter(l => l.scope === 'paragraph' && l.resolution.paragraph !== null)
    .map(l => l.resolution.paragraph as number)
  if (locked.length) {
    const last = Math.max(...locked)
    lines.push(`  last locked paragraph (¶${last + 1}, verbatim):\n${paras[last] ?? ''}`)
  }
  return lines.join('\n')
}

/** Build the ladder for one scene against its chapter. Each rendering is
 *  made once and kept: lowering a rung re-renders the one sibling that
 *  moved, never the ladder. */
export function siblingLadder(subject: { chapter: string; sceneId?: string }, scenes: ProseScene[]): Ladder {
  const rows = siblingsOf(subject, scenes).map((x, i) => ({ ...x, i, rung: rungFor(x.distance) }))
  let locks: LockReader | null = null
  const readLocks = (): LockReader => (locks ??= lockResolver(scenes))
  const cache = new Map<string, string>()
  const render = (r: (typeof rows)[number]): string => {
    const key = `${r.scene.scene}|${r.rung}`
    let out = cache.get(key)
    if (out === undefined) { out = renderRung(r.scene, r.rung, readLocks()); cache.set(key, out) }
    return out
  }
  return {
    get rungs() { return rows.map(r => ({ scene: r.scene.scene, rung: r.rung, distance: r.distance })) },
    text: () => rows.map(render).join('\n\n'),
    note: () => rows.map(r => `${r.scene.scene} at ${r.rung}`).join('; '),
    lower: () => {
      // The farthest first; among equals the later scene, so the scene
      // before is the last to lose its prose.
      const candidate = [...rows].sort((a, b) => b.distance - a.distance || b.i - a.i)
        .find(r => r.rung !== 'summary')
      if (!candidate) return false
      candidate.rung = RUNGS[RUNGS.indexOf(candidate.rung) + 1]
      return true
    },
  }
}
