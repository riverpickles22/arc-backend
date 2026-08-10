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
import type { AnnotationLike, ResolvedAnnotation } from 'arc-canon-graph'
import { orphanedAnnotations, resolveAnnotations } from 'arc-canon-graph/annotations.ts'
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

export interface NewAnnotation {
  scene: string
  paragraph: number
  quote: string
  body: string
}

/** File a note. The anchor is captured as the author made it; nothing about
 *  scope is asked for or inferred here. */
export function createAnnotation(input: NewAnnotation): ResolvedAnnotation {
  if (!input.scene || typeof input.paragraph !== 'number' || !input.body?.trim()) {
    throw new HttpError(400, 'scene, paragraph and body are required')
  }
  if (!proseScenes().some(s => s.scene === input.scene)) {
    throw new HttpError(400, `no such scene: ${input.scene}`)
  }
  const note: AnnotationLike = {
    id: nextId(),
    anchor: { scene: input.scene, paragraph: input.paragraph, quote: (input.quote ?? '').trim() },
    body: input.body.trim(),
    status: 'open',
    created_at: new Date().toISOString().slice(0, 10),
  }
  fs.mkdirSync(DIR(), { recursive: true })
  fs.writeFileSync(fileFor(note.id), yamlDump(note, { indent: 2, lineWidth: 100, noRefs: true, sortKeys: false }))
  return resolveAnnotations([note], sceneBodies())[0]
}

const STATUSES = ['open', 'working', 'resolved', 'dropped'] as const

/** Change a note's status. Resolving or dropping is the author's act — a
 *  machine may propose against a note but never closes one (§14). */
export function updateAnnotation(id: string, status: string): ResolvedAnnotation {
  if (!(STATUSES as readonly string[]).includes(status)) {
    throw new HttpError(400, `status must be one of ${STATUSES.join(', ')}`)
  }
  const file = fileFor(id)
  if (!id.startsWith('note.') || !fs.existsSync(file)) throw new HttpError(404, `no such note: ${id}`)
  const note = yamlLoad(fs.readFileSync(file, 'utf8')) as AnnotationLike
  note.status = status as AnnotationLike['status']
  fs.writeFileSync(file, yamlDump(note, { indent: 2, lineWidth: 100, noRefs: true, sortKeys: false }))
  return resolveAnnotations([note], sceneBodies())[0]
}
