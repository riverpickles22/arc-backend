// Refusing one paragraph changes one paragraph (A64-8). The author rejected
// a paragraph and watched a block of the scene's changes vanish; the files
// showed the reject itself had touched one, but the invariant was a belief,
// not a check. Now it is a check, taken before the write.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { git, makeStory, writeScene } from './fixture.ts'

const STORY = makeStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

const { proseRejectParagraph, proseDraft, countParagraphEdits } = await import('../src/story.ts')

const FILE = 'prose/ch-01/scene-01.md'
const seed = (draft: string) => {
  git(STORY, 'checkout', 'HEAD', '--', '.'); git(STORY, 'clean', '-fdq')
  writeScene(STORY, FILE, 'sc.01-1', 'One as the book has it.\n\nTwo as the book has it.\n\nThree as the book has it.\n\nFour as the book has it.')
  git(STORY, 'add', '-A')
  if (git(STORY, 'status', '--porcelain').trim()) git(STORY, 'commit', '-qm', 'prose: four paragraphs')
  const abs = path.join(STORY, FILE)
  fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace(/---\n\n[\s\S]*$/, `---\n\n${draft}\n`))
}
// Read the body the way the server does: after the frontmatter fence,
// whatever the whitespace between them — a reject rewrites the file without
// the blank line the fixture wrote, and both are a scene.
const body = () => fs.readFileSync(path.join(STORY, FILE), 'utf8')
  .replace(/^---\n[\s\S]*?\n---\n/, '').trim().split(/\n{2,}/)

test('the edit count is the minimal one over paragraphs', () => {
  const a = ['p1', 'p2', 'p3', 'p4']
  assert.equal(countParagraphEdits(a, ['p1', 'X', 'p3', 'p4']), 1)   // one swapped
  assert.equal(countParagraphEdits(a, ['p1', 'p3', 'p4']), 1)        // one removed
  assert.equal(countParagraphEdits(a, ['p1', 'p2', 'N', 'p3', 'p4']), 1)   // one inserted
  assert.equal(countParagraphEdits(a, a), 0)
  assert.equal(countParagraphEdits(a, ['X', 'p2', 'p3', 'Y']), 4)    // two ends changed: the span between counts
  assert.equal(countParagraphEdits(a, ['p1', 'p2']), 2)
})

test('rejecting one changed paragraph leaves every other change pending', () => {
  seed('One REVISED.\n\nTwo REVISED.\n\nThree as the book has it.\n\nFour REVISED.')
  assert.equal(proseDraft().changes.length, 1)
  // Refuse the second paragraph's change: main's words come back there only.
  proseRejectParagraph(FILE, { side: 'draft', paragraph: 1 })
  assert.deepEqual(body(), ['One REVISED.', 'Two as the book has it.', 'Three as the book has it.', 'Four REVISED.'])
  assert.equal(proseDraft().changes.length, 1, 'the scene is still pending — two changes remain')
})

test('a refused insertion goes away alone, and a refused deletion comes back alone', () => {
  seed('One as the book has it.\n\nAN EXTRA PARAGRAPH.\n\nTwo as the book has it.\n\nFour as the book has it.')
  // The draft inserted one paragraph and deleted "Three". Refuse the insertion.
  proseRejectParagraph(FILE, { side: 'draft', paragraph: 1 })
  assert.deepEqual(body(), ['One as the book has it.', 'Two as the book has it.', 'Four as the book has it.'])
  // Now refuse the deletion of "Three": it is put back, nothing else moves.
  proseRejectParagraph(FILE, { side: 'main', paragraph: 2 })
  assert.deepEqual(body(), ['One as the book has it.', 'Two as the book has it.', 'Three as the book has it.', 'Four as the book has it.'])
  assert.equal(proseDraft().changes.length, 0, 'every change refused, one at a time — the scene matches the book')
})

test('accepting one changed paragraph puts that paragraph in the book and leaves the rest pending', async () => {
  const { proseAcceptParagraph } = await import('../src/story.ts')
  seed('One REVISED.\n\nTwo REVISED.\n\nThree as the book has it.\n\nFour REVISED.')
  proseAcceptParagraph(FILE, { side: 'draft', paragraph: 1 })
  // The book took "Two" alone.
  const head = git(STORY, 'show', `HEAD:${FILE}`).replace(/^---\n[\s\S]*?\n---\n/, '').trim().split(/\n{2,}/)
  assert.deepEqual(head, ['One as the book has it.', 'Two REVISED.', 'Three as the book has it.', 'Four as the book has it.'])
  // The working tree still carries the other two changes, waiting.
  assert.deepEqual(body(), ['One REVISED.', 'Two REVISED.', 'Three as the book has it.', 'Four REVISED.'])
  assert.equal(proseDraft().changes.length, 1, 'the scene is still pending')
})
