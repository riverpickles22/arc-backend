// The story's presentation layer: view.yaml and the assets/ directory.
//
// These are deliberately not canon — they say how the story is *drawn*, not
// what is true about it — so they live outside canon/ and are served straight
// through rather than going near the validator. They live in the story repo
// rather than the viewer so arc-frontend stays story-agnostic.
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

export interface ProseScene {
  scene: string; chapter: string; status: string
  pov: string | null; events: string[]; facts: string[]
  file: string; body: string
}

/** Every bound scene in prose/ (conventions §10). Files without scene
 *  frontmatter (READMEs, loose drafts) are not part of the manuscript. */
export function proseScenes(): ProseScene[] {
  const root = path.join(STORY, 'prose')
  const out: ProseScene[] = []
  for (const abs of mdFiles(root)) {
    const text = fs.readFileSync(abs, 'utf8')
    const fm = text.match(FM_RE)
    if (!fm) continue
    const meta = (yamlLoad(fm[1]) ?? {}) as Record<string, unknown>
    if (typeof meta.scene !== 'string') continue
    out.push({
      scene: meta.scene,
      chapter: String(meta.chapter ?? ''),
      status: String(meta.status ?? 'proposed'),
      pov: typeof meta.pov === 'string' ? meta.pov : null,
      events: Array.isArray(meta.events) ? meta.events.map(String) : [],
      facts: Array.isArray(meta.facts) ? meta.facts.map(String) : [],
      file: path.relative(STORY, abs),
      body: text.slice(fm[0].length),
    })
  }
  return out
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
