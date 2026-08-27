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
import { proseScenes } from './story'

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
    ...(input.by ? { by: input.by } : {}),
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
