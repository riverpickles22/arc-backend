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
import type { BriefingResponse, CanonDoc } from 'arc-canon-graph'
import { paragraphsOf } from 'arc-canon-graph/annotations.ts'
import { annotations } from './annotations'
import { canonJson } from './canon'
import { unreadEpisodes } from './episodes'
import { routeCounts } from './reroute'
import { dueRows } from './due'
import { unfinishedRuns } from './run'
import { liveIds } from './runs'
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
    else due = dueRows(canon.doc, accepted.chapter, material, proseScenes()).map(o => ({ id: o.id, body: o.body, klass: o.klass, window: o.window }))
  }

  return {
    git: draft.git,
    lastAccepted: accepted,
    draft: changes,
    notes,
    routes: Object.fromEntries(Object.entries(routeCounts()).map(([scene, c]) => [scene, c.waiting])),
    unplaced,
    due,
    lastSession: draft.git ? lastSessionOf(proseLog()) : [],
    unfinished: unfinishedRuns(liveIds()),
    // what arc has not read of the accepts: listed, never started (rung 0)
    unread: draft.git ? unreadEpisodes() : [],
  }
}
