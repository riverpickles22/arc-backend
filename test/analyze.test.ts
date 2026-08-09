// The analysis pass: prompt assembly, and the guarantee that matters —
// it writes nothing. The model call itself is the integration story's.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { git, makeStory, writeScene } from './fixture.ts'

const story = makeStory()
process.env.ARC_STORY_PATH = story
const { buildAnalysisPrompt, runAnalysis } = await import('../src/analyze.ts')
const { proseDraft, proseScenes } = await import('../src/story.ts')

test('prompt carries the style contract, canon, contracts, and each changed scene', () => {
  const prompt = buildAnalysisPrompt({
    style: 'SMELL FIRST, ALWAYS.',
    canon: '{"entities":{"char.x":{}}}',
    changes: [
      { file: 'prose/ch-01/scene-01.md', status: 'modified', main: { body: 'The old opening.' } as never },
      { file: 'prose/ch-01/scene-02.md', status: 'added', main: null },
      { file: 'prose/ch-01/scene-09.md', status: 'deleted', main: null },
    ],
    scenes: [
      { file: 'prose/ch-01/scene-01.md' } as never,
      { file: 'prose/ch-01/scene-02.md' } as never,
    ],
    readFile: rel => `BODY OF ${rel}`,
  })
  assert.match(prompt, /SMELL FIRST, ALWAYS\./)
  assert.match(prompt, /char\.x/)
  assert.match(prompt, /BODY OF prose\/ch-01\/scene-01\.md/)
  assert.match(prompt, /BODY OF prose\/ch-01\/scene-02\.md/)
  assert.match(prompt, /The old opening\./)          // modified scenes carry the version they replace
  assert.match(prompt, /scene-09\.md — DELETED/)
  assert.match(prompt, /ARGUED claim/)               // the register rule is in the prompt
  assert.match(prompt, /Write nothing; propose nothing/)
})

test('no draft changes → 409, and nothing is written', async () => {
  git(story, 'checkout', 'HEAD', '--', '.')
  git(story, 'clean', '-fdq')
  const before = execFileSync('git', ['-C', story, 'status', '--porcelain', '-uall'], { encoding: 'utf8' })
  await assert.rejects(runAnalysis(), /no draft changes to analyze/)
  const after = execFileSync('git', ['-C', story, 'status', '--porcelain', '-uall'], { encoding: 'utf8' })
  assert.equal(before, after)
})

test('with a draft present the pass reads it but writes nothing (engine stubbed off)', async () => {
  writeScene(story, 'prose/ch-01/scene-02.md', 'sc.01-2', 'A pending scene.')
  assert.equal(proseDraft().changes.length, 1)
  assert.ok(proseScenes().some(s => s.scene === 'sc.01-2'))
  const before = execFileSync('git', ['-C', story, 'status', '--porcelain', '-uall'], { encoding: 'utf8' })
  process.env.ARC_DRAFT_ENGINE = 'none'
  try {
    await assert.rejects(runAnalysis(), /No generation engine/)
  } finally {
    delete process.env.ARC_DRAFT_ENGINE
  }
  const after = execFileSync('git', ['-C', story, 'status', '--porcelain', '-uall'], { encoding: 'utf8' })
  assert.equal(before, after)
  git(story, 'clean', '-fdq')
})
