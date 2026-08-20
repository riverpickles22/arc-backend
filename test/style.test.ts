// The style contract's two layers (conventions §10): where the author layer
// lives, and how the two compose. Pure — no disk, no model.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { makeStory } from './fixture.ts'

process.env.ARC_STORY_PATH = makeStory()
const styleMod = await import('../src/style.ts')
const { authorStylePath, legacyAuthorStylePath, composeStyle } = styleMod

const layer = (source: 'author' | 'story', body: string) => ({ source, path: `/x/${source}.md`, body })

test('author layer resolution: explicit path, then ARC_HOME, then ~/.arc — in the style directory', () => {
  assert.equal(authorStylePath({ ARC_AUTHOR_STYLE: '/dotfiles/voice.md' }, '/home/a'), '/dotfiles/voice.md')
  // The canonical home is the style DIRECTORY — versioned as its own repo,
  // apart from the machine state that shares the arc home.
  assert.equal(authorStylePath({ ARC_HOME: '/home/a/.config/arc' }, '/home/a'), path.join('/home/a/.config/arc', 'style', 'style.md'))
  assert.equal(authorStylePath({}, '/home/a'), path.join('/home/a', '.arc', 'style', 'style.md'))
  // an explicit path wins over ARC_HOME
  assert.equal(authorStylePath({ ARC_AUTHOR_STYLE: '/v.md', ARC_HOME: '/h' }, '/home/a'), '/v.md')
  // and the legacy location is still known, for the fallback and the migration
  assert.equal(legacyAuthorStylePath({}, '/home/a'), path.join('/home/a', '.arc', 'style.md'))
  assert.equal(legacyAuthorStylePath({ ARC_HOME: '/h' }, '/home/a'), path.join('/h', 'style.md'))
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

test('migration moves the legacy file into its versioned home, once, and leaves a working pointer', async () => {
  const os = await import('node:os')
  const fs = await import('node:fs')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-style-home-'))
  const prevHome = process.env.ARC_HOME
  process.env.ARC_HOME = tmp
  try {
    const legacy = path.join(tmp, 'style.md')
    fs.writeFileSync(legacy, '# My voice\n\nNo semicolons.\n')

    const canonical = styleMod.migrateAuthorStyle()
    assert.equal(canonical, path.join(tmp, 'style', 'style.md'))
    assert.match(fs.readFileSync(canonical!, 'utf8'), /No semicolons/)
    assert.ok(fs.lstatSync(legacy).isSymbolicLink(), 'the old path still answers — as a pointer')
    assert.match(fs.readFileSync(legacy, 'utf8'), /No semicolons/, 'reading through it works')
    assert.ok(fs.existsSync(path.join(tmp, 'style', '.git')), 'the layer has its own history')
    assert.equal(fs.existsSync(path.join(tmp, '.git')), false, 'and the arc home itself is NOT a repo — machine state stays scratch')

    // Idempotent: running again changes nothing and invents nothing.
    assert.equal(styleMod.migrateAuthorStyle(), path.join(tmp, 'style', 'style.md'))

    // And a ratification into the migrated layer is committed in its repo.
    fs.appendFileSync(canonical!, '\nShort sentences under threat.\n')
    assert.equal(styleMod.commitAuthorStyle(canonical!, 'style: ratify test rule'), true)
    const { execFileSync } = await import('node:child_process')
    const log = execFileSync('git', ['-C', path.join(tmp, 'style'), 'log', '--oneline'], { encoding: 'utf8' })
    assert.match(log, /ratify test rule/)
  } finally {
    if (prevHome === undefined) delete process.env.ARC_HOME
    else process.env.ARC_HOME = prevHome
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('a fresh setup migrates nothing and invents nothing', async () => {
  const os = await import('node:os')
  const fs = await import('node:fs')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-style-fresh-'))
  const prevHome = process.env.ARC_HOME
  process.env.ARC_HOME = tmp
  try {
    assert.equal(styleMod.migrateAuthorStyle(), null)
    assert.equal(fs.existsSync(path.join(tmp, 'style')), false, 'no empty scaffolding appears')
  } finally {
    if (prevHome === undefined) delete process.env.ARC_HOME
    else process.env.ARC_HOME = prevHome
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
