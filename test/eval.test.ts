// The private evaluation of the drafting brief (A82-3): a recording is the
// pass's own brief and the engine's real answer, kept under .arc/eval/ and
// offered to nobody; a comparison sets two labels side by side, blind, and
// counts only what the author wrote down. No model is reached: the first
// test runs the pass under the fixture engine, the rest record through the
// stub CLI.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { STORY, reset } from './fixture-scenarios.ts'
import { installStubCli } from './fixture.ts'

const { observeBriefs } = await import('../src/fixtures.ts')
const { runDraft } = await import('../src/draft.ts')
const { compare, draftEvalBrief, evalDir, recordCase, xIs, EvalError } = await import('../src/eval.ts')

/** The example ships no .gitignore, and a story has to ignore .arc/ before a
 *  recording is allowed in it — as the novel does. Told to this clone alone
 *  (.git/info/exclude), so no tracked file changes and reset() leaves it. */
const ignoreArc = (): void => fs.appendFileSync(path.join(STORY, '.git', 'info', 'exclude'), '\n.arc/\n')
const unignoreArc = (): void => {
  const f = path.join(STORY, '.git', 'info', 'exclude')
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/\n\.arc\/\n/g, ''))
}
const { sha16 } = await import('../src/records.ts')

const CHAPTER = 'ch.01-ninety-one-stairs'
const status = (): string => execFileSync('git', ['-C', STORY, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' })
/** Everything on disk in the story outside .git and .arc/eval — what a
 *  recording must leave exactly as it found it. */
function outsideEval(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name), rel = path.relative(STORY, full)
      if (rel === '.git' || rel === path.join('.arc', 'eval')) continue
      if (e.isDirectory()) walk(full); else out.push(`${rel}:${sha16(fs.readFileSync(full, 'utf8'))}`)
    }
  }
  walk(STORY)
  return out.sort()
}

test('the eval brief is the brief the draft pass sends — one assembly, not two', async () => {
  reset()
  process.env.ARC_DRAFT_ENGINE = 'fixture'
  const mine = draftEvalBrief(CHAPTER).rendered
  const seen: string[] = []
  const stop = observeBriefs(b => { if (b.row === 'draft.scene.one-shot.write') seen.push(b.brief) })
  try { await runDraft(CHAPTER) } finally { stop() }
  assert.equal(seen.length, 1, 'the pass sent one writing brief')
  assert.equal(mine, seen[0])
  reset()
})

// From here on the engine is the CLI, and the CLI is a stub whose answer the
// test names — a different one per recording, as two real answers would be.
// The engine is pinned inside each recording, not at the top of the file: the
// module body runs before any test does, and the first test needs the fixture.
const STUB = installStubCli({ name: 'eval', answer: 'process.env.STUB_ANSWER' })
process.env.PATH = `${STUB}${path.delimiter}${process.env.PATH}`
const record = (label: string, answer: string, again = false) => {
  process.env.ARC_DRAFT_ENGINE = 'claude-cli'
  process.env.STUB_ANSWER = answer
  return recordCase(CHAPTER, label, { again })
}
/** One sentence: it ends where it stops, and nothing inside it starts another. */
const oneSentence = (e: Error): boolean =>
  e instanceof EvalError && e.message.startsWith('Nothing was recorded, because ') && e.message.endsWith('.') && !/[.!?]\s+[A-Z]/.test(e.message)

test('a story that does not ignore .arc/ is refused in one sentence, before anything is asked', async () => {
  reset()
  await assert.rejects(() => record('before', 'never kept'), (e: Error) => oneSentence(e) && /does not ignore its \.arc\/ folder/.test(e.message))
  assert.ok(!fs.existsSync(evalDir()), 'and nothing was written')
  assert.equal(status(), '')
})

test('a recording keeps the brief, the answer and the proof — under .arc/eval/ and nowhere else', async () => {
  reset()
  ignoreArc()
  const before = outsideEval()
  assert.equal(status(), '')
  const { file, saved } = await record('before', 'The stairs were ninety-one, and she counted them.')
  assert.equal(path.relative(STORY, file), path.join('.arc', 'eval', 'before', `${CHAPTER}.json`))
  assert.deepEqual(outsideEval(), before, 'nothing else in the story changed: no draft, no run, no ledger line, no receipt')
  assert.equal(status(), '', 'and git status in the story is exactly what it was')
  assert.ok(!fs.existsSync(path.join(STORY, '.arc', 'runs')), 'no run was minted')
  assert.ok(!fs.existsSync(path.join(STORY, 'prose', 'ch-01', 'scene-02.md')), 'the answer was not offered as a draft')

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(onDisk, saved)
  assert.equal(saved.answer, 'The stairs were ninety-one, and she counted them.')
  assert.equal(saved.brief, draftEvalBrief(CHAPTER).rendered)
  assert.equal(saved.brief_fingerprint, sha16(saved.brief))
  assert.match(saved.record_fingerprint, /^[0-9a-f]{16}$/)
  assert.notEqual(saved.record_fingerprint, saved.rules_fingerprint)
  assert.ok('transcript' in saved, 'where the runtime kept its own copy is named, or null')
  assert.match(saved.rules_fingerprint, /^[0-9a-f]{16}$/)
  assert.equal(saved.row, 'draft.scene.one-shot.write')
  assert.equal(saved.scene, 'sc.01-2')
  assert.equal(saved.model, 'stub-model')
  assert.ok(saved.tokens.input > 0 && saved.tokens.output > 0)
  assert.equal(saved.envelope?.ok, true, 'the launch carried its row, so the envelope is proven as a run\'s is')
})

test('with no engine, one sentence and nothing written', async () => {
  process.env.ARC_DRAFT_ENGINE = 'none'
  try {
    await assert.rejects(() => recordCase(CHAPTER, 'nowhere'), (e: Error) => oneSentence(e) && /nothing can answer/.test(e.message))
    assert.ok(!fs.existsSync(path.join(evalDir(), 'nowhere')))
  } finally { process.env.ARC_DRAFT_ENGINE = 'claude-cli' }
})

test('a case already recorded is kept unless the author says again', async () => {
  const file = path.join(evalDir(), 'before', `${CHAPTER}.json`)
  const kept = fs.readFileSync(file, 'utf8')
  await assert.rejects(() => record('before', 'a second answer'), (e: Error) => oneSentence(e) && /already recorded under "before"/.test(e.message))
  assert.equal(fs.readFileSync(file, 'utf8'), kept)
})

test('a label that is not a plain name is refused before anything is asked', async () => {
  await assert.rejects(() => recordCase(CHAPTER, '../elsewhere'), EvalError)
  await assert.rejects(() => recordCase('ch.99-nothing', 'before'), /no chapter ch\.99-nothing/)
  assert.throws(() => compare('before', 'before'), /name two/)
  assert.throws(() => compare('before', 'never-recorded'), /nothing is recorded under "never-recorded"/)
})

const base = (): string => path.join(evalDir(), 'compare-after-vs-before')
const readJudgments = () => JSON.parse(fs.readFileSync(`${base()}.judgments.json`, 'utf8'))

test('compare sets the two answers side by side under blind names, and says what is proven', async () => {
  await record('after', 'Ninety-one stairs. She did not count.')
  const out = compare('before', 'after')
  assert.match(out.lines[0], /^1 case recorded under both after and before/)
  assert.ok(out.lines.some(l => l === 'proven: the drafting rules are the same in both'))
  assert.ok(out.lines.some(l => /^proven: the brief is identical in both/.test(l)), 'same rules, same record: the spread, not a change')
  assert.equal(compare('after', 'before').page, out.page, 'asked the other way round, it is the same comparison and the same files')
  assert.equal(out.tally, null)
  assert.ok(out.lines.some(l => /nothing is judged yet/.test(l)))

  const page = fs.readFileSync(`${base()}.md`, 'utf8')
  assert.match(page, /The stairs were ninety-one, and she counted them\./)
  assert.match(page, /Ninety-one stairs\. She did not count\./)
  assert.doesNotMatch(page.split('## ')[1], /\b(before|after)\b/, 'the pair does not say which label wrote which')
  const key = JSON.parse(fs.readFileSync(`${base()}.key.json`, 'utf8'))
  assert.equal(key[CHAPTER].X, xIs(CHAPTER, 'after', 'before'))
  assert.deepEqual(new Set([key[CHAPTER].X, key[CHAPTER].Y]), new Set(['before', 'after']))
  const j = readJudgments()
  assert.deepEqual(j.cases[CHAPTER].X, { voice: null, usefulness: null, effort: null })
})

test('a rules change between the labels is proven by fingerprint', () => {
  const file = path.join(evalDir(), 'after', `${CHAPTER}.json`)
  const original = fs.readFileSync(file, 'utf8')
  const moved = JSON.parse(original); moved.rules_fingerprint = '0'.repeat(16)
  const put = (): void => fs.writeFileSync(file, JSON.stringify(moved))
  try {
    put()
    let lines = compare('before', 'after').lines
    assert.ok(lines.some(l => l === 'proven: the drafting rules differ between after and before in every case'))
    assert.ok(!lines.some(l => /the record moved/.test(l)), 'the rules alone moved')

    // The rules AND the record: a difference there is not the rules' alone.
    moved.record_fingerprint = '1'.repeat(16); put()
    lines = compare('before', 'after').lines
    assert.ok(lines.some(l => /the drafting rules differ/.test(l)))
    assert.ok(lines.some(l => /the rest of the brief .* differs in 1 of 1 cases .* not the rules' alone/.test(l)))

    // The record alone.
    moved.rules_fingerprint = JSON.parse(original).rules_fingerprint; put()
    lines = compare('before', 'after').lines
    assert.ok(lines.some(l => l === 'proven: the drafting rules are the same in both'))
    assert.ok(lines.some(l => /the record moved between the recordings/.test(l)))
    assert.ok(!lines.some(l => /the brief is identical/.test(l)))
  } finally { fs.writeFileSync(file, original) }
})

test('two answers to two different scenes are not a pair', () => {
  const file = path.join(evalDir(), 'after', `${CHAPTER}.json`)
  const original = fs.readFileSync(file, 'utf8')
  const later = JSON.parse(original); later.scene = 'sc.01-3'
  fs.writeFileSync(file, JSON.stringify(later))
  try {
    assert.throws(() => compare('before', 'after'), /share no case that asked for the same scene.*sc\.01-3 under after, sc\.01-2 under before/)
  } finally { fs.writeFileSync(file, original) }
})

test('the tally counts what the author wrote, by label, and a started judgment is never overwritten', () => {
  const j = readJudgments()
  const key = JSON.parse(fs.readFileSync(`${base()}.key.json`, 'utf8'))[CHAPTER]
  const side = (label: string): 'X' | 'Y' => key.X === label ? 'X' : 'Y'
  j.cases[CHAPTER][side('before')] = { voice: 2, usefulness: 3, effort: null }
  j.cases[CHAPTER].note = 'the second one hears her'   // the author's own words, beside the numbers
  j.mine = 'read on a train'
  fs.writeFileSync(`${base()}.judgments.json`, JSON.stringify(j))

  const part = compare('before', 'after')
  assert.equal(part.tally, null)
  assert.ok(part.lines.some(l => new RegExp(`not counted — some numbers still missing.*${CHAPTER.replace('.', '\\.')}`).test(l)))
  assert.deepEqual(readJudgments().cases[CHAPTER][side('before')], { voice: 2, usefulness: 3, effort: null }, 'what the author started is kept')
  assert.equal(readJudgments().cases[CHAPTER].note, 'the second one hears her', 'and so is anything else they wrote there')
  assert.equal(readJudgments().mine, 'read on a train')

  const full = readJudgments()
  full.cases[CHAPTER][side('before')] = { voice: 2, usefulness: 3, effort: 2 }
  full.cases[CHAPTER][side('after')] = { voice: 4, usefulness: 4, effort: 5 }
  fs.writeFileSync(`${base()}.judgments.json`, JSON.stringify(full))
  const out = compare('before', 'after')
  assert.deepEqual(out.tally, {
    judged: 1,
    means: { before: { voice: 2, usefulness: 3, effort: 2 }, after: { voice: 4, usefulness: 4, effort: 5 } },
    won: { before: 0, after: 1 }, ties: 0,
  })
  assert.ok(out.lines.some(l => /judged better overall: after in 1, before in 0/.test(l)))
})

test('an answer recorded again since it was judged is not counted, and the numbers are kept', async () => {
  await record('after', 'A third answer, recorded later.', true)
  const out = compare('before', 'after')
  assert.equal(out.tally, null)
  assert.ok(out.lines.some(l => /recorded again since you judged them/.test(l)))
  const j = readJudgments().cases[CHAPTER]
  assert.ok([j.X, j.Y].some((s: { voice: number }) => s.voice === 4), 'the author\'s numbers are still there')
})

test('a judgments file that is not JSON is left exactly as it is', () => {
  fs.writeFileSync(`${base()}.judgments.json`, '{ half')
  const out = compare('before', 'after')
  assert.ok(out.lines.some(l => /not readable as JSON/.test(l)))
  assert.equal(fs.readFileSync(`${base()}.judgments.json`, 'utf8'), '{ half')
  unignoreArc()
  reset()
})
