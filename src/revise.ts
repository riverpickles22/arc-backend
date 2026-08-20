// Write fan-out: the author's open notes, worked into the prose.
//
// The hard case, and deliberately last. It is the only workflow that exercises
// write fan-out, inter-note conflict and staleness at once — which is exactly
// why it must not be first. Running it before the read fan-out (A13-3) would
// tell you something broke without telling you which idea was wrong.
//
// A13-3 earned that ordering rather than merely asserting it: a lens there
// produced a finding citing a record it had never been given. Read-only work
// made that cost nothing. A revision worker doing the same would have changed
// the book.
//
// FOUR RULES SHAPE EVERYTHING HERE.
//
//   1. CONFLICTS ARE SURFACED BEFORE ANYTHING IS WRITTEN. "Make Manuel seem
//      more suspicious here" and "the Manuel reveal feels too obvious" are
//      both instructions and they pull opposite ways. Implementing both
//      blindly is the failure this workflow exists to avoid.
//   2. OVERLAPPING WRITE SETS SERIALISE. Two nodes that would write the same
//      scene run one after the other; disjoint nodes run at once. Safety comes
//      from the shape of the claims, not from hoping.
//   3. STALENESS IS DETERMINISTIC. When one node writes something another read,
//      the second is marked stale by fingerprint comparison — no model is asked
//      whether it still matters (work-graph.md §6).
//   4. PROSE STAYS SERIAL WITHIN A REVISION SET. Voice continuity is not a
//      graph property; fanning out reasoning is safe, fanning out prose is not.
import fs from 'node:fs'
import path from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import type { ResolvedAnnotation, RevisionResult } from 'arc-canon-graph'
import { MODEL, STORY } from './config'
import { getClient } from './agent'
import { currentEngine, runCliPrompt, stripFences } from './engine'
import { checkPathWrite, grant, type Capability } from './capability'
import { DEFAULT_POLICY } from './context'
import { recordGenerated } from './ledger'
import { snapshotReads, staleReads, type Run, type WorkNode } from './run'
import { styleContract } from './style'
import { locksOn } from './locks'
import { lockViolations } from 'arc-canon-graph/annotations.ts'
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

const CONFLICT_RULES = `You are arc's NOTE CONFLICT PASS. The author left these notes on their own
manuscript at different times. Some may pull in opposite directions.

Find only GENUINE tensions: two notes that cannot both be satisfied, or that
ask for opposite movement on the same thing. "Make him seem more suspicious
here" and "the reveal feels too obvious" are a real tension. Two notes about
different characters are not, however near each other they sit.

You are NOT resolving anything. You are telling the author what they will have
to decide. Do not suggest which note should win.

Answer with a JSON array and nothing else:
  [{"between": ["note.001", "note.007"], "tension": "one sentence"}]
An empty array is the common answer and a good one.`

/** What a note is about, in the words the model should read. A note with no
 *  quote is about the section rather than a sentence in it — often because it
 *  is about something the section does NOT say, which has no passage to point
 *  at. Naming the scope beats quoting an empty string. */
const scopeOf = (n: ResolvedAnnotation): string =>
  n.anchor.quote ? `at "${n.anchor.quote.slice(0, 60)}"` : 'about the whole scene'

export function buildConflictPrompt(notes: ResolvedAnnotation[]): string {
  const listed = notes.map(n =>
    `${n.id} — on ${n.anchor.scene}, ${scopeOf(n)}\n  ${n.body.trim()}`).join('\n\n')
  return `${CONFLICT_RULES}\n\n=== THE AUTHOR'S OPEN NOTES ===\n${listed}\n\nAnswer with the JSON array.`
}

export function parseConflicts(text: string): Conflict[] {
  const raw = stripFences(text)
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end < start) return []
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1))
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((x): Conflict[] => {
      const c = x as Partial<Conflict>
      if (!Array.isArray(c.between) || c.between.length < 2) return []
      if (typeof c.tension !== 'string' || !c.tension.trim()) return []
      return [{ between: c.between.map(String), tension: c.tension.trim() }]
    })
  } catch {
    return []
  }
}

const REVISE_RULES = `You are arc's REVISION WORKER. The author left notes on one scene of their
own novel. Revise the prose so the notes are answered.

THE CONTRACT BELOW IS BINDING — this is the author's book and their voice, and
a revision that improves the prose by breaking a stated rule is a failure.

Change as little as the notes require. You are not rewriting the scene; you
are answering what was asked about it. Prose you were not asked about stays
exactly as it is, to the character.

Never invent a fact about the world. If a note implies something the record
would have to carry — a new person, a date, a place — do NOT write it in. Say
so at the end instead; that is a proposal for the author, not yours to make.

Answer with ONLY the revised scene body. No frontmatter, no commentary, no
fences. If a note cannot be answered without inventing canon, leave that
passage alone.`

export function buildRevisePrompt(scene: string, body: string, notes: ResolvedAnnotation[], style: string): string {
  const listed = notes.map(n =>
    `- ${n.id} (${n.anchor.quote ? `on "${n.anchor.quote.slice(0, 70)}"` : 'about the whole scene'}): ${n.body.trim()}`).join('\n')
  return [
    REVISE_RULES,
    `=== THE AUTHOR'S STYLE CONTRACT (binding) ===\n${style}`,
    `=== THE NOTES TO ANSWER (scene ${scene}) ===\n${listed}`,
    `=== THE SCENE AS IT STANDS ===\n${body}`,
    'Answer with the revised scene body alone.',
  ].join('\n\n')
}

async function ask(prompt: string): Promise<string> {
  if (currentEngine() === 'claude-cli') return (await runCliPrompt(prompt, { cwd: STORY })).text
  const message = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }],
  })
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length

/** Revise one scene. Prose generation is SERIAL within this call by
 *  construction — one scene, one pass — because voice continuity is not a
 *  graph property and fanning it out would fray it. */
async function reviseOne(cluster: RevisionCluster, node: WorkNode, run: Run): Promise<RevisionResult> {
  const base = {
    scene: cluster.scene,
    file: cluster.file,
    notes: cluster.notes.map(n => n.id),
    words_before: 0,
    words_after: 0,
    word_delta: 0,
    changed: false,
    stale: [] as string[],
  }
  try {
    node.status = 'running'
    run.emit('task.started', node.id, { kind: node.kind, claim: node.claim, reads: node.reads })

    // The gate, before anything is generated: a worker that cannot write this
    // file should not spend a pass discovering that.
    const allowed = checkPathWrite(node.claim, cluster.file)
    if (!allowed.ok) {
      node.status = 'failed'
      return { ...base, refused: allowed.message ?? 'scope exceeded' }
    }

    const abs = path.join(STORY, cluster.file)
    const raw = fs.readFileSync(abs, 'utf8')
    const scene = parseScene(raw, cluster.file)
    if (!scene) throw new Error(`${cluster.file} is not a scene file`)

    // Locked prose is settled prose (A29). The worker is told which
    // paragraphs are fenced; the check after the model answers is what makes
    // the fence real — a worker that rewrites a locked paragraph fails, and
    // nothing is written. The author hears the lock's name, not an override.
    const sceneLocks = locksOn(cluster.scene, scene.body)
    const fenced = sceneLocks
      .filter(l => l.resolution.paragraph !== null &&
        (l.resolution.state === 'resolved' || l.resolution.state === 'drifted'))
      .map(l => l.resolution.paragraph! + 1)
    const lockNotice = fenced.length
      ? `\n\nLOCKED PARAGRAPHS — the author has marked paragraph${fenced.length === 1 ? '' : 's'} ` +
        `${fenced.join(', ')} of this scene as settled. Reproduce ${fenced.length === 1 ? 'it' : 'them'} ` +
        `verbatim, word for word, and write around ${fenced.length === 1 ? 'it' : 'them'}.`
      : ''

    const revised = stripFences(await ask(
      buildRevisePrompt(cluster.scene, scene.body, cluster.notes, styleContract()) + lockNotice,
    )).trim()

    if (!revised) throw new Error('the revision worker returned nothing')

    const violated = lockViolations(scene.body, revised, sceneLocks)
    if (violated.length) {
      throw new Error(
        `revision touched locked prose — paragraph ${violated[0].paragraph + 1} ` +
        `(${violated.map(v => v.lock.id).join(', ')}) is settled; nothing was written`)
    }

    // Staleness FIRST: if something this node read has moved since it read it,
    // the revision was written against a story that no longer exists.
    const stale = staleReads(node)
    if (stale.length) {
      node.status = 'stale'
      run.emit('task.stale', node.id, { changed: stale })
      return { ...base, words_before: words(scene.body), stale }
    }

    // Frontmatter is untouched: a revision changes prose, and the bindings are
    // the author's. The write lands in the working tree — the draft layer —
    // so it is reviewed through the gate that already exists.
    const head = raw.slice(0, raw.length - scene.body.length)
    const next = head + revised + (revised.endsWith('\n') ? '' : '\n')
    fs.writeFileSync(abs, next)

    // What arc wrote, before the author touches it. Git only ever sees the
    // accepted version, so without this a revision — the most common way arc
    // writes prose — is indistinguishable from the author's own typing by the
    // time anyone looks, and the style-learning pass would file arc's
    // sentences as the author's revision of themselves.
    recordGenerated(cluster.file, next, { engine: currentEngine() ?? 'unknown', scene: cluster.scene, origin: 'revise' })

    node.status = 'completed'
    run.emit('task.completed', node.id, { wrote: [cluster.file], notes: base.notes })

    return {
      ...base,
      words_before: words(scene.body),
      words_after: words(revised),
      word_delta: words(revised) - words(scene.body),
      changed: revised.trim() !== scene.body.trim(),
    }
  } catch (e) {
    node.status = 'failed'
    return { ...base, error: e instanceof Error ? e.message : String(e) }
  }
}

interface ReviseReport {
  /** Surfaced before anything was written. Non-empty means nothing was. */
  conflicts: Conflict[]
  clusters: number
  waves: number
  revisions: RevisionResult[]
  notes_addressed: string[]
  scenes_changed: string[]
  word_delta: number
  stale_nodes: string[]
  /** Named, never made: a revision worker holds no canon capability. */
  proposed_canon_changes: string[]
  wall_ms: number
}

export async function runRevisionFanOut(notes: ResolvedAnnotation[], run: Run): Promise<ReviseReport> {
  const started = Date.now()
  const clusters = clusterNotes(notes)
  const empty: ReviseReport = {
    conflicts: [], clusters: clusters.length, waves: 0, revisions: [],
    notes_addressed: [], scenes_changed: [], word_delta: 0, stale_nodes: [],
    proposed_canon_changes: [], wall_ms: 0,
  }
  if (!clusters.length) return { ...empty, wall_ms: Date.now() - started }

  // BEFORE ANY WRITE. The author decides which of two contradictory notes
  // wins; arc's job is to notice that they must.
  const all = clusters.flatMap(c => c.notes)
  let conflicts: Conflict[] = []
  try {
    conflicts = parseConflicts(await ask(buildConflictPrompt(all)))
  } catch (e) {
    // A conflict pass that fails must not become a licence to write blindly.
    return {
      ...empty,
      conflicts: [{ between: all.map(n => n.id), tension: `arc could not check these notes for conflicts (${e instanceof Error ? e.message : String(e)}), so nothing was revised.` }],
      wall_ms: Date.now() - started,
    }
  }
  if (conflicts.length) {
    run.emit('judge.completed', undefined, { conflicts, wrote: 'nothing — the author decides first' })
    return { ...empty, conflicts, wall_ms: Date.now() - started }
  }

  const nodes = planRevisionGraph(clusters)
  const waves = scheduleWaves(nodes)
  const revisions: RevisionResult[] = []

  // Waves in order; within a wave, concurrently — the write sets say which.
  for (const wave of waves) {
    const out = await Promise.all(wave.map(node => reviseOne(clusters[nodes.indexOf(node)], node, run)))
    revisions.push(...out)

    // A completed wave may have moved what a later node read. Re-fingerprint
    // rather than assume — the whole of staleness (work-graph.md §6).
    for (const later of nodes.filter(n => n.status === 'queued')) {
      const moved = staleReads(later)
      if (moved.length) {
        later.status = 'stale'
        run.emit('task.stale', later.id, { changed: moved })
      }
    }
  }

  const report: ReviseReport = {
    conflicts: [],
    clusters: clusters.length,
    waves: waves.length,
    revisions,
    notes_addressed: revisions.filter(r => r.changed).flatMap(r => r.notes),
    scenes_changed: revisions.filter(r => r.changed).map(r => r.file),
    word_delta: revisions.reduce((a, r) => a + r.word_delta, 0),
    stale_nodes: revisions.filter(r => r.stale.length).map(r => r.scene),
    proposed_canon_changes: [],
    wall_ms: Date.now() - started,
  }
  run.emit('judge.completed', undefined, report)
  return report
}
