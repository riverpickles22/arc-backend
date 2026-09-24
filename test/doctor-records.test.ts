// What is on disk after a killed run or a retired proposal, counted (A67-12).
//
// Four counts, each read from the record and never from prose: run records
// with no receipt, transcript files no run names, proposals whose
// fingerprints no longer match, and rows no decision of the author's has ever
// answered for.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeExampleStory } from './fixture.ts'

const STORY = makeExampleStory()
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-doctor-home-'))
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

const { doctorRecords } = await import('../src/doctor.ts')
const { encodeProjectDir, scratchParent, scratchDirFor } = await import('../src/engine.ts')
const { writeAlternative, clearAlternatives } = await import('../src/reroute.ts')
const { sha16 } = await import('../src/records.ts')
const { proseScenes } = await import('../src/story.ts')

const SCENE = 'sc.02-1'
const runDir = (id: string) => path.join(STORY, '.arc', 'runs', id)
const countOf = (id: string) => doctorRecords(STORY, HOME).counts.find(c => c.id === id)!

const putRun = (id: string, opts: { launched?: boolean; receipt?: boolean } = {}) => {
  fs.mkdirSync(runDir(id), { recursive: true })
  fs.writeFileSync(path.join(runDir(id), 'root.json'),
    JSON.stringify({ prompt: 'another way through', started_at: '2026-09-14T00:00:00Z', source: 'ui' }))
  if (opts.launched !== false) {
    fs.writeFileSync(path.join(runDir(id), 'launches.jsonl'),
      JSON.stringify({ attempt: 'late-entry-1', session_id: 's1', scratch_dir: scratchDirFor(id, '1'), expected_transcript: null, at: '2026-09-14T00:00:00Z' }) + '\n')
  }
  if (opts.receipt) fs.writeFileSync(path.join(runDir(id), 'receipt.yaml'), 'run_id: ' + id + '\nending: landed\n')
}

test('a clean story has nothing waiting on the first three counts', () => {
  clearAlternatives(SCENE)
  assert.equal(countOf('runs-without-receipt').count, 0)
  assert.equal(countOf('transcripts-no-receipt-names').count, 0)
  assert.equal(countOf('proposals-out-of-date').count, 0)
})

test('a run arc executed and never closed is one run record without a receipt', () => {
  putRun('run.9001')
  const c = countOf('runs-without-receipt')
  assert.equal(c.count, 1)
  assert.deepEqual(c.some, ['run.9001'], 'and it is named, so the author can go and look')

  // An OPEN receipt is what a kill actually leaves: the receipt is written
  // before the first token, so counting the file rather than the ending would
  // report zero for exactly the case this count exists to catch.
  fs.writeFileSync(path.join(runDir('run.9001'), 'receipt.yaml'), 'run_id: run.9001\nstarted_at: 2026-09-14T00:00:00Z\n')
  assert.equal(countOf('runs-without-receipt').count, 1, 'a receipt with no ending is a run that did not end')

  // Closed, it stops being counted.
  fs.writeFileSync(path.join(runDir('run.9001'), 'receipt.yaml'), 'run_id: run.9001\nending: unfinished\n')
  assert.equal(countOf('runs-without-receipt').count, 0)

  // And a receipt arc cannot read is not finished either: saying nothing
  // about it would be the one answer that is certainly wrong.
  fs.writeFileSync(path.join(runDir('run.9001'), 'receipt.yaml'), 'run_id: [unclosed\n  - : :\n')
  assert.equal(countOf('runs-without-receipt').count, 1)
  fs.rmSync(runDir('run.9001'), { recursive: true, force: true })
})

test('a run arc only OBSERVED is never counted: nothing was left in flight', () => {
  // A Claude Code session's own run, opened by the hook. arc did not launch a
  // child for it and has no receipt to close; naming it would be noise the
  // author cannot act on.
  putRun('run.9002', { launched: false })
  assert.equal(countOf('runs-without-receipt').count, 0)
  fs.rmSync(runDir('run.9002'), { recursive: true, force: true })
})

test('a transcript no run names is counted; one a run names is not', () => {
  const parent = scratchParent(process.env, HOME, STORY)
  const dir = path.join(HOME, '.claude', 'projects', encodeProjectDir(path.join(parent, 'run-9003', '1')))
  fs.mkdirSync(dir, { recursive: true })
  const orphan = path.join(dir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl')
  fs.writeFileSync(orphan, '{}\n')

  const c = countOf('transcripts-no-receipt-names')
  assert.equal(c.count, 1)
  assert.deepEqual(c.some, [orphan])

  // Now give it a run that names it: the same file, no longer stray.
  fs.mkdirSync(runDir('run.9003'), { recursive: true })
  fs.writeFileSync(path.join(runDir('run.9003'), 'launches.jsonl'),
    JSON.stringify({ attempt: '1', session_id: 's', scratch_dir: dir, expected_transcript: orphan, at: '2026-09-14T00:00:00Z' }) + '\n')
  fs.writeFileSync(path.join(runDir('run.9003'), 'receipt.yaml'), 'run_id: run.9003\n')
  assert.equal(countOf('transcripts-no-receipt-names').count, 0)

  fs.rmSync(runDir('run.9003'), { recursive: true, force: true })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a proposal whose fingerprints moved is counted; one written by an older arc is not', () => {
  clearAlternatives(SCENE)
  const body = proseScenes().find(s => s.scene === SCENE)!.body
  const base = {
    scene: SCENE, seed: 'late-entry', based_on: 'b', briefing: '', coverage: null, overlap: 0,
    created_at: '2026-09-12T00:00:00Z', body: 'A different way in.',
  }
  // Written from the scene as it stands: current, not counted.
  writeAlternative({ ...base, id: 'alt-d0000001', run: 'run.0001', reads: [{ id: SCENE, version: sha16(body) }] } as never)
  assert.equal(countOf('proposals-out-of-date').count, 0)

  // Written from a scene that has since changed: counted.
  writeAlternative({ ...base, id: 'alt-d0000002', run: 'run.0001', reads: [{ id: SCENE, version: 'aaaaaaaaaaaaaaaa' }] } as never)
  const c = countOf('proposals-out-of-date')
  assert.equal(c.count, 1)
  assert.deepEqual(c.some, [`${SCENE}/alt-d0000002`])

  // Written by an older arc: it named no fingerprints, so none of them moved.
  // It is stale for a different reason and the author reads it differently.
  writeAlternative({ ...base, id: 'alt-d0000003' } as never)
  assert.equal(countOf('proposals-out-of-date').count, 1, 'still just the one')
  clearAlternatives(SCENE)
})

test('the counts name where they were read from, and never read prose to get them', () => {
  const d = doctorRecords(STORY, HOME)
  assert.equal(d.story, STORY)
  assert.equal(d.transcripts, path.join(HOME, '.claude', 'projects'))
  assert.deepEqual(d.counts.map(c => c.id),
    ['runs-without-receipt', 'transcripts-no-receipt-names', 'proposals-out-of-date', 'rows-never-attended'],
    'four counts, in the order the terminal says them')
  for (const c of d.counts) {
    assert.equal(typeof c.count, 'number')
    assert.ok(c.some.length <= 5, 'a sample, so a terminal line stays a line')
  }
})

test('a row drops out of the count once a decision of the author\'s has answered for it', async () => {
  const { ROW_EXPLORE_SCENE, jobFingerprint } = await import('../src/registry.ts')
  const before = countOf('rows-never-attended')
  assert.ok(before.count > 0, 'a story with no history has answered for nothing')

  // A record receipt with an author's decision on it, fingerprinted to the
  // row: that is what `attended` means, and it is the only thing that should
  // move this count.
  const history = path.join(STORY, 'history')
  fs.mkdirSync(history, { recursive: true })
  fs.writeFileSync(path.join(history, 'run.8001.yaml'), [
    'run_id: run.8001',
    'ending: landed',
    'produced_by:',
    `  job_fingerprint: ${jobFingerprint(ROW_EXPLORE_SCENE)}`,
    'author_decision:',
    '  decision: accepted',
    '',
  ].join('\n'))
  try {
    const after = countOf('rows-never-attended')
    assert.equal(after.count, before.count - 1, 'exactly the one row the receipt answered for')
    assert.ok(!after.some.includes('explore.scene.one-shot'), 'and it is the right one')
  } finally {
    fs.rmSync(path.join(history, 'run.8001.yaml'), { force: true })
  }
})

test('letting a killed run\'s working notes go closes its record, keeping what it had got as far as writing', async () => {
  const { deleteRunTranscripts } = await import('../src/runs.ts')
  const { readWorkingReceipt } = await import('../src/run.ts')
  const id = 'run.8002'
  fs.mkdirSync(runDir(id), { recursive: true })
  fs.writeFileSync(path.join(runDir(id), 'root.json'), JSON.stringify({
    run_id: id, source: 'ui', raw_author_input: 'another way through sc.02-1',
    started_at: '2026-09-14T00:00:00Z', story_revision: null, subject: 'sc.02-1',
  }))
  fs.writeFileSync(path.join(runDir(id), 'launches.jsonl'),
    JSON.stringify({ attempt: 'late-entry-1', session_id: 's', scratch_dir: 'x', expected_transcript: null, at: '2026-09-14T00:00:00Z' }) + '\n')
  // What a kill leaves: the receipt written before the first token, open.
  fs.writeFileSync(path.join(runDir(id), 'receipt.yaml'), [
    `run_id: ${id}`, 'source: ui', 'raw_author_input: another way through sc.02-1',
    'started_at: 2026-09-14T00:00:00Z', 'decided_at: ""', 'story_revision: null',
    'story_revision_at_decision: null', 'request:', '  gesture: another way through sc.02-1',
    '  cell: explore · scene · one-shot', 'intent: null', 'claims: []', 'scope_expansions: []',
    'context_manifest: []', 'checks: null', 'judgment: null', 'result:', '  records: []', '  commit: null', '',
  ].join('\n'))

  assert.equal(countOf('runs-without-receipt').count, 1, 'counted while it is open')
  deleteRunTranscripts(id)

  const closed = readWorkingReceipt(id)!
  assert.equal(closed.ending, 'unfinished', 'closed with what actually happened')
  assert.equal(closed.raw_author_input, 'another way through sc.02-1',
    'and the author\'s own words survive — the record says what they asked for')
  assert.equal(closed.request?.gesture, 'another way through sc.02-1', 'as does everything the run had got as far as writing')
  assert.equal(countOf('runs-without-receipt').count, 0, 'and the count is back to zero')
  fs.rmSync(runDir(id), { recursive: true, force: true })
})

test('a run arc is working on right now is never called unfinished', async () => {
  const id = 'run.8003'
  putRun(id)
  assert.equal(doctorRecords(STORY, HOME, new Set([id])).counts.find(c => c.id === 'runs-without-receipt')!.count, 0,
    'a live run\'s receipt has no ending yet because it has not ended yet')
  assert.equal(countOf('runs-without-receipt').count, 1, 'and the moment it is no longer live, it counts')
  fs.rmSync(runDir(id), { recursive: true, force: true })
})

test('a route whose scene file is gone is still counted: routes leave disk only through a disposition', () => {
  clearAlternatives(SCENE)
  const dir = path.join(STORY, '.arc', 'alternatives', 'sc.99-9')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'alt-e0000001.md'), [
    '---',
    'id: alt-e0000001',
    'scene: sc.99-9',
    'seed: late-entry',
    'based_on: b',
    'created_at: 2026-09-12T00:00:00Z',
    'overlap: 0',
    'run: run.0001',
    'reads:',
    '  - id: sc.99-9',
    '    version: aaaaaaaaaaaaaaaa',
    '---',
    '',
    'A way through a scene that is no longer there.',
    '',
  ].join('\n'))
  try {
    const c = countOf('proposals-out-of-date')
    assert.equal(c.count, 1, 'a walk that started from the manuscript would have reported all clear')
    assert.deepEqual(c.some, ['sc.99-9/alt-e0000001'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the close writes BOTH records, because two readers ask the same question', async () => {
  // The briefing reads `events.jsonl` for a `run.ended`; `arc doctor` reads
  // the receipt for an ending. A close that wrote only one would leave the
  // briefing offering a gesture that had already been made, forever — the
  // author pressing "let its working notes go" on a row that never goes.
  const { deleteRunTranscripts } = await import('../src/runs.ts')
  const { unfinishedRuns, readWorkingReceipt } = await import('../src/run.ts')
  const id = 'run.8004'
  putRun(id)
  assert.ok(unfinishedRuns(new Set(), STORY).some(r => r.id === id), 'the briefing names it')
  assert.equal(countOf('runs-without-receipt').count, 1, 'and so does the doctor')

  deleteRunTranscripts(id)

  assert.ok(!unfinishedRuns(new Set(), STORY).some(r => r.id === id), 'the briefing stops naming it')
  assert.equal(countOf('runs-without-receipt').count, 0, 'and so does the doctor')
  assert.equal(readWorkingReceipt(id)?.ending, 'unfinished')
  fs.rmSync(runDir(id), { recursive: true, force: true })
})
