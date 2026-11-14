// The checks list each sentence over the contract's and-chain or word count
// (A77-1).
//
// The properties pinned here: a sentence over a number the RATIFIED contract
// states is listed with its scene, paragraph, its count and the bar; a
// contract that states neither number lists no countable finding; a sentence
// in a locked paragraph — or anywhere under a section lock — is not counted
// against; and the count the author reads is the count the gates refuse at,
// because both go through one reader and one counter. Nothing offers a repair.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { git, makeStory } from './fixture.ts'

const story = makeStory()
process.env.ARC_STORY_PATH = story
process.env.ARC_DRAFT_ENGINE = 'none'
// Never the author's own layer: a fixture path, absent unless a test writes
// it, so the contract is this story's docs/style.md and, where a test sets
// one, that fixture author layer.
process.env.ARC_HOME = path.join(story, '.arc-home')
process.env.ARC_AUTHOR_STYLE = path.join(story, '.arc-home', 'style', 'style.md')
const { countableChecks, andCapFromContract, wordCapFromContract } = await import('../src/countable.ts')
const { andChainViolations, longSentenceViolations } = await import('../src/reroute.ts')
const { createArcServer } = await import('../src/server.ts')
const { styleForPass, gateCtx } = await import('../src/reroute.ts')
const { GATES } = await import('../src/gates.ts')
const { styleContract } = await import('../src/style.ts')
const { predicatesOf } = await import('../src/rule-gates.ts')

const file = 'prose/ch-01/scene-01.md'
const abs = path.join(story, file)
const LOCKS = path.join(story, 'locks')
const STYLE = path.join(story, 'docs', 'style.md')
const AUTHOR = process.env.ARC_AUTHOR_STYLE!

// Synthetic prose. ¶1 chains four "and"s in eighteen words; ¶3 runs to
// twenty-six words with no "and" at all; ¶2 is under both bars.
const CHAIN = 'The rain came and the dogs ran and the men shouted and the boats rocked and nobody slept.'
const SHORT = 'Short one here.'
const LONG = 'Under the long grey awning of the market the old fisherman counted his coins twice over before he paid the boy who carried his nets home.'
const BODY = `${CHAIN}\n\n${SHORT}\n\n${LONG}`

const BOTH = '# Style\n\n## 3. Rhythm\n- **A chain stops at three.** One process, not a procedure.\n- **A sentence stops at 20 words.** However it is joined.\n'
const NEITHER = '# Style\n\n## 3. Rhythm\n- Vary the sentence length; let the long ones earn it.\n'

type Hit = { scene: string; file: string; check: string; paragraph: number; excerpt: string; register: string; measured?: number; bar?: number; lock?: string }

function setUp(style: string, locks: Record<string, string> = {}, author: string | null = null) {
  git(story, 'checkout', 'HEAD', '--', '.')
  git(story, 'clean', '-fdq')
  fs.rmSync(LOCKS, { recursive: true, force: true })
  const before = fs.readFileSync(abs, 'utf8')
  const fm = before.slice(0, before.indexOf('---', 3) + 4)
  fs.writeFileSync(abs, `${fm}${BODY}\n`)
  fs.mkdirSync(path.dirname(STYLE), { recursive: true })
  fs.writeFileSync(STYLE, style)
  fs.rmSync(AUTHOR, { force: true })
  if (author !== null) {
    fs.mkdirSync(path.dirname(AUTHOR), { recursive: true })
    fs.writeFileSync(AUTHOR, author)
  }
  if (Object.keys(locks).length) {
    fs.mkdirSync(LOCKS, { recursive: true })
    for (const [name, yaml] of Object.entries(locks)) fs.writeFileSync(path.join(LOCKS, name), yaml)
  }
}

async function countable(): Promise<Hit[]> {
  const srv = createArcServer()
  await new Promise<void>(r => srv.listen(0, r))
  const port = (srv.address() as { port: number }).port
  try {
    const res = await fetch(`http://localhost:${port}/api/prose/checks`)
    assert.equal(res.status, 200)
    const body = await res.json() as { findings: Hit[] }
    return body.findings.filter(f => f.check === 'and-chain' || f.check === 'sentence-length')
  } finally { srv.close() }
}

test('a sentence over the contract\'s chain or word number is listed with its scene, paragraph, count and bar', async () => {
  setUp(BOTH)
  const hits = await countable()
  assert.equal(hits.length, 2, 'one sentence over each number, and nothing else')

  const chain = hits.find(h => h.check === 'and-chain')!
  assert.equal(chain.scene, 'sc.01-1')
  assert.equal(chain.file, file)
  assert.equal(chain.paragraph, 0)
  assert.equal(chain.measured, 4)
  assert.equal(chain.bar, 3)
  assert.equal(chain.register, 'proven')
  assert.match(chain.excerpt, /^The rain came and the dogs ran/, 'the excerpt is the sentence itself')
  assert.ok(CHAIN.startsWith(chain.excerpt.replace(/…$/, '')), 'and only the author\'s words — the count travels as fields')

  const long = hits.find(h => h.check === 'sentence-length')!
  assert.equal(long.paragraph, 2)
  assert.equal(long.measured, 26)
  assert.equal(long.bar, 20)
  assert.ok(LONG.startsWith(long.excerpt.replace(/…$/, '')), 'the start of the sentence, verbatim')

  for (const h of hits) {
    assert.ok(!('fix' in h) && !('repair' in h) && !('suggestion' in h), 'nothing offers a repair')
    assert.doesNotMatch(h.excerpt, /\b(fault|error|violat|wrong|too long)/i, 'a proven count, never called a fault')
  }
})

test('a contract that states neither number lists no countable finding', async () => {
  setUp(NEITHER)
  assert.deepEqual(await countable(), [])
  assert.deepEqual(countableChecks(BODY, NEITHER), [], 'absent from the contract, there is no rule to count against')
})

test('a sentence in a locked paragraph is not listed; a section lock silences the scene', async () => {
  setUp(BOTH, { 'lock-001.yaml': `id: lock.001\nanchor:\n  scene: sc.01-1\n  paragraph: 0\n  quote: ${CHAIN}\n` })
  const hits = await countable()
  assert.deepEqual(hits.map(h => [h.check, h.paragraph]), [['sentence-length', 2]],
    'the chain in the locked paragraph is not counted against; the unlocked long sentence still is')

  setUp(BOTH, { 'lock-002.yaml': 'id: lock.002\nanchor:\n  scene: sc.01-1\n' })
  assert.deepEqual(await countable(), [], 'a settled section is counted against nowhere')

  setUp(BOTH, { 'lock-003.yaml': 'id: lock.003\nanchor:\n  chapter: ch.01\n' })
  assert.deepEqual(await countable(), [], 'nor is any scene of a locked chapter')
})

test('the counts are the gates\' own: one reader for the contract, one counter for a sentence', () => {
  const andCap = andCapFromContract(BOTH)!
  const wordCap = wordCapFromContract(BOTH)!
  const checks = countableChecks(BODY, BOTH)
  assert.deepEqual(
    checks.filter(c => c.check === 'and-chain').map(c => c.measured),
    andChainViolations(BODY, andCap).map(v => v.ands))
  assert.deepEqual(
    checks.filter(c => c.check === 'sentence-length').map(c => c.measured),
    longSentenceViolations(BODY, wordCap).map(v => v.words))
  const barOf = { 'and-chain': andCap, 'sentence-length': wordCap }
  for (const c of checks) assert.equal(c.bar, barOf[c.check], 'each finding carries its own rule\'s number')
  // The gate's lock-by-text and the check's lock-by-index skip the same paragraph.
  assert.deepEqual(andChainViolations(BODY, andCap, [CHAIN]), [])
  assert.deepEqual(countableChecks(BODY, BOTH, (_p, i) => i === 0).map(c => c.check), ['sentence-length'])
})

// ---- A77-2: the book's number is the one counted --------------------------
//
// The composed contract puts the author's layer first and says "layer 2 wins
// on any conflict". The readers honour that: with both layers stating a
// number the book's is the bar, in the checks and in the gates alike; with
// the book silent, the author's applies.

// The author is stricter on both counts than the book: chain two, sentence
// ten. CHAIN (4 "and"s, 18 words) and LONG (26 words) are over the author's
// bars and the book's; SHORT is under every bar.
const AUTHOR_STRICT = '# How I write\n\n- **A chain stops at two.** Always.\n- **A sentence stops at 10 words.**\n'
// The book is looser than the author: chain five, sentence thirty. Nothing in
// BODY is over either of the book's numbers.
const BOOK_LOOSE = '# Style\n\n## 3. Rhythm\n- **A chain stops at five.** This book runs on.\n- **A sentence stops at 30 words.**\n'

/** The bar a gate would refuse a write at, read the way the reroute and the
 *  revise read it: the contract as rendered for the pass, through gateCtx. */
function gateOn(prose: string) {
  const sceneFile = path.join(story, file)
  const style = styleForPass({ scene: 'sc.01-1', file, body: fs.readFileSync(sceneFile, 'utf8') })
  const ctx = gateCtx({
    sceneName: 'sc.01-1', sceneBody: '', sceneLocks: [], lockedTexts: [], literals: [],
    andCap: andCapFromContract(style), wordCap: wordCapFromContract(style), destination: [],
  })
  const answer = { body: prose, prose, briefing: '', coverage: null, dropped: [], returned: 0, overlap: null, leansOn: null }
  return { chain: GATES['and-chain']!(ctx, answer), sentence: GATES['sentence-length']!(ctx, answer) }
}

test('with both layers stating a number, the book\'s gates the write and bars the check', async () => {
  setUp(BOOK_LOOSE, {}, AUTHOR_STRICT)
  const contract = styleContract()
  assert.ok(contract.indexOf('chain stops at two') < contract.indexOf('chain stops at five'),
    'the author\'s layer comes first in the composed contract — the case the readers must not fall for')
  assert.equal(andCapFromContract(contract), 5)
  assert.equal(wordCapFromContract(contract), 30)

  assert.deepEqual(await countable(), [], 'nothing is over the book\'s numbers, though all of it is over the author\'s')

  const g = gateOn(BODY)
  assert.equal(g.chain.verdict, 'held')
  assert.equal(g.chain.record.bar, 5, 'the chain gate measures against the book\'s number')
  assert.equal(g.sentence.verdict, 'held')
  assert.equal(g.sentence.record.bar, 30, 'and so does the sentence gate')

  // A book STRICTER than the author bars at its own number, too.
  setUp(BOTH, {}, BOOK_LOOSE)
  const hits = await countable()
  assert.deepEqual(hits.map(h => [h.check, h.bar]), [['and-chain', 3], ['sentence-length', 20]])
  const s = gateOn(BODY)
  assert.equal(s.chain.verdict, 'refused')
  assert.equal(s.chain.record.bar, 3)
  assert.equal(s.sentence.verdict, 'refused')
  assert.equal(s.sentence.record.bar, 20)
})

test('with only the author\'s layer stating it, the author\'s number applies', async () => {
  setUp(NEITHER, {}, AUTHOR_STRICT)
  const hits = await countable()
  assert.deepEqual(hits.map(h => [h.check, h.paragraph, h.bar]),
    [['and-chain', 0, 2], ['sentence-length', 0, 10], ['sentence-length', 2, 10]])
  const g = gateOn(BODY)
  assert.equal(g.chain.verdict, 'refused')
  assert.equal(g.chain.record.bar, 2)
  assert.equal(g.sentence.verdict, 'refused')
  assert.equal(g.sentence.record.bar, 10)

  // Each rule falls back on its own: the book states the chain only, so the
  // sentence number is still the author's.
  setUp('# Style\n\n- **A chain stops at five.**\n', {}, AUTHOR_STRICT)
  assert.equal(andCapFromContract(styleContract()), 5)
  assert.equal(wordCapFromContract(styleContract()), 10)
  assert.deepEqual((await countable()).map(h => [h.check, h.bar]), [['sentence-length', 10], ['sentence-length', 10]])
})

test('the learner\'s predicates read one rule or one line through the same readers', () => {
  assert.deepEqual(predicatesOf('A chain stops at three. A sentence stops at 40 words.'), ['and-chain:3', 'sentence-length:40'])
  assert.deepEqual(predicatesOf('- **A chain stops at two.** Always.'), ['and-chain:2'], 'a line with no layer header is read as it is')
})

test('a layer header quoted inside either body does not move where the book\'s layer begins', async () => {
  const { BOOK_LAYER_HEADER } = await import('../src/countable.ts')
  // The author pasted the header from a brief, above their own stricter rule.
  setUp('- **A chain stops at five.**\n', {}, `Notes\n${BOOK_LAYER_HEADER}\n- A chain stops at two.\n`)
  const contract = styleContract()
  assert.equal(contract.split('\n').filter(l => l === BOOK_LAYER_HEADER).length, 1, 'one header line of its own; the quoted one is quoted')
  assert.equal(andCapFromContract(contract), 5, 'the book\'s number, not the author\'s under a pasted header')
  assert.equal(gateOn(BODY).chain.record.bar, 5)
  assert.deepEqual((await countable()).filter(h => h.check === 'and-chain'), [])

  // The book quotes the header AFTER its own rule.
  setUp(`- **A chain stops at five.**\n\n${BOOK_LAYER_HEADER}\nquoted from a brief\n`, {}, '- A chain stops at two.\n')
  assert.equal(andCapFromContract(styleContract()), 5)
  assert.equal(gateOn(BODY).chain.record.bar, 5)
})
