// THE SHAPE OF A NOTES REVISION: how notes group, what a worker may write,
// and what a reading of them says. The RUNNING of it is work-notes.ts, which
// drives U2's row through the gate runner (A69-9).
//
// FOUR RULES SHAPED THIS, and they still hold wherever it is used.
//
//   1. CONFLICTS ARE SURFACED BEFORE ANYTHING IS WRITTEN. "Make Manuel seem
//      more suspicious here" and "the Manuel reveal feels too obvious" are
//      both instructions and they pull opposite ways. Implementing both
//      blindly is the failure this workflow exists to avoid. The row's
//      `conflict` stage is that reading, and it fails closed.
//   2. OVERLAPPING WRITE SETS SERIALISE. Two nodes that would write the same
//      scene run one after the other; disjoint nodes run at once. Safety comes
//      from the shape of the claims, not from hoping.
//   3. STALENESS IS DETERMINISTIC. When one node writes something another read,
//      the second is marked stale by fingerprint comparison — no model is asked
//      whether it still matters (work-graph.md §6).
//   4. PROSE STAYS SERIAL WITHIN A REVISION SET. Voice continuity is not a
//      graph property; fanning out reasoning is safe, fanning out prose is not.
//
// WHAT WENT WITH THE ROW (A69-9). The rules text is the row's; the seam call,
// the SDK path and the per-node worker are the gate runner's. The BOOK-WIDE
// fan-out went too: it wrote into the Changes reading, which is governed from
// this slice on, and revising every note in the book at once is Revise at
// manuscript scope, which no slice owns yet (§11). The graph shape below is
// what a chapter or manuscript scope will need when one does.
import fs from 'node:fs'
import path from 'node:path'
import type { ResolvedAnnotation } from 'arc-canon-graph'
import { STORY } from './config'
import { stripFences } from './engine'
import { snapshotReads, type WorkNode } from './run'
import { grant, type Capability } from './capability'
import { DEFAULT_POLICY } from './context'
import { parseScene } from './story'

interface Conflict {
  between: string[]
  tension: string
}

interface RevisionCluster {
  scene: string
  file: string
  notes: ResolvedAnnotation[]
}

/** Group open notes by the scene they touch.
 *
 *  The scene is the natural write-set boundary: a revision changes one file,
 *  so one cluster per scene gives disjoint claims by construction. Notes whose
 *  anchor no longer resolves are excluded — arc never guesses where a thought
 *  now belongs (conventions §14), and revising from a lost anchor would be
 *  exactly that guess. */
export function clusterNotes(notes: ResolvedAnnotation[]): RevisionCluster[] {
  const byScene = new Map<string, ResolvedAnnotation[]>()
  for (const n of notes) {
    if (n.status && n.status !== 'open') continue
    if (n.resolution.state === 'orphaned' || n.resolution.state === 'no-scene') continue
    const scene = n.anchor.scene
    byScene.set(scene, [...(byScene.get(scene) ?? []), n])
  }
  return [...byScene.entries()]
    .map(([scene, list]) => ({ scene, file: fileForScene(scene), notes: list }))
    .filter(c => !!c.file)
    .sort((a, b) => a.scene.localeCompare(b.scene))
}

/** The prose file a scene id lives in, found by reading rather than by
 *  guessing a path convention. */
function fileForScene(scene: string): string {
  const root = path.join(STORY, 'prose')
  const walk = (dir: string): string | '' => {
    if (!fs.existsSync(dir)) return ''
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        const hit = walk(p)
        if (hit) return hit
      } else if (e.name.endsWith('.md')) {
        const parsed = parseScene(fs.readFileSync(p, 'utf8'), path.relative(STORY, p))
        if (parsed?.scene === scene) return path.relative(STORY, p)
      }
    }
    return ''
  }
  return walk(root)
}

/** One node per cluster, holding write capability over ITS OWN SCENE ONLY.
 *
 *  Never canon: a revision changes prose, and a note that implies a canon
 *  change is a proposal for the author, not something a prose worker may do
 *  on its way past. */
export function planRevisionGraph(clusters: RevisionCluster[]): WorkNode[] {
  return clusters.map(c => {
    const reads = [c.scene]
    const claim: Capability = grant({
      reads,
      writes: [c.file],           // this scene's file, and nothing else
      proposes: [],
      creates: [],
    })
    return {
      id: `revise:${c.scene}`,
      kind: 'revision',
      claim,
      anchors: [c.scene],
      selectors: [{ kind: 'anchor' as const, of: c.scene, because: 'the notes are anchored here' }],
      context_manifest: [{ id: c.scene, because: 'the scene the notes are about', via: `anchor:${c.scene}` }],
      context_policy: DEFAULT_POLICY,
      context_cited: [],
      reads,
      read_versions: snapshotReads(reads),
      writes: [c.file],
      creates: [],
      depends_on: [],
      status: 'queued',
      worker: 'revision',
    }
  })
}

/** Groups of nodes that may run together.
 *
 *  Two nodes whose write sets intersect must not run at once — one would
 *  overwrite the other's work and the loser would never know. Disjoint nodes
 *  are free. This returns waves: every node in a wave is safe to run
 *  concurrently, and waves run in order. */
export function scheduleWaves(nodes: WorkNode[]): WorkNode[][] {
  const waves: WorkNode[][] = []
  for (const node of nodes) {
    const wave = waves.find(w => w.every(other => !overlaps(other.writes, node.writes)))
    if (wave) wave.push(node)
    else waves.push([node])
  }
  return waves
}

const overlaps = (a: string[], b: string[]): boolean => a.some(x => b.includes(x))

export function parseConflicts(text: string): Conflict[] {
  return readConflicts(text) ?? []
}

/** THE SAME READING, WITH "I COULD NOT READ THAT" LEFT IN. An empty array is
 *  the common answer and a good one; an apology, a truncation or a paragraph
 *  of prose is not an answer at all. Told apart, because the difference is
 *  whether the revision that follows was licensed (§5, P2 fails closed):
 *  `[]` means the reading looked and found nothing, `null` means it did not
 *  look, and only the first may let a write proceed (A69-9). */
export function readConflicts(text: string): Conflict[] | null {
  const raw = stripFences(text)
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end < start) return null
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1))
    if (!Array.isArray(parsed)) return null
    const out: Conflict[] = []
    for (const x of parsed) {
      const c = x as Partial<Conflict>
      if (!Array.isArray(c.between) || c.between.length < 2) continue
      if (typeof c.tension !== 'string' || !c.tension.trim()) continue
      out.push({ between: c.between.map(String), tension: c.tension.trim() })
    }
    // An entry that is not a conflict is dropped — a partly malformed answer
    // that still names one real tension is enough to stop the write, which
    // is the safe direction. But an answer that HAD entries and none of them
    // could be read is not "no conflicts": nothing was understood, and
    // treating it as an empty list is the licence to write this must never
    // give (§5, P2 fails closed).
    return parsed.length && !out.length ? null : out
  } catch {
    return null
  }
}
