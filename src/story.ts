// The story's presentation layer: view.yaml and the assets/ directory.
//
// These are deliberately not canon — they say how the story is *drawn*, not
// what is true about it — so they live outside canon/ and are served straight
// through rather than going near the validator. They live in the story repo
// rather than the viewer so arc-frontend stays story-agnostic.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { load as yamlLoad } from 'js-yaml'
import type { DocArticle, MaterialItem, ProseChange, ProseDraft, ProseScene, SceneContract } from 'arc-canon-graph'
import { STORY } from './config'
import { clearGenerated } from './ledger'
import { HttpError } from './http'
import { resolveWithin } from './safe-path'

// The wire types live in arc-canon-graph (graph/api-types.ts) — one source
// of truth shared with the frontend. Re-exported so importers of this
// module keep working.
export type { DocArticle, ProseChange, ProseDraft, ProseScene, SceneContract }

const ASSETS = path.join(STORY, 'assets')

const CONTENT_TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.geojson': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

/** view.yaml as a plain object, or {} when the story doesn't have one. */
export function viewConfig(): unknown {
  const p = path.join(STORY, 'view.yaml')
  if (!fs.existsSync(p)) return {}
  return yamlLoad(fs.readFileSync(p, 'utf8')) ?? {}
}

const FM_RE = /^---\n([\s\S]*?)\n---\n?/

function mdFiles(root: string): string[] {
  if (!fs.existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name)
      if (fs.statSync(abs).isDirectory()) walk(abs)
      else if (name.endsWith('.md')) out.push(abs)
    }
  }
  walk(root)
  return out
}

/** Every docs/ article, with its canon binding when the frontmatter has one.
 *  The corpus is small (dozens of files) — read fresh, no cache to invalidate. */
export function docsArticles(): DocArticle[] {
  const root = path.join(STORY, 'docs')
  return mdFiles(root).map(abs => {
    const text = fs.readFileSync(abs, 'utf8')
    const fm = text.match(FM_RE)
    const meta = fm ? ((yamlLoad(fm[1]) ?? {}) as Record<string, unknown>) : {}
    return {
      path: path.relative(STORY, abs),
      canon: typeof meta.canon === 'string' ? meta.canon : null,
      body: fm ? text.slice(fm[0].length) : text,
    }
  })
}

/** Parse one scene file (conventions §10). Files without scene frontmatter
 *  (READMEs, loose drafts) are not part of the manuscript. */
export function parseScene(text: string, file: string): ProseScene | null {
  const fm = text.match(FM_RE)
  if (!fm) return null
  const meta = (yamlLoad(fm[1]) ?? {}) as Record<string, unknown>
  if (typeof meta.scene !== 'string') return null
  return {
    scene: meta.scene,
    chapter: String(meta.chapter ?? ''),
    status: String(meta.status ?? 'proposed'),
    pov: typeof meta.pov === 'string' ? meta.pov : null,
    events: Array.isArray(meta.events) ? meta.events.map(String) : [],
    facts: Array.isArray(meta.facts) ? meta.facts.map(String) : [],
    contract: meta.contract && typeof meta.contract === 'object' ? (meta.contract as SceneContract) : null,
    file,
    body: text.slice(fm[0].length),
  }
}

/** Every bound scene in prose/ — the working tree, i.e. the draft layer. */
export function proseScenes(): ProseScene[] {
  const out: ProseScene[] = []
  for (const abs of mdFiles(path.join(STORY, 'prose'))) {
    const scene = parseScene(fs.readFileSync(abs, 'utf8'), path.relative(STORY, abs))
    if (scene) out.push(scene)
  }
  return out
}

/** Story material (conventions §12): the unplaced layer, read fresh like
 *  docs and prose — the corpus is small by nature. */
export function materialItems(): MaterialItem[] {
  const root = path.join(STORY, 'material')
  if (!fs.existsSync(root)) return []
  const out: MaterialItem[] = []
  for (const name of fs.readdirSync(root).sort()) {
    if (!name.endsWith('.yaml')) continue
    const item = yamlLoad(fs.readFileSync(path.join(root, name), 'utf8')) as MaterialItem | null
    if (item && typeof item.id === 'string') out.push(item)
  }
  return out
}

// ---- the draft layer -----------------------------------------------------
//
// Prose has two layers and no new version store: main is the story repo's
// HEAD, the draft is the working tree. Accepting ratifies the draft into
// main as a git commit scoped to prose/ (commit = ratify, the same gate
// canon uses); discarding a file is a surfaced git checkout. A story that
// isn't a git repository simply has no draft layer.

function git(...args: string[]): string {
  return execFileSync('git', ['-C', STORY, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
}

/** The draft state: every prose file that differs from HEAD, with the main
 *  version of each, plus the ratification history of prose/. */
export function proseDraft(): ProseDraft {
  let prefix: string
  try { prefix = git('rev-parse', '--show-prefix').trim() } catch {
    return { git: false, changes: [], history: [] }
  }

  const changes: ProseChange[] = []
  // -uall: list untracked FILES, not their directory — a scene in a brand-new
  // chapter dir otherwise reports as `?? prose/ch-01/` and vanishes here.
  for (const line of git('status', '--porcelain', '-uall', '--', 'prose').split('\n')) {
    if (!line.trim()) continue
    const xy = line.slice(0, 2)
    let repoRel = line.slice(3).trim()
    if (repoRel.includes(' -> ')) repoRel = repoRel.split(' -> ')[1]   // rename: the new path
    if (!repoRel.endsWith('.md')) continue
    const file = prefix && repoRel.startsWith(prefix) ? repoRel.slice(prefix.length) : repoRel
    const status = xy.includes('?') || xy.includes('A') ? 'added' : xy.includes('D') ? 'deleted' : 'modified'
    let main: ProseScene | null = null
    if (status !== 'added') {
      try { main = parseScene(git('show', `HEAD:${repoRel}`), file) } catch { /* not at HEAD */ }
    }
    changes.push({ file, status, main })
  }

  let history: ProseDraft['history'] = []
  try {
    history = git('log', '-n', '20', '--pretty=format:%h\t%ad\t%s', '--date=short', '--', 'prose')
      .split('\n').filter(Boolean)
      .map(l => { const [hash, date, ...rest] = l.split('\t'); return { hash, date, subject: rest.join('\t') } })
  } catch { /* no commits yet */ }

  return { git: true, changes, history }
}

/** Ratify the draft into main: stage and commit prose/ only. Anything else
 *  sitting in the story's working tree (canon edits, notes) is untouched. */
export function proseAccept(message?: string): { hash: string; files: string[] } {
  const draft = proseDraft()
  if (!draft.git) throw new HttpError(400, 'this story is not a git repository — there is no draft layer to accept')
  if (!draft.changes.length) throw new HttpError(409, 'no draft changes to accept')
  git('add', '-A', '--', 'prose')
  const n = draft.changes.length
  const msg = message?.trim() || `prose: accept draft (${n} scene${n === 1 ? '' : 's'})`
  git('commit', '-m', msg, '--', 'prose')
  return { hash: git('rev-parse', '--short', 'HEAD').trim(), files: draft.changes.map(c => c.file) }
}

/** Write a scene's body back, leaving its frontmatter byte-identical.
 *
 *  The edit lands in the working tree, which IS the draft layer — so it needs
 *  no new gate, no new store, and shows up as an ordinary pending change the
 *  author accepts or discards like any other.
 *
 *  `baseline` is the body the edit started from. arc has no file watcher, so
 *  the viewer cannot know the author also has this scene open in their own
 *  editor; comparing against what they started from is what turns a silent
 *  clobber into a refusal. Whitespace-insensitive, because a trailing newline
 *  is not a conflict.
 */
export function proseWrite(file: string, body: string, baseline?: string): ProseScene {
  if (!file.startsWith('prose/')) throw new HttpError(400, `not a prose file: ${file}`)
  const abs = resolveWithin(path.join(STORY, 'prose'), file.slice('prose/'.length))
  if (!abs.endsWith('.md')) throw new HttpError(400, `not a scene file: ${file}`)
  if (!fs.existsSync(abs)) throw new HttpError(404, `no such scene: ${file}`)

  const before = fs.readFileSync(abs, 'utf8')
  const fm = before.match(FM_RE)
  if (!fm) throw new HttpError(400, `${file} has no scene frontmatter`)

  const current = before.slice(fm[0].length)
  const settle = (t: string) => t.replace(/\r\n/g, '\n').trimEnd()
  if (baseline !== undefined && settle(baseline) !== settle(current)) {
    throw new HttpError(409, `${file} changed underneath this edit — reload the manuscript and reapply it`)
  }

  const next = fm[0] + (body.endsWith('\n') ? body : body + '\n')
  fs.writeFileSync(abs, next)
  const scene = parseScene(next, file)
  if (!scene) {
    fs.writeFileSync(abs, before)   // the author's words are never the casualty
    throw new HttpError(400, `${file} no longer parses as a scene — reverted`)
  }
  return scene
}

/** Accept ONE paragraph of a scene, leaving every other change pending.
 *
 *  Accept has been all-or-nothing: `git add -A -- prose` takes every edit in
 *  every scene as a single judgment, which is the opposite of what a review
 *  gate is for. A chapter with four changes is four decisions.
 *
 *  The mechanism is partial staging with the paragraph as the unit, because a
 *  paragraph is what an author actually judges. Build a version of the scene
 *  carrying the accepted paragraph's new text and main's text everywhere else,
 *  commit that, then put the author's full working tree back. HEAD gains the
 *  one change; the working tree keeps the rest, so the remaining diff is
 *  exactly what has not been decided yet.
 *
 *  The working tree is restored in a finally: a failure here must never cost
 *  the author words they have not accepted.
 */
export function proseAcceptParagraph(file: string, index: number, message?: string): { hash: string; file: string } {
  const draft = proseDraft()
  if (!draft.git) throw new HttpError(400, 'this story is not a git repository — there is no draft layer to accept')
  const change = draft.changes.find(c => c.file === file)
  if (!change) throw new HttpError(404, `no draft change for ${file}`)
  if (change.status !== 'modified' || !change.main) {
    throw new HttpError(400, 'a paragraph can only be accepted on a modified scene — accept an added or deleted scene whole')
  }
  const abs = resolveWithin(path.join(STORY, 'prose'), file.slice('prose/'.length))
  const working = fs.readFileSync(abs, 'utf8')
  const fm = working.match(FM_RE)
  if (!fm) throw new HttpError(400, `${file} has no scene frontmatter`)

  const split = (body: string) => body.split(/\n{2,}/).map(x => x.trim()).filter(Boolean)
  const draftParas = split(working.slice(fm[0].length))
  const mainParas = split(change.main.body)
  if (index < 0 || index >= draftParas.length) throw new HttpError(400, `no paragraph ${index} in ${file}`)

  // main's paragraphs, with the accepted one carrying the draft's text. A
  // paragraph the draft added sits at the end of what main had.
  const merged = [...mainParas]
  if (index < merged.length) merged[index] = draftParas[index]
  else merged.push(draftParas[index])

  try {
    fs.writeFileSync(abs, fm[0] + merged.join('\n\n') + '\n')
    git('add', '--', file)
    git('commit', '-m', message?.trim() || `prose: accept one change in ${path.basename(file)}`, '--', file)
    return { hash: git('rev-parse', '--short', 'HEAD').trim(), file }
  } finally {
    fs.writeFileSync(abs, working)   // the author's unaccepted words, always
  }
}

/** Roll one file back to main. The path arrives from the browser — reject
 *  anything that escapes prose/, including symlink escapes. */
export function proseDiscard(file: string): void {
  if (!file.startsWith('prose/')) throw new HttpError(400, `not a prose file: ${file}`)
  const abs = resolveWithin(path.join(STORY, 'prose'), file.slice('prose/'.length))
  const change = proseDraft().changes.find(c => c.file === file)
  if (!change) throw new HttpError(404, `no draft change for ${file}`)
  if (change.status === 'added') fs.rmSync(abs)
  else git('checkout', 'HEAD', '--', file)
  // A generation the author threw away must never be diffed against a later
  // hand-written scene at the same path.
  clearGenerated([file])
}

export interface Asset { body: Buffer; contentType: string }

/**
 * Read a file from the story's assets/ directory.
 * Returns null when it doesn't exist or isn't a servable type.
 * Rejects any name that escapes assets/ (incl. symlink escapes) — the name
 * arrives from the browser; null keeps the existing 404 behavior.
 */
export function readAsset(name: string): Asset | null {
  let abs: string
  try {
    abs = resolveWithin(ASSETS, name)
  } catch {
    return null
  }
  const contentType = CONTENT_TYPES[path.extname(abs).toLowerCase()]
  if (!contentType) return null
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null
  return { body: fs.readFileSync(abs), contentType }
}
