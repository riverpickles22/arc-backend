// APPROVE · NEVER for a canon proposal (A74-4). Proposals are filed by the
// real pass on a stub `claude` (no key, no subscription); what is under test
// is the decision: the text edits, the one commit, the evidence log, the
// receipt, and the duplicate gate remembering a never.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { dump as yamlDump, load as yamlLoad } from 'js-yaml'
import { installStubCli, makeExampleStory, git } from './fixture.ts'

const STORY = makeExampleStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'claude-cli'

const SCENE_FILE = 'prose/ch-01/scene-01.md'
{
  const abs = path.join(STORY, SCENE_FILE)
  fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace('Then the log.', 'Then the log, and the barometer beside it.'))
  git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'prose: accept sc.01-1')
}

process.env.PATH = `${installStubCli({
  name: 'proposals',
  answer: `process.env.STUB_ANSWER ?? '[]'`,
})}${path.delimiter}${process.env.PATH}`

const { runUpdateRecord } = await import('../src/update-record.ts')
const { decideProposals, removeItem, approveItem } = await import('../src/decide-proposals.ts')
const { readProposalDecisions, appendProposalDecision } = await import('../src/evidence.ts')
const { ROW_UPDATE_RECORD_SCENE, rowStatus, readStatusReceipts } = await import('../src/registry.ts')
const { validateStory } = await import('../src/canon.ts')
const { createArcServer } = await import('../src/server.ts')
const { HttpError } = await import('../src/http.ts')
const { proposalKey } = await import('../src/proposals.ts')

const server = createArcServer()
await new Promise<void>(resolve => server.listen(0, resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
test.after(() => server.close())

const obj = (value: string, extra: Record<string, unknown> = {}) =>
  ({ class: 'stated', subject: 'new', type: 'object', field: 'name', value, evidence: ['¶5'], note: `${value}.`, ...extra })
const edge = (field: string) =>
  ({ class: 'implied', subject: 'char.ines', type: 'relationship', field, value: 'char.wren', evidence: ['¶5'], note: 'Read from the page.' })

async function file(answer: unknown[]): Promise<{ run: string; filed: { id: string }[]; refused: number }> {
  process.env.STUB_ANSWER = JSON.stringify(answer)
  return runUpdateRecord('sc.01-1', undefined, undefined, { rerun: true }) as never
}
const commits = (): number => Number(git(STORY, 'rev-list', '--count', 'HEAD').trim())
const read = (rel: string): string => fs.readFileSync(path.join(STORY, rel), 'utf8')
const attention = async (): Promise<string[]> =>
  ((await (await fetch(`${base}/api/attention`)).json()) as { proposedRecords: { id: string }[] }).proposedRecords.map(r => r.id)
const refusal = (fn: () => unknown): string => {
  try { fn() } catch (e) { assert.ok(e instanceof HttpError); return (e as Error).message }
  assert.fail('expected a refusal')
}
const head = (): string => git(STORY, 'rev-parse', 'HEAD').trim()

test('approve one: status is the only byte that changes, one commit, receipt stamped, row attended', async () => {
  const r = await file([obj('The barometer')])
  const id = r.filed[0].id
  const rel = `canon/entities/objects/${id.slice(id.indexOf('.') + 1)}.yaml`
  const before = read(rel)
  const n = commits()
  const out = decideProposals([id], 'approve')
  assert.equal(commits(), n + 2, 'one decision commit, then the receipts join the record behind it')
  assert.equal(read(rel), before.replace('status: proposed', 'status: canon'))
  assert.match(git(STORY, 'log', '-1', '--format=%s', 'HEAD~1').trim(), /^One fact from scene 1 of Ninety-One Stairs is canon$/)
  assert.doesNotMatch(out.reply, /sc\.01-1/, 'the author reads a chapter and a place in it, never arc\'s scene id')
  assert.match(git(STORY, 'log', '-1', '--format=%s').trim(), /^Record: the receipt for /)
  assert.equal(git(STORY, 'status', '--porcelain', '--', 'history', 'canon', 'docs').trim(), '', 'nothing tracked is left dirty')
  assert.doesNotMatch(git(STORY, 'show', `HEAD:docs/entities/objects/${path.basename(rel, '.yaml')}.md`), /Proposed, not canon/, 'the committed page no longer says it is proposed')
  assert.deepEqual(git(STORY, 'show', '--name-only', '--format=', 'HEAD~1').trim().split('\n').sort(),
    [`docs/entities/objects/${path.basename(rel, '.yaml')}.md`, rel, 'docs/style.evidence.jsonl', `history/${r.run}.yaml`].sort())
  assert.equal(out.decided[0].id, id)
  const d = readProposalDecisions().at(-1)!
  assert.deepEqual([d.id, d.verdict, d.origin, d.class, d.scene, d.run], [id, 'approved', 'author', 'stated', 'sc.01-1', r.run])
  const rec = yamlLoad(git(STORY, 'show', `HEAD:history/${r.run}.yaml`)) as { author_decision: { decision: string }; gates: { gate: string; verdict: string; bar_from?: string }[]; result: { commit: string } }
  assert.match(rec.gates.find(g => g.gate === 'locks')!.bar_from!, /^not checked: locks anchor prose, and no canon record can be locked$/)
  assert.match(d.locks!, /^not checked/)
  assert.equal(rec.author_decision.decision, 'accepted')
  assert.ok(rec.gates.some(g => g.gate === 'locks' && g.verdict === 'not applicable'), 'the lock check is recorded as not applicable')
  assert.equal(rec.result.commit, git(STORY, 'rev-parse', '--short', 'HEAD~1').trim(), 'the receipt names the decision commit, from the record')
  assert.ok(!(await attention()).includes(id))
  assert.ok(validateStory().ok)
  assert.equal(rowStatus(ROW_UPDATE_RECORD_SCENE, readStatusReceipts(), true), 'attended')
  assert.ok(fs.existsSync(path.join(STORY, `docs/entities/objects/${path.basename(rel, '.yaml')}.md`)), 'the article stays')
})

test('approve two: an entity and an edge in one commit; another pending edge is not carried in', async () => {
  const r = await file([obj('The sextant'), edge('friend'), edge('rival')])
  const [o, e1, e2] = r.filed.map(f => f.id)
  assert.equal(r.filed.length, 3)
  const relBefore = read('canon/relationships.yaml')
  const n = commits()
  const out = decideProposals([o, e1], 'approve')
  assert.equal(commits(), n + 2)
  assert.match(git(STORY, 'log', '-1', '--format=%s', 'HEAD~1').trim(), /^Two facts from scene 1 of Ninety-One Stairs are canon$/)
  assert.equal(out.reply, 'Two facts from scene 1 of Ninety-One Stairs are in your record now.')
  const landed = git(STORY, 'show', 'HEAD~1:canon/relationships.yaml')
  assert.ok(landed.includes(e1) && !landed.includes(e2), 'only the approved edge landed')
  assert.equal(read('canon/relationships.yaml'), relBefore.replace(new RegExp(`(id: ${e1}\\n(?:.*\\n)*?\\s+status: )proposed`), '$1canon'),
    'the working file changes the one status line and still holds the other proposal')
  assert.ok((await attention()).includes(e2) && !(await attention()).includes(e1))
  // tidy: decline the other so later tests start clean
  decideProposals([e2], 'never')
})

test('approve changes only the edge status line; never gives back every other byte', async () => {
  const original = read('canon/relationships.yaml')
  const r = await file([edge('mentor')])
  const id = r.filed[0].id
  const filed = read('canon/relationships.yaml')
  assert.ok(filed.startsWith(original) && filed.length > original.length)
  const approved = approveItem(filed, id)!
  const a = filed.split('\n'), b = approved.split('\n')
  assert.equal(a.length, b.length)
  assert.deepEqual(a.map((l, i) => (l === b[i] ? null : [l.trim(), b[i].trim()])).filter(Boolean), [['status: proposed', 'status: canon']])
  const n = commits()
  decideProposals([id], 'never')
  assert.equal(read('canon/relationships.yaml'), original, 'every other byte is as it was before the proposal')
  assert.equal(commits(), n + 2, 'the decision, then its receipt joins the record')
  assert.equal(git(STORY, 'status', '--porcelain', '--', 'canon/relationships.yaml').trim(), '')
  assert.equal(readProposalDecisions().at(-1)!.verdict, 'never')
})

test('never removes a new entity and the article arc wrote, and the duplicate gate then refuses it, even under a fresh id', async () => {
  const r = await file([obj('The lantern hook')])
  const id = r.filed[0].id
  const slug = id.slice(id.indexOf('.') + 1)
  const n = commits()
  decideProposals([id], 'never')
  assert.equal(commits(), n + 2, 'a decision commit and its receipt commit, even though the proposal was never in the book')
  assert.ok(!fs.existsSync(path.join(STORY, `canon/entities/objects/${slug}.yaml`)))
  assert.ok(!fs.existsSync(path.join(STORY, `docs/entities/objects/${slug}.md`)), 'the article arc created goes too')
  const d = readProposalDecisions().at(-1)!
  assert.deepEqual([d.id, d.verdict, d.class], [id, 'never', 'stated'])
  assert.ok(d.key)
  assert.ok(validateStory().ok)
  assert.ok(!(await attention()).includes(id))
  // the same fact, by the same name, again — and the old id is taken, so a new
  // proposal would be minted under a DIFFERENT id: the refusal is by name
  fs.mkdirSync(path.join(STORY, 'canon/entities/objects'), { recursive: true })
  const { takenIds } = await import('../src/records.ts')
  const { buildCandidate } = await import('../src/proposals.ts')
  const occupied = new Set(takenIds()); occupied.add(id)
  const fresh = buildCandidate({ class: 'stated', subject: 'new', type: 'object', field: 'name', value: 'The Lantern Hook', evidence: [] }, { scene: 'sc.01-1', era: null, taken: occupied })
  assert.ok(fresh.ok && fresh.id !== id, 'a fresh id would have been minted')
  const again = await file([obj('The  Lantern Hook')])
  assert.equal(again.filed.length, 0)
  assert.equal(again.refused, 1, 'refused as a duplicate')
  const w = yamlLoad(read(`.arc/runs/${again.run}/receipt.yaml`)) as { gates: { gate: string; verdict: string }[] }
  assert.ok(w.gates.some(g => g.gate === 'duplicate'), 'the receipt names the gate')
})

test('a record proposed before arc kept a record is decidable; its key comes from the record', async () => {
  // the example ships a proposed chapter pair, an object and an edge with no origin
  const ids = await attention()
  assert.ok(ids.includes('ch.01-ninety-one-stairs'))
  const n = commits()
  const out = decideProposals(['ch.01-ninety-one-stairs'], 'approve')
  assert.equal(commits(), n + 1)
  assert.equal(out.decided[0].class, null)
  const d = readProposalDecisions().at(-1)!
  assert.deepEqual([d.class, d.scene, d.run, d.verdict], [null, null, null, 'approved'])
  assert.ok(d.key.length === 16)
  const landed = git(STORY, 'show', 'HEAD:canon/chapters.yaml')
  assert.equal((landed.match(/status: canon/g) ?? []).length, 1)
  assert.equal((landed.match(/status: proposed/g) ?? []).length, 1, 'the other chapter is untouched')
  // and a legacy edge can be declined
  const rel = read('canon/relationships.yaml')
  decideProposals(['rel.ines-log'], 'never')
  assert.ok(!read('canon/relationships.yaml').includes('rel.ines-log'))
  assert.equal(read('canon/relationships.yaml'), removeItem(rel, 'rel.ines-log'))
  assert.ok(validateStory().ok)
})

test('whole requests are refused in one sentence and nothing changes', async () => {
  const r = await file([obj('The brass key'), { class: 'retracted', subject: 'char.wren', type: 'character', field: 'name', value: 'Wren', evidence: ['¶5'], note: 'No longer shown.' }])
  const id = r.filed.find(f => f.id !== 'char.wren')!.id
  const n = commits(), h = head(), status = git(STORY, 'status', '--porcelain')
  const ev = readProposalDecisions().length
  const cases: [unknown, unknown, RegExp][] = [
    [[id, 'obj.nothing-here'], 'approve', /no longer waiting in your record/],
    [['char.ines'], 'approve', /not waiting for your decision/],
    [['char.wren'], 'never', /stays until you edit it yourself/],
    [[id], 'later', /Later is yours to keep in the viewer/],
    [[id], 'forever', /approve a proposal or mark it never/],
    [[], 'approve', /Say which proposals/],
    ['x', 'approve', /Say which proposals/],
  ]
  for (const [ids, action, re] of cases) assert.match(refusal(() => decideProposals(ids, action)), re)
  appendProposalDecision({ id, class: 'stated', key: 'k', scene: 'sc.01-1', run: r.run, verdict: 'approved' })
  assert.match(refusal(() => decideProposals([id], 'approve')), /already decided/)
  fs.writeFileSync(path.join(STORY, 'docs/style.evidence.jsonl'), read('docs/style.evidence.jsonl').split('\n').filter(l => l && !l.includes('"key":"k"')).join('\n') + '\n')
  assert.equal(readProposalDecisions().length, ev)
  assert.equal(commits(), n); assert.equal(head(), h)
  assert.equal(git(STORY, 'status', '--porcelain'), status)
  // through the route: the sentence, as the author's, with a status
  const res = await fetch(`${base}/api/record/proposals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [id], action: 'later' }) })
  assert.equal(res.status, 400)
  const ok = await fetch(`${base}/api/record/proposals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [id], action: 'never' }) })
  assert.equal(ok.status, 200)
})

test('a decision the story would not take refuses the whole batch and puts everything back', async () => {
  // declining an object the rest of the story still names (its article, its scene) leaves a dangling reference
  const status = git(STORY, 'status', '--porcelain'), n = commits()
  const msg = refusal(() => decideProposals(['obj.keepers-log'], 'never'))
  assert.match(msg, /Nothing was changed/)
  assert.equal(commits(), n); assert.equal(git(STORY, 'status', '--porcelain'), status)
  assert.ok(fs.existsSync(path.join(STORY, 'canon/entities/objects/keepers-log.yaml')))
})

// ---- the review's findings -------------------------------------------------------------

test('an item the book holds with a trailing comment is approved in the book, not dropped', () => {
  const rel = 'canon/relationships.yaml'
  fs.writeFileSync(path.join(STORY, rel), read(rel) + '\n  - id: rel.commented  # carried over\n    type: relationship\n    kind: ally\n    status: proposed\n    from: char.ines\n    to: place.whitcombe-light\n    directed: false\n    summary: A legacy edge.\n')
  git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'a legacy proposed edge with a comment')
  decideProposals(['rel.commented'], 'approve')
  const landed = git(STORY, 'show', 'HEAD:canon/relationships.yaml')   // no run, so no receipt commit behind it
  assert.match(landed, /- id: rel\.commented {2}# carried over\n(?:.*\n)*?\s+status: canon/)
})

test('the author\'s uncommitted words in a touched file stay out of the commit and stay in the file', async () => {
  const rel = 'canon/relationships.yaml'
  const r = await file([edge('guardian')])
  const id = r.filed[0].id
  fs.writeFileSync(path.join(STORY, rel), read(rel).replace('Nine years of one voice', 'Ten years of one voice'))
  decideProposals([id], 'approve')
  assert.doesNotMatch(git(STORY, 'show', 'HEAD~1:' + rel), /Ten years/, 'a hand edit is not this decision\'s to commit')
  assert.match(git(STORY, 'show', 'HEAD~1:' + rel), /Nine years/)
  assert.match(git(STORY, 'show', 'HEAD~1:' + rel), new RegExp(`id: ${id}`))
  assert.match(read(rel), /Ten years/, 'and it is still in the working file')
  assert.match(git(STORY, 'diff', '--', rel), /Ten years/)
  git(STORY, 'checkout', '--', rel)
})

test('a second decision on one run commits its own hash on the receipt, read from HEAD', async () => {
  const r = await file([obj('The anemometer'), obj('The rain gauge')])
  const [a, b] = r.filed.map(f => f.id)
  decideProposals([a], 'approve')
  const first = git(STORY, 'rev-parse', '--short', 'HEAD~1').trim()
  assert.equal((yamlLoad(git(STORY, 'show', `HEAD:history/${r.run}.yaml`)) as { result: { commit: string } }).result.commit, first)
  decideProposals([b], 'never')
  const second = git(STORY, 'rev-parse', '--short', 'HEAD~1').trim()
  assert.notEqual(first, second)
  const rec = yamlLoad(git(STORY, 'show', `HEAD:history/${r.run}.yaml`)) as { result: { commit: string }; author_decision: { note: string } }
  assert.equal(rec.result.commit, second)
  assert.equal(git(STORY, 'show', `HEAD~2:history/${r.run}.yaml`).includes(`commit: ${second}`), false)
  assert.match(rec.author_decision.note, /approved .*; never /)
  assert.equal(git(STORY, 'status', '--porcelain', '--', 'history').trim(), '')
})

test('a legacy entity with only arc\'s stub for a page is declined with it; one with its own page is refused up front', () => {
  const stub = (id: string, slug: string, body: string): void => {
    fs.mkdirSync(path.join(STORY, 'docs/entities/objects'), { recursive: true })
    fs.writeFileSync(path.join(STORY, `canon/entities/objects/${slug}.yaml`), `id: ${id}\ntype: object\nname: ${slug}\nstatus: proposed\nsummary: x\nsignificance: y\n`)
    fs.writeFileSync(path.join(STORY, `docs/entities/objects/${slug}.md`), body)
  }
  stub('obj.ghost', 'ghost', '---\ncanon: obj.ghost\n---\n\n# ghost\n\n> **Proposed, not canon.** Read from the prose; not decided.\n\nx\n')
  stub('obj.owned', 'owned', '---\ncanon: obj.owned\n---\n\n# owned\n\nA page the author wrote.\n')
  git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'two legacy entities')
  assert.match(refusal(() => decideProposals(['obj.owned'], 'never')), /still has its own page in the book — remove it first, then decline it\./)
  assert.ok(fs.existsSync(path.join(STORY, 'canon/entities/objects/owned.yaml')))
  decideProposals(['obj.ghost'], 'never')
  assert.ok(!fs.existsSync(path.join(STORY, 'canon/entities/objects/ghost.yaml')) && !fs.existsSync(path.join(STORY, 'docs/entities/objects/ghost.md')))
  assert.equal(git(STORY, 'status', '--porcelain', '--', 'canon', 'docs/entities').trim().split('\n').filter(l => !/owned/.test(l)).join(''), '', 'the deletion was committed')
  assert.ok(validateStory().ok)
})

test('a legacy event is declined once for each person in it', () => {
  fs.mkdirSync(path.join(STORY, 'canon/events/story'), { recursive: true })
  fs.writeFileSync(path.join(STORY, 'canon/events/story/the-supper.yaml'), yamlDump({
    id: 'event.the-supper', type: 'event', scope: 'story', status: 'proposed', title: 'The supper',
    when: { era: 'era.keeping' }, participants: [{ entity: 'char.ines', role: 'host' }, { entity: 'char.wren', role: 'guest' }], summary: 'x', on_page: true,
  }))
  const before = readProposalDecisions().length
  decideProposals(['event.the-supper'], 'never')
  const mine = readProposalDecisions().slice(before)
  assert.equal(mine.length, 2)
  const want = ['char.ines', 'char.wren'].map(e => proposalKey({ subject: e, type: 'event', field: 'event', value: 'The supper' })).sort()
  assert.deepEqual(mine.map(d => d.key).sort(), want)
  assert.ok(mine.every(d => d.verdict === 'never' && d.id === 'event.the-supper'))
})

test('an edge is not canon before what it is about: alone it is refused, together both land and the book validates', async () => {
  const { dump } = await import('js-yaml')
  const rel = 'canon/relationships.yaml'
  void dump
  const ent = (await file([obj('The ledger box')])).filed[0].id
  const e = (await file([{ class: 'implied', subject: 'char.ines', type: 'relationship', field: 'friend', value: ent, evidence: ['¶5'], note: 'Read from the page.' }])).filed[0].id
  const n = commits(), h = head(), status = git(STORY, 'status', '--porcelain')
  assert.match(refusal(() => decideProposals([e], 'approve')), /^Approve The ledger box first, or together with this — it is what this fact is about\.$/)
  assert.equal(commits(), n); assert.equal(head(), h); assert.equal(git(STORY, 'status', '--porcelain'), status)
  decideProposals([e, ent], 'approve')
  const book = git(STORY, 'show', `HEAD~1:${rel}`)
  assert.match(book, new RegExp(`id: ${e}\\n(?:.*\\n)*?\\s+status: canon`))
  assert.match(git(STORY, 'show', 'HEAD~1:canon/entities/objects/the-ledger-box.yaml'), /status: canon/)
  // the book as HEAD holds it validates
  const out = fs.mkdtempSync(path.join(path.dirname(STORY), 'head-'))
  for (const f of git(STORY, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').filter(Boolean)) {
    fs.mkdirSync(path.dirname(path.join(out, f)), { recursive: true })
    fs.writeFileSync(path.join(out, f), git(STORY, 'show', `HEAD:${f}`))
  }
  const py = path.resolve(process.env.ARC_CORE_PATH ?? '../arc-core', '.venv/bin/python'), tool = path.resolve(process.env.ARC_CORE_PATH ?? '../arc-core', 'tools/validate.py')
  const { execFileSync } = await import('node:child_process')
  assert.match(execFileSync(py, [tool, out], { encoding: 'utf8' }), /^OK/m)
  fs.rmSync(out, { recursive: true, force: true })
})

test('a conflict is decided on its own: a batch holding one is refused 409 in the author\'s words; the one alone approves', async () => {
  const filed = await file([obj('Wren'), obj('The brass astrolabe')])   // Wren is already a person: arc proves the clash
  const ids = filed.filed.map(f => f.id)
  assert.equal(ids.length, 2, JSON.stringify(filed))
  const was = head()
  const said = refusal(() => decideProposals(ids, 'approve'))
  assert.match(said, /^Wren has a conflict arc found — decide it on its own\.$/)
  assert.equal(head(), was, 'nothing changed')
  const conflicted = ids.find(id => id.includes('wren'))!
  assert.doesNotThrow(() => decideProposals([conflicted], 'approve'))
  assert.notEqual(head(), was, 'the one alone is approved')
})
