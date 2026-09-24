// The fixture engine: a recorded answer keyed by the fingerprint of the
// rendered brief (agent-workflows.md §4, the engine seam; A67-9).
//
// Every rowed pass has to be testable with no key and no subscription, and a
// brief that changes — a word in its rules, a new slice layer, a moved
// threshold — has to be a test failure before it is an author's surprise.
// Both follow from one rule: the fixture answers ONLY a brief it has seen
// before, byte for byte. A miss refuses with the fingerprint named; the
// fixture never invents, never fuzzy-matches, never falls back to a model.
//
// The store is a directory of markdown files, one per recorded answer:
//
//   fixtures/<row key>/<name>.md
//   ---
//   row: explore.scene.one-shot
//   name: lands
//   fingerprint: 3f1e…         # briefFingerprint() over the rendered brief
//   expect: lands              # what the gate should do with the answer
//   scenario: >                # how the brief was produced, in one breath
//   ---
//   <the answer, verbatim, as the model would have returned it>
//
// The scenarios that render the briefs live in arc-backend's tests
// (test/fixture-scenarios.ts); `npm run fixtures:rekey` re-fingerprints
// every fixture after a deliberate brief change. Nothing here renders a
// brief — the engine only recognises one.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load as yamlLoad } from 'js-yaml'
import type { RowKey } from './registry'
import { sha16 } from './records'

/** Where the recorded answers live. ARC_FIXTURES_PATH overrides, for a test
 *  that wants an empty store or its own. */
export const FIXTURES_DIR = path.resolve(
  process.env.ARC_FIXTURES_PATH ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures'),
)

export interface Fixture {
  /** the registry row's key (registry.ts, rowKey) — the fixture directory */
  row: RowKey
  name: string
  fingerprint: string
  /** what the gate should do with this answer — the test reads it, the engine does not */
  expect: string
  scenario: string
  answer: string
  file: string
}

/** The fingerprint of a rendered brief: sha256 over the exact text the
 *  engine is handed, sixteen hex characters — the same width every other
 *  fingerprint in arc uses. Exact on purpose: a changed space is a changed
 *  brief, and saying otherwise would be the fixture inventing a match. */
export function briefFingerprint(brief: string): string {
  return sha16(brief)
}

const FM_RE = /^---\n([\s\S]*?)\n---\n/

export function parseFixture(text: string, file: string): Fixture | null {
  const m = text.match(FM_RE)
  if (!m) return null
  const head = yamlLoad(m[1]) as Partial<Fixture> | null
  if (!head || typeof head.row !== 'string' || typeof head.name !== 'string' || typeof head.fingerprint !== 'string') return null
  return {
    row: head.row, name: head.name, fingerprint: head.fingerprint,
    expect: String(head.expect ?? ''), scenario: String(head.scenario ?? '').trim(),
    answer: text.slice(m[0].length).replace(/^\n/, '').replace(/\n$/, ''),
    file,
  }
}

/** Every recorded answer on disk, read fresh: the store is small, and a
 *  rekey has to be visible to the very next call. */
export function loadFixtures(dir: string = FIXTURES_DIR): Fixture[] {
  if (!fs.existsSync(dir)) return []
  const out: Fixture[] = []
  for (const key of fs.readdirSync(dir).sort()) {
    const sub = path.join(dir, key)
    if (!fs.statSync(sub).isDirectory()) continue
    for (const name of fs.readdirSync(sub).sort()) {
      if (!name.endsWith('.md')) continue
      const file = path.join(sub, name)
      const f = parseFixture(fs.readFileSync(file, 'utf8'), file)
      if (f) out.push(f)
    }
  }
  return out
}

export class FixtureMiss extends Error {
  constructor(readonly row: RowKey, readonly fingerprint: string, known: Fixture[]) {
    super(
      `fixture engine has no recorded answer for the ${row} brief ${fingerprint} — ` +
      `the brief changed, or this scenario was never recorded` +
      (known.length ? ` (recorded for ${row}: ${known.map(k => `${k.name} ${k.fingerprint}`).join(', ')})` : ` (nothing is recorded for ${row})`) +
      `. If the change is intended, run \`npm run fixtures:rekey\` in arc-backend.`,
    )
    this.name = 'FixtureMiss'
  }
}

export interface BriefSeen { row: RowKey; brief: string; fingerprint: string; hit: Fixture | null }
const observers = new Set<(seen: BriefSeen) => void>()

/** Watch every brief the fixture engine is handed, hit or miss. This is how
 *  the tests learn what a scenario rendered, and how the rekey script gets
 *  the fingerprint to record — the brief is observed at the seam, never
 *  re-rendered by a second path that could drift from the first. */
export function observeBriefs(fn: (seen: BriefSeen) => void): () => void {
  observers.add(fn)
  return () => { observers.delete(fn) }
}

/** The fixture realisation of the seam: the same shape runCliPrompt returns,
 *  so a pass cannot tell which engine answered — which is the point. */
export async function runFixturePrompt(brief: string, opts: { row: RowKey }): Promise<{ text: string; sessionId: string | null }> {
  const fingerprint = briefFingerprint(brief)
  const known = loadFixtures().filter(f => f.row === opts.row)
  const hit = known.find(f => f.fingerprint === fingerprint) ?? null
  for (const fn of observers) fn({ row: opts.row, brief, fingerprint, hit })
  if (!hit) throw new FixtureMiss(opts.row, fingerprint, known)
  return { text: hit.answer, sessionId: null }
}
