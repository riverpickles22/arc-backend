// The one path guard. Every path that arrives from outside (the browser,
// the model) resolves through here before touching the filesystem.
import fs from 'node:fs'
import path from 'node:path'
import { HttpError } from './http'

/**
 * Resolve `rel` inside `root`, rejecting anything that escapes — by `..`,
 * by absolute path, or by a symlink planted inside the tree. Returns the
 * absolute path (based on the real root, so callers compare consistently).
 */
export function resolveWithin(root: string, rel: string): string {
  const realRoot = fs.realpathSync(root)
  const abs = path.resolve(realRoot, rel)
  if (abs !== realRoot && !abs.startsWith(realRoot + path.sep)) {
    throw new HttpError(400, `path escapes ${path.basename(root)}/: ${rel}`)
  }
  // A symlink inside the tree can point anywhere: realpath the deepest
  // existing ancestor of the target and require it to still be inside.
  let probe = abs
  while (!fs.existsSync(probe)) probe = path.dirname(probe)
  const real = fs.realpathSync(probe)
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new HttpError(400, `path escapes ${path.basename(root)}/ via symlink: ${rel}`)
  }
  return abs
}
