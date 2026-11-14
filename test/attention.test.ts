// GET /api/attention serves proposals FLAT, with their origin (A74-2): class,
// scene, run and the sentence each cited paragraph now holds — rendered by
// code. A record proposed before arc kept a record is served with class null.
// (Its own file: it needs the example story, whose canon exports; the minimal
// one test/server.test.ts uses does not.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { dump as stringify } from 'js-yaml'
import { git, makeExampleStory } from './fixture.ts'

const STORY = makeExampleStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

const { createArcServer } = await import('../src/server.ts')
const { buildCandidate } = await import('../src/proposals.ts')
const { recordProposalOrigin } = await import('../src/ledger.ts')
const { proseScenes } = await import('../src/story.ts')

const server = createArcServer()
await new Promise<void>(resolve => server.listen(0, resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
test.after(() => server.close())

const scene = proseScenes()[0]
const HEAD = (): string => git(STORY, 'rev-parse', 'HEAD').trim()

/** File a proposal the way the pass does: record first, canon file last — or
 *  with no record at all (`legacy`). */
function file(name: string, o: { legacy?: boolean; evidence?: string[]; skipFile?: boolean; proven?: string; argued?: string; type?: string; kind?: string } = {}): string {
  const c = buildCandidate(
    { class: 'stated', subject: 'new', type: o.type ?? 'object', field: 'name', value: name, evidence: [], note: `${name}.`, ...(o.kind ? { kind: o.kind } : {}) },
    { scene: scene.scene, era: 'era.keeping', taken: new Set() },
  )
  assert.ok(c.ok)
  if (!o.legacy) {
    recordProposalOrigin({
      origin: 'update-record', file: c.file, scene: scene.scene, run: 'run.0042', canon: c.id, type: o.type ?? 'object',
      class: 'stated', key: 'k-' + c.id, range: { from: HEAD(), to: HEAD() }, evidence: o.evidence ?? [],
      ...(o.proven ? { proven_conflict: o.proven } : {}), ...(o.argued ? { argued_conflict: o.argued } : {}),
    })
  }
  if (!o.skipFile) {
    fs.mkdirSync(path.dirname(path.join(STORY, c.file)), { recursive: true })
    fs.writeFileSync(path.join(STORY, c.file), stringify(c.record))
    fs.mkdirSync(path.dirname(path.join(STORY, c.article.file)), { recursive: true })
    fs.writeFileSync(path.join(STORY, c.article.file), c.article.text)
  }
  return c.id
}

type Item = { id: string; type: string; class: string | null; scene: string | null; run: string | null; cites: { paragraph: string; passage: string; sentence: string }[]; since: string | null; summary: string; kind: string | null; conflict: { register: 'proven' | 'argued'; text: string } | null }
const items = async (): Promise<Item[]> => (await (await fetch(`${base}/api/attention`)).json() as { proposedRecords: Item[] }).proposedRecords

const paras = (body: string): string[] => body.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
const SCENE_ABS = path.join(STORY, scene.file)

test('a proposal is served flat with its origin and the passage its paragraph holds in the book', async () => {
  const first = paras(scene.body)[0]
  const named = first.split(/\s+/).slice(0, 2).join(' ')   // a name the first sentence says
  const id = file(named, { evidence: ['¶1', '¶99', '-¶1'] })
  const it = (await items()).find(i => i.id === id)!
  assert.equal(it.type, 'entity')
  assert.equal(it.class, 'stated')
  assert.equal(it.scene, scene.scene)
  assert.equal(it.run, 'run.0042')
  assert.ok(it.since)
  assert.deepEqual(it.cites.map(c => c.paragraph), ['¶1', '¶99', '-¶1'])
  assert.equal(it.cites[0].passage, first, 'the whole paragraph, rendered by code')
  assert.ok(it.cites[0].sentence.toLowerCase().includes(named.toLowerCase()), 'the sentence that says the name')
  assert.deepEqual([it.cites[1].passage, it.cites[1].sentence], ['', ''], 'a paragraph the scene does not have reads empty')
  assert.deepEqual([it.cites[2].passage, it.cites[2].sentence], ['', ''], 'a removed paragraph is not in the book')
})

test('a pending draft on the scene changes nothing the cite shows', async () => {
  const id = file('The draft probe', { evidence: ['¶1'] })
  const before = (await items()).find(i => i.id === id)!.cites[0]
  assert.ok(before.passage)
  const original = fs.readFileSync(SCENE_ABS, 'utf8')
  fs.writeFileSync(SCENE_ABS, original.replace(before.passage.slice(0, 12), 'A rewritten opening'))   // uncommitted
  try {
    assert.deepEqual((await items()).find(i => i.id === id)!.cites[0], before)
  } finally { fs.writeFileSync(SCENE_ABS, original) }
})

test('a paragraph inserted above the cited one, committed, empties the cite rather than reattaching by index', async () => {
  const id = file('The insert probe', { evidence: ['¶1'] })
  assert.ok((await items()).find(i => i.id === id)!.cites[0].passage)
  const original = fs.readFileSync(SCENE_ABS, 'utf8')
  const bodyStart = original.indexOf(scene.body.trim().slice(0, 20))
  fs.writeFileSync(SCENE_ABS, original.slice(0, bodyStart) + 'A new first paragraph the author wrote.\n\n' + original.slice(bodyStart))
  git(STORY, 'add', '-A'); git(STORY, 'commit', '-qm', 'prose: a paragraph above')
  const c = (await items()).find(i => i.id === id)!.cites[0]
  assert.deepEqual([c.passage, c.sentence], ['', ''])
})

test('a record proposed before arc kept a record is served with class null', async () => {
  const id = file('The old compass', { legacy: true })
  const it = (await items()).find(i => i.id === id)!
  assert.deepEqual({ class: it.class, scene: it.scene, run: it.run, since: it.since, cites: it.cites },
    { class: null, scene: null, run: null, since: null, cites: [] })
})

test('the response carries the unread list, the briefing\'s own: history made before the lane marked its accepts is not unread', async () => {
  const body = await (await fetch(`${base}/api/attention`)).json() as { unread: unknown[]; proposals: number }
  assert.deepEqual(body.unread, [], 'the story\'s commits carry no Arc-Lane trailer: nothing arc was asked to read')
  const briefing = await (await fetch(`${base}/api/briefing`)).json() as { unread: unknown[] }
  assert.deepEqual(briefing.unread, body.unread, 'one function behind both')
  assert.equal(body.proposals, (await items()).length)
})

test('a proposed record whose file was deleted is no longer listed', async () => {
  const id = file('The ghost lamp')
  assert.ok((await items()).some(i => i.id === id))
  const c = fs.readdirSync(path.join(STORY, 'canon/entities/objects')).find(f => f.includes('ghost'))!
  fs.rmSync(path.join(STORY, 'canon/entities/objects', c))
  fs.rmSync(path.join(STORY, 'docs/entities/objects', c.replace('.yaml', '.md')))
  assert.ok(!(await items()).some(i => i.id === id))
})

test('a proposal about a record that exists says which one (A74-12); a new person has no "about"', async () => {
  const c = buildCandidate(
    { class: 'stated', subject: 'char.ines', type: 'event', field: 'event', value: 'Ines climbs again', evidence: [], with: ['char.wren'] },
    { scene: scene.scene, era: 'era.keeping', taken: new Set(), entities: [{ id: 'char.ines', type: 'character' }, { id: 'char.wren', type: 'character' }], sceneSpan: { start: '1910-11', end: '1910-11' } },
  )
  assert.ok(c.ok)
  recordProposalOrigin({
    origin: 'update-record', file: c.file, scene: scene.scene, run: 'run.0043', canon: c.id, type: 'event', about: 'char.ines', beside: 'rel.ines-wren',
    class: 'stated', key: 'k-' + c.id, range: { from: HEAD(), to: HEAD() }, evidence: [],
  })
  fs.writeFileSync(path.join(STORY, c.file), stringify(c.record))
  type WithAbout = Item & { about: { id: string; name: string | null; type: string | null; beside: string | null; others: { id: string; name: string | null }[] } | null }
  const probe = file('The about probe')
  const all = await items() as WithAbout[]
  assert.deepEqual(all.find(i => i.id === c.id)!.about, { id: 'char.ines', name: 'Ines Vargas', type: 'character', beside: 'rel.ines-wren', others: [{ id: 'char.wren', name: 'Wren' }] })
  assert.equal(all.find(i => i.id === c.id)!.type, 'event')
  assert.equal(all.find(i => i.id === probe)!.about, null)
})

test('the approval contract: each item carries the summary as filed, its kind, and its conflict in names, never ids (proven wins over argued); a legacy item has no conflict', async () => {
  const plain = file('The plain probe')
  const proven = file('The proven probe', { proven: 'obj.keepers-log held by char.ines (from 1910) and char.wren over overlapping periods with no transfer recorded', argued: 'obj.keepers-log' })
  const argued = file('The argued probe', { argued: 'obj.keepers-log' })
  const legacy = file('The legacy probe', { legacy: true })
  const place = file('The kind probe', { type: 'place', kind: 'building' })
  const person = file('The species probe', { type: 'character', kind: 'human' })
  const all = await items()
  const get = (id: string): Item => all.find(i => i.id === id)!
  assert.equal(get(plain).summary, 'The plain probe.', 'the summary as it stands in the file')
  assert.equal(get(plain).conflict, null)
  assert.equal(get(plain).kind, null, 'an object has no kind')
  assert.equal(get(place).kind, 'building', 'a place carries its kind')
  assert.equal(get(person).kind, 'human', 'a character carries its species')
  assert.deepEqual(get(proven).conflict, { register: 'proven', text: 'The Whitcombe light log held by Ines Vargas (from 1910) and Wren over overlapping periods with no transfer recorded' })
  assert.deepEqual(get(argued).conflict, { register: 'argued', text: 'The Whitcombe light log' })
  for (const i of [proven, argued]) assert.doesNotMatch(get(i).conflict!.text, /\b[a-z]{2,8}\.[a-z]/, 'no dotted id reaches the author')
  assert.equal(get(legacy).summary, 'The legacy probe.')
  assert.equal(get(legacy).conflict, null)
})

test('conflictForAuthor names events, edges and chapters, and says the kind for an id the book does not hold', async () => {
  const { conflictForAuthor } = await import('../src/attention.ts')
  const doc = { entities: { 'char.a': { name: 'Ada' }, 'char.b': { name: 'Bo' } }, events: { 'event.x': { title: 'The wreck' } }, relationships: [{ id: 'rel.ab', from: 'char.a', to: 'char.b' }], chapters: [{ id: 'ch.01-one', title: 'One' }] } as never
  assert.equal(conflictForAuthor('event.x, rel.ab, ch.01-one, char.ghost and obj.ghost-log, 1910-11.', doc), 'The wreck, Ada and Bo, One, a character and an object, 1910-11.')
})
