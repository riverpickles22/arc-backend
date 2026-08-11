// Reading the story's records off disk, in one place.
//
// Three callers need the same walk for different reasons: the capability gate
// needs the ids a file holds, minting needs every id the story has taken, and
// a work node needs a fingerprint of exactly what it read so staleness can be
// decided without asking a model (work-graph.md §6).
//
// All of it reads the YAML rather than the canon export, because the files
// are the source of truth (graph-model.md §5) and because these answers must
// stay available while canon is mid-edit and failing validation — which is
// precisely when an agent is working.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { load as yamlLoad } from 'js-yaml'
import { STORY } from './config'
import { type CanonRecord, recordsIn } from './capability'

/** Story-relative paths under `dir`, recursively. */
export function listFiles(dir: string, base = ''): string[] {
  const out: string[] = []
  const root = path.join(STORY, dir, base)
  if (!fs.existsSync(root)) return out
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const rel = path.join(dir, base, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(dir, path.join(base, entry.name)))
    else out.push(rel)
  }
  return out
}

export interface LocatedRecord extends CanonRecord {
  path: string
}

/** Every record under the given story directories. An unparseable file
 *  contributes nothing — it reserves no id and blocks no work; the validator
 *  is what reports it. */
export function storyRecords(dirs: string[] = ['canon', 'material']): LocatedRecord[] {
  const out: LocatedRecord[] = []
  for (const dir of dirs) {
    for (const rel of listFiles(dir)) {
      if (!rel.endsWith('.yaml')) continue
      try {
        for (const r of recordsIn(yamlLoad(fs.readFileSync(path.join(STORY, rel), 'utf8')), rel))
          out.push({ ...r, path: rel })
      } catch {
        // unparseable; nothing to record
      }
    }
  }
  return out
}

/** Every id the story has already taken — the collision set for minting. */
export function takenIds(): Set<string> {
  return new Set(storyRecords().map(r => r.id))
}

/** The ids one file holds, for read-scope checks. */
export function idsInFile(abs: string, rel: string): string[] {
  if (!abs.endsWith('.yaml')) return []
  try {
    return recordsIn(yamlLoad(fs.readFileSync(abs, 'utf8')), rel).map(r => r.id)
  } catch {
    return []
  }
}

export const fingerprint = (body: string): string => createHash('sha256').update(body).digest('hex').slice(0, 12)

/** id → content fingerprint, for every record in the story. A work node
 *  records these for what it actually read; comparing them afterwards is the
 *  whole of staleness detection. */
export function fingerprints(): Map<string, string> {
  return new Map(storyRecords().map(r => [r.id, fingerprint(r.body)]))
}

/** What the run began against. Git is arc's transaction time, so the SHA is
 *  the honest answer to "which version of the story was this?" — null when
 *  the story is not a repository, which is a supported state. */
export function storyRevision(): string | null {
  try {
    return execFileSync('git', ['-C', STORY, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim()
  } catch {
    return null
  }
}
