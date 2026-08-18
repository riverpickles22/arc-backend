// The style contract (conventions §10): the author's voice, written down so
// it survives a new session, a new collaborator, or a machine.
//
// Two layers, both loaded, the more specific winning:
//   ~/.arc/style.md      how this author writes, in any book
//   <STORY>/docs/style.md   how THIS book's sentences behave — wins on conflict
//
// Composition is concatenation with labels, never a rule-level merge: there is
// no schema here and nothing to keep in sync. The precedence sentence comes
// after both blocks so it is the last thing a model reads.
//
// This module is the ONLY place either path is resolved. Passes that write or
// judge prose call styleContract(); nothing else needs to know the layout.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { StyleLayerPayload as StyleLayer } from 'arc-canon-graph'
import { STORY } from './config'

/** Where the author-level contract lives, or null when the author has none.
 *  Pure: environment and home directory come in as arguments. */
export function authorStylePath(
  env: { ARC_AUTHOR_STYLE?: string; ARC_HOME?: string },
  home: string,
): string {
  if (env.ARC_AUTHOR_STYLE) return env.ARC_AUTHOR_STYLE
  if (env.ARC_HOME) return path.join(env.ARC_HOME, 'style.md')
  return path.join(home, '.arc', 'style.md')
}

/** Frontmatter is a binding mechanism for docs articles (§7); in a style
 *  contract it is noise the model should never see. */
export const stripFrontmatter = (text: string): string =>
  text.replace(/^---\n[\s\S]*?\n---\n?/, '')

const read = (source: StyleLayer['source'], p: string): StyleLayer | null =>
  fs.existsSync(p) ? { source, path: p, body: stripFrontmatter(fs.readFileSync(p, 'utf8')) } : null

/** Both layers as they exist on disk. Either may be absent; absent is normal,
 *  not an error — a writer with one book needs only the story layer. */
export function loadStyleLayers(): { author: StyleLayer | null; story: StyleLayer | null } {
  return {
    author: read('author', authorStylePath(process.env, os.homedir())),
    story: read('story', path.join(STORY, 'docs', 'style.md')),
  }
}

/** The block every prose pass puts in its prompt. Pure, so the labels and the
 *  precedence sentence are testable without touching a disk. */
export function composeStyle(layers: { author: StyleLayer | null; story: StyleLayer | null }): string {
  if (!layers.author && !layers.story) {
    return 'No style contract exists for this story (conventions §10). Write clean, restrained prose, and do not invent house rules.'
  }
  const out = [
    '=== STYLE LAYER 1 — THE AUTHOR (constant across every book) ===',
    layers.author?.body.trim() ?? '(this author has no author-level style file)',
    '',
    "=== STYLE LAYER 2 — THIS BOOK (docs/style.md) ===",
    layers.story?.body.trim() ?? '(this story has no style contract of its own)',
    '',
    'PRECEDENCE: layer 2 wins on any conflict; layer 1 applies wherever layer 2',
    'is silent. Both bind prose FORM only — canon still wins on any question of',
    'FACT (conventions §1). Any rule marked proposed, anywhere, is NOT binding.',
  ]
  return out.join('\n')
}

/** The style contract as a prompt block. The one call sites use. */
export function styleContract(): string {
  return composeStyle(loadStyleLayers())
}

/** One line for the startup banner — a two-layer feature that silently loads
 *  one layer is a bug generator, so say which layers are live. */
export function describeStyle(): string {
  const { author, story } = loadStyleLayers()
  const parts = [story ? 'docs/style.md' : null, author ? author.path : null].filter(Boolean)
  return parts.length ? parts.join(' + ') : 'none (conventions §10)'
}
