// Annotations (conventions §14): the author's thoughts, anchored to the
// prose that provoked them.
//
// Read fresh off disk like material and docs — the corpus is small by nature
// and a note the author edited in a text editor must show up immediately.
// Resolution against current prose happens on every read, so a note that has
// drifted or orphaned says so the moment the manuscript moves.
import fs from 'node:fs'
import path from 'node:path'
import { dump as yamlDump, load as yamlLoad } from 'js-yaml'
import type { AnnotationLike, CreateAnnotationRequest, ResolvedAnnotation } from 'arc-canon-graph'
import { orphanedAnnotations, paragraphsOf, resolveAnnotations } from 'arc-canon-graph/annotations.ts'
import { STORY } from './config'
import { HttpError } from './http'
import { proseDraft, proseScenes } from './story'
import { generatedFiles, generatedFor } from './ledger'
import { readJudgments } from './evidence'
import { answeredStates, attributionOf, bodyParagraphs, noteInstruction, recordNoteResolution } from './note-lifecycle'

const DIR = () => path.join(STORY, 'annotations')

function sceneBodies(): (scene: string) => string | null {
  const byScene = new Map(proseScenes().map(s => [s.scene, s.body]))
  return scene => byScene.get(scene) ?? null
}

/** Every note on disk, resolved against the prose as it stands. */
export function annotations(): ResolvedAnnotation[] {
  const dir = DIR()
  if (!fs.existsSync(dir)) return []
  const notes: AnnotationLike[] = []
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.yaml')) continue
    const item = yamlLoad(fs.readFileSync(path.join(dir, name), 'utf8')) as AnnotationLike | null
    if (item && typeof item.id === 'string') notes.push(item)
  }
  return resolveAnnotations(notes, sceneBodies())
}

/** Notes whose anchor no longer resolves — proven, and the author's to place. */
export function orphaned(): ResolvedAnnotation[] {
  return orphanedAnnotations(annotations())
}

const fileFor = (id: string) => path.join(DIR(), `${id.replace(/^note\./, 'note-')}.yaml`)

/** Next free id. Sequential and human-referenceable: the author says
 *  "notes 4 and 7", not a hash. */
function nextId(): string {
  const dir = DIR()
  const used = fs.existsSync(dir)
    ? fs.readdirSync(dir).map(n => Number(n.match(/^note-(\d+)\.yaml$/)?.[1] ?? 0))
    : []
  return `note.${String(Math.max(0, ...used) + 1).padStart(3, '0')}`
}

/** File a note. The anchor is captured as the author made it; nothing about
 *  scope is asked for or inferred here — a request carrying a paragraph is a
 *  note about that passage, one carrying none is about the whole scene. */
export function createAnnotation(input: CreateAnnotationRequest): ResolvedAnnotation {
  if (!input.scene || !input.body?.trim()) {
    throw new HttpError(400, 'scene and body are required')
  }
  // A quote with no index is neither shape. Refusing beats storing an anchor
  // that could never resolve.
  const onPassage = typeof input.paragraph === 'number'
  if (onPassage && !(Number.isInteger(input.paragraph) && input.paragraph! >= 0)) {
    throw new HttpError(400, `paragraph must be a whole number from 0, or absent for a note about the whole scene`)
  }
  if (!onPassage && input.quote?.trim()) {
    throw new HttpError(400, 'a quote needs the paragraph it came from; omit both for a note about the whole scene')
  }
  if (!proseScenes().some(s => s.scene === input.scene)) {
    throw new HttpError(400, `no such scene: ${input.scene}`)
  }
  const keypoint = input.kind === 'keypoint'
  // A KEYPOINT SAYS WHO MINTED IT. A note comes through one door, the
  // viewer, and is the author's; a keypoint is minted by the author's hand
  // and by agent sessions alike, and conventions §14 keeps those apart by
  // `by` — a session's keypoints are the agent's, always. Absence here would
  // have to be guessed, and a guess of `author` puts an agent's reading of
  // the scene in the record under the author's name. So it is refused.
  if (input.by !== undefined && input.by !== 'author' && input.by !== 'agent') {
    throw new HttpError(400, `"${String(input.by)}" is not someone arc knows: by author, or by agent`)
  }
  if (keypoint && input.by === undefined) {
    throw new HttpError(400, 'a keypoint must say who minted it: by author, or by agent')
  }
  // The snapshot: the covered paragraphs' verbatim text, captured NOW,
  // because the note's referent will not stand still (A49-1). Coverage is
  // the anchored paragraph, extended forward only as far as the quote
  // actually reaches — a quote that spans a break covers both paragraphs,
  // and each captured entry is one of them.
  const snapshot = (() => {
    if (!onPassage) return undefined
    const body = sceneBodies()(input.scene)
    if (body === null) return undefined
    const paras = paragraphsOf(body)
    if (input.paragraph! >= paras.length) return undefined
    const covered = [paras[input.paragraph!]]
    const squash = (t: string) => t.replace(/\s+/g, ' ').trim()
    const q = squash(input.quote ?? '')
    if (q) {
      let i = input.paragraph! + 1
      while (!squash(covered.join(' ')).includes(q) && i < paras.length) covered.push(paras[i++])
    }
    return covered
  })()
  const note: AnnotationLike = {
    id: nextId(),
    anchor: onPassage
      ? { scene: input.scene, paragraph: input.paragraph, quote: (input.quote ?? '').trim(),
          ...(snapshot ? { paragraphs: snapshot } : {}) }
      : { scene: input.scene },
    body: input.body.trim(),
    // A keypoint has no lifecycle: it exists or it doesn't. Giving it a
    // status would put it in every surface that works notes as tasks.
    ...(keypoint ? { kind: 'keypoint' as const } : { status: 'open' as const }),
    // ALWAYS WRITTEN, never inferred (A69-2). A writing brief carries the
    // author's notes and not arc's (§4), and the filter that does it can only
    // be safe if absence has one meaning. Every note written from here on says
    // who wrote it; the notes already on disk predate the field and are the
    // author's, which is why the reader's default is `author` and must stay
    // the same shape as this line.
    by: input.by ?? 'author',
    created_at: new Date().toISOString().slice(0, 10),
  }
  fs.mkdirSync(DIR(), { recursive: true })
  fs.writeFileSync(fileFor(note.id), yamlDump(note, { indent: 2, lineWidth: 100, noRefs: true, sortKeys: false }))
  return resolveAnnotations([note], sceneBodies())[0]
}

/** Hard delete, keypoints only. A note is a thought — resolved or dropped,
 *  never erased (§14). A keypoint is a marker, and removing a marker is the
 *  author's ordinary right-click, not a loss of record: git holds history. */
export function deleteAnnotation(id: string): void {
  const file = fileFor(id)
  if (!id.startsWith('note.') || !fs.existsSync(file)) throw new HttpError(404, `no such annotation: ${id}`)
  const item = yamlLoad(fs.readFileSync(file, 'utf8')) as AnnotationLike
  if (item.kind !== 'keypoint') {
    throw new HttpError(400, `${id} is a note, and notes are never deleted — resolve it or drop it instead`)
  }
  fs.unlinkSync(file)
}

const STATUSES = ['open', 'working', 'resolved', 'dropped'] as const

/** Change a note's status. Resolving or dropping is the author's act — a
 *  machine may propose against a note but never closes one (§14). */
/** Change a note's status, its body, or both.
 *
 *  The anchor is never touched: revising a thought is not re-anchoring it, and
 *  a note that quietly moved would be exactly the silent relocation §14
 *  refuses to do. No edit timestamp either — annotations are committed with
 *  the story, so git already holds when a thought changed and what it said
 *  before, and a schema field would say it worse. */
export function updateAnnotation(
  id: string,
  patch: { status?: string; body?: string },
): ResolvedAnnotation {
  const { status, body } = patch
  if (status === undefined && body === undefined) {
    throw new HttpError(400, 'nothing to update: pass a status, a body, or both')
  }
  if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) {
    throw new HttpError(400, `status must be one of ${STATUSES.join(', ')}`)
  }
  // An emptied note is a dropped note; making it say nothing is not an edit.
  if (body !== undefined && !body.trim()) {
    throw new HttpError(400, 'a note cannot be emptied — drop it instead')
  }
  const file = fileFor(id)
  if (!id.startsWith('note.') || !fs.existsSync(file)) throw new HttpError(404, `no such note: ${id}`)
  const note = yamlLoad(fs.readFileSync(file, 'utf8')) as AnnotationLike
  if (status !== undefined) note.status = status as AnnotationLike['status']
  if (body !== undefined) note.body = body.trim()
  fs.writeFileSync(file, yamlDump(note, { indent: 2, lineWidth: 100, noRefs: true, sortKeys: false }))
  return resolveAnnotations([note], sceneBodies())[0]
}

/** The notes that drive revision work on one scene: open (or unstatused)
 *  notes, never key points — those mark what a passage must get across and
 *  ask for no change (A30). One filter, shared by every pass that reads
 *  notes, so "the scene's open notes" means the same thing to redraft,
 *  reroute and work-notes. Rail order, as annotations() sorts them. */
export function openNotesOn(scene: string): ResolvedAnnotation[] {
  return annotations().filter(n =>
    n.anchor.scene === scene && (!n.status || n.status === 'open') && (n.kind ?? 'note') === 'note')
}

/** Close the notes a change answered, once that change is in the book.
 *
 *  The generation ledger records which notes each pass was handed (A63-1),
 *  so this needs no reading and no judgement: a note is closed because the
 *  prose written from it has been ratified, not because anyone decided the
 *  note was met. Two rules shape it (A63-4):
 *
 *  RESOLVED, NEVER DELETED. A resolved note leaves the rail exactly as a
 *  deleted one would, and it is what the style learner mines afterwards to
 *  see what the author kept and what they changed. Erasing it would cut
 *  that loop silently.
 *
 *  AT THE ACCEPT, NEVER AT THE WRITE. A revision is a proposal until the
 *  author takes it. Closing the note when the pass wrote would leave the
 *  author with the thought gone and the change discarded.
 *
 *  Returns the ids it closed. Never throws: losing a status is a smaller
 *  harm than failing an accept that has already committed.
 */
export function closeAnsweredNotes(files: string[]): string[] {
  const closed: string[] = []
  for (const file of files) {
    let gen: ReturnType<typeof generatedFor>
    try { gen = generatedFor(file) } catch { continue }
    if (!gen) continue
    const attribution = attributionOf(gen.entry)
    // Only an open note closes. One the author already resolved or dropped
    // is theirs and stays as they left it; a keypoint is a marker, never a
    // request; a note arc wrote was never an instruction (A72-7).
    const closable = (note: ResolvedAnnotation | undefined): note is ResolvedAnnotation =>
      !!note && (note.kind ?? 'note') === 'note' && (note.by ?? 'author') !== 'agent'
      && (!note.status || note.status === 'open' || note.status === 'working')
    const resolve = (id: string, version: string, spans: number): void => {
      try {
        updateAnnotation(id, { status: 'resolved' })
        closed.push(id)
        recordNoteResolution({ note: id, version, file, decision: lastDecisionOn(file), spans })
      } catch (e) {
        console.error(`[warn] could not close ${id} after the accept (the prose is in):`, e)
      }
    }
    if (attribution) {
      // AT PARAGRAPH GRAIN (A72-7): a note resolves when ITS spans are in the
      // book, whatever else in the scene still waits; a span that is gone —
      // rejected, discarded, replaced by hand — leaves it open for the author.
      let main: string[] = [], draft: string[] = []
      try { ({ main, draft } = sceneSides(file)) } catch { continue }
      // the scene is at HEAD only once the accept committed it, which is what
      // makes this a decision and not a write
      if (!main.length && !draft.length) continue
      const notes = annotations()
      for (const s of answeredStates(attribution, main, draft, id => notes.find(n => n.id === id))) {
        if (s.state !== 'accepted') continue
        const note = notes.find(n => n.id === s.id)
        if (!closable(note)) continue
        resolve(s.id, attribution.find(a => a.id === s.id)!.version, s.of)
      }
      continue
    }
    // AN ENTRY FROM BEFORE ATTRIBUTION WAS RECORDED closes as it always did:
    // every handed note, once the scene has nothing pending left.
    try { if (proseDraft().changes.some(c => c.file === file)) continue } catch { continue }
    for (const id of gen.entry.notes ?? []) {
      const note = annotations().find(n => n.id === id)
      if (!closable(note)) continue
      resolve(id, noteInstruction(note), 0)
    }
  }
  return closed
}

/** The two sides of a scene for the lifecycle: the book and the working
 *  tree, as paragraphs. The draft layer already holds the book's side of
 *  every pending scene; a scene with nothing pending is its own book side.
 *  No git here — the lane's files are the only ones that spawn it. */
function sceneSides(file: string): { main: string[]; draft: string[] } {
  const abs = path.join(STORY, file)
  const draft = fs.existsSync(abs) ? bodyParagraphs(fs.readFileSync(abs, 'utf8')) : []
  const change = proseDraft().changes.find(c => c.file === file)
  if (!change) return { main: draft, draft }
  return { main: change.main ? paragraphsOf(change.main.body) : [], draft }
}

/** The decision that just landed on this file, for the resolution record —
 *  the latest judgment the evidence log holds for it. */
function lastDecisionOn(file: string): string | null {
  try { return readJudgments().filter(j => j.file === file).at(-1)?.decision ?? null } catch { return null }
}

/** THE SWEEP, at startup (A72-7, criterion 5): resolution runs after an
 *  accept returns, so a process that died between the commit and the close
 *  left a note open that the book had already answered. Every answer here
 *  is derived from disk, so asking again over every file the ledger knows
 *  closes exactly those and nothing twice. */
export function settleAnsweredNotes(): string[] {
  try { return closeAnsweredNotes(generatedFiles()) } catch { return [] }
}

/** WHERE EACH HANDED NOTE'S CHANGE STANDS for one pending scene (A72-7) —
 *  what the rail reads. Only the states the author can act on are served:
 *  waiting (the badge), partly (some of it is in). Gone, edited and
 *  nothing-produced carry no badge: the draft does not answer that note. */
export function answeredNow(change: { file: string; main: { body: string } | null }): { id: string; state: 'waiting' | 'partly'; accepted: number; of: number }[] | null {
  let gen: ReturnType<typeof generatedFor>
  try { gen = generatedFor(change.file) } catch { return null }
  const attribution = attributionOf(gen?.entry)
  // NULL when there is no provenance to read, and an EMPTY LIST when there
  // is and no note's change is still pending — the two are different on the
  // wire: the viewer falls back to the handed list only for the first.
  if (!gen || !attribution) return null
  const abs = path.join(STORY, change.file)
  let draft: string[]
  try { draft = bodyParagraphs(fs.readFileSync(abs, 'utf8')) } catch { return [] }
  const main = change.main ? paragraphsOf(change.main.body) : []
  const notes = annotations()
  return answeredStates(attribution, main, draft, id => notes.find(n => n.id === id))
    .filter((s): s is typeof s & { state: 'waiting' | 'partly' } => s.state === 'waiting' || s.state === 'partly')
    .map(s => ({ id: s.id, state: s.state, accepted: s.accepted, of: s.of }))
}
