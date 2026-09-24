// The style contract carries no run of the subject scene's own prose (A67-14).
//
// The leak gate refuses a brief that carries eight consecutive words of what
// the row withheld. A ratified style contract teaches by quoting the book, so
// on the one pass that must work without the scene, the contract itself
// carries the scene in. The gate is right to refuse; what is handed to it is
// what was wrong.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeExampleStory } from './fixture.ts'

const STORY = makeExampleStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

const { stripQuotedSpans, leaks } = await import('../src/gates.ts')
const { ROUTE_WITHHELD } = await import('../src/registry.ts')

const N = ROUTE_WITHHELD.spanWords
const MARK = '**(withheld)**'
const SCENE = 'The eighty-fourth step was loose and had been loose for a year. She counted it anyway, the way she counted the rest.'

test('a rule that quotes the scene inline loses the quotation and keeps the rule', () => {
  const contract = `## 3. Rhythm\n- **The staged progression is a signature, rationed.** "The eighty-fourth step was loose and had been loose for a year." Use it once a chapter.\n`
  const out = stripQuotedSpans(contract, SCENE, N, MARK)
  assert.equal(out.stripped, 1, 'one maximal run, not one marker per word')
  assert.match(out.text, /## 3\. Rhythm/, 'the heading stands')
  assert.match(out.text, /The staged progression is a signature, rationed\./, 'the rule still reads as a rule')
  assert.match(out.text, /Use it once a chapter\./, 'and what came after it survives')
  assert.ok(out.text.includes(MARK), 'and the author is told something was taken out')
  assert.doesNotMatch(out.text, /eighty-fourth step was loose and had been loose/)
})

test('what comes out passes the gate that refused it', () => {
  const withheld = { text: [SCENE], allowed: [], spanWords: N }
  const contract = `- **A rule.** "${SCENE}" and more words after it.\n`
  assert.ok(leaks(contract, withheld).length > 0, 'the contract as it stands leaks')
  const out = stripQuotedSpans(contract, SCENE, N, MARK)
  assert.deepEqual(leaks(out.text, withheld), [], 'and after the strip the gate holds')
})

test('a rule quoting a DIFFERENT scene is untouched: that prose is not withheld from this pass', () => {
  const other = 'The lamp room smelled of paraffin and cold brass, as it had every night that winter.'
  const contract = `- **A rule about a sibling.** "${other}"\n`
  const out = stripQuotedSpans(contract, SCENE, N, MARK)
  assert.equal(out.stripped, 0)
  assert.equal(out.text, contract, 'byte for byte')
})

test('a run shorter than the bar is an ordinary phrase, not a quotation', () => {
  const contract = 'Prefer the plain verb: she counted it anyway, and moved on.\n'
  assert.equal(stripQuotedSpans(contract, SCENE, N, MARK).stripped, 0)
})

test('punctuation and capitals around the run survive, because the cut is by word not by regex', () => {
  const contract = `Consider: ("The eighty-fourth step was loose and had been loose for a year"), which works.\n`
  const out = stripQuotedSpans(contract, SCENE, N, MARK)
  assert.equal(out.stripped, 1)
  assert.match(out.text, /^Consider: \("/, 'what stood before the first word of the run is still there')
  assert.match(out.text, /"\), which works\.$/m, 'and what stood after its last word')
})

test('two separate quotations become two markers, and adjacent windows one', () => {
  const contract = `One: "The eighty-fourth step was loose and had been loose for a year." Then unrelated words in between here for a while. Two: "She counted it anyway, the way she counted the rest."\n`
  const out = stripQuotedSpans(contract, SCENE, N, MARK)
  assert.equal(out.stripped, 2)
  assert.equal(out.text.split(MARK).length - 1, 2)
})

test('an empty or tiny source strips nothing rather than everything', () => {
  assert.equal(stripQuotedSpans('anything at all', '', N, MARK).stripped, 0)
  assert.equal(stripQuotedSpans('anything at all', 'four words only here', N, MARK).stripped, 0)
  assert.equal(stripQuotedSpans('short', SCENE, N, MARK).text, 'short')
})

test('the two tokenizers are one: what the stripper cuts, the gate can no longer find', () => {
  // The stripper and the gate MUST read the same word stream. When they do
  // not, the strip removes nothing, the gate still refuses, and the pass
  // refuses with nothing left to point at. Three shapes that broke a
  // per-character tokenizer: a context-sensitive lowercase (Greek final
  // sigma), a lowercase that grows a combining mark (İ), and an astral letter
  // whose surrogate halves are not letters on their own.
  for (const word of ['\u039f\u0394\u039f\u03a3', '\u0130ZMIR', '\u{20000}\u{20001}']) {
    const scene = `He kept the stern name ${word} in his head all night.`
    const contract = `- **A rule the author ratified.** "${scene}" Keep that cadence.\n`
    const withheld = { text: [scene], allowed: [], spanWords: N }
    assert.ok(leaks(contract, withheld).length > 0, `${word}: the contract leaks before the strip`)
    const out = stripQuotedSpans(contract, scene, N, MARK)
    assert.ok(out.stripped > 0, `${word}: the strip found it`)
    assert.deepEqual(leaks(out.text, withheld), [], `${word}: and the gate can no longer find it`)
  }
})

test('what the row lets through is not cut: a locked paragraph the brief hands over verbatim', () => {
  // The gate subtracts the row's `allowed` set — locked paragraphs and the
  // contract's own quoted withholds. Cutting them here would gut a rule for
  // no gate reason AND put a marker saying the passage is withheld from a
  // pass that is given it verbatim two blocks later: a false statement in the
  // proven register.
  const locked = 'The eighty-fourth step was loose and had been loose for a year.'
  const contract = `- **A rule about the settled paragraph.** "${locked}" Keep that cadence.\n`
  const withheld = { text: [SCENE], allowed: [locked], spanWords: N }
  assert.deepEqual(leaks(contract, withheld), [], 'the gate is content with it')
  const out = stripQuotedSpans(contract, SCENE, N, MARK, [locked])
  assert.equal(out.stripped, 0, 'so the strip leaves it alone')
  assert.equal(out.text, contract)
  // And without the allowance it would have gone — so the test is about the
  // allowance and not about the run being absent.
  assert.equal(stripQuotedSpans(contract, SCENE, N, MARK).stripped, 1)
})

test('a run that overruns the quotation keeps the contract\'s line structure', () => {
  const contract = `- **A rule.** "The eighty-fourth step was loose and had been loose for a year."\n  She counted it anyway, says the rule, and so should you.\n  A third line.\n`
  const out = stripQuotedSpans(contract, SCENE, N, MARK)
  assert.ok(out.stripped > 0)
  assert.equal(out.text.split('\n').length, contract.split('\n').length,
    'a cut that spans a line break gives the line breaks back — three lines in, three lines out')
  assert.match(out.text, /A third line\./)
})

test('the composition the pass uses strips a touchstone AND an inline quotation', async () => {
  const { styleForPass } = await import('../src/reroute.ts')
  const { proseScenes } = await import('../src/story.ts')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const scene = proseScenes()[0]
  const paras = scene.body.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
  const quoted = paras.find(p => p.split(/\s+/).length > N)!

  // A contract that quotes the scene in BOTH shapes, because the composition
  // is two strips and a test that exercises neither cannot tell them apart.
  const style = path.join(STORY, 'docs', 'style.md')
  const before = fs.readFileSync(style, 'utf8')
  fs.writeFileSync(style, `${before}\n## Rhythm\n- **A rule that teaches by quoting.** "${quoted}" Use it once a chapter.\n\n## Touchstones\n**A passage from ${scene.file}, kept as a model**\n\n> ${quoted}\n\n`)
  try {
    const withheld = { text: [scene.body], allowed: [], spanWords: N }
    assert.ok(leaks(fs.readFileSync(style, 'utf8'), withheld).length > 0,
      'the contract as the author wrote it carries the scene')
    const out = styleForPass({ scene: scene.scene, file: scene.file, body: scene.body })
    assert.deepEqual(leaks(out, withheld), [],
      'and what a withholding pass is handed carries no run of the scene it must work without')
    assert.match(out, /A rule that teaches by quoting/, 'the rule still reads as a rule')
    assert.match(out, /Use it once a chapter\./)
    assert.match(out, /is withheld from this pass/, 'and the author is told something was taken out')
  } finally {
    fs.writeFileSync(style, before)
  }
})

test('a contract that quotes BOTH scenes keeps the sibling and loses the subject', async () => {
  const { styleForPass } = await import('../src/reroute.ts')
  const { proseScenes } = await import('../src/story.ts')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const scene = proseScenes()[0]
  const quoted = scene.body.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.split(/\s+/).length > N)[0]
  const sibling = 'The lamp room smelled of paraffin and cold brass, as it had every night that winter.'
  const style = path.join(STORY, 'docs', 'style.md')
  const before = fs.readFileSync(style, 'utf8')
  fs.writeFileSync(style, `${before}\n## Rhythm\n- **About this scene.** "${quoted}"\n- **About another.** "${sibling}"\n`)
  try {
    const out = styleForPass({ scene: scene.scene, file: scene.file, body: scene.body })
    assert.ok(out.includes(sibling), 'a rule quoting a scene this pass is not writing still teaches by example')
    assert.ok(!out.includes(quoted), 'and the one quoting the scene it IS writing does not')
  } finally {
    fs.writeFileSync(style, before)
  }
})
