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
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { StyleLayerPayload as StyleLayer } from 'arc-canon-graph'
import { STORY } from './config'

/** Where the author-level contract canonically lives.
 *  Pure: environment and home directory come in as arguments.
 *
 *  Its own directory — <arc home>/style/ — and deliberately not the arc home
 *  itself. The style directory is versioned as its own repo, because a
 *  ratification into the author layer is a decision and decisions deserve
 *  history; the rest of ~/.arc is machine state (generation ledger, run
 *  telemetry, baselines) that is promised to be safe to delete, and a repo
 *  over all of it would quietly turn scratch into record. */
export function authorStylePath(
  env: { ARC_AUTHOR_STYLE?: string; ARC_HOME?: string },
  home: string,
): string {
  if (env.ARC_AUTHOR_STYLE) return env.ARC_AUTHOR_STYLE
  return path.join(env.ARC_HOME ?? path.join(home, '.arc'), 'style', 'style.md')
}

/** Where it lived before the style directory existed: <arc home>/style.md.
 *  Read as a fallback until migration has run, so nobody's contract goes
 *  silently unloaded in between. */
export function legacyAuthorStylePath(
  env: { ARC_HOME?: string },
  home: string,
): string {
  return path.join(env.ARC_HOME ?? path.join(home, '.arc'), 'style.md')
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
  const canonical = read('author', authorStylePath(process.env, os.homedir()))
  const legacy = process.env.ARC_AUTHOR_STYLE
    ? null   // an explicit override names one file; there is no elsewhere
    : read('author', legacyAuthorStylePath(process.env, os.homedir()))
  return {
    author: canonical ?? legacy,
    story: read('story', path.join(STORY, 'docs', 'style.md')),
  }
}

// ---- the author layer's own history -------------------------------------

const styleGit = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** Move <arc home>/style.md into its versioned directory, once, idempotently.
 *
 *  Runs at startup so no request pays for it and no step is the author's to
 *  remember. The old path becomes a symlink to the new file, so everything
 *  that reads ~/.arc/style.md directly — the arc-canon skill, an editor
 *  bookmark — keeps working without knowing anything moved. Never throws:
 *  a failed migration leaves the legacy fallback doing what it always did. */
export function migrateAuthorStyle(): string | null {
  if (process.env.ARC_AUTHOR_STYLE) return null
  try {
    const home = os.homedir()
    const canonical = authorStylePath(process.env, home)
    const legacy = legacyAuthorStylePath(process.env, home)
    const dir = path.dirname(canonical)

    if (!fs.existsSync(canonical)) {
      const stat = fs.existsSync(legacy) ? fs.lstatSync(legacy) : null
      if (!stat || !stat.isFile() || stat.isSymbolicLink()) return null   // nothing to migrate
      fs.mkdirSync(dir, { recursive: true })
      fs.renameSync(legacy, canonical)
      fs.symlinkSync(canonical, legacy)
    }

    // The history, even for a file that was already in place. init and a
    // baseline commit are both no-ops when they have already happened.
    if (!fs.existsSync(path.join(dir, '.git'))) {
      styleGit(dir, 'init', '-q')
      try { styleGit(dir, 'add', '--', 'style.md'); styleGit(dir, 'commit', '-qm', 'author style: as it stood before arc versioned it') } catch { /* empty file, or identity unset */ }
    }
    return canonical
  } catch (e) {
    console.error('[warn] author-style migration skipped:', e)
    return null
  }
}

/** Commit the author layer after a ratification — its repo, its history.
 *  Best effort: the ratification itself already stands on disk. */
export function commitAuthorStyle(filePath: string, subject: string): boolean {
  try {
    const dir = path.dirname(filePath)
    if (!fs.existsSync(path.join(dir, '.git'))) return false
    styleGit(dir, 'add', '--', path.basename(filePath))
    if (!styleGit(dir, 'status', '--porcelain', '--', path.basename(filePath)).trim()) return false
    styleGit(dir, 'commit', '-qm', subject)
    return true
  } catch {
    return false
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
