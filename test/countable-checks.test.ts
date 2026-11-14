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
// Never the author's own layer: a fixture path, absent, so the contract is
// this story's docs/style.md and nothing else.
process.env.ARC_HOME = path.join(story, '.arc-home')
process.env.ARC_AUTHOR_STYLE = path.join(story, '.arc-home', 'style', 'style.md')
const { countableChecks, andCapFromContract, wordCapFromContract } = await import('../src/countable.ts')
const { andChainViolations, longSentenceViolations } = await import('../src/reroute.ts')
const { createArcServer } = await import('../src/server.ts')

const file = 'prose/ch-01/scene-01.md'
const abs = path.join(story, file)
const LOCKS = path.join(story, 'locks')
const STYLE = path.join(story, 'docs', 'style.md')

// Synthetic prose. ¶1 chains four "and"s in eighteen words; ¶3 runs to
// twenty-six words with no "and" at all; ¶2 is under both bars.
const CHAIN = 'The rain came and the dogs ran and the men shouted and the boats rocked and nobody slept.'
const SHORT = 'Short one here.'
const LONG = 'Under the long grey awning of the market the old fisherman counted his coins twice over before he paid the boy who carried his nets home.'
const BODY = `${CHAIN}\n\n${SHORT}\n\n${LONG}`

const BOTH = '# Style\n\n## 3. Rhythm\n- **A chain stops at three.** One process, not a procedure.\n- **A sentence stops at 20 words.** However it is joined.\n'
const NEITHER = '# Style\n\n## 3. Rhythm\n- Vary the sentence length; let the long ones earn it.\n'

type Hit = { scene: string; file: string; check: string; paragraph: number; excerpt: string; register: string; measured?: number; bar?: number; lock?: string }

function setUp(style: string, locks: Record<string, string> = {}) {
  git(story, 'checkout', 'HEAD', '--', '.')
  git(story, 'clean', '-fdq')
  fs.rmSync(LOCKS, { recursive: true, force: true })
  const before = fs.readFileSync(abs, 'utf8')
  const fm = before.slice(0, before.indexOf('---', 3) + 4)
  fs.writeFileSync(abs, `${fm}${BODY}\n`)
  fs.mkdirSync(path.dirname(STYLE), { recursive: true })
  fs.writeFileSync(STYLE, style)
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
