// Frontmatter parsing: scenes and docs articles.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeStory } from './fixture.ts'

const story = makeStory()
fs.mkdirSync(path.join(story, 'docs'), { recursive: true })
fs.writeFileSync(path.join(story, 'docs', 'bound.md'), '---\ncanon: char.test\n---\n\n# Bound\n\nBody.\n')
fs.writeFileSync(path.join(story, 'docs', 'plain.md'), '# Plain\n\nNo frontmatter.\n')
process.env.ARC_STORY_PATH = story
const { docsArticles, parseScene, proseScenes } = await import('../src/story.ts')

test('parseScene: no frontmatter → null', () => {
  assert.equal(parseScene('Just prose.', 'x.md'), null)
})

test('parseScene: frontmatter without scene: → null', () => {
  assert.equal(parseScene('---\ntitle: note\n---\nBody', 'x.md'), null)
})

test('parseScene: bindings, defaults, and body', () => {
  const s = parseScene('---\nscene: sc.01-1\nchapter: ch.01\nfacts: [char.a]\n---\n\nThe prose.\n', 'p/x.md')
  assert.equal(s?.scene, 'sc.01-1')
  assert.equal(s?.status, 'proposed')      // defaulted
  assert.equal(s?.pov, null)               // omitted = omniscient
  assert.deepEqual(s?.facts, ['char.a'])
  assert.equal(s?.contract, null)
  assert.equal(s?.file, 'p/x.md')
  assert.match(s?.body ?? '', /The prose/)
})

test('parseScene: contract passthrough', () => {
  const s = parseScene('---\nscene: sc.01-1\nchapter: ch.01\nstatus: canon\ncontract:\n  purpose: why\n  motifs: [a, b]\n---\nBody', 'x.md')
  assert.equal(s?.contract?.purpose, 'why')
  assert.deepEqual(s?.contract?.motifs, ['a', 'b'])
})

test('docsArticles: canon binding read, plain files still included', () => {
  const arts = docsArticles()
  const byPath = new Map(arts.map(a => [a.path, a]))
  assert.equal(byPath.get('docs/bound.md')?.canon, 'char.test')
  assert.match(byPath.get('docs/bound.md')?.body ?? '', /^# Bound/m)
  assert.equal(byPath.get('docs/plain.md')?.canon, null)
})

test('proseScenes: reads the committed fixture scene from the working tree', () => {
  const scenes = proseScenes()
  assert.equal(scenes.length, 1)
  assert.equal(scenes[0].scene, 'sc.01-1')
})
