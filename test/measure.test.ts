// The four numbers, read from a planted record (A76-3).
//
// A synthetic story with a known history: one scene accepted, capture's read
// of it filing three proposals — one approved as proposed, one renamed by the
// author before approving, one answered never — and then a fact the author
// added to the record by hand. The script must count the false one and the
// missed one, print every number with its definition, source and date, and
// leave the story exactly as it found it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { git, writeScene } from './fixture.ts'
import { proposalKey } from '../src/proposals.ts'

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(BACKEND, 'src', 'measure-cli.ts')
const STORY = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-test-measure-'))

const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(STORY, rel)), { recursive: true })
  fs.writeFileSync(path.join(STORY, rel), text)
}
const append = (rel: string, obj: unknown): void => {
  fs.mkdirSync(path.dirname(path.join(STORY, rel)), { recursive: true })
  fs.appendFileSync(path.join(STORY, rel), JSON.stringify(obj) + '\n')
}
const commitAt = (at: string, message: string): void => {
  git(STORY, 'add', '-A')
  execFileSync('git', ['-C', STORY, 'commit', '-qm', message], { env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } })
}
const character = (id: string, name: string): string =>
  `id: ${id}\ntype: character\nname: ${name}\nspecies: human\nstatus: canon\n`
const keyOf = (name: string): string => proposalKey({ subject: 'new', type: 'character', field: 'name', value: name })
const EVIDENCE = 'docs/style.evidence.jsonl'
const SCENE = 'sc.01-1'
const CELL = (job: string, scope: string, mode: string) => ({ job, scope, mode, depth: 'standard', stage: null })
const receipt = (run: string, extra: Record<string, unknown>): string => JSON.stringify({
  run_id: run, source: 'ui', raw_author_input: 'x', decided_at: '', story_revision: null, story_revision_at_decision: null,
  intent: null, claims: [], scope_expansions: [], context_manifest: [], checks: null, judgment: null,
  result: { records: [], commit: null }, ...extra,
})

// ---- the planted history ---------------------------------------------------------

git(STORY, 'init', '-q')
git(STORY, 'config', 'user.email', 'test@test')
git(STORY, 'config', 'user.name', 'test')
write('.gitignore', '.arc/\n')
write('canon/story.yaml', 'title: A Test Story\n')
write('canon/entities/characters/ann.yaml', character('char.ann', 'Ann'))
writeScene(STORY, 'prose/ch-01/scene-01.md', SCENE, 'The first paragraph.')
commitAt('2026-10-01T10:00:00Z', 'the story')

// the scene accepted
writeScene(STORY, 'prose/ch-01/scene-01.md', SCENE, 'The first paragraph, accepted.\n\nBob and Dan came up the stairs.')
commitAt('2026-10-02T10:00:00Z', 'accept the scene')

// a draft before the style gates existed, one after (refused, then repaired)
write('history/run.0000.yaml', receipt('run.0000', { cell: CELL('draft', 'scene', 'one-shot'), started_at: '2026-09-01T10:00:00.000Z', ending: 'landed', gates: [{ gate: 'locks', verdict: 'held', attempt: 1 }] }))
write('history/run.0002.yaml', receipt('run.0002', {
  cell: CELL('draft', 'scene', 'one-shot'), started_at: '2026-10-02T09:00:00.000Z', ending: 'landed',
  gates: [{ gate: 'sentence-length', verdict: 'refused', attempt: 1 }, { gate: 'sentence-length', verdict: 'held', attempt: 2 }, { gate: 'and-chain', verdict: 'held', attempt: 2 }],
}))
// the author's verdicts on arc's prose: one rejected before the gates, one rewritten after, one kept as written
append(EVIDENCE, { at: '2026-09-15T10:00:00.000Z', file: 'prose/ch-01/scene-01.md', scene: SCENE, granularity: 'paragraph', paragraph: 0, verdict: 'rejected', arcWrote: 'one', authorKept: '', origin: 'draft', baseline: null, run: 'run.0000' })
append(EVIDENCE, { at: '2026-10-02T10:00:00.000Z', file: 'prose/ch-01/scene-01.md', scene: SCENE, granularity: 'paragraph', paragraph: 0, verdict: 'accepted', arcWrote: 'two', authorKept: 'three', origin: 'draft', baseline: null, run: 'run.0002' })
append(EVIDENCE, { at: '2026-10-02T10:00:01.000Z', file: 'prose/ch-01/scene-01.md', scene: SCENE, granularity: 'paragraph', paragraph: 1, verdict: 'approved', arcWrote: 'four', authorKept: 'four', origin: 'draft', baseline: null, run: 'run.0002' })

// capture reads the accepted scene and files three proposals
write('history/run.0001.yaml', receipt('run.0001', {
  cell: CELL('update-record', 'scene', 'triggered'), request: { gesture: 'x', cell: 'update-record · scene · triggered · standard', subject: SCENE },
  started_at: '2026-10-02T11:00:00.000Z', ending: 'landed',
  result: { records: ['char.bob', 'char.cat', 'char.dan'], commit: null, range: { from: 'a', to: 'b' } },
}))
for (const [id, name] of [['char.bob', 'Bob'], ['char.cat', 'Cat'], ['char.dan', 'Dan']]) {
  append('.arc/drafts.jsonl', { at: '2026-10-02T11:00:00.000Z', sha: 'x', origin: 'update-record', scene: SCENE, run: 'run.0001', canon: id, type: 'character', class: 'stated', key: keyOf(name), file: `canon/entities/characters/${id.slice(5)}.yaml` })
}

// Bob approved exactly as proposed
write('canon/entities/characters/bob.yaml', character('char.bob', 'Bob'))
append(EVIDENCE, { at: '2026-10-03T10:00:00.000Z', kind: 'proposal', id: 'char.bob', class: 'stated', key: keyOf('Bob'), scene: SCENE, run: 'run.0001', verdict: 'approved', origin: 'author' })
commitAt('2026-10-03T10:00:00Z', 'One fact is canon')

// Dan renamed Daniel by the author, then approved: the origin's key first, then the record's own
write('canon/entities/characters/dan.yaml', character('char.dan', 'Daniel'))
append(EVIDENCE, { at: '2026-10-04T10:00:00.000Z', kind: 'proposal', id: 'char.dan', class: 'stated', key: keyOf('Dan'), scene: SCENE, run: 'run.0001', verdict: 'approved', origin: 'author' })
append(EVIDENCE, { at: '2026-10-04T10:00:00.001Z', kind: 'proposal', id: 'char.dan', class: 'stated', key: keyOf('Daniel'), scene: SCENE, run: 'run.0001', verdict: 'approved', origin: 'author' })
commitAt('2026-10-04T10:00:00Z', 'One fact is canon')

// THE PLANTED FALSE PROPOSAL: Cat, answered never (its file never reached the book)
append(EVIDENCE, { at: '2026-10-05T10:00:00.000Z', kind: 'proposal', id: 'char.cat', class: 'stated', key: keyOf('Cat'), scene: SCENE, run: 'run.0001', verdict: 'never', origin: 'author' })
commitAt('2026-10-05T10:00:00Z', 'One fact is declined')

// THE PLANTED MISSED ONE: a place the author added by hand, which capture never proposed
write('canon/entities/places/harbour.yaml', 'id: place.harbour\ntype: place\nname: The Harbour\nkind: waterfront\nstatus: canon\n')
// and a change to status alone, which is not a fact
write('canon/entities/characters/ann.yaml', character('char.ann', 'Ann').replace('status: canon', 'status: proposed'))
commitAt('2026-10-06T10:00:00Z', 'the harbour, by hand')

// a lens fan-out that showed three findings — working state, never committed
write('.arc/runs/run.0003/root.json', JSON.stringify({ run_id: 'run.0003', started_at: '2026-10-03T12:00:00.000Z' }))
append('.arc/runs/run.0003/events.jsonl', { at: '2026-10-03T12:01:00.000Z', event: 'judge.completed', detail: { lenses: [{ lens: 'continuity', findings: 2 }, { lens: 'craft', findings: 1 }] } })
// the material worker's judgment emits the same event with no lenses: no finding shown
write('.arc/runs/run.0004/root.json', JSON.stringify({ run_id: 'run.0004', started_at: '2026-10-03T13:00:00.000Z' }))
append('.arc/runs/run.0004/events.jsonl', { at: '2026-10-03T13:01:00.000Z', event: 'judge.completed', node: 'judge', detail: { verdict: 'accept', findings: 9, metrics: {} } })
// an inspect reading that kept three findings and dropped one: ONE citations record, held
write('.arc/runs/run.0005/receipt.yaml', receipt('run.0005', {
  cell: CELL('inspect', 'scene', 'one-shot'), started_at: '2026-10-03T14:00:00.000Z', ending: 'landed',
  gates: [{ gate: 'citations', verdict: 'held', measured: 1, attempt: 1 }],
  evidence: { returned: 3, dropped: [{ reason: 'unresolvable', count: 1 }] },
}))
// an uncommitted file in the working tree, which must stay exactly as it is
write('canon/entities/characters/eve.yaml', character('char.eve', 'Eve').replace('status: canon', 'status: proposed'))

const run = (...args: string[]): string =>
  execFileSync(process.execPath, ['--import', 'tsx', CLI, STORY, ...args], { cwd: BACKEND, encoding: 'utf8' })

interface Out { window: { since: string | null }; measures: { id: string; status: string; value: string; totals: Record<string, unknown>; rows: Record<string, unknown>[] }[] }
const measureOf = (out: Out, id: string) => out.measures.find(m => m.id === id)!

// ---- criterion 2 ------------------------------------------------------------------

test('capture precision counts the planted false proposal and the planted missed one', () => {
  const capture = measureOf(JSON.parse(run('--json')) as Out, 'capture-precision')
  assert.equal(capture.status, 'measured')
  const t = capture.totals
  assert.equal(t.scenes_read, 1)
  assert.equal(t.filed, 3)
  assert.equal(t.never, 1, 'the planted false proposal')
  assert.equal(t.missed, 1, 'the planted missed fact')
  assert.deepEqual(t.missed_ids, ['place.harbour'], 'the status-only change is not a fact, and the approvals are not misses')
  assert.equal(t.approved, 2)
  assert.equal(t.approved_unedited, 1, 'Bob as proposed; Dan renamed before the approval')
  assert.deepEqual(t.approved_edited_ids, ['char.dan'])
  assert.equal(t.waiting, 0)
  assert.equal(t.false_per_scene, 1)
  assert.equal(t.missed_per_scene, 1)
  assert.deepEqual(capture.rows.map(r => r.row), ['update-record.scene.triggered'])
})

test('style-gate usefulness and review precision read the planted record, by row', () => {
  const out = JSON.parse(run('--json')) as Out
  const style = measureOf(out, 'style-gate-usefulness')
  assert.equal(style.totals.gates_first_ran, '2026-10-02T09:00:00.000Z')
  assert.equal(style.totals.refusals, 1)
  assert.equal(style.totals.runs, 4, 'every rowed run, as context')
  assert.equal(style.totals.gated_runs, 1, 'the draft before the gates, capture and inspect are not counted')
  assert.equal(style.totals.refusals_per_run, 1)
  assert.equal(style.totals.complaints_before, 1)
  assert.equal(style.totals.complaints_after, 1, 'the approved paragraph is no complaint')
  const draft = style.rows.find(r => r.row === 'draft.scene.one-shot')!
  assert.equal(draft.runs, 2); assert.equal(draft.gated_runs, 1); assert.equal(draft.refusals, 1)
  assert.equal(draft.refusals_per_run, 1, 'over the run a style gate judged, not the one before the gates')

  const review = measureOf(out, 'review-precision')
  assert.equal(review.status, 'not measurable yet')
  assert.equal(review.totals.findings_shown, 6, 'three from the lenses, three inspect kept; the material judgment is no reading')
  assert.deepEqual(review.rows.map(r => [r.row, r.readings, r.findings_shown]),
    [['lenses (no row yet)', 1, 3], ['inspect.scene.one-shot', 1, 3]])
  assert.equal(review.totals.acted_on, null)

  // every commit here is a day apart: one commit a session, no time between
  // two of them to infer from (measure-burden.test.ts plants the sessions)
  const burden = measureOf(out, 'record-maintenance-burden')
  assert.equal(burden.status, 'measured')
  assert.match(burden.value, /^nothing to count yet — the session timer has counted nothing/)
})

test('--since windows it: a read before the window is not counted', () => {
  const out = JSON.parse(run('--json', '--since', '2026-10-05')) as Out
  assert.equal(out.window.since, '2026-10-05T00:00:00.000Z')
  const t = measureOf(out, 'capture-precision').totals
  assert.equal(t.reads, 0)
  assert.equal(t.missed, 0)
  assert.equal(t.never, 0, 'the never on 2026-10-05 is on a read before the window')
  assert.equal(t.approved, 0)
  assert.equal(t.decided_on_reads_outside_window, 3)
  assert.deepEqual(measureOf(out, 'capture-precision').rows, [], 'nothing lands under unrowed')
})

// ---- criterion 1 ------------------------------------------------------------------

test('every number is printed with its definition, its source and its date', () => {
  const text = run()
  assert.match(text, /^arc · the four numbers · measured \d{4}-\d{2}-\d{2}T/m)
  assert.match(text, /window: all history · the records read run from 2026-09-01 to 2026-10-06/)
  const blocks = text.split(/\n(?=\d\. )/).slice(1)
  assert.deepEqual(blocks.map(b => b.split(' — ')[0]),
    ['1. capture precision', '2. style-gate usefulness', '3. review precision', '4. record-maintenance burden'])
  for (const b of blocks) {
    assert.match(b, /\n {3}default definition — confirm or change: \S/)
    assert.match(b, /\n {3}source: \S/)
    assert.match(b, /\n {3}dated: measured \d{4}-\d{2}-\d{2}/)
  }
  assert.match(blocks[0], /^1\. capture precision — 1 false and 1 missed per scene capture read \(1 scene\); 1 of 2 approved unedited/)
  assert.match(blocks[2], /what is missing: /)
  assert.match(blocks[3], /^4\. record-maintenance burden — nothing to count yet/)
})

// ---- criterion 3 ------------------------------------------------------------------

/** Every file under the story, .git included: its hash and its mtime. */
function snapshot(): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) { walk(abs); continue }
      const st = fs.statSync(abs)
      out.set(path.relative(STORY, abs), `${createHash('sha256').update(fs.readFileSync(abs)).digest('hex')} ${st.mtimeMs}`)
    }
  }
  walk(STORY)
  return out
}

test('it changes nothing in the story: git status, every file and every mtime, .git included', () => {
  const statusBefore = git(STORY, 'status', '--porcelain')
  const head = git(STORY, 'rev-parse', 'HEAD')
  const before = snapshot()   // taken after status, which may refresh the index
  run(); run('--json'); run('--json', '--since', '2026-10-01')
  const after = snapshot()
  assert.deepEqual([...after], [...before])
  assert.equal(git(STORY, 'status', '--porcelain'), statusBefore)
  assert.equal(git(STORY, 'rev-parse', 'HEAD'), head)
  assert.ok(statusBefore.includes('eve.yaml'), 'the uncommitted proposal is still there, still uncommitted')
})
