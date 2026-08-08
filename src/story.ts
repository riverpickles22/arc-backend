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
import { STORY } from './config'

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

export interface DocArticle { path: string; canon: string | null; body: string }

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

export interface SceneContract {
  purpose?: string; reader_before?: string; reader_after?: string
  wants?: Record<string, string>
  must_establish?: string[]; must_withhold?: string[]; motifs?: string[]
  constraints?: string
}

export interface ProseScene {
  scene: string; chapter: string; status: string
  pov: string | null; events: string[]; facts: string[]
  contract: SceneContract | null
  file: string; body: string
}

/** Parse one scene file (conventions §10). Files without scene frontmatter
 *  (READMEs, loose drafts) are not part of the manuscript. */
function parseScene(text: string, file: string): ProseScene | null {
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

export interface ProseChange {
  file: string                                  // story-relative, matches ProseScene.file
  status: 'added' | 'modified' | 'deleted'
  main: ProseScene | null                       // the scene as of HEAD; null for added files
}

export interface ProseDraft {
  git: boolean
  changes: ProseChange[]
  history: { hash: string; date: string; subject: string }[]
}

/** The draft state: every prose file that differs from HEAD, with the main
 *  version of each, plus the ratification history of prose/. */
export function proseDraft(): ProseDraft {
  let prefix: string
  try { prefix = git('rev-parse', '--show-prefix').trim() } catch {
    return { git: false, changes: [], history: [] }
  }

  const changes: ProseChange[] = []
  for (const line of git('status', '--porcelain', '--', 'prose').split('\n')) {
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
  if (!draft.git) throw new Error('this story is not a git repository — there is no draft layer to accept')
  if (!draft.changes.length) throw new Error('no draft changes to accept')
  git('add', '-A', '--', 'prose')
  const n = draft.changes.length
  const msg = message?.trim() || `prose: accept draft (${n} scene${n === 1 ? '' : 's'})`
  git('commit', '-m', msg, '--', 'prose')
  return { hash: git('rev-parse', '--short', 'HEAD').trim(), files: draft.changes.map(c => c.file) }
}

/** Roll one file back to main. The path arrives from the browser — reject
 *  anything that escapes prose/. */
export function proseDiscard(file: string): void {
  const abs = path.resolve(STORY, file)
  const proseRoot = path.resolve(STORY, 'prose')
  if (!abs.startsWith(proseRoot + path.sep)) throw new Error(`not a prose file: ${file}`)
  const change = proseDraft().changes.find(c => c.file === file)
  if (!change) throw new Error(`no draft change for ${file}`)
  if (change.status === 'added') fs.rmSync(abs)
  else git('checkout', 'HEAD', '--', file)
}

export interface Asset { body: Buffer; contentType: string }

/**
 * Read a file from the story's assets/ directory.
 * Returns null when it doesn't exist or isn't a servable type.
 * Rejects any name that escapes assets/ — the name arrives from the browser.
 */
export function readAsset(name: string): Asset | null {
  const abs = path.resolve(ASSETS, name)
  if (abs !== ASSETS && !abs.startsWith(ASSETS + path.sep)) return null
  const contentType = CONTENT_TYPES[path.extname(abs).toLowerCase()]
  if (!contentType) return null
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null
  return { body: fs.readFileSync(abs), contentType }
}
