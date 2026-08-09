// The style contract's two layers (conventions §10): where the author layer
// lives, and how the two compose. Pure — no disk, no model.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { makeStory } from './fixture.ts'

process.env.ARC_STORY_PATH = makeStory()
const styleMod = await import('../src/style.ts')
const { authorStylePath, composeStyle } = styleMod

const layer = (source: 'author' | 'story', body: string) => ({ source, path: `/x/${source}.md`, body })

test('author layer resolution: explicit path, then ARC_HOME, then ~/.arc', () => {
  assert.equal(authorStylePath({ ARC_AUTHOR_STYLE: '/dotfiles/voice.md' }, '/home/a'), '/dotfiles/voice.md')
  assert.equal(authorStylePath({ ARC_HOME: '/home/a/.config/arc' }, '/home/a'), path.join('/home/a/.config/arc', 'style.md'))
  assert.equal(authorStylePath({}, '/home/a'), path.join('/home/a', '.arc', 'style.md'))
  // an explicit path wins over ARC_HOME
  assert.equal(authorStylePath({ ARC_AUTHOR_STYLE: '/v.md', ARC_HOME: '/h' }, '/home/a'), '/v.md')
})

test('both layers compose, labeled, with precedence stated after them', () => {
  const out = composeStyle({ author: layer('author', 'No semicolons.'), story: layer('story', 'Smell first.') })
  assert.match(out, /STYLE LAYER 1 — THE AUTHOR/)
  assert.match(out, /STYLE LAYER 2 — THIS BOOK/)
  assert.match(out, /No semicolons\./)
  assert.match(out, /Smell first\./)
  // the precedence sentence is last — the final thing a model reads
  assert.ok(out.indexOf('PRECEDENCE') > out.indexOf('Smell first.'))
  assert.match(out, /layer 2 wins/)
  assert.match(out, /NOT binding/)          // proposed rules never bind
  assert.match(out, /canon still wins/)     // form vs fact
})

test('a missing layer is not an error — it says so and keeps the other', () => {
  const storyOnly = composeStyle({ author: null, story: layer('story', 'Smell first.') })
  assert.match(storyOnly, /no author-level style file/)
  assert.match(storyOnly, /Smell first\./)

  const authorOnly = composeStyle({ author: layer('author', 'No semicolons.'), story: null })
  assert.match(authorOnly, /no style contract of its own/)
  assert.match(authorOnly, /No semicolons\./)
})

test('neither layer present degrades to an honest instruction, not an empty block', () => {
  const out = composeStyle({ author: null, story: null })
  assert.match(out, /No style contract exists/)
  assert.doesNotMatch(out, /STYLE LAYER/)
  assert.match(out, /do not invent house rules/)
})

test('frontmatter never reaches the prompt — it binds docs, not prose', () => {
  const { stripFrontmatter } = styleMod
  assert.equal(stripFrontmatter('---\ncanon: null\n---\n# Style\nRule.'), '# Style\nRule.')
  assert.equal(stripFrontmatter('# Style\nRule.'), '# Style\nRule.')   // none present, untouched
})
