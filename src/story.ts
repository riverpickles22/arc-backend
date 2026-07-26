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
