// Where everything lives. The monorepo version of this file walked up the tree
// looking for a directory containing both stories/ and tools/; with arc split
// across repos no such directory exists, so adjacency becomes configuration.
// Defaults assume sibling checkouts, which is the normal local layout.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function resolveDir(envVar: string, fallback: string, mustContain: string, what: string): string {
  const raw = process.env[envVar] ?? fallback
  const abs = path.resolve(ROOT, raw)
  if (!fs.existsSync(path.join(abs, mustContain))) {
    throw new Error(
      `${what} not found at ${abs} (no ${mustContain}/ inside it).\n` +
      `Set ${envVar} to the ${what} checkout, or clone it next to arc-backend as ${fallback}.`
    )
  }
  return abs
}

/** arc-core: schemas, conventions, and the python tools. */
export const CORE = resolveDir('ARC_CORE_PATH', '../arc-core', 'schema', 'arc-core')

/**
 * The story being edited: canon/, docs/, research/, prose/.
 * Defaults to arc-core's worked example so a fresh checkout runs with no
 * configuration; point ARC_STORY_PATH at your own story to use it.
 */
export const STORY = resolveDir(
  'ARC_STORY_PATH', '../arc-core/examples/example-story', 'canon', 'the story',
)

/** Python with pyyaml + jsonschema installed — arc-core's venv, or whatever is on PATH. */
export const PYTHON = process.env.ARC_PYTHON
  ?? (fs.existsSync(path.join(CORE, '.venv', 'bin', 'python'))
    ? path.join(CORE, '.venv', 'bin', 'python')
    : 'python3')

export const PORT = Number(process.env.PORT ?? 8787)

// Opus 5 is the current recommended model; override per-deployment if needed.
export const MODEL = process.env.ARC_MODEL ?? 'claude-opus-5'

export function describeConfig(): string {
  return [
    `  core   ${CORE}`,
    `  story  ${STORY}`,
    `  python ${PYTHON}`,
    `  model  ${MODEL}`,
  ].join('\n')
}
