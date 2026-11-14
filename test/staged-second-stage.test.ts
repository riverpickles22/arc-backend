// SECOND-STAGE STALENESS (A72-12, criterion 1): a staged pass is briefed —
// and lands — from the scene as it stands when ITS OWN stage launches, not
// from the one the first stage read.
//
// §10's compare "runs at a second stage's launch", and `work-notes.ts` takes
// `destinationAt` and re-reads the scene inside the write loop rather than
// once at the top. The mechanism is by construction; this is the test that
// says so, because a refactor that hoisted either read would be invisible
// and would cost the author the paragraph they typed between the stages.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { git, installStubCli, makeExampleStory } from './fixture.ts'

const STORY = makeExampleStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

const { createAnnotation } = await import('../src/annotations.ts')
const FILE = 'prose/ch-01/scene-01.md'
const abs = path.join(STORY, FILE)
const SCENE = 'sc.01-1'
/** The paragraph the author types in while the first stage is out — ¶1,
 *  which no lock settles (lock.001 holds ¶2) and no note anchors to. */
const THEIRS = 'Ines went up at four, as she had gone up at four for nine years.'

test('the write stage reads the scene as it stands when IT launches, and keeps what was typed while the conflict reading ran', async () => {
  const note = createAnnotation({ scene: SCENE, paragraph: 6, quote: 'The wind did what it did.', body: 'Shorter — one line of wind.' })
  git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'a note on the wind')
  const was = fs.readFileSync(abs, 'utf8')
  assert.ok(was.includes('Ines went up at four because'), 'the paragraph the author is about to rewrite')

  const bin = installStubCli({
    name: 'staged',
    // WHILE THE CONFLICT READING IS ANSWERING, the author types in the
    // scene. The write stage has not launched yet.
    before: `
      if (/Answer with a JSON array and nothing else/.test(prompt)) {
        const fs2 = require('node:fs')
        const p = ${JSON.stringify(abs)}
        const t = fs2.readFileSync(p, 'utf8')
        fs2.writeFileSync(p, t.replace(/Ines went up at four because[^]*?voice on the stairs\./, ${JSON.stringify(THEIRS)}))
      }
    `,
    // the reading finds no tension; the write echoes the scene it was
    // HANDED with only the note's own paragraph rewritten, which is what a
    // minimal revision does
    answer: `/Answer with a JSON array and nothing else/.test(prompt)
      ? '[]'
      : (prompt.match(/=== THE SCENE AS IT STANDS \\([^)]*\\) ===\\n([\\s\\S]*?)\\n\\nAnswer with/) || [null, ''])[1]
          .replace(/The wind did what it did\\.[^]*?Fresh, she wrote\\. Nothing\\./, 'The wind got up at midnight and kept at the seams.')`,
  })
  const prevPath = process.env.PATH
  process.env.PATH = `${bin}:${process.env.PATH}`
  process.env.ARC_DRAFT_ENGINE = 'claude-cli'
  try {
    const { runWorkNotes } = await import('../src/work-notes.ts')
    const out = await runWorkNotes({ scene: SCENE }) as { changed: boolean; reply: string }
    assert.equal(out.changed, true, out.reply)

    const now = fs.readFileSync(abs, 'utf8')
    assert.match(now, /The wind got up at midnight and kept at the seams\./, 'the revision the note asked for landed')
    assert.ok(now.includes(THEIRS), 'and the paragraph typed between the stages is still the author\'s')
    assert.ok(!now.includes('Ines went up at four because'),
      'the words the FIRST stage read are not put back over what the author typed after it')
    assert.ok(now.includes('The eighty-fourth was loose.'), 'and the settled paragraph came back verbatim')
    void note
  } finally {
    process.env.PATH = prevPath
    process.env.ARC_DRAFT_ENGINE = 'none'
  }
})
