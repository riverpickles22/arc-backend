// THE FOUR NUMBERS (A76-3; roadmap phase 4, "Measure").
//
// Capture precision, style-gate usefulness, review precision and the
// record-maintenance burden, each computed from what the record already holds
// — the record receipts in history/, the working receipts and event logs in
// .arc/runs/, the evidence log, the generation ledger and git history — and
// printed with its definition, its sources and the window of history it
// covers. Re-run it on another day and the two printouts are a trend.
//
// NO MODEL CALL, AND NOTHING WRITTEN. Every read is `fs.readFileSync` or a
// read-only git verb through the story's own `git` helper, which is what
// test/commit-lane.test.ts reads: a verb that moves something in this file
// fails that check. Nothing here opens a file for writing.
//
// ONE PLACE PER DEFINITION. Each number is one entry of MEASURES below: its
// name, the definition the author reads, its sources and the function that
// computes it, side by side. Every definition is printed as a DEFAULT the
// author confirms or changes (idea-measure-before-branching); changing one is
// an edit to that entry. A76-4 replaced the burden's entry with the number.
//
// REGISTERS. Every count is proven — code can show the files behind it. A
// number that rests on an approximation says so in its definition, and a
// number the record cannot show yet is printed as not measurable, with what
// is missing, rather than filled with a proxy.
import fs from 'node:fs'
import path from 'node:path'
import { load as yamlLoad } from 'js-yaml'
import { STORY } from './config'
import { git } from './lane'
import { entityKeys, recordKeys } from './proposals'
import { rowKey, type Cell } from './registry'
import type { GateRecord, Receipt } from './run'
import { SESSION_GAP_HOURS } from './briefing'
import { countedIntervals, IDLE_MINUTES, kindOfPath, RECORD_DIRS, SESSIONS_REL } from './session'
import { COUNTABLE_RULES } from './countable'
import type { SessionInterval, SessionKind } from 'arc-canon-graph/api-types.ts'

// ---- the result ------------------------------------------------------------------

export type MeasureStatus = 'measured' | 'not measurable yet' | 'not measured yet'

export interface MeasureResult {
  id: 'capture-precision' | 'style-gate-usefulness' | 'review-precision' | 'record-maintenance-burden'
  name: string
  status: MeasureStatus
  /** printed as "default definition — confirm or change" */
  definition: string
  sources: string[]
  /** the headline, in one line */
  value: string
  /** what the record lacks, for a number it cannot show yet */
  missing?: string
  /** the same number cut by registry row (`rowKey`) */
  rows: Record<string, unknown>[]
  /** the counts behind the headline, for --json */
  totals: Record<string, unknown>
  /** the window of history this number actually read */
  covers: { from: string | null; to: string | null }
}

export interface Measurement {
  measured_at: string
  story: string
  window: { since: string | null; from: string | null; to: string | null }
  measures: MeasureResult[]
}

// ---- reading the record (read-only) ------------------------------------------------

interface Commit { sha: string; parent: string | null; at: string; files: string[] }

interface Evidence {
  at: string
  kind?: string
  /** a judgment (no kind) */
  scene?: string | null
  verdict?: string
  arcWrote?: string
  authorKept?: string
  run?: string | null
  /** a proposal decision */
  id?: string
  key?: string
  class?: string | null
  /** the line exactly as the file holds it, so its commit can be found */
  line: string
}

interface LedgerOrigin { origin?: string; canon?: string; file?: string; run?: string; key?: string; reverted?: boolean }

interface RunLog { id: string; started_at: string | null; events: { at: string; event: string; detail?: Record<string, unknown> }[] }

export interface StoryRecord {
  since: string | null
  /** by run id; the record receipt wins over the working one */
  receipts: Map<string, Receipt>
  evidence: Evidence[]
  ledger: LedgerOrigin[]
  runs: RunLog[]
  /** oldest first; null when the story is not a git repository */
  commits: Commit[] | null
  dismissed: { at: string }[]
  /** the session timer's intervals, oldest first */
  intervals: SessionInterval[]
  /** every commit's time and kind, for the burden's fallback; null when not a repository */
  stamps: Stamp[] | null
}

const EVIDENCE_REL = 'docs/style.evidence.jsonl'
const STYLE_CONTRACT_REL = 'docs/style.md'
const DISMISSED_REL = 'docs/style.dismissed.md'

const readText = (rel: string): string | null => {
  try { return fs.readFileSync(path.join(STORY, rel), 'utf8') } catch { return null }
}
const jsonLines = <T>(text: string | null): (T & { line: string })[] =>
  (text ?? '').split('\n').filter(Boolean).flatMap(line => {
    try { return [{ ...(JSON.parse(line) as T), line }] } catch { return [] }
  })
const dirEntries = (rel: string): string[] => {
  try { return fs.readdirSync(path.join(STORY, rel)).sort() } catch { return [] }
}
const inWindow = (at: string | null | undefined, since: string | null): boolean => !since || (!!at && at >= since)

/** The text of a file at a commit, or null where it was not there. Paths are
 *  the story's own (`./` resolves against the story directory, which is
 *  where the helper runs git, so a story inside a larger repository reads
 *  the same as one at its root). */
function showAt(rev: string | null, rel: string): string | null {
  if (!rev) return null
  // asked first, so a path the commit does not hold is an empty answer and
  // never git's complaint on the terminal
  try { if (!git('ls-tree', '--name-only', rev, '--', rel).trim()) return null } catch { return null }
  try { return git('show', `${rev}:./${rel}`) } catch { return null }
}

function readCommits(): Commit[] | null {
  let out: string
  try {
    out = git('log', '--reverse', '--relative', '--format=%x1e%H%x09%P%x09%cI', '--name-only',
      '--', 'canon', 'prose', EVIDENCE_REL, STYLE_CONTRACT_REL)
  } catch {
    return null
  }
  return out.split('\x1e').filter(s => s.trim()).map(chunk => {
    const [head, ...files] = chunk.split('\n')
    const [sha, parents, at] = head.split('\t')
    return { sha, parent: parents.split(' ')[0] || null, at: new Date(at).toISOString(), files: files.map(f => f.trim()).filter(Boolean) }
  })
}

export function readRecord(since: string | null): StoryRecord {
  const receipts = new Map<string, Receipt>()
  const take = (text: string | null): void => {
    if (!text) return
    try {
      const r = yamlLoad(text) as Receipt | null
      if (r && typeof r === 'object' && r.run_id && !receipts.has(r.run_id)) receipts.set(r.run_id, r)
    } catch { /* not a receipt */ }
  }
  for (const f of dirEntries('history')) if (f.endsWith('.yaml')) take(readText(path.join('history', f)))
  const runs: RunLog[] = []
  for (const id of dirEntries(path.join('.arc', 'runs'))) {
    take(readText(path.join('.arc', 'runs', id, 'receipt.yaml')))
    let started: string | null = null
    try { started = (JSON.parse(readText(path.join('.arc', 'runs', id, 'root.json')) ?? '') as { started_at?: string }).started_at ?? null } catch { /* none */ }
    runs.push({ id, started_at: started, events: jsonLines<RunLog['events'][number]>(readText(path.join('.arc', 'runs', id, 'events.jsonl'))) })
  }
  const dismissed = [...(readText(DISMISSED_REL) ?? '').matchAll(/<!--\s*arc:dismissed\s+(\{[\s\S]*?\})\s*-->/g)].flatMap(m => {
    try { return [JSON.parse(m[1]) as { at: string }] } catch { return [] }
  })
  return {
    since,
    receipts,
    evidence: jsonLines<Evidence>(readText(EVIDENCE_REL)),
    ledger: jsonLines<LedgerOrigin>(readText(path.join('.arc', 'drafts.jsonl'))),
    runs,
    commits: readCommits(),
    dismissed,
    intervals: countedIntervals(),
    stamps: readStamps(),
  }
}

// ---- canon at a commit -------------------------------------------------------------

type CanonObj = Record<string, unknown>

/** Every record a canon file's text holds, by id: a file that is one record,
 *  or the items of its lists. */
function recordsInText(text: string | null): Map<string, CanonObj> {
  const out = new Map<string, CanonObj>()
  if (!text) return out
  let doc: unknown
  try { doc = yamlLoad(text) } catch { return out }
  if (!doc || typeof doc !== 'object') return out
  const top = doc as CanonObj
  if (typeof top.id === 'string') { out.set(top.id, top); return out }
  for (const v of Object.values(top)) {
    if (!Array.isArray(v)) continue
    for (const m of v) if (m && typeof m === 'object' && typeof (m as CanonObj).id === 'string') out.set((m as CanonObj).id as string, m as CanonObj)
  }
  return out
}

/** The keys a record answers to, by the functions the duplicate gate uses. */
function keysOf(o: CanonObj): string[] {
  if (o.type === 'relationship') return recordKeys({ relationships: [o as unknown as { from: string; to: string; kind: string; directed?: boolean }] })
  if (o.type === 'event') return recordKeys({ events: { e: { title: String(o.title ?? o.name ?? ''), participants: (o.participants as { entity: string }[] | undefined) ?? [] } } })
  return entityKeys(o as { type?: string; name?: string; aliases?: string[] })
}

/** One record as a commit holds it: in the file its origin names, or found
 *  by walking the commit's canon/. */
function recordAt(rev: string | null, id: string, file: string | undefined): CanonObj | null {
  if (!rev) {
    const files = file ? [file] : []
    for (const f of files) { const hit = recordsInText(readText(f)).get(id); if (hit) return hit }
    return null
  }
  if (file) { const hit = recordsInText(showAt(rev, file)).get(id); if (hit) return hit }
  let names: string[] = []
  try { names = git('ls-tree', '-r', '--name-only', rev, '--', 'canon').split('\n').filter(n => n.endsWith('.yaml')) } catch { return null }
  for (const n of names) { const hit = recordsInText(showAt(rev, n)).get(id); if (hit) return hit }
  return null
}

const sansStatus = (o: CanonObj): string => JSON.stringify({ ...o, status: undefined })

// ---- shared cuts -------------------------------------------------------------------

const rowOf = (r: Receipt): string => r.cell ? rowKey(r.cell as unknown as Cell) : 'unrowed'
const ratio = (n: number, d: number): number | null => d ? Math.round((n / d) * 100) / 100 : null
const fmt = (n: number | null): string => n === null ? 'n/a' : String(n)
const span = (ats: (string | null | undefined)[]): { from: string | null; to: string | null } => {
  const xs = ats.filter((a): a is string => !!a).sort()
  return { from: xs[0] ?? null, to: xs.at(-1) ?? null }
}

/** The scenes a prose commit touched, read from each file's frontmatter at
 *  that commit — ids only. */
function scenesOf(c: Commit): string[] {
  const out: string[] = []
  for (const f of c.files.filter(f => f.startsWith('prose/') && f.endsWith('.md'))) {
    const m = /^---\n[\s\S]*?^scene:[ \t]*(\S+)/m.exec(showAt(c.sha, f) ?? '')
    if (m) out.push(m[1])
  }
  return out
}

/** Did this commit record a decision on a proposal (decide-proposals.ts)? Its
 *  evidence-log diff adds a `kind: proposal` line. */
function decidesProposals(c: Commit): boolean {
  if (!c.files.includes(EVIDENCE_REL)) return false
  try {
    return git('show', '--format=', '--unified=0', c.sha, '--', EVIDENCE_REL).split('\n')
      .some(l => l.startsWith('+{') && l.includes('"kind":"proposal"'))
  } catch { return false }
}

// ---- 1. capture precision ----------------------------------------------------------

const CAPTURE_JOB = 'update-record'

function capturePrecision(rec: StoryRecord): Omit<MeasureResult, 'id' | 'name' | 'definition' | 'sources'> {
  const u7 = [...rec.receipts.values()].filter(r => r.cell?.job === CAPTURE_JOB && inWindow(r.started_at, rec.since))
  const landed = u7.filter(r => r.ending === 'landed')
  const runRow = new Map(u7.map(r => [r.run_id, rowOf(r)]))
  const sceneOfRun = new Map(landed.map(r => [r.run_id, r.request?.subject ?? null]))
  const originFile = new Map<string, string>()
  for (const o of rec.ledger) if (o.origin === CAPTURE_JOB && o.canon && o.file && !o.reverted) originFile.set(`${o.run}|${o.canon}`, o.file)

  // filed: what each landed read put in the record
  const filed = new Set<string>()
  for (const r of landed) for (const id of r.result?.records ?? []) filed.add(`${r.run_id}|${id}`)
  // every id capture ever proposed, in any window: none of them can be missed
  const proposedIds = new Set<string>([
    ...[...rec.receipts.values()].filter(r => r.cell?.job === CAPTURE_JOB).flatMap(r => r.result?.records ?? []),
    ...rec.ledger.filter(o => o.origin === CAPTURE_JOB && o.canon).map(o => o.canon!),
    ...rec.evidence.filter(e => e.kind === 'proposal' && e.run && e.id).map(e => e.id!),
  ])

  // decisions, one per proposal (run|id): the first line carries the key it
  // was proposed under (decide-proposals writes the origin's key first)
  // A DECISION IS WINDOWED BY THE READ THAT FILED IT, never by its own date:
  // a never on a read before the window would otherwise count against scenes
  // the window does not hold. One on a read outside the window is counted
  // apart; one whose read left no receipt falls back to its own date.
  const inWindowRuns = new Set(u7.map(r => r.run_id))
  const decided = new Map<string, Evidence[]>()
  const decidedOutside = new Set<string>()
  for (const e of rec.evidence) {
    if (e.kind !== 'proposal' || !e.run || !e.id) continue
    const k = `${e.run}|${e.id}`
    const counted = inWindowRuns.has(e.run) || (!rec.receipts.has(e.run) && inWindow(e.at, rec.since))
    if (!counted) { decidedOutside.add(k); continue }
    decided.set(k, [...(decided.get(k) ?? []), e])
  }

  type Row = { row: string; scenes_read: number; filed: number; approved: number; approved_unedited: number; never: number; waiting: number; missed: number }
  const rows = new Map<string, Row>()
  const rowFor = (name: string): Row => {
    if (!rows.has(name)) rows.set(name, { row: name, scenes_read: 0, filed: 0, approved: 0, approved_unedited: 0, never: 0, waiting: 0, missed: 0 })
    return rows.get(name)!
  }
  const scenesByRow = new Map<string, Set<string>>()
  for (const r of landed) {
    const s = r.request?.subject
    if (!s) continue
    scenesByRow.set(rowOf(r), new Set([...(scenesByRow.get(rowOf(r)) ?? []), s]))
  }
  for (const [row, s] of scenesByRow) rowFor(row).scenes_read = s.size
  for (const k of filed) {
    const row = rowFor(runRow.get(k.split('|')[0]) ?? 'unrowed')
    row.filed++
    if (!decided.has(k)) row.waiting++
  }

  const editedIds: string[] = []
  for (const [k, lines] of decided) {
    const [run, id] = k.split('|')
    const row = rowFor(runRow.get(run) ?? 'unrowed')
    const verdict = lines[0].verdict
    if (verdict === 'never') { row.never++; continue }
    if (verdict !== 'approved') continue
    row.approved++
    // the approval's own commit: the one that added this exact line
    let commit: string | null = null
    try { commit = git('log', '--format=%H', `-S${lines[0].line}`, '--', EVIDENCE_REL).trim().split('\n').filter(Boolean).at(-1) ?? null } catch { commit = null }
    const at = recordAt(commit, id, originFile.get(k))
    if (at && lines[0].key && keysOf(at).includes(lines[0].key)) row.approved_unedited++
    else editedIds.push(id)
  }

  // MISSED: a canon change outside capture's decisions, after an accept of a
  // scene capture read, for an id capture never proposed
  const missed: { id: string; scene: string; commit: string; how: 'added' | 'changed' }[] = []
  const afterUnread: string[] = []
  const readAt = new Map<string, string>()   // scene → earliest landed read
  const readRow = new Map<string, string>()  // scene → that read's row
  for (const r of landed) {
    const s = r.request?.subject
    if (s && (!readAt.has(s) || r.started_at < readAt.get(s)!)) { readAt.set(s, r.started_at); readRow.set(s, rowOf(r)) }
  }
  let lastScenes: string[] = []
  for (const c of rec.commits ?? []) {
    const touched = scenesOf(c)
    if (touched.length) lastScenes = touched
    const canonFiles = c.files.filter(f => f.startsWith('canon/') && f.endsWith('.yaml'))
    if (!canonFiles.length || !inWindow(c.at, rec.since) || decidesProposals(c)) continue
    const scene = lastScenes[0]
    if (!scene) continue                        // before any accept: nothing to have missed
    for (const f of canonFiles) {
      const before = recordsInText(showAt(c.parent, f))
      const after = recordsInText(showAt(c.sha, f))
      for (const [id, o] of after) {
        if (proposedIds.has(id)) continue
        const prior = before.get(id)
        const how = !prior ? 'added' : sansStatus(prior) !== sansStatus(o) ? 'changed' : null
        if (!how) continue
        const read = readAt.get(scene)
        if (read && read <= c.at) missed.push({ id, scene, commit: c.sha, how })
        else afterUnread.push(id)
      }
    }
  }
  // each miss goes to ONE row, the earliest read's, so the rows sum to the total
  for (const m of missed) {
    rowFor(readRow.get(m.scene)!).missed++
  }

  const all = [...rows.values()]
  const sum = (k: keyof Row): number => all.reduce((n, r) => n + (r[k] as number), 0)
  const scenesRead = new Set([...sceneOfRun.values()].filter((s): s is string => !!s)).size
  const totals = {
    reads: u7.length, reads_landed: landed.length, scenes_read: scenesRead,
    filed: sum('filed'), approved: sum('approved'), approved_unedited: sum('approved_unedited'),
    never: sum('never'), waiting: sum('waiting'), missed: missed.length,
    false_per_scene: ratio(sum('never'), scenesRead), missed_per_scene: ratio(missed.length, scenesRead),
    missed_by_how: { added: missed.filter(m => m.how === 'added').length, changed: missed.filter(m => m.how === 'changed').length },
    missed_ids: missed.map(m => m.id), approved_edited_ids: editedIds,
    // counted apart: a canon change after an accept capture had not read
    // (the record's first import among them) is no miss of capture's
    changed_where_capture_had_not_read: afterUnread.length,
    // decisions on proposals filed by a read outside the window, counted apart
    decided_on_reads_outside_window: decidedOutside.size,
  }
  const covers = span([
    ...u7.map(r => r.started_at), ...[...decided.values()].map(l => l[0].at),
    ...missed.map(m => (rec.commits ?? []).find(c => c.sha === m.commit)?.at),
  ])
  if (!u7.length) {
    return { status: 'measured', value: 'capture has read no scene in this window, so there is nothing to count yet', rows: [], totals, covers }
  }
  return {
    status: 'measured',
    value: `${fmt(totals.false_per_scene)} false and ${fmt(totals.missed_per_scene)} missed per scene capture read (${scenesRead} scene${scenesRead === 1 ? '' : 's'}); `
      + `${totals.approved_unedited} of ${totals.approved} approved unedited; ${totals.waiting} still waiting`,
    rows: all, totals, covers,
  }
}

// ---- 2. style-gate usefulness ------------------------------------------------------

/** The gates that hold arc's prose to a countable rule of the style contract
 *  — the countable rules themselves, by the name a gate and a finding share
 *  (`countable.ts`), so a third rule is a style gate the day it is one. */
export const STYLE_GATES: readonly string[] = COUNTABLE_RULES

const isStyleGate = (g: GateRecord): boolean => STYLE_GATES.includes(g.gate)

/** An author's verdict that did not keep arc's words as written. */
const isComplaint = (e: Evidence): boolean =>
  e.kind === undefined && (e.verdict === 'rejected' || (e.verdict === 'accepted' && (e.arcWrote ?? '') !== (e.authorKept ?? '')))

function styleGateUsefulness(rec: StoryRecord): Omit<MeasureResult, 'id' | 'name' | 'definition' | 'sources'> {
  const all = [...rec.receipts.values()]
  const gatedAt = all.filter(r => (r.gates ?? []).some(isStyleGate)).map(r => r.started_at).sort()
  const cutover = gatedAt[0] ?? null
  const rowed = all.filter(r => r.cell && inWindow(r.started_at, rec.since))

  type Row = { row: string; runs: number; gated_runs: number; refusals: number; refusals_per_run: number | null; could_not_judge: number; ended_refused_by_style: number; complaints_before: number; complaints_after: number }
  const rows = new Map<string, Row>()
  const rowFor = (name: string): Row => {
    if (!rows.has(name)) rows.set(name, { row: name, runs: 0, gated_runs: 0, refusals: 0, refusals_per_run: null, could_not_judge: 0, ended_refused_by_style: 0, complaints_before: 0, complaints_after: 0 })
    return rows.get(name)!
  }
  for (const r of rowed) {
    const row = rowFor(rowOf(r))
    const style = (r.gates ?? []).filter(isStyleGate)
    row.runs++
    if (style.length) row.gated_runs++
    row.refusals += style.filter(g => g.verdict === 'refused').length
    row.could_not_judge += style.filter(g => g.verdict === 'could not judge').length
    const last = (r.gates ?? []).filter(g => g.verdict === 'refused').at(-1)
    if (r.ending === 'refused' && last && isStyleGate(last)) row.ended_refused_by_style++
  }
  // over the runs a style gate judged: a run before the gates existed, or
  // of a row whose answer is not prose, could not have been refused
  for (const row of rows.values()) row.refusals_per_run = ratio(row.refusals, row.gated_runs)

  const judged = rec.evidence.filter(e => e.kind === undefined && inWindow(e.at, rec.since))
  const period = (e: Evidence): 'before' | 'after' => cutover && e.at >= cutover ? 'after' : 'before'
  const scenes = { before: new Set<string>(), after: new Set<string>() }
  const complaints = { before: 0, after: 0 }
  for (const e of judged) {
    const p = period(e)
    if (e.scene) scenes[p].add(e.scene)
    if (!isComplaint(e)) continue
    complaints[p]++
    const receipt = e.run ? rec.receipts.get(e.run) : undefined
    const row = rowFor(receipt ? rowOf(receipt) : 'no run recorded')
    if (p === 'before') row.complaints_before++; else row.complaints_after++
  }
  // the headline is over the rows the style gates judge at all: a row whose
  // answer is not prose carries none, and is listed but not counted
  const judgedRows = [...rows.values()].filter(r => r.gated_runs > 0)
  const refusals = judgedRows.reduce((n, r) => n + r.refusals, 0)
  const runs = judgedRows.reduce((n, r) => n + r.gated_runs, 0)
  const contractChanges = (rec.commits ?? []).filter(c => c.files.includes(STYLE_CONTRACT_REL) && inWindow(c.at, rec.since)).length
  const totals = {
    gates_first_ran: cutover, runs: rowed.length, gated_runs: runs,
    refusals, refusals_per_run: ratio(refusals, runs),
    complaints_before: complaints.before, scenes_judged_before: scenes.before.size, complaints_per_scene_before: ratio(complaints.before, scenes.before.size),
    complaints_after: complaints.after, scenes_judged_after: scenes.after.size, complaints_per_scene_after: ratio(complaints.after, scenes.after.size),
    context: { rules_declined: rec.dismissed.filter(d => inWindow(d.at, rec.since)).length, style_contract_commits: rec.commits ? contractChanges : null },
  }
  const covers = span([...rowed.map(r => r.started_at), ...judged.map(e => e.at)])
  const value = !rowed.length && !judged.length
    ? 'no run and no verdict on arc\'s prose in this window, so there is nothing to count yet'
    : `${fmt(totals.refusals_per_run)} refusals per run (${refusals} over ${runs} run${runs === 1 ? '' : 's'} a style gate judged); complaints per scene ${fmt(totals.complaints_per_scene_before)} before the gates, ${fmt(totals.complaints_per_scene_after)} after`
      + (cutover ? ` (the gates first ran ${cutover.slice(0, 10)})` : ' (no run in the record carries a style gate yet)')
  return { status: 'measured', value, rows: [...rows.values()], totals, covers }
}

// ---- 3. review precision -----------------------------------------------------------

const REVIEW_MISSING = 'The record keeps how many findings a reading showed but nothing about what the author did with any one of them. '
  + 'The lens runs keep a count per lens and no finding; an inspect reading keeps its findings in the answer it returned, with no id; '
  + 'and no note, edit or dismissal names the finding it came from (the viewer records no dismissal at all). '
  + 'To measure it, each finding a reading shows needs an id on that run\'s record, and the note made from it — or the author\'s dismissal of it, in the evidence log — needs to name that id.'

function reviewPrecision(rec: StoryRecord): Omit<MeasureResult, 'id' | 'name' | 'definition' | 'sources'> {
  const rows = new Map<string, { row: string; readings: number; findings_shown: number; acted_on: null }>()
  const add = (row: string, n: number): void => {
    const r = rows.get(row) ?? { row, readings: 0, findings_shown: 0, acted_on: null }
    r.readings++; r.findings_shown += n
    rows.set(row, r)
  }
  const ats: string[] = []
  // the lenses are not on a row yet: their fan-out leaves one judge.completed event
  for (const run of rec.runs) {
    for (const e of run.events) {
      // the material worker's judgment emits the same event, with no lenses
      if (e.event !== 'judge.completed' || !Array.isArray(e.detail?.lenses) || !inWindow(e.at, rec.since)) continue
      const lenses = e.detail!.lenses as { findings?: number }[]
      add('lenses (no row yet)', lenses.reduce((n, l) => n + (l.findings ?? 0), 0))
      ats.push(e.at)
    }
  }
  // U9: the findings the reading kept, as the gate runner counts them onto
  // the receipt (`evidence.returned`) — the citations gate writes one record
  // per reading, not one per finding
  for (const r of rec.receipts.values()) {
    if (r.cell?.job !== 'inspect' || r.ending !== 'landed' || !inWindow(r.started_at, rec.since)) continue
    add(rowOf(r), r.evidence?.returned ?? 0)
    ats.push(r.started_at)
  }
  const shown = [...rows.values()].reduce((n, r) => n + r.findings_shown, 0)
  const readings = [...rows.values()].reduce((n, r) => n + r.readings, 0)
  return {
    status: 'not measurable yet',
    value: `not measurable yet — ${shown} finding${shown === 1 ? '' : 's'} shown in ${readings} reading${readings === 1 ? '' : 's'}, and the record cannot show which the author acted on`,
    missing: REVIEW_MISSING,
    rows: [...rows.values()],
    totals: { findings_shown: shown, acted_on: null },
    covers: span(ats),
  }
}

// ---- 4. record-maintenance burden (A76-4) -------------------------------------------

/** What a commit's files say the author was doing: prose is writing; the
 *  canon, the notes, the docs (the style contract among them), the
 *  annotations, the locks and the material are the record. A commit that
 *  touches prose counts as writing — an accept carries its evidence line
 *  beside the scene — and one that touches neither (arc's own receipts in
 *  history/) is no author time and is left out. */
export function kindOfCommit(files: string[]): SessionKind | null {
  // The directories are session.ts's, the ones the timer watches (A81-3).
  const kinds = files.map(kindOfPath)
  return kinds.includes('writing') ? 'writing' : kinds.includes('record') ? 'record' : null
}

interface Stamp { at: string; kind: SessionKind }

/** Every commit's time and kind, oldest first; null when not a repository. */
function readStamps(): Stamp[] | null {
  let out: string
  try { out = git('log', '--reverse', '--relative', '--format=%x1e%cI', '--name-only') } catch { return null }
  return out.split('\x1e').filter(s => s.trim()).flatMap(chunk => {
    const [at, ...files] = chunk.split('\n')
    const kind = kindOfCommit(files.map(f => f.trim()).filter(Boolean))
    return kind ? [{ at: new Date(at.trim()).toISOString(), kind }] : []
  })
}

export interface BurdenSession {
  row: string
  start: string
  end: string
  source: 'timer' | 'commit times (inferred)'
  writing_minutes: number
  record_minutes: number
  /** record minutes per writing minute; null with no writing time */
  burden: number | null
}

const MIN = 60_000
const minutes = (ms: number): number => Math.round(ms / MIN * 10) / 10

/** Split the timer's intervals and the commits into sessions, by the same
 *  gap the briefing uses, and measure each: by the timer where it counted
 *  anything in that session, by commit times where it did not. Pure. */
export function burdenSessions(intervals: SessionInterval[], stamps: Stamp[], gapHours = SESSION_GAP_HOURS): BurdenSession[] {
  type Item = { start: number; end: number; interval?: SessionInterval; stamp?: Stamp }
  const items: Item[] = [
    ...intervals.map(i => ({ start: Date.parse(i.start), end: Date.parse(i.end), interval: i })),
    ...stamps.map(s => ({ start: Date.parse(s.at), end: Date.parse(s.at), stamp: s })),
  ].sort((a, b) => a.start - b.start)
  const groups: Item[][] = []
  let reach = -Infinity
  for (const it of items) {
    if (!groups.length || it.start - reach > gapHours * 3600 * 1000) groups.push([])
    groups.at(-1)!.push(it)
    reach = Math.max(reach, it.end)
  }
  return groups.map(g => {
    const start = Math.min(...g.map(i => i.start)), end = Math.max(...g.map(i => i.end))
    const timed = g.filter(i => i.interval)
    const ms = { writing: 0, record: 0 }
    if (timed.length) {
      for (const i of timed) ms[i.interval!.kind] += i.end - i.start
    } else {
      // THE INFERENCE: the time between two commits went on whatever the
      // later one changed, up to the timer's idle bound — a longer gap is
      // not all work. The first commit of a session has no before.
      const marks = g.filter(i => i.stamp)
      for (let k = 1; k < marks.length; k++) ms[marks[k].stamp!.kind] += Math.min(marks[k].start - marks[k - 1].start, IDLE_MINUTES * MIN)
    }
    const w = minutes(ms.writing), r = minutes(ms.record)
    return {
      row: `session ${new Date(start).toISOString().slice(0, 16).replace('T', ' ')}`,
      start: new Date(start).toISOString(), end: new Date(end).toISOString(),
      source: timed.length ? 'timer' : 'commit times (inferred)',
      writing_minutes: w, record_minutes: r,
      burden: ms.writing ? ratio(ms.record, ms.writing) : null,
    } satisfies BurdenSession
  })
}

export type BurdenTrend = { direction: 'falling' | 'rising' | 'flat'; over: BurdenSession['source']; burdens: number[] }

/** Rising, falling or flat, by the least-squares slope of the burden over
 *  the sessions that have one, in order — over the TIMED sessions only, or,
 *  with fewer than two of those, the inferred ones only: a count and a proxy are on different
 *  scales, and a shift from one to the other is no trend. Null under two. */
export function burdenTrend(sessions: BurdenSession[]): BurdenTrend | null {
  const of = (src: BurdenSession['source']): number[] =>
    sessions.filter(s => s.source === src).map(s => s.burden).filter((b): b is number => b !== null)
  const timed = of('timer')
  const over: BurdenSession['source'] = timed.length >= 2 ? 'timer' : 'commit times (inferred)'
  const ys = over === 'timer' ? timed : of(over)
  if (ys.length < 2) return null
  const n = ys.length, mx = (n - 1) / 2, my = ys.reduce((a, b) => a + b, 0) / n
  const slope = ys.reduce((a, y, x) => a + (x - mx) * (y - my), 0) / ys.reduce((a, _y, x) => a + (x - mx) ** 2, 0)
  return { direction: Math.abs(slope) < 0.01 ? 'flat' : slope < 0 ? 'falling' : 'rising', over, burdens: ys }
}

function recordMaintenanceBurden(rec: StoryRecord): Omit<MeasureResult, 'id' | 'name' | 'definition' | 'sources'> {
  const sessions = burdenSessions(rec.intervals, rec.stamps ?? [])
    .filter(s => inWindow(s.start, rec.since))
    // a session in which nothing was counted or inferred says nothing
    .filter(s => s.writing_minutes || s.record_minutes)
  const inferred = sessions.filter(s => s.source !== 'timer').length
  const trend = burdenTrend(sessions)
  const totals = {
    sessions: sessions.length, timed_sessions: sessions.length - inferred, inferred_sessions: inferred,
    fell_back: inferred > 0,
    writing_minutes: minutes(sessions.reduce((n, s) => n + s.writing_minutes, 0) * MIN),
    record_minutes: minutes(sessions.reduce((n, s) => n + s.record_minutes, 0) * MIN),
    trend: trend?.direction ?? null, trend_over: trend?.over ?? null, trend_burdens: trend?.burdens ?? [],
  }
  const covers = span(sessions.flatMap(s => [s.start, s.end]))
  if (!sessions.length) {
    return {
      status: 'measured', rows: [], totals, covers,
      value: rec.stamps === null
        ? 'nothing to count yet — the session timer has counted nothing, and this story has no commit history to infer from'
        : 'nothing to count yet — the session timer has counted nothing, and no two commits to the prose or the record in this window fall in one session, so there is no time between them to infer from',
    }
  }
  const last = sessions.at(-1)!
  const lastMeasured = sessions.filter(s => s.burden !== null).at(-1)
  const head = !lastMeasured
    ? `no writing time in any session yet, so nothing to divide by (${sessions.length} session${sessions.length === 1 ? '' : 's'}, ${totals.record_minutes} minutes on the record)`
    : `${fmt(lastMeasured.burden)} record minutes per writing minute in the ${lastMeasured === last ? 'last session' : 'last session with writing time — no writing time in the last session —'} (${DATE(lastMeasured.start)}, ${lastMeasured.record_minutes} on the record, ${lastMeasured.writing_minutes} writing, by ${lastMeasured.source})`
  const trendText = !trend ? 'too few for a trend'
    : `trend ${trend.direction} over the ${trend.burdens.length} ${trend.over === 'timer' ? 'timed' : 'inferred'} sessions (${trend.burdens.map(b => fmt(b)).join(' → ')})${trend.over === 'timer' ? '' : ' — no two timed sessions yet, so this trend is of the inference'}`
  const fellBack = inferred
    ? ` FELL BACK to commit times for ${inferred} of ${sessions.length} session${sessions.length === 1 ? '' : 's'}: the timer counted nothing in ${inferred === 1 ? 'it' : 'them'}, so the time between commits was inferred, not counted.`
    : ''
  return {
    status: 'measured',
    value: `${head}; ${sessions.length} session${sessions.length === 1 ? '' : 's'}, ${trendText}.${fellBack}`,
    rows: sessions as unknown as Record<string, unknown>[], totals, covers,
  }
}

// ---- the definitions, one entry each ----------------------------------------------

interface MeasureSpec {
  id: MeasureResult['id']
  name: string
  definition: string
  sources: string[]
  compute: (rec: StoryRecord) => Omit<MeasureResult, 'id' | 'name' | 'definition' | 'sources'>
}

export const MEASURES: MeasureSpec[] = [
  {
    id: 'capture-precision',
    name: 'capture precision',
    definition: 'False and missed proposals per scene capture read, and how many proposals the author approved unedited. '
      + 'A proposal is one fact capture (update-record) filed from an accepted scene. '
      + 'FALSE: a proposal the author answered never. '
      + 'MISSED (approximated): a canon record added or changed by a commit that records no decision on a proposal — the author\'s own hand, or anything else outside capture — '
      + 'after a scene capture had read; it is attributed to the scene most recently changed in the book before that commit (any commit to prose/, an accept or the author\'s own save), an id capture ever proposed is never counted, and a change to `status` alone is not counted. '
      + 'The record cannot tell a new fact from a correction, so an edit to an existing record counts as missed; a change after an accept capture never read is counted apart. '
      + 'APPROVED UNEDITED (approximated): an approved proposal whose record, as the approval committed it, still answers to the key it was proposed under — its name for an entity, its ends and kind for a relationship, its title and participants for an event. '
      + 'An edit to any other field before the approval cannot be seen: a proposal waits uncommitted, and git sees only what was approved. '
      + 'LATER is not recorded (it hides a proposal for the session), so a filed proposal with no decision counts as waiting. '
      + 'Per scene means divided by the distinct scenes capture read in the window, and a decision is windowed by the read that filed it — a decision on a read outside the window is counted apart.',
    sources: [
      'history/*.yaml and .arc/runs/*/receipt.yaml — update-record receipts: the scene read, what each read filed',
      `${EVIDENCE_REL} — kind "proposal": approved or never, with the key it was proposed under`,
      '.arc/drafts.jsonl — each proposal\'s origin: the file it was filed in',
      'git log and git show over canon/, prose/ and the evidence log — the approval\'s commit, the canon changes after each accept',
    ],
    compute: capturePrecision,
  },
  {
    id: 'style-gate-usefulness',
    name: 'style-gate usefulness',
    definition: 'Refusals per run, and the author\'s style complaints per scene before and after the gates. '
      + `A STYLE GATE holds arc's prose to a countable rule of the style contract: ${STYLE_GATES.join(', ')} (withhold-literals answers to the scene contract, not the style contract, and is left out). `
      + 'REFUSALS PER RUN: style-gate records with verdict refused on a run\'s receipt — a refused first answer and a refused repair count once each — over the runs whose receipt carries a style-gate record — a run from before the gates existed, or of a row whose answer is not prose, could not have been refused and is listed as context, not counted; a could-not-judge is counted apart and never as held. '
      + 'BEFORE AND AFTER: split at the start of the first run whose receipt carries a style-gate record. '
      + 'COMPLAINTS (approximated): the record holds no complaint as such. It holds the author\'s verdict on arc\'s prose in the evidence log, so a complaint is a verdict that did not keep arc\'s words as written — rejected, or accepted with what was kept differing from what arc wrote. '
      + 'Not every rewrite is about style, so this over-counts; a note about style is not counted, because telling one from any other note takes a reading. '
      + 'Per scene means divided by the distinct scenes judged in that period. Rules declined and commits to the style contract are printed beside it as context, not counted.',
    sources: [
      'history/*.yaml and .arc/runs/*/receipt.yaml — the gate records, the ending, the row',
      `${EVIDENCE_REL} — the author's verdicts on arc's prose (records with no kind)`,
      `${DISMISSED_REL} and git log of ${STYLE_CONTRACT_REL} — context`,
    ],
    compute: styleGateUsefulness,
  },
  {
    id: 'review-precision',
    name: 'review precision',
    definition: 'Lens findings the author acts on, divided by the findings shown. '
      + 'SHOWN: the findings an inspect reading kept after its citations gate (the receipt\'s evidence.returned) — every one of them is what the viewer lists — and the findings the lens fan-out returned (the lens counts on its judge.completed event, a lens whose reading went stale included, as the response includes it; a lens that failed returned none). '
      + 'No viewer surface renders lens findings today, so for the lenses SHOWN means returned to whoever asked, not seen by the author. '
      + 'ACTED ON: a finding the author made a note from, edited the prose for, or dismissed.',
    sources: [
      '.arc/runs/*/events.jsonl — the lens runs\' judge.completed events',
      '.arc/runs/*/receipt.yaml — inspect receipts: evidence.returned, the findings kept',
    ],
    compute: reviewPrecision,
  },
  {
    id: 'record-maintenance-burden',
    name: 'record-maintenance burden',
    definition: 'Author minutes on the record divided by minutes writing, per session — the health number the thesis lives on, trending toward zero. '
      + `A SESSION is a run of counted time and commits with no gap longer than ${SESSION_GAP_HOURS} hours between them (the briefing's gap). `
      + `MINUTES are the session timer's: what the author counted as writing or as the record in the viewer's header; a count in which nothing happened — no input in the viewer, no change to the story's files — for ${IDLE_MINUTES} minutes was closed at the last thing that did. `
      + 'Where the timer counted anything in a session, the timer alone decides it. '
      + `FALLBACK (inferred, and printed when used): a session the timer counted nothing in is read from commit times — the time between two commits is given to what the later one changed, writing for prose/, the record for ${RECORD_DIRS.map(d => `${d}/`).join(', ')}; a commit that touches prose counts as writing — so a scene accept that carries record changes beside the prose counts as writing — one that touches neither is left out, the first commit of a session has no time before it, and no gap counts for more than ${IDLE_MINUTES} minutes (the timer's idle bound). `
      + 'Commits are not where minutes go, so an inferred session is a proxy, not a count. '
      + 'TREND: the least-squares slope of the burden over the sessions that have writing time, in order — falling, rising, or flat within 0.01 per session — over the timed sessions only, or, with fewer than two of those, over the inferred ones only, and it says which.',
    sources: [
      `${SESSIONS_REL} and .arc/session.json — the session timer's intervals`,
      'git log over the whole story — commit times and the files each touched, for the fallback',
    ],
    compute: recordMaintenanceBurden,
  },
]

// ---- the measurement and its printout ------------------------------------------------

export function measure(opts: { since?: string | null; now?: Date } = {}): Measurement {
  const since = opts.since ? new Date(opts.since).toISOString() : null
  const rec = readRecord(since)
  const measures = MEASURES.map(m => ({ id: m.id, name: m.name, definition: m.definition, sources: m.sources, ...m.compute(rec) }))
  const all = span(measures.flatMap(m => [m.covers.from, m.covers.to]))
  return { measured_at: (opts.now ?? new Date()).toISOString(), story: STORY, window: { since, ...all }, measures }
}

const DATE = (s: string | null): string => s ? s.slice(0, 10) : '—'

export function renderText(m: Measurement): string {
  const out: string[] = []
  out.push(`arc · the four numbers · measured ${m.measured_at}`)
  out.push(`story: ${m.story}`)
  out.push(`window: ${m.window.since ? `since ${DATE(m.window.since)}` : 'all history'} · ${m.window.from ? `the records read run from ${DATE(m.window.from)} to ${DATE(m.window.to)}` : 'no record in it to read'}`)
  if (!m.measures.length) return out.join('\n')
  m.measures.forEach((x, i) => {
    out.push('', `${i + 1}. ${x.name} — ${x.value}`)
    out.push(`   default definition — confirm or change: ${x.definition}`)
    out.push(`   source: ${x.sources.join('; ')}`)
    out.push(`   dated: measured ${DATE(m.measured_at)}, ${x.covers.from ? `over records from ${DATE(x.covers.from)} to ${DATE(x.covers.to)}` : 'over no record yet'}${m.window.since ? ` (window since ${DATE(m.window.since)})` : ' (window: all history)'}`)
    if (x.missing) out.push(`   what is missing: ${x.missing}`)
    if (x.rows.length) {
      out.push('   by row:')
      for (const r of x.rows) {
        const { row, ...rest } = r as { row: string }
        out.push(`     ${row}: ${Object.entries(rest).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v === null ? 'n/a' : v}`).join(' · ')}`)
      }
    }
  })
  return out.join('\n')
}
