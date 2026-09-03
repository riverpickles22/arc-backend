// The re-entry briefing: assembled from the record, never generated.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { git, makeExampleStory } from './fixture.ts'

// A claude on PATH that records every invocation. The CLI engine is the one
// that runs on the author's machine, so "no engine call" is proven by the
// marker never appearing — not by inspecting imports.
const MARKER = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arc-briefing-engine-')), 'invoked')
function installRecordingCli(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-stub-briefing-'))
  const bin = path.join(dir, 'claude')
  fs.writeFileSync(bin, `#!/usr/bin/env node
if (process.argv.includes('--version')) { process.stdout.write('stub 1.0\\n'); process.exit(0) }   // the availability probe, not a prompt
require('node:fs').writeFileSync(${JSON.stringify(MARKER)}, process.argv.join(' '))
process.stdout.write(JSON.stringify({ subtype: 'success', is_error: false, session_id: 's', result: 'never' }))
`)
  fs.chmodSync(bin, 0o755)
  return dir
}

const STORY = makeExampleStory()
process.env.ARC_STORY_PATH = STORY
delete process.env.ANTHROPIC_API_KEY
process.env.ARC_DRAFT_ENGINE = 'claude-cli'
process.env.PATH = `${installRecordingCli()}${path.delimiter}${process.env.PATH}`

// The example commits one scene in ch.02. A second accept lands a scene in
// ch.01 AND rewrites the ch.02 scene: the briefing must name the ch.02 one
// (latest in reading order), with its committed final paragraph.
const CH02 = path.join(STORY, 'prose', 'ch-02', 'scene-01.md')
const CH02_LAST = 'Ines put the lamp down on the ninety-first stair and did not pick it up again.'
fs.writeFileSync(CH02, fs.readFileSync(CH02, 'utf8').trimEnd() + `\n\nThe stair held too.\n\n${CH02_LAST}\n`)
fs.mkdirSync(path.join(STORY, 'prose', 'ch-01'), { recursive: true })
fs.writeFileSync(path.join(STORY, 'prose', 'ch-01', 'scene-01.md'),
  '---\nscene: sc.01-1\nchapter: ch.01-ninety-one-stairs\nstatus: proposed\nfacts: []\nevents: []\n---\n\nThe first stair.\n')
git(STORY, 'add', '-A')
git(STORY, 'commit', '-qm', 'prose: accept draft (2 scenes)')
const HEAD = git(STORY, 'rev-parse', '--short', 'HEAD').trim()
const HEAD_AT = git(STORY, 'log', '-1', '--pretty=format:%aI').trim()

const { createArcServer } = await import('../src/server.ts')
const { currentEngine } = await import('../src/engine.ts')
const { writeAlternative } = await import('../src/reroute.ts')
const { dueIn, lastSessionOf } = await import('../src/briefing.ts')

const server = createArcServer()
await new Promise<void>(resolve => server.listen(0, resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
test.after(() => server.close())
const load = async () => {
  const res = await fetch(base + '/api/briefing')
  assert.equal(res.status, 200)
  return res.json()
}

test('zero engine invocations, with the CLI engine live', async () => {
  assert.equal(currentEngine(), 'claude-cli')   // the seam is armed, so silence means something
  await load()
  assert.equal(fs.existsSync(MARKER), false, 'the briefing invoked the engine')
})

test('where you left off: the last accepted scene, its final paragraph verbatim, and when', async () => {
  const b = await load()
  assert.equal(b.git, true)
  assert.equal(b.lastAccepted.scene, 'sc.02-1')          // ch.02 outranks ch.01 in reading order
  assert.equal(b.lastAccepted.chapter, 'ch.02-the-aurelia')
  assert.equal(b.lastAccepted.file, 'prose/ch-02/scene-01.md')
  assert.equal(b.lastAccepted.paragraph, CH02_LAST)
  assert.equal(b.lastAccepted.hash, HEAD)
  assert.equal(b.lastAccepted.acceptedAt, HEAD_AT)
})

test('the paragraph is what main says, not what the draft has done since', async () => {
  fs.writeFileSync(CH02, fs.readFileSync(CH02, 'utf8').trimEnd() + '\n\nA paragraph nobody has accepted.\n')
  const b = await load()
  assert.equal(b.lastAccepted.paragraph, CH02_LAST)
  assert.deepEqual(b.draft, [{ file: 'prose/ch-02/scene-01.md', scene: 'sc.02-1', status: 'modified' }])
  git(STORY, 'checkout', '--', 'prose')
})

test('pending counts match their stores', async () => {
  const empty = await load()
  assert.deepEqual(empty.draft, [])
  assert.deepEqual(empty.notes, [])
  assert.deepEqual(empty.routes, {})
  assert.equal(empty.unplaced, 0)

  // Draft: one added scene.
  fs.writeFileSync(path.join(STORY, 'prose', 'ch-01', 'scene-02.md'),
    '---\nscene: sc.01-2\nchapter: ch.01-ninety-one-stairs\nstatus: proposed\nfacts: []\nevents: []\n---\n\nNew.\n')
  // Notes: one open, one working, one resolved, one dropped, one keypoint —
  // only the first two are open notes.
  const notes = path.join(STORY, 'annotations'); fs.mkdirSync(notes, { recursive: true })
  const note = (n: number, extra: string) =>
    fs.writeFileSync(path.join(notes, `note-00${n}.yaml`), `id: note.00${n}\nanchor:\n  scene: sc.02-1\nbody: thought ${n}\n${extra}`)
  note(1, 'status: open\n'); note(2, 'status: working\n'); note(3, 'status: resolved\n'); note(4, 'status: dropped\n'); note(5, 'kind: keypoint\n')
  // Routes: two chain heads on one scene (a revision does not count twice).
  const alt = (id: string, revises?: string) => writeAlternative({
    id, scene: 'sc.02-1', seed: 'late', based_on: 'abcd', created_at: `2026-09-0${id.length}T00:00:00Z`,
    body: 'Another way.', briefing: 'argued', coverage: null, overlap: null, ...(revises ? { revises } : {}),
  })
  alt('a'); alt('bb'); alt('ccc', 'a')
  // Material: two unplaced, one placed.
  const mat = path.join(STORY, 'material'); fs.mkdirSync(mat, { recursive: true })
  fs.writeFileSync(path.join(mat, 'm1.yaml'), 'id: mat.001\ntype: motif-idea\nstatus: unplaced\nbody: salt\n')
  fs.writeFileSync(path.join(mat, 'm2.yaml'), 'id: mat.002\ntype: motif-idea\nstatus: unplaced\nbody: rope\n')
  fs.writeFileSync(path.join(mat, 'm3.yaml'), 'id: mat.003\ntype: motif-idea\nstatus: placed\nbody: lamp\n')

  const b = await load()
  assert.deepEqual(b.draft, [{ file: 'prose/ch-01/scene-02.md', scene: 'sc.01-2', status: 'added' }])
  assert.deepEqual(b.notes.map((n: { id: string }) => n.id), ['note.001', 'note.002'])
  assert.equal(b.notes[0].scene, 'sc.02-1')
  assert.deepEqual(b.routes, { 'sc.02-1': 2 })
  assert.equal(b.unplaced, 2)
  fs.rmSync(path.join(STORY, 'prose', 'ch-01', 'scene-02.md'))
})

test("what's due: only obligations whose window touches the current chapter", async () => {
  const mat = path.join(STORY, 'material'); fs.mkdirSync(mat, { recursive: true })
  const obl = (n: string, window: string) =>
    fs.writeFileSync(path.join(mat, `o${n}.yaml`), `id: obl.${n}\ntype: obligation\nstatus: unplaced\nbody: owe ${n}\n${window}`)
  obl('open-from', 'window:\n  from: ch.02-the-aurelia\n')                  // from ch.02 onward → due
  obl('closed', 'window:\n  to: ch.01-ninety-one-stairs\n')                // closed before ch.02 → not due here
  obl('span', 'window:\n  from: ch.01-ninety-one-stairs\n  to: ch.02-the-aurelia\n')   // spans → due
  obl('nowhere', '')                                                        // no window → not due anywhere
  const b = await load()
  assert.deepEqual(b.due.map((d: { id: string }) => d.id), ['obl.open-from', 'obl.span'])
  assert.equal(b.due[0].klass, 'unowned')
  assert.deepEqual(b.due[0].window, { from: 'ch.02-the-aurelia' })
  for (const n of ['open-from', 'closed', 'span', 'nowhere']) fs.rmSync(path.join(mat, `o${n}.yaml`))
})

test('dueIn: overdue outranks the class an obligation was also filed under', () => {
  const order = new Map([['ch.1', 1], ['ch.2', 2]])
  const row = { id: 'o', body: 'x', window: { to: 'ch.2' } }
  const due = dueIn('ch.2', order, [{ ...row, klass: 'unowned' }, { ...row, klass: 'overdue' }])
  assert.deepEqual(due.map(d => [d.id, d.klass]), [['o', 'overdue']])
  assert.deepEqual(dueIn('ch.9', order, [{ ...row, klass: 'unowned' }]), [])   // unknown chapter: nothing is placed
})

test("the last session's commits: a run of accepts closer than the gap", async () => {
  const at = (h: number) => ({ hash: `h${h}`, date: new Date(Date.UTC(2026, 8, 3, h)).toISOString(), subject: `s${h}` })
  const log = [at(20), at(18), at(17), at(5), at(4)]   // 17→5 is a twelve-hour silence
  assert.deepEqual(lastSessionOf(log).map(c => c.hash), ['h20', 'h18', 'h17'])
  assert.deepEqual(lastSessionOf([]), [])
  const b = await load()
  assert.deepEqual(b.lastSession.map((c: { hash: string }) => c.hash), [HEAD, git(STORY, 'rev-parse', '--short', 'HEAD~1').trim()])
  assert.equal(b.lastSession[0].subject, 'prose: accept draft (2 scenes)')
})
