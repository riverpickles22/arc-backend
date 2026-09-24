// What is on disk after a killed run or a retired proposal, counted (A67-12).
//
// Invariant 6 says arc can always say what it is holding; invariant 9 says
// every run ends with a receipt. Both are claims about the FILES, and a claim
// about files is worth nothing unless something counts them. These four
// counts are that something.
//
// Every one is read from the record — `.arc/runs/`, the transcript parent,
// `history/`, the registry's own status — and never from prose, and never
// from a model's reading. They are proven, in the register's strict sense:
// arc can show you the files it counted.
import fs from 'node:fs'
import { load as yamlLoad } from 'js-yaml'
import os from 'node:os'
import path from 'node:path'
import { STORY } from './config'
import { encodeProjectDir, scratchParent } from './engine'
import { launchesOf } from './run'
import { registryStatus } from './registry'
import { fingerprintsNow, listAlternatives, withStaleness } from './reroute'
import { liveIds } from './runs'

/** One count, with the files behind it. `some` is a sample, not the whole
 *  list: the terminal prints a sentence, and an author who wants the rest can
 *  look where the sentence says. */
export interface RecordCount {
  id: 'runs-without-receipt' | 'transcripts-no-receipt-names' | 'proposals-out-of-date' | 'rows-never-attended'
  count: number
  some: string[]
}

export interface DoctorRecords {
  counts: RecordCount[]
  /** where each count was read from, so the sentence can say it */
  story: string
  transcripts: string
}

const runsRoot = (story: string): string => path.join(story, '.arc', 'runs')

const runIds = (story: string): string[] => {
  try {
    return fs.readdirSync(runsRoot(story)).filter(id => /^run\.\d+$/.test(id)).sort()
  } catch {
    return []
  }
}

/** A run arc EXECUTED whose record never finished.
 *
 *  NOT "has no receipt file". The receipt is written before the first token,
 *  so a run killed with the backend leaves one — open, with no ending on it.
 *  That is the thing invariant 9 is actually about: every run ends with a
 *  receipt, and a receipt with no ending is a run that did not end. Counting
 *  the file instead of the ending would report zero for exactly the case the
 *  count exists to catch.
 *
 *  Narrower than "every run" on purpose: a run with no launch on record is
 *  one a Claude Code session opened and arc only observed (work-graph §10) —
 *  arc never ran it, has nothing to close, and naming it would be noise the
 *  author cannot act on. */
function runsWithoutReceipt(story: string, live: ReadonlySet<string>): RecordCount {
  const some: string[] = []
  for (const id of runIds(story)) {
    // A run this process is still WORKING is not unfinished. Its receipt is
    // written before the first token and its launch the moment the child
    // spawns, so for the whole twenty minutes a route may take it matches
    // every other test here — and telling the author their working run never
    // finished, and to let its notes go, is both false and a 409.
    if (live.has(id)) continue
    const dir = path.join(runsRoot(story), id)
    if (!fs.existsSync(path.join(dir, 'launches.jsonl'))) continue
    const file = path.join(dir, 'receipt.yaml')
    if (!fs.existsSync(file)) { some.push(id); continue }
    try {
      const r = yamlLoad(fs.readFileSync(file, 'utf8')) as { ending?: string } | null
      if (!r?.ending) some.push(id)
    } catch {
      // Unreadable is not finished. A receipt arc cannot read is one it
      // cannot stand behind, and saying nothing about it would be the one
      // answer that is certainly wrong.
      some.push(id)
    }
  }
  return { id: 'runs-without-receipt', count: some.length, some: some.slice(0, 5) }
}

/** Transcript files under arc's own scratch parent that no run's launches
 *  name. These are what a run record removed by hand, or a launch that died
 *  before it could record itself, leaves behind: text from the book in a file
 *  nothing points at. */
function transcriptsNoReceiptNames(story: string, home: string): RecordCount {
  const parent = scratchParent(process.env, home, story)
  const projects = path.join(home, '.claude', 'projects')
  const prefix = encodeProjectDir(parent)
  let dirs: string[] = []
  try {
    dirs = fs.readdirSync(projects).filter(d => d.startsWith(prefix))
  } catch {
    return { id: 'transcripts-no-receipt-names', count: 0, some: [] }
  }
  const named = new Set<string>()
  for (const id of runIds(story)) {
    for (const l of launchesOf(id)) {
      for (const p of [l.transcript_path, l.expected_transcript]) if (p) named.add(p)
    }
  }
  const some: string[] = []
  for (const d of dirs) {
    let files: string[] = []
    try { files = fs.readdirSync(path.join(projects, d)).filter(f => f.endsWith('.jsonl')) } catch { continue }
    for (const f of files) {
      const full = path.join(projects, d, f)
      if (!named.has(full)) some.push(full)
    }
  }
  return { id: 'transcripts-no-receipt-names', count: some.length, some: some.slice(0, 5) }
}

/** Proposals whose fingerprints no longer match what they were written from
 *  (invariant 1). Counted as the write path counts them, so the number here
 *  and the label on the route can never disagree. A route written by an older
 *  arc is not this: it named no fingerprints, so none of them moved. */
function proposalsOutOfDate(story: string): RecordCount {
  const some: string[] = []
  let scenes: string[] = []
  // Walked from the ALTERNATIVES, not from the manuscript. A route leaves disk
  // only through a disposition, so a scene file the author deleted or renamed
  // leaves its routes behind — and a count that walked the manuscript would
  // report all clear over exactly those.
  try {
    scenes = fs.readdirSync(path.join(story, '.arc', 'alternatives'), { withFileTypes: true })
      .filter(e => e.isDirectory()).map(e => e.name).sort()
  } catch {
    return { id: 'proposals-out-of-date', count: 0, some: [] }
  }
  for (const scene of scenes) {
    // Hoisted: the map costs a canon read, an annotation read and the style
    // composition, and computing it per route walks the manuscript once per
    // route instead of once per scene.
    const now = fingerprintsNow(scene)
    for (const a of listAlternatives(scene)) {
      const stale = withStaleness(a, now).stale
      if (stale?.why === 'the record moved') some.push(`${scene}/${a.id}`)
    }
  }
  return { id: 'proposals-out-of-date', count: some.length, some: some.slice(0, 5) }
}

/** Rows no receipt with an author's decision on it has ever answered for.
 *  A row is a promise about how a job is run; until the author has decided
 *  about something it produced, the promise is untested. */
function rowsNeverAttended(): RecordCount {
  const some = registryStatus()
    .filter(r => r.status === 'built' || r.status === 'designed')
    .map(r => r.key)
  return { id: 'rows-never-attended', count: some.length, some: some.slice(0, 5) }
}

export function doctorRecords(story: string = STORY, home: string = os.homedir(), live: ReadonlySet<string> = liveIds()): DoctorRecords {
  return {
    counts: [
      runsWithoutReceipt(story, live),
      transcriptsNoReceiptNames(story, home),
      proposalsOutOfDate(story),
      rowsNeverAttended(),
    ],
    story,
    transcripts: path.join(home, '.claude', 'projects'),
  }
}
