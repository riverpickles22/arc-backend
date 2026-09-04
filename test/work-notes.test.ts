// "Work through my notes on this scene": the scene's open notes are the
// brief, the register is chosen on purpose, and the ledger names the notes.
// The engine is a recording stub — what reaches the pass, and what is
// written down about it, are the properties under test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { git, makeExampleStory } from './fixture.ts'

const LOG = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-work-notes-log-'))

/** A claude on PATH that logs every prompt and answers by what it was asked:
 *  an empty JSON array to the conflict check, revised prose to anything else. */
function installStubCli(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-stub-work-notes-'))
  const bin = path.join(dir, 'claude')
  fs.writeFileSync(bin, `#!/usr/bin/env node
if (process.argv.includes('--version')) { process.stdout.write('stub 1.0\\n'); process.exit(0) }
const fs = require('node:fs'); const path = require('node:path')
const chunks = []
process.stdin.on('data', c => chunks.push(c))
process.stdin.on('end', () => {
  const prompt = chunks.join('')
  const n = fs.readdirSync(process.env.STUB_LOG).length
  fs.writeFileSync(path.join(process.env.STUB_LOG, String(n).padStart(3, '0') + '.txt'), prompt)
  const result = prompt.includes('Answer with the JSON array')
    ? '[]'
    : (prompt.includes('REDRAFT pass') ? 'A rebuilt first paragraph.\\n\\nA rebuilt second paragraph.\\n\\n=== BRIEFING ===\\nchecklist held' : 'A revised first paragraph.\\n\\nA revised second paragraph.')
  process.stdout.write(JSON.stringify({ subtype: 'success', is_error: false, session_id: 'stub', result }))
})
`)
  fs.chmodSync(bin, 0o755)
  return dir
}

// The worked example: a canon that exports, which the clean pass needs.
// Its one scene (sc.02-1) takes the notes; two more scenes in the same
// chapter hold a note that must never reach it, and no note at all.
const STORY = makeExampleStory()
const SCENE = (id: string, body: string) => [
  '---', `scene: ${id}`, 'chapter: ch.02-the-aurelia', 'status: proposed', 'pov: char.ines',
  'facts: [char.ines, place.whitcombe-light]', 'events: [event.the-wreck]', '---', '', body, '',
].join('\n')
fs.writeFileSync(path.join(STORY, 'prose/ch-02/scene-02.md'), SCENE('sc.02-2', 'Another scene entirely.\n\nWith its own second paragraph.'))
fs.writeFileSync(path.join(STORY, 'prose/ch-02/scene-03.md'), SCENE('sc.02-3', 'A scene nobody has noted.'))
git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'prose: work-notes fixture')
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'claude-cli'
process.env.STUB_LOG = LOG
process.env.PATH = `${installStubCli()}${path.delimiter}${process.env.PATH}`

const { runWorkNotes, describeOutcome, nothingToWork } = await import('../src/work-notes.ts')
const { createAnnotation, openNotesOn } = await import('../src/annotations.ts')
const { generatedFor } = await import('../src/ledger.ts')
const { proseDraft } = await import('../src/story.ts')
const { HttpError } = await import('../src/http.ts')

const reset = () => { git(STORY, 'checkout', 'HEAD', '--', '.'); git(STORY, 'clean', '-fdq'); fs.rmSync(path.join(STORY, '.arc'), { recursive: true, force: true }) }
const prompts = () => fs.readdirSync(LOG).sort().map(f => fs.readFileSync(path.join(LOG, f), 'utf8'))
const clearLog = () => { for (const f of fs.readdirSync(LOG)) fs.unlinkSync(path.join(LOG, f)) }

// sc.02-1 takes two notes; sc.02-2 takes one that must never reach a pass
// over sc.02-1; a keypoint on sc.02-1 must never count as a note.
assert.equal(openNotesOn('sc.02-1').length, 0)
const n1 = createAnnotation({ scene: 'sc.02-1', paragraph: 0, quote: 'The light held', body: 'Slow the doorway down.' })
const n2 = createAnnotation({ scene: 'sc.02-1', body: 'The whole scene wants more heat.' })
createAnnotation({ scene: 'sc.02-2', paragraph: 0, quote: 'Another', body: 'NOT-FOR-SCENE-ONE' })
createAnnotation({ scene: 'sc.02-1', paragraph: 0, quote: 'The light held', body: 'a marker, not a request', kind: 'keypoint' })
git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'notes')

test('a scene with no open notes is refused with the next action, and nothing runs', async () => {
  reset(); clearLog()
  await assert.rejects(() => runWorkNotes({ scene: 'sc.02-3' }),
    (e: unknown) => e instanceof HttpError && e.status === 409 && e.message === nothingToWork('sc.02-3'))
  assert.equal(prompts().length, 0)
  assert.match(nothingToWork('sc.02-3'), /right-click a paragraph/)
  await assert.rejects(() => runWorkNotes({ scene: 'sc.99-9' }), (e: unknown) => e instanceof HttpError && e.status === 400)
})

test('the scene\'s open notes are the brief — only that scene\'s, never a keypoint — and the ledger names them', async () => {
  reset(); clearLog()
  const out = await runWorkNotes({ scene: 'sc.02-1', source: 'cli' })
  assert.equal(out.mode, 'revise')
  assert.deepEqual(out.notes, [n2.id, n1.id])   // rail order: the scene note leads
  assert.equal(out.changed, true)
  assert.equal(out.conflicts.length, 0)
  assert.equal(out.file, 'prose/ch-02/scene-01.md')
  assert.ok(out.run)

  const seen = prompts()
  assert.equal(seen.length, 2, 'the conflict check, then one revision')
  for (const p of seen) {
    assert.ok(p.includes('Slow the doorway down.') && p.includes('more heat'), 'both notes reach the pass')
    assert.ok(!p.includes('NOT-FOR-SCENE-ONE'), 'another scene\'s note never does')
    assert.ok(!p.includes('a marker, not a request'), 'a keypoint is not a note')
  }

  const gen = generatedFor('prose/ch-02/scene-01.md')
  assert.equal(gen?.entry.origin, 'revise')
  assert.deepEqual(gen?.entry.notes, [n2.id, n1.id])

  // The draft status carries the provenance; the untouched scene is not a change.
  const draft = proseDraft()
  const mine = draft.changes.find(c => c.file === 'prose/ch-02/scene-01.md')
  assert.equal(mine?.origin, 'revise')
  assert.deepEqual(mine?.answers, [n2.id, n1.id])
  assert.equal(draft.changes.find(c => c.file === 'prose/ch-02/scene-02.md'), undefined)

  assert.match(out.reply, /2 notes on sc\.02-1 were worked into the scene/)
  assert.match(out.reply, /open the manuscript to review it/)
  assert.ok(!out.reply.includes('revised first paragraph'), 'the reply never carries the prose')
})

test('the clean pass answers the same notes and records them under its own origin', async () => {
  reset(); clearLog()
  const out = await runWorkNotes({ scene: 'sc.02-1', mode: 'redraft', guidance: 'keep it short' })
  assert.equal(out.mode, 'redraft')
  assert.deepEqual(out.notes, [n2.id, n1.id])
  assert.equal(out.run, null)
  const seen = prompts()
  assert.equal(seen.length, 1, 'no conflict pass — the rebuild reads the notes itself')
  assert.ok(seen[0].includes("THE AUTHOR'S OPEN NOTES ON THIS SCENE") && seen[0].includes('more heat'))
  assert.ok(seen[0].includes("AUTHOR'S GUIDANCE (binding): keep it short"))
  const gen = generatedFor('prose/ch-02/scene-01.md')
  assert.equal(gen?.entry.origin, 'redraft')
  assert.deepEqual(gen?.entry.notes, [n2.id, n1.id])
  assert.match(out.reply, /answered in a clean pass over the scene/)
})

test('a hand-edited scene carries no provenance, and an accepted generation stops claiming the next edit', async () => {
  reset(); clearLog()
  // Hand edit: nothing in the ledger, nothing on the change.
  const f = path.join(STORY, 'prose/ch-02/scene-02.md')
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('Another scene entirely.', 'Another scene, by hand.'))
  const hand = proseDraft().changes.find(c => c.file === 'prose/ch-02/scene-02.md')
  assert.ok(hand)
  assert.equal(hand.origin, undefined)
  assert.equal(hand.answers, undefined)

  // A generation the author accepted: the ledger still holds it, HEAD now
  // equals it, so a later hand edit is the author's own.
  await runWorkNotes({ scene: 'sc.02-1' })
  git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'accept')
  const g = path.join(STORY, 'prose/ch-02/scene-01.md')
  fs.writeFileSync(g, fs.readFileSync(g, 'utf8').replace('A revised first paragraph.', 'The author\'s own first paragraph.'))
  const later = proseDraft().changes.find(c => c.file === 'prose/ch-02/scene-01.md')
  assert.ok(later)
  assert.equal(later.origin, undefined)
  assert.equal(later.answers, undefined)
  reset()
})

test('the outcome sentence says what happened and ends with where to look', () => {
  const base = { scene: 'sc.02-1', mode: 'revise' as const, notes: ['ann.001'], changed: true, conflicts: [] }
  assert.match(describeOutcome(base), /^1 note on sc\.02-1 was worked into the scene\./)
  assert.match(describeOutcome({ ...base, changed: false }), /changed nothing/)
  assert.match(describeOutcome({ ...base, refused: 'this section is locked (lock.001)' }), /not revised: this section is locked/)
  assert.match(describeOutcome({ ...base, conflicts: [{ between: ['ann.001', 'ann.002'], tension: 'one wants heat, one wants cold.' }] }),
    /pull against each other, so nothing was written\. ann\.001 and ann\.002: one wants heat/)
})
