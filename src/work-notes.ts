// "Work through my notes on this scene."
//
// The author leaves notes in the margin and later asks for them to be
// worked — in Claude Code, from the rail, from a terminal. No ceremony: the
// scene's open notes ARE the brief, and the contract and the record come
// with them as they always do. This module is the one place that sentence
// resolves to a pass, so the register is chosen on purpose rather than by
// which button happened to be nearest:
//
//   revise  — the minimal revision; the notes are instructions, the prose
//             changes as little as they require (revise.ts, scoped here to
//             ONE scene's notes instead of every open note in the book)
//   redraft — the clean pass; the notes are answered where the rebuild
//             allows (redraft.ts, which already reads them)
//
// Both record which notes they were handed on the generation ledger, so the
// viewer can say "answered in the draft" beside a note and the receipt can
// name them — provenance, never a model's judgement that a note was met.
// A scene with no open notes is refused, not run on nothing: the author is
// told what to do in the words the product uses.
import type { NoteConflict, WorkNotesMode, WorkNotesResponse } from 'arc-canon-graph'
import { openNotesOn } from './annotations'
import { HttpError } from './http'
import { locksOn } from './locks'
import { runRedraft } from './redraft'
import { runRevisionFanOut } from './revise'
import { Run, type Source } from './run'
import { closeRun, registerRun } from './runs'
import { proseScenes } from './story'

export interface WorkNotesTarget {
  scene: string
  mode?: WorkNotesMode
  /** Binding guidance for the clean pass; the minimal revision takes its
   *  instructions from the notes alone. */
  guidance?: string
  /** Who asked — the viewer, a terminal, a Claude Code session. */
  source?: Source
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The refusal for a scene with nothing to work through. Ends with the next
 *  action in the product's own gestures (CLAUDE.md: keystrokes, not verbs). */
export const nothingToWork = (scene: string): string =>
  `${scene} has no open notes — nothing to work through. Leave a note on the scene in arc first: highlight a phrase and write, or right-click a paragraph and choose "note". Then ask again.`

/** One paragraph for the author: what happened and where to look. Never the
 *  prose — the draft lands beside the scene, and arc is where it is read. */
export function describeOutcome(a: {
  scene: string; mode: WorkNotesMode; notes: string[]; changed: boolean
  conflicts: NoteConflict[]; refused?: string; error?: string
}): string {
  if (a.conflicts.length) {
    const pairs = a.conflicts.map(c => `${c.between.join(' and ')}: ${c.tension}`).join(' ')
    return `Two of your notes on ${a.scene} pull against each other, so nothing was written. ${pairs} Decide which wins — resolve or edit one in arc — then ask again.`
  }
  if (a.refused) return `${a.scene} was not revised: ${a.refused}. Nothing was written.`
  if (a.error) return `The pass over ${a.scene} did not finish: ${a.error}. Nothing was written.`
  if (!a.changed) return `The pass read ${count(a.notes.length, 'note')} on ${a.scene} and changed nothing. Nothing was written; the notes stay open.`
  const how = a.mode === 'redraft' ? 'answered in a clean pass over' : 'worked into'
  return `${count(a.notes.length, 'note')} on ${a.scene} ${a.notes.length === 1 ? 'was' : 'were'} ${how} the scene. The draft is beside the scene in arc — open the manuscript to review it. Nothing is accepted, and the notes stay open until you close them.`
}

export async function runWorkNotes(t: WorkNotesTarget): Promise<WorkNotesResponse> {
  const scene = proseScenes().find(s => s.scene === t.scene)
  if (!scene) throw new HttpError(400, `no scene ${t.scene}`)
  const notes = openNotesOn(t.scene)
  if (!notes.length) throw new HttpError(409, nothingToWork(t.scene))
  const ids = notes.map(n => n.id)
  const mode: WorkNotesMode = t.mode ?? 'revise'

  // Settled prose, BEFORE any token is spent. Both passes refuse a scene
  // settled entire, but the minimal revision would first pay for a conflict
  // check; a lock is proven and free, so it answers first (A29, A40-1).
  const whole = locksOn(t.scene, scene.body)
    .filter(l => l.resolution.state === 'resolved' || l.resolution.state === 'drifted')
    .find(l => l.scope === 'scene' || l.scope === 'chapter')
  if (whole) {
    throw new HttpError(423,
      `${whole.scope === 'chapter' ? 'this chapter' : 'this section'} is settled — locked (${whole.id}). Unlock it from the scene's header in arc to work the notes; nothing was written.`)
  }

  if (mode === 'redraft') {
    // The clean pass reads the same notes itself (openNotesOn) and records
    // them on the ledger; its refusals — locks, the validator, a quoted
    // withhold — surface as they are, in the author's words.
    const out = await runRedraft({ scene: t.scene, guidance: t.guidance })
    return {
      scene: t.scene, mode, notes: ids, file: out.file, changed: true, conflicts: [],
      reply: describeOutcome({ scene: t.scene, mode, notes: ids, changed: true, conflicts: [] }),
      run: null,
    }
  }

  // The minimal revision, scoped to this scene: one cluster, one wave, and
  // the conflict check before anything is written — the fan-out's own
  // rules, applied to the notes the author pointed at.
  const run = new Run(t.source ?? 'ui', `work the open notes on ${t.scene} into the prose`)
  registerRun(run)
  const report = await runRevisionFanOut(notes, run)
  closeRun(run.id, report.conflicts.length ? 'abandoned' : 'accepted')
  const mine = report.revisions.find(r => r.scene === t.scene)
  const changed = mine?.changed === true
  // What the pass was handed is the record — a note whose anchor has
  // orphaned is dropped by the fan-out, and the reply must not claim it.
  const handed = mine?.notes ?? ids
  return {
    scene: t.scene, mode, notes: handed,
    file: mine?.file ?? scene.file,
    changed,
    conflicts: report.conflicts,
    reply: describeOutcome({
      scene: t.scene, mode, notes: handed, changed, conflicts: report.conflicts,
      refused: mine?.refused, error: mine?.error,
    }),
    run: run.id,
  }
}
