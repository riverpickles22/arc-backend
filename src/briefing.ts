// The re-entry briefing: where the author left off, what is in flight, what
// is due. Assembly, not generation — every input already exists and is
// already served somewhere; this is the one surface that shows them
// together (harness.md §13 item 2, rung 0). No model call, ever: if one
// seems needed here, the design is being violated.
//
// The registers hold. A paragraph is read back from the accept commit, so
// it is the author's own words, byte for byte. Counts are the stores'
// lengths. An obligation is "due" only because the chapter order places its
// window over the current chapter — a proven fact, not a judgement.
import { loadGraph } from 'arc-canon-graph'
import type { BriefingResponse, CanonDoc } from 'arc-canon-graph'
import { paragraphsOf } from 'arc-canon-graph/annotations.ts'
import { annotations } from './annotations'
import { canonJson } from './canon'
import { routeCounts } from './reroute'
import { git, materialItems, parseScene, proseDraft, proseScenes } from './story'

/** Two accepts further apart than this belong to different sessions. */
export const SESSION_GAP_HOURS = 6

interface Commit { hash: string; date: string; subject: string }

/** Prose commits newest first, with ISO dates — the accept history. */
function proseLog(limit = 50): Commit[] {
  try {
    return git('log', '-n', String(limit), '--pretty=format:%h\t%aI\t%s', '--', 'prose')
      .split('\n').filter(Boolean)
      .map(l => { const [hash, date, ...rest] = l.split('\t'); return { hash, date, subject: rest.join('\t') } })
  } catch { return [] }   // no commits yet
}

/** The newest run of commits closer together than the session gap. */
export function lastSessionOf(log: Commit[], gapHours = SESSION_GAP_HOURS): Commit[] {
  const out: Commit[] = []
  for (const c of log) {
    const prev = out[out.length - 1]
    if (prev && Date.parse(prev.date) - Date.parse(c.date) > gapHours * 3600 * 1000) break
    out.push(c)
  }
  return out
}

/** Chapter id → reading order, from the canon; null when the canon cannot be
 *  read. Kept separate so a broken canon costs the DUE section and nothing
 *  else — the paragraph and the counts do not depend on it. */
function chapterOrder(): { order: Map<string, number>; doc: CanonDoc } | null {
  try {
    const doc = JSON.parse(canonJson()) as CanonDoc
    return { order: new Map((doc.chapters ?? []).map(c => [c.id, c.order ?? 0])), doc }
  } catch { return null }
}

/** The scene the last accept touched: the newest commit that added or
 *  changed a prose file, and among its files the one latest in reading
 *  order. Read from the commit, not the working tree — "the last paragraph
 *  you accepted" is what main says, not what the draft has since done. */
function lastAccepted(order: Map<string, number> | null): BriefingResponse['lastAccepted'] {
  let head: string
  try {
    head = git('log', '-n', '1', '--diff-filter=AM', '--name-only', '--pretty=format:%h\t%aI', '--', 'prose')
  } catch { return null }
  const lines = head.split('\n').filter(Boolean)
  if (!lines.length) return null
  const [hash, acceptedAt] = lines[0].split('\t')
  let prefix = ''
  try { prefix = git('rev-parse', '--show-prefix').trim() } catch { /* root */ }
  const scenes = lines.slice(1)
    .filter(f => f.endsWith('.md'))
    .map(repoRel => {
      const file = prefix && repoRel.startsWith(prefix) ? repoRel.slice(prefix.length) : repoRel
      try { return parseScene(git('show', `${hash}:${repoRel}`), file) } catch { return null }
    })
    .filter((s): s is NonNullable<typeof s> => s !== null)
  if (!scenes.length) return null
  const rank = (chapter: string) => order?.get(chapter) ?? Number.POSITIVE_INFINITY
  scenes.sort((a, b) => (rank(a.chapter) - rank(b.chapter)) || a.file.localeCompare(b.file))
  const last = scenes[scenes.length - 1]
  const paras = paragraphsOf(last.body)
  return {
    scene: last.scene, chapter: last.chapter, file: last.file,
    paragraph: paras[paras.length - 1] ?? '',
    acceptedAt, hash,
  }
}

/** Unmet obligations whose window touches `chapter`. A bound naming no
 *  chapter, or a chapter the canon does not order, leaves that side open. */
export function dueIn(
  chapter: string,
  order: Map<string, number>,
  unmet: { id: string; body: string; klass: 'unowned' | 'unwritten' | 'overdue'; window?: { from?: string; to?: string } }[],
): NonNullable<BriefingResponse['due']> {
  const cur = order.get(chapter)
  if (cur === undefined) return []
  const out: NonNullable<BriefingResponse['due']> = []
  const seen = new Map<string, number>()
  for (const o of unmet) {
    if (!o.window) continue   // an obligation with no window is owed nowhere in particular
    const from = o.window.from !== undefined ? (order.get(o.window.from) ?? Number.NEGATIVE_INFINITY) : Number.NEGATIVE_INFINITY
    const to = o.window.to !== undefined ? (order.get(o.window.to) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY
    if (cur < from || cur > to) continue
    const row = { id: o.id, body: o.body, klass: o.klass, window: o.window }
    const at = seen.get(o.id)
    // One row per obligation; overdue outranks the class it was also filed under.
    if (at === undefined) { seen.set(o.id, out.length); out.push(row) }
    else if (o.klass === 'overdue') out[at] = row
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

export function briefing(): BriefingResponse {
  const draft = proseDraft()
  const canon = chapterOrder()
  const accepted = draft.git ? lastAccepted(canon?.order ?? null) : null

  const scenesByFile = new Map(proseScenes().map(s => [s.file, s.scene]))
  const changes = draft.changes.map(c => ({
    file: c.file,
    scene: c.main?.scene ?? scenesByFile.get(c.file) ?? null,
    status: c.status,
  }))

  const notes = annotations()
    .filter(n => (n.kind ?? 'note') === 'note')
    .filter(n => (n.status ?? 'open') !== 'resolved' && (n.status ?? 'open') !== 'dropped')
    .map(n => ({ id: n.id, scene: n.anchor.scene, body: n.body }))

  const material = materialItems()
  const unplaced = material.filter(m => m.status === 'unplaced').length

  let due: BriefingResponse['due'] = []
  if (accepted) {
    if (!canon) due = null
    else {
      const g = loadGraph(canon.doc)
      const obl = g.obligations(
        material,
        proseScenes().map(s => ({ scene: s.scene, chapter: s.chapter, satisfies: s.contract?.satisfies })),
      )
      due = dueIn(accepted.chapter, canon.order, [
        ...obl.unowned.map(o => ({ ...o, klass: 'unowned' as const })),
        ...obl.unwritten.map(o => ({ ...o, klass: 'unwritten' as const })),
        ...obl.overdue.map(o => ({ ...o, klass: 'overdue' as const })),
      ])
    }
  }

  return {
    git: draft.git,
    lastAccepted: accepted,
    draft: changes,
    notes,
    routes: routeCounts(),
    unplaced,
    due,
    lastSession: draft.git ? lastSessionOf(proseLog()) : [],
  }
}
