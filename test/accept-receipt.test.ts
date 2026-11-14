// EVERY DECISION ON A GOVERNED DRAFT WRITES ITS RECORD RECEIPT (A76-1).
//
// The accept stamped only an adopted route's run, so a drafted, redrafted or
// notes-revised scene entered the book with no durable trace of the run that
// wrote it. Pinned here, under the fixture engine on a disposable copy of the
// worked example: an accept of any rowed writing run commits history/<run>.yaml
// with the decision and the accept's hash, in the records commit behind it; a
// draft taken in two steps ends with one receipt that says both; a discard
// commits the receipt and nothing else; the receipt carries none of the
// draft's prose; the draft row reads attended after one accepted run; and a
// draft with no run behind it writes no receipt at all.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { load as yamlLoad } from 'js-yaml'
import type { Receipt } from '../src/run.ts'
// Sets the story and the fixture engine before anything under src/ loads.
import { SCENARIOS, SCENE, STORY, renderScenario, reset } from './fixture-scenarios.ts'
import { git } from './fixture.ts'

const { createArcServer } = await import('../src/server.ts')
const { runDraft } = await import('../src/draft.ts')
const { runRedraft } = await import('../src/redraft.ts')
const { runWorkNotes } = await import('../src/work-notes.ts')
const { createAnnotation } = await import('../src/annotations.ts')
const { proseScenes, parseScene } = await import('../src/story.ts')
const { generatedFor } = await import('../src/ledger.ts')
const { baseOf } = await import('../src/base.ts')
const { ROW_DRAFT_SCENE, rowKey, registryStatus } = await import('../src/registry.ts')
const { listAlternatives, adoptAlternative } = await import('../src/reroute.ts')
const { alignParagraphs } = await import('arc-canon-graph')

const server = createArcServer()
await new Promise<void>(resolve => server.listen(0, resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
test.after(() => server.close())
const post = async (p: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
  const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

const CHAPTER = 'ch.01-ninety-one-stairs'
const fileOf = (scene: string): string => proseScenes().find(s => s.scene === scene)!.file
const head = (): string => git(STORY, 'rev-parse', '--short', 'HEAD').trim()
const atHead = (run: string): string | null => {
  try { return git(STORY, 'show', `HEAD:history/${run}.yaml`) } catch { return null }
}
const historyAtHead = (): string[] =>
  git(STORY, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'history').split('\n').filter(Boolean)
const paragraphs = (body: string): string[] => body.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
const bodyOf = (file: string, text: string): string => parseScene(text, file)?.body ?? text

async function accept(file: string): Promise<string> {
  const res = await post('/api/prose/accept', { files: [file], bases: { [file]: baseOf(file) } })
  assert.equal(res.status, 200, JSON.stringify(res.json))
  return res.json.hash as string
}

/** The record receipt must carry no paragraph of what the run wrote. */
function assertNoProse(text: string, file: string): void {
  const gen = generatedFor(file)
  assert.ok(gen, 'the ledger still holds what arc wrote')
  for (const p of paragraphs(bodyOf(file, gen!.content))) {
    // a fragment of every paragraph, so a wrapped YAML line cannot hide it
    assert.ok(!text.includes(p.slice(0, 30)), `the receipt carries none of the draft's prose: "${p.slice(0, 30)}"`)
  }
  assert.doesNotMatch(text, new RegExp(STORY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'and no absolute path')
}

test('accepting a drafted scene commits its run\'s record receipt with the decision and the accept\'s hash', async () => {
  reset()
  const before = registryStatus().find(r => r.key === rowKey(ROW_DRAFT_SCENE))!.status
  assert.equal(before, 'built', 'no decision yet: the draft row is built, not attended')
  const out = await runDraft(CHAPTER) as { run?: string; file: string | null }
  assert.ok(out.run && out.file)

  const hash = await accept(out.file!)
  const text = atHead(out.run!)
  assert.ok(text, 'HEAD:history/<run>.yaml exists')
  const r = yamlLoad(text!) as Receipt
  assert.equal(r.author_decision?.decision, 'accepted')
  assert.equal(r.result.commit, hash, 'the receipt names the accept\'s commit')
  assert.deepEqual(r.result.records, [out.file])
  assert.deepEqual(r.author_decision?.taken?.map(s => s.grain), ['scene'])
  // the accept, then the records commit right behind it
  const log = git(STORY, 'log', '--format=%s', '-2').trim().split('\n')
  assert.match(log[0], new RegExp(`^Record: the receipt for ${hash}`))
  assert.match(log[1], /^prose: accept/)
  assert.equal(git(STORY, 'status', '--porcelain', '--', 'history').trim(), '', 'nothing left dirty under history/')
  assertNoProse(text!, out.file!)

  // criterion 5: one accepted run and the row is attended
  assert.equal(registryStatus().find(r => r.key === rowKey(ROW_DRAFT_SCENE))!.status, 'attended')
  reset()
})

test('a clean pass and a notes revision accept through the same path', async () => {
  reset()
  const redrafted = await runRedraft({ scene: SCENE }) as { run?: string }
  assert.ok(redrafted.run)
  const hash = await accept(fileOf(SCENE))
  const r = yamlLoad(atHead(redrafted.run!)!) as Receipt
  assert.equal(r.author_decision?.decision, 'accepted')
  assert.equal(r.result.commit, hash)

  reset()
  // the fixture scenario's own note, word for word, so the recorded answer applies
  createAnnotation({ scene: SCENE, paragraph: 4, quote: 'Then the log.', body: 'the log entry should cost her something', by: 'author' })
  const revised = await runWorkNotes({ scene: SCENE }) as { run?: string }
  assert.ok(revised.run, 'the notes revision names its run')
  assert.equal(generatedFor(fileOf(SCENE))?.entry.origin, 'revise')
  const second = await accept(fileOf(SCENE))
  const rr = yamlLoad(atHead(revised.run!)!) as Receipt
  assert.equal(rr.author_decision?.decision, 'accepted')
  assert.equal(rr.result.commit, second)
  reset()
})

test('a draft accepted in two steps ends with one record receipt that says both', async () => {
  reset()
  const out = await runRedraft({ scene: SCENE }) as { run?: string }
  const file = fileOf(SCENE)
  const draft = paragraphs(bodyOf(file, fs.readFileSync(path.join(STORY, file), 'utf8')))
  const main = new Set(paragraphs(bodyOf(file, git(STORY, 'show', `HEAD:${file}`))))
  const changed = draft.findIndex(p => !main.has(p))
  assert.ok(changed >= 0, 'the clean pass changed a paragraph')

  const first = await post('/api/prose/accept-paragraph', { file, side: 'draft', paragraph: changed, base: baseOf(file) })
  assert.equal(first.status, 200, JSON.stringify(first.json))
  const one = yamlLoad(atHead(out.run!)!) as Receipt
  assert.deepEqual(one.author_decision?.taken?.map(s => s.grain), ['paragraph'])
  assert.equal(one.result.commit, first.json.hash, 'the paragraph accept\'s own commit')
  assert.equal((one.author_decision?.taken?.[0] as { paragraph: number }).paragraph, changed, 'at the grain the accept named')

  const second = await accept(file)
  const both = yamlLoad(atHead(out.run!)!) as Receipt
  assert.deepEqual(both.author_decision?.taken?.map(s => [s.grain, s.commit]), [['paragraph', first.json.hash], ['scene', second]])
  assert.equal(both.result.commit, second, 'the latest decision\'s commit')
  assert.match(both.author_decision?.note ?? '', /paragraph .*; accepted /)
  assert.equal(historyAtHead().filter(f => f.includes(out.run!)).length, 1, 'one file, not two')
  assertNoProse(atHead(out.run!)!, file)
  reset()
})

test('discarding a governed draft commits its record receipt, and nothing else', async () => {
  reset()
  const out = await runRedraft({ scene: SCENE }) as { run?: string }
  const file = fileOf(SCENE)
  // something else pending beside it, which the discard must not commit
  const other = 'notes/stray.md'
  fs.mkdirSync(path.join(STORY, 'notes'), { recursive: true })
  fs.writeFileSync(path.join(STORY, other), 'left alone\n')
  const gen = generatedFor(file)!
  const before = head()

  const res = await post('/api/prose/discard', { file, base: baseOf(file) })
  assert.equal(res.status, 200, JSON.stringify(res.json))
  assert.equal(git(STORY, 'rev-list', '--count', `${before}..HEAD`).trim(), '1', 'one commit: the records commit')
  assert.deepEqual(git(STORY, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean), [`history/${out.run}.yaml`])
  assert.match(git(STORY, 'log', '--format=%s', '-1'), /^Record: the receipt for the discard of /)
  assert.ok(fs.existsSync(path.join(STORY, other)), 'the stray file is still there, uncommitted')

  const text = atHead(out.run!)!
  const r = yamlLoad(text) as Receipt
  assert.equal(r.author_decision?.decision, 'rejected')
  assert.deepEqual(r.author_decision?.taken?.map(s => s.grain), ['discard'])
  assert.equal(r.result.commit, null, 'a discard commits no prose, so there is no decision commit to name')
  for (const p of paragraphs(bodyOf(file, gen.content))) assert.ok(!text.includes(p.slice(0, 30)), 'no prose of the discarded draft')
  reset()
})

test('a draft with no run behind it accepts and discards exactly as before, and writes no receipt', async () => {
  reset()
  const file = fileOf(SCENE)
  const abs = path.join(STORY, file)
  const edit = (): void => fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').trimEnd() + '\n\nTyped by hand.\n')
  const history = (): number => historyAtHead().length

  const n = history()
  edit()
  const hash = await accept(file)
  assert.equal(head(), hash, 'the accept is the last commit: no records commit behind it')
  assert.equal(history(), n)

  edit()
  const before = head()
  assert.equal((await post('/api/prose/discard', { file, base: baseOf(file) })).status, 200)
  assert.equal(head(), before, 'a discard of the author\'s own words commits nothing')
  assert.ok(!fs.existsSync(path.join(STORY, 'history')) || git(STORY, 'status', '--porcelain', '--', 'history').trim() === '')

  // and the author's own edit AFTER an accepted run is theirs, not the run's
  reset()
  const out = await runRedraft({ scene: SCENE }) as { run?: string }
  await accept(file)
  const settled = atHead(out.run!)
  edit()
  const later = await accept(file)
  assert.equal(head(), later, 'no records commit behind the second accept')
  assert.equal(atHead(out.run!), settled, 'the settled receipt is unchanged')
  reset()
})

// ---- piece by piece (the review of A76-1) ----------------------------------

/** The first change still pending in a scene, named the way the viewer names
 *  it: a deletion by its main-side index, anything else by its draft side. */
function firstChange(file: string): { side: 'main' | 'draft'; paragraph: number } | null {
  const split = (body: string) => body.split(/\n{2,}/).map(x => x.trim()).filter(Boolean)
  const working = split(bodyOf(file, fs.readFileSync(path.join(STORY, file), 'utf8')))
  const main = split(bodyOf(file, git(STORY, 'show', `HEAD:${file}`)))
  const hit = alignParagraphs(main, working).find(a => a.kind !== 'same')
  if (!hit) return null
  return hit.kind === 'del' ? { side: 'main', paragraph: hit.mainIndex! } : { side: 'draft', paragraph: hit.draftIndex! }
}
const pends = async (file: string): Promise<boolean> =>
  ((await (await fetch(`${base}/api/prose/draft`)).json()) as { changes: { file: string }[] }).changes.some(c => c.file === file)

/** Decide every change in the scene one paragraph at a time, by `verdict(i)`. */
async function pieceByPiece(file: string, verdict: (i: number) => 'accept' | 'reject'): Promise<number> {
  let i = 0
  for (let t = firstChange(file); t && await pends(file); t = firstChange(file), i++) {
    const res = await post(`/api/prose/${verdict(i)}-paragraph`, { file, ...t, base: baseOf(file) })
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.ok(i < 50, 'the draft runs out of changes')
  }
  return i
}

test('a draft taken whole piece by piece is settled, and the author\'s later edit is not credited to the run', async () => {
  reset()
  const out = await runRedraft({ scene: SCENE }) as { run?: string }
  const file = fileOf(SCENE)
  const steps = await pieceByPiece(file, () => 'accept')
  assert.ok(steps >= 1)
  assert.equal(await pends(file), false, 'nothing pends')
  const settled = atHead(out.run!)!
  const r = yamlLoad(settled) as Receipt
  assert.equal(r.author_decision?.taken?.length, steps)
  assert.equal(r.author_decision?.taken?.at(-1)?.settled, true, 'the last piece settles the draft')

  const abs = path.join(STORY, file)
  fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').trimEnd() + '\n\nTyped by hand.\n')
  const hash = await accept(file)
  assert.equal(head(), hash, 'no records commit follows the hand edit\'s accept')
  assert.equal(atHead(out.run!), settled, 'the run\'s receipt is byte-equal to what the last paragraph accept left')
  assert.equal(fs.readFileSync(path.join(STORY, 'history', `${out.run}.yaml`), 'utf8'), settled)
  reset()
})

test('a draft refused piece by piece ends settled and rejected; one partly taken lists both kinds of step', async () => {
  reset()
  const out = await runRedraft({ scene: SCENE }) as { run?: string }
  const file = fileOf(SCENE)
  const before = head()
  await pieceByPiece(file, () => 'reject')
  assert.equal(await pends(file), false)
  const text = atHead(out.run!)
  assert.ok(text, 'a refusal commits the receipt, as the discard does')
  const r = yamlLoad(text!) as Receipt
  assert.equal(r.author_decision?.decision, 'rejected')
  assert.ok(r.author_decision?.taken?.every(s => s.grain === 'paragraph' && s.verdict === 'rejected'))
  assert.equal(r.author_decision?.taken?.at(-1)?.settled, true)
  assert.equal(r.result.commit, null, 'no decision commit to name')
  for (const h of git(STORY, 'rev-list', `${before}..HEAD`).trim().split('\n')) {
    assert.deepEqual(git(STORY, 'show', '--name-only', '--format=', h).split('\n').filter(Boolean), [`history/${out.run}.yaml`],
      'every commit a refusal made holds the receipt and nothing else')
  }

  reset()
  const mixed = await runRedraft({ scene: SCENE }) as { run?: string }
  const steps = await pieceByPiece(file, i => (i === 0 ? 'accept' : 'reject'))
  const m = yamlLoad(atHead(mixed.run!)!) as Receipt
  const verdicts = new Set(m.author_decision?.taken?.map(s => (s as { verdict?: string }).verdict))
  assert.ok(steps > 1, 'the clean pass left more than one change to decide')
  assert.deepEqual([...verdicts].sort(), ['accepted', 'rejected'], 'both kinds of step')
  assert.equal(m.author_decision?.decision, 'accepted', 'a piece of it is in the book')
  assert.equal(m.author_decision?.taken?.at(-1)?.settled, true)
  reset()
})

test('a settled receipt with no commit of its own, left uncommitted, rides in the next records commit', async () => {
  reset()
  fs.mkdirSync(path.join(STORY, 'history'), { recursive: true })
  const orphan = 'history/run.orphaned.yaml'
  fs.writeFileSync(path.join(STORY, orphan), [
    'run_id: run.orphaned',
    'author_decision:',
    '  decision: rejected',
    '  taken:',
    '    - { file: prose/ch-01/scene-01.md, commit: null, grain: discard }',
    'result: { records: [prose/ch-01/scene-01.md], commit: null }',
    '',
  ].join('\n'))
  const out = await runDraft(CHAPTER) as { run?: string; file: string | null }
  await accept(out.file!)
  const committed = git(STORY, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort()
  assert.deepEqual(committed, [orphan, `history/${out.run}.yaml`].sort())
  reset()
})

test('a receipt arc could not keep is said in the author\'s words, and the accept still landed', async () => {
  reset()
  const out = await runDraft(CHAPTER) as { run?: string; file: string | null }
  const dir = path.join(STORY, 'history')
  fs.mkdirSync(dir, { recursive: true })
  fs.chmodSync(dir, 0o555)
  try {
    const res = await post('/api/prose/accept', { files: [out.file], bases: { [out.file!]: baseOf(out.file!) } })
    assert.equal(res.status, 200, 'the accept landed')
    assert.equal(res.json.hash, head(), 'and it is the last commit')
    assert.match(git(STORY, 'log', '--format=%s', '-1'), /^prose: accept/)
    const said = String(res.json.afterwards ?? '')
    assert.match(said, /your words are in the book/)
    assert.match(said, /not kept/)
    assert.doesNotMatch(said, /receipt|commit|git|agent|history/i, 'no machine words')
  } finally {
    fs.chmodSync(dir, 0o755)
  }
  reset()
})

test('a paragraph accept on an adopted route continues the adopt receipt', async () => {
  const lands = SCENARIOS.find(s => s.row === 'explore.scene.one-shot' && s.name === 'lands')!
  const { result } = await renderScenario(lands) as { result: { run?: string } }
  const run = result.run!
  const alt = listAlternatives(SCENE)[0]
  adoptAlternative(SCENE, alt.id)
  const file = fileOf(SCENE)
  const t = firstChange(file)!
  const res = await post('/api/prose/accept-paragraph', { file, ...t, base: baseOf(file) })
  assert.equal(res.status, 200, JSON.stringify(res.json))
  const r = yamlLoad(atHead(run)!) as Receipt
  assert.match(r.author_decision?.note ?? '', new RegExp(`^adopted ${alt.id} into .*; accepted ${t.side} paragraph ${t.paragraph} `))
  assert.deepEqual(r.author_decision?.taken?.map(s => s.grain), ['paragraph'])
  assert.equal(r.result.commit, res.json.hash)
  assert.equal(historyAtHead().filter(f => f.includes(run)).length, 1, 'one file')
  reset()
})

test('a sentence accept records its step at sentence grain', async () => {
  reset()
  const out = await runRedraft({ scene: SCENE }) as { run?: string }
  const file = fileOf(SCENE)
  const split = (body: string) => body.split(/\n{2,}/).map(x => x.trim()).filter(Boolean)
  const working = split(bodyOf(file, fs.readFileSync(path.join(STORY, file), 'utf8')))
  const main = split(bodyOf(file, git(STORY, 'show', `HEAD:${file}`)))
  const changed = alignParagraphs(main, working).filter(a => a.kind === 'changed')
  assert.ok(changed.length, 'the clean pass changed a paragraph in place')
  let hit: { paragraph: number; sentence: number; hash: string } | null = null
  for (const a of changed) {
    for (let sentence = 0; sentence < 12 && !hit; sentence++) {
      const res = await post('/api/prose/accept-sentence', { file, side: 'draft', paragraph: a.draftIndex, sentence, base: baseOf(file) })
      if (res.status === 200) hit = { paragraph: a.draftIndex!, sentence, hash: res.json.hash as string }
    }
    if (hit) break
  }
  assert.ok(hit, 'one sentence of the draft was taken')
  const r = yamlLoad(atHead(out.run!)!) as Receipt
  const step = r.author_decision?.taken?.[0] as { grain: string; verdict: string; paragraph: number; sentence: number }
  assert.deepEqual([step.grain, step.verdict, step.paragraph, step.sentence], ['sentence', 'accepted', hit!.paragraph, hit!.sentence])
  assert.equal(r.result.commit, hit!.hash)
  reset()
})
