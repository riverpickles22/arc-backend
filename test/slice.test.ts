// The context assembler (A69-2): the layers, the statuses, the floor and the
// ceiling. Runs against the worked example, with no key and no engine — the
// assembler consults no model, which is the point of assembling before you
// launch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { copyExampleStory, git } from './fixture.ts'

const STORY = copyExampleStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_AUTHOR_STYLE = path.join(STORY, 'no-author-layer.md')

const { assembleWritingSlice, WRITING_LAYERS } = await import('../src/slice.ts')
const { WRITING_SLICE, ROW_EXPLORE_SCENE } = await import('../src/registry.ts')
const { proseScenes } = await import('../src/story.ts')
const { HttpError } = await import('../src/http.ts')

const SCENE = 'sc.01-1'
const scene = () => proseScenes().find(s => s.scene === SCENE)!

/** A writing row, as A69-3 will declare one. The assembler takes the row, so
 *  the test builds the smallest honest one rather than reaching for a row
 *  that does not exist yet. */
const rowWith = (inputTokens?: number) => ({
  ...ROW_EXPLORE_SCENE,
  job: 'draft' as const, scope: 'scene' as const,
  withholding: false, withheld: undefined,
  slice: WRITING_SLICE,
  budget: { ...ROW_EXPLORE_SCENE.budget, inputTokens },
})

/** A writing row that must work WITHOUT the scene — the only kind whose
 *  contract is abbreviated, because a rule quoting the scene hands such a
 *  pass the thing it is meant to find another way to. */
const withholdingRow = (inputTokens = 40_000) => ({
  ...rowWith(inputTokens),
  withholding: true as const,
  withheld: ROW_EXPLORE_SCENE.withheld,
})

const subject = () => ({ chapter: scene().chapter, scene: scene() })

test('every layer of §4 is on the manifest, with a status and never "missing"', () => {
  const s = assembleWritingSlice(rowWith(40_000), subject())
  assert.deepEqual(s.manifest.map(l => l.layer), [...WRITING_LAYERS],
    'all twelve, in the order a brief carries them')
  for (const l of s.manifest) {
    assert.ok(['given', 'not shown', 'deferred', 'none'].includes(l.status), `${l.layer}: ${l.status}`)
    if (l.status !== 'given') {
      assert.ok(l.because && l.because.length > 3, `${l.layer} says why it is not given`)
    }
  }
  assert.ok(!JSON.stringify(s.manifest).includes('missing'), 'nothing reads "missing"')
})

test('a block carries its ids and the reason it is here, and the brief is what the blocks render', () => {
  const s = assembleWritingSlice(rowWith(40_000), subject())
  for (const b of s.blocks) {
    assert.equal(b.status, 'given')
    assert.ok(b.reason.trim(), `${b.layer} says why it is in the brief`)
    assert.ok(b.text.trim(), `${b.layer} has text`)
  }
  const contract = s.blocks.find(b => b.layer === 'contract')!
  assert.deepEqual(contract.ids, [SCENE])
  const canon = s.blocks.find(b => b.layer === 'canon')!
  assert.ok(canon.text.includes('included:'), 'the canon layer carries the pack\'s inclusion reasons')
  const brief = s.render()
  for (const b of s.blocks) assert.ok(brief.includes(b.text), `${b.layer} is in the rendered brief`)
})

test('research is deferred on every writing brief, and says so in the author\'s words', () => {
  const s = assembleWritingSlice(rowWith(40_000), subject())
  const research = s.manifest.find(l => l.layer === 'research')!
  assert.equal(research.status, 'deferred')
  assert.match(research.because!, /research is not read yet/)
})

test('the reader-effect fields reach the craft plan and never the write stage', () => {
  const write = assembleWritingSlice(rowWith(40_000), subject(), { stage: 'write' })
  const plan = assembleWritingSlice(rowWith(40_000), subject(), { stage: 'craft-plan' })
  const of = (s: { blocks: { layer: string; text: string }[] }) =>
    s.blocks.find(b => b.layer === 'contract')!.text
  assert.ok(!of(write).includes('reader_after'), 'the write stage is not told what the reader should feel')
  assert.ok(of(plan).includes('reader_after'), 'the craft plan is, because translating it is its whole job')
  assert.ok(of(write).includes('must_establish'), 'and it still gets what the scene must do')
})

test('a note arc wrote never reaches a writing pass; the author\'s do', async () => {
  const dir = path.join(STORY, 'annotations')
  const mine = path.join(dir, 'note-900.yaml')
  const theirs = path.join(dir, 'note-901.yaml')
  fs.writeFileSync(mine, `id: note.900\nby: agent\nstatus: open\nanchor:\n  scene: ${SCENE}\nbody: arc thinks the stair should come earlier\n`)
  fs.writeFileSync(theirs, `id: note.901\nby: author\nstatus: open\nanchor:\n  scene: ${SCENE}\nbody: the dog should be at the landing sooner\n`)
  try {
    const s = assembleWritingSlice(rowWith(40_000), subject())
    const notes = s.manifest.find(l => l.layer === 'notes')!
    assert.deepEqual(notes.ids, ['note.901'], 'only the author\'s note')
    const text = s.render()
    assert.ok(text.includes('the dog should be at the landing sooner'))
    assert.ok(!text.includes('arc thinks the stair should come earlier'),
      'an agent note handed back as an instruction is a model\'s guess becoming the author\'s brief')
  } finally {
    fs.rmSync(mine, { force: true }); fs.rmSync(theirs, { force: true })
  }
})

test('the contract is rendered abbreviated, never edited, and the manifest says by how much', () => {
  const file = path.join(STORY, 'docs', 'style.md')
  const before = fs.readFileSync(file, 'utf8')
  const quoted = scene().body.split('\n\n')[0].split(' ').slice(0, 14).join(' ')
  fs.writeFileSync(file, `${before}\n\n## Rhythm\n\nKeep the long sentence moving: "${quoted}"\n`)
  try {
    const s = assembleWritingSlice(withholdingRow(), subject())
    const rules = s.manifest.find(l => l.layer === 'promoted-rules')!
    assert.equal(rules.status, 'given')
    assert.match(rules.note ?? '', /abbreviated: \d+ passages? of the contract quote this scene/)
    assert.match(rules.note ?? '', /your contract is unchanged/)
    const text = s.blocks.find(b => b.layer === 'promoted-rules')!.text
    assert.ok(!text.includes(quoted), 'the quoted passage is out of the RENDERING')
    assert.ok(text.includes('Rhythm'), 'and the rule it sat in is still a rule')
    assert.equal(fs.readFileSync(file, 'utf8'), `${before}\n\n## Rhythm\n\nKeep the long sentence moving: "${quoted}"\n`,
      'the ratified file on disk is untouched — this is a projection, not an edit')
  } finally {
    fs.writeFileSync(file, before)
  }
})

test('a pass that is given the scene reads the contract whole — nothing is abbreviated for it', () => {
  const file = path.join(STORY, 'docs', 'style.md')
  const before = fs.readFileSync(file, 'utf8')
  const quoted = scene().body.split('\n\n')[0].split(' ').slice(0, 14).join(' ')
  fs.writeFileSync(file, `${before}\n\n## Rhythm\n\nKeep the long sentence moving: "${quoted}"\n`)
  try {
    const s = assembleWritingSlice(rowWith(40_000), subject())
    const rules = s.manifest.find(l => l.layer === 'promoted-rules')!
    assert.equal(rules.note, undefined, 'nothing was left out, so nothing is claimed')
    assert.ok(s.blocks.find(b => b.layer === 'promoted-rules')!.text.includes(quoted),
      'a row handed the scene loses nothing by reading the rule that quotes it')
  } finally {
    fs.writeFileSync(file, before)
  }
})

test('a draft has no scene, and that is not a story without a contract or notes', () => {
  const s = assembleWritingSlice(rowWith(40_000), { chapter: scene().chapter, sceneId: 'sc.01-2' })
  const rules = s.manifest.find(l => l.layer === 'promoted-rules')!
  assert.equal(rules.status, 'given', 'the ratified contract is there — there is simply no prose to abbreviate')
  assert.ok(s.render().includes('THE AUTHOR\'S STYLE CONTRACT'))
  const contract = s.manifest.find(l => l.layer === 'contract')!
  assert.equal(contract.status, 'none')
  assert.match(contract.because!, /has not been written yet/)
  const locks = s.manifest.find(l => l.layer === 'locks')!
  assert.equal(locks.status, 'none')
})

test('a layer arc cannot build yet is deferred, never none — none means there is nothing', () => {
  const s = assembleWritingSlice(rowWith(40_000), subject())
  const by = (l: string) => s.manifest.find(m => m.layer === l)!
  for (const layer of ['research']) {
    assert.equal(by(layer).status, 'deferred',
      `${layer}: arc does not read this yet, and saying "none" would tell the author the book is empty here`)
  }
  // `position` and `voice` are built now (A69-7).
  assert.equal(by('position').status, 'given')
  assert.equal(by('voice').status, 'given')
  // `dramatic-condition` is built now (A69-6): the example's keeper has
  // stances on record and the story owes one obligation in this chapter.
  assert.equal(by('dramatic-condition').status, 'given')
  // `handoff` is built now (A69-5) and this scene is the first of the book,
  // so it is honestly `none` — see the test below that proves the difference.
  assert.equal(by('handoff').status, 'none')

  // `intent` is built now (A69-4): with no line said there is honestly
  // nothing to translate, which is `none` and not `deferred`.
  assert.equal(by('intent').status, 'none')
  assert.match(by('intent').because!, /nothing to translate/)

  // The example's scene has a locked paragraph, so the lock notice is built
  // and given — the layer §4's floor sentence names and the table omits.
  assert.equal(by('locks').status, 'given')
  assert.ok(s.render().includes('LOCKED PARAGRAPHS'))

  // And `none` still means what it says: a scene arc has not written has no
  // contract of its own, and nothing is pretending otherwise.
  const draft = assembleWritingSlice(rowWith(40_000), { chapter: scene().chapter, sceneId: 'sc.01-2' })
  assert.equal(draft.manifest.find(l => l.layer === 'contract')!.status, 'none')
})

test('the budget is a ceiling: a small slice stays small, and nothing pads it', () => {
  const s = assembleWritingSlice(rowWith(40_000), subject())
  assert.ok(s.estimate < 40_000, 'the example fits with room to spare')
  assert.ok(s.estimate > 0)
  const roomier = assembleWritingSlice(rowWith(400_000), subject())
  assert.equal(roomier.estimate, s.estimate, 'a bigger allowance does not make a bigger brief')
  assert.deepEqual(roomier.manifest, s.manifest)
})

test('when it does not fit, layers drop in the row\'s order and read "not shown", never "missing"', () => {
  const full = assembleWritingSlice(rowWith(40_000), subject())
  const canon = full.manifest.find(l => l.layer === 'canon')!
  assert.equal(canon.status, 'given')
  // Tight enough that the droppable layers have to go, loose enough that the
  // floor still fits.
  const floorOnly = full.blocks.filter(b => ['contract', 'withholds', 'canon'].includes(b.layer))
    .reduce((n, b) => n + Math.ceil((`=== X ===\n${b.text}`).length / 4), 0)
  const tight = assembleWritingSlice(rowWith(floorOnly + 200), subject())
  const notShown = tight.manifest.filter(l => l.status === 'not shown')
  assert.ok(notShown.length, 'something dropped')
  for (const l of notShown) assert.equal(l.because, 'room ran out')
  for (const l of tight.manifest) {
    if (['contract', 'withholds', 'canon'].includes(l.layer) && canonGiven(full, l.layer)) {
      assert.notEqual(l.status, 'not shown', `${l.layer} is floor and never drops`)
    }
  }
})

test('layers drop in the row\'s order, and the style contract is the last to go', () => {
  // Shrink the allowance step by step and record what is gone at each size.
  // The set of dropped layers must grow as a PREFIX of the row's drop order —
  // which is what "the order is the row's" means, and what comparing a set
  // with a copy of itself cannot show.
  const full = assembleWritingSlice(rowWith(400_000), subject())
  const givenLayers = new Set(full.blocks.map(b => b.layer))
  const droppableGiven = WRITING_SLICE.dropOrder.filter(l => givenLayers.has(l as never))
  assert.ok(droppableGiven.length >= 2, 'the example gives at least two droppable layers to order')

  let previous = 0
  for (let budget = full.estimate; budget > 0; budget -= Math.ceil(full.estimate / 12)) {
    let s
    try { s = assembleWritingSlice(rowWith(budget), subject()) } catch { break }
    const gone = s.manifest.filter(l => l.status === 'not shown').map(l => l.layer)
    // As sets: the manifest lists layers in the order a brief carries them,
    // the drop order is the row's, and the claim is about membership.
    assert.deepEqual([...gone].sort(), droppableGiven.slice(0, gone.length).sort(),
      `at ${budget} the layers gone are the first ${gone.length} of the row's order, not an arbitrary set`)
    assert.ok(gone.length >= previous, 'a tighter allowance never drops fewer')
    previous = gone.length
  }
  assert.ok(previous > 0, 'the allowance got tight enough for something to drop')

  // The contract is last in the order, so it is the last thing lost.
  const tightest = droppableGiven[droppableGiven.length - 1]
  assert.equal(tightest, 'promoted-rules',
    'a draft in the wrong voice is work the author undoes, so the voice goes last')
})

const canonGiven = (s: { manifest: { layer: string; status: string }[] }, layer: string) =>
  s.manifest.find(l => l.layer === layer)!.status === 'given'

test('a floor that will not fit refuses before a token is spent, in the author\'s words', () => {
  assert.throws(
    () => assembleWritingSlice(rowWith(50), subject()),
    (e: unknown) => {
      assert.ok(e instanceof HttpError && e.status === 400)
      assert.match(e.message, /does not fit in one pass/)
      assert.match(e.message, /sc\.01-1/)
      assert.match(e.message, /ask again/, 'it ends in what the author does next')
      assert.ok(!/token|budget|slice|layer/i.test(e.message.replace(/allowance/g, '')),
        'and says it without arc\'s vocabulary')
      return true
    })
})

test('a row with no input ceiling cannot assemble a brief at all', () => {
  assert.throws(() => assembleWritingSlice(rowWith(undefined), subject()),
    /carries no input budget/)
})

test('the manifest survives into a record receipt, names and ids only', async () => {
  const { toRecordReceipt, emptyReceipt } = await import('../src/run.ts')
  const s = assembleWritingSlice(rowWith(40_000), subject())
  // Only the run's own header is read to open a receipt; nothing below
  // touches the run again.
  const receipt = emptyReceipt({
    id: 'run.9999',
    root: { source: 'ui', raw_author_input: 'draft the next scene', started_at: new Date().toISOString(), story_revision: 'abc1234' },
  } as unknown as Parameters<typeof emptyReceipt>[0])
  receipt.slice = {
    ...s.forReceipt(),
    withheld_by_design: [],
    runtime_added: [],
  }
  const record = toRecordReceipt(receipt)
  assert.deepEqual(record.slice!.layers!.map(l => l.layer), [...WRITING_LAYERS],
    'every layer is still named in the committed record')
  assert.deepEqual(record.slice!.included, s.blocks.map(b => b.layer))
  const canon = record.slice!.layers!.find(l => l.layer === 'canon')!
  assert.ok(canon.ids.includes('char.ines'), 'and carries the ids it was built from')
  assert.ok(!JSON.stringify(record.slice).includes(scene().body.slice(0, 40)), 'and no prose')
})

test('the receipt shape is the manifest: given and not shown by layer, with the reading behind them', () => {
  const s = assembleWritingSlice(rowWith(40_000), subject())
  const r = s.forReceipt()
  assert.deepEqual(r.included, s.blocks.map(b => b.layer))
  assert.deepEqual(r.layers.map(l => l.layer), [...WRITING_LAYERS])
  assert.equal(r.dropped_for_budget.length, 0)
  const text = JSON.stringify(r)
  assert.ok(!text.includes(scene().body.split('\n\n')[0].slice(0, 40)),
    'names and ids only — no prose goes into a receipt')
})

// ---- the handoff (A69-5) ---------------------------------------------------

test('the handoff reads the previous scene back: what the reader has, what moved, what is owing', async () => {
  const { previousScene } = await import('../src/slice.ts')
  const s = assembleWritingSlice(rowWith(40_000), { chapter: scene().chapter, sceneId: 'sc.01-2' })
  const handoff = s.manifest.find(l => l.layer === 'handoff')!
  assert.equal(handoff.status, 'given')
  assert.deepEqual(handoff.ids, [SCENE], 'and the receipt names the scene it came from')

  const text = s.blocks.find(b => b.layer === 'handoff')!.text
  assert.match(text, /It follows sc\.01-1/)
  assert.match(text, /WHAT THE READER NOW HAS/)
  assert.match(text, /eighty-fourth stair/, 'its reader_after, verbatim')
  assert.match(text, /WHAT IT MOVED/)
  assert.match(text, /WHAT IT LEFT OWING/, 'the example ships an open obligation on this scene')
  assert.match(text, /mat\.light-must-nearly-fail/)

  // Book order, not file order.
  const canon = JSON.parse((await import('../src/canon.ts')).canonJson())
  const { proseScenes: all } = await import('../src/story.ts')
  assert.equal(previousScene(canon, { chapter: 'ch.02-the-aurelia', sceneId: 'sc.02-1' }, all())?.scene, SCENE,
    'across a chapter boundary it is the last scene of the chapter before')
  assert.equal(previousScene(canon, { chapter: scene().chapter, sceneId: 'sc.01-1' }, all()), null,
    'and the first scene of the book has none')
})

test('the first scene of the book reads `none`, with the reason — never `not shown`', () => {
  const s = assembleWritingSlice(rowWith(40_000), { chapter: scene().chapter, scene: scene() })
  const handoff = s.manifest.find(l => l.layer === 'handoff')!
  assert.equal(handoff.status, 'none')
  assert.match(handoff.because!, /the first scene of the book/)
})

test('a handoff that follows a scene still proposed says so — accepted, and not yet a fact', () => {
  const s = assembleWritingSlice(rowWith(40_000), { chapter: scene().chapter, sceneId: 'sc.01-2' })
  // The example's scene ships `status: proposed` and is committed: in the
  // book, not promoted. Promotion is the author's act, never the accept's
  // side effect (conventions §4), so this is not "not accepted".
  const text = s.blocks.find(b => b.layer === 'handoff')!.text
  assert.match(text, /FOLLOWS A SCENE STILL PROPOSED/)
  assert.ok(!text.includes('NOT YET ACCEPTED'))
  assert.match(s.manifest.find(l => l.layer === 'handoff')!.note!, /accepted and not yet promoted/)
})

test('a span the record spells as a bare date or year still reads as a span', async () => {
  const { parseScene } = await import('../src/story.ts')
  // YAML hands an unquoted day date over as a Date and a bare year as a
  // number; the record's own spelling is what the diff reads.
  const s = parseScene('---\nscene: sc.09-1\nchapter: ch.09\nspan: { start: 1910-11-03, end: 1911 }\n---\nbody\n', 'f.md')!
  assert.deepEqual(s.span, { start: '1910-11-03', end: '1911' })
})

test('what it moved is read from the record: a span that crosses a state change names the change', () => {
  const file = path.join(STORY, scene().file)
  const original = fs.readFileSync(file, 'utf8')
  const oneMonth = 'span: { start: "1910-11", end: "1910-11" }'
  assert.ok(original.includes(oneMonth), 'the example scene states its span')
  try {
    // The example's scene covers one month and Ines's two states sit a year
    // apart, so over it nothing honestly moved. Stretched over her second
    // state, the handoff has to say what changed — by name, never a count.
    fs.writeFileSync(file, original.replace(oneMonth, 'span: { start: "1910-11", end: "1911-02" }'))
    const s = assembleWritingSlice(rowWith(40_000), { chapter: scene().chapter, sceneId: 'sc.01-2' })
    const text = s.blocks.find(b => b.layer === 'handoff')!.text
    assert.match(text, /WHAT IT MOVED\nchar\.ines\n/)
    assert.match(text, /age: 36 → 37/)
    assert.match(text, /condition: /)
    assert.ok(!text.includes('nothing the record has caught up with yet'))
  } finally {
    fs.writeFileSync(file, original)
  }
})

test('an obligation the record marks absorbed, or satisfied, is not owing — whoever it touches', () => {
  const dir = path.join(STORY, 'material')
  const absorbed = path.join(dir, 'mat-test-absorbed.yaml')
  const satisfied = path.join(dir, 'mat-test-satisfied.yaml')
  fs.writeFileSync(absorbed, ['id: mat.test-absorbed', 'type: obligation', 'status: absorbed',
    'body: the dog must be seen to age', 'related: [char.ines]'].join('\n') + '\n')
  fs.writeFileSync(satisfied, ['id: mat.test-satisfied', 'type: obligation', 'status: unplaced',
    'body: the stair must be counted once', 'related: [char.ines]', 'satisfied_by: [sc.01-1]'].join('\n') + '\n')
  const unwritten = path.join(dir, 'mat-test-unwritten.yaml')
  fs.writeFileSync(unwritten, ['id: mat.test-unwritten', 'type: obligation', 'status: placed',
    'body: the burn must be seen to heal', 'related: [char.ines]', 'satisfied_by: [sc.05-1]'].join('\n') + '\n')
  try {
    const s = assembleWritingSlice(rowWith(40_000), { chapter: scene().chapter, sceneId: 'sc.01-2' })
    const text = s.blocks.find(b => b.layer === 'handoff')!.text
    assert.match(text, /open mat\.light-must-nearly-fail/, 'the live one is owing')
    assert.ok(!text.includes('mat.test-absorbed'), 'a paid debt is not handed to the pass')
    assert.ok(!text.includes('mat.test-satisfied'), 'nor one a written scene satisfies')
    assert.match(text, /open mat\.test-unwritten/, 'but one claimed by a scene that does not exist is still owed — only prose discharges')
  } finally {
    fs.rmSync(absorbed, { force: true })
    fs.rmSync(satisfied, { force: true })
    fs.rmSync(unwritten, { force: true })
  }
})

test('a chapter the canon does not list is never mistaken for the start of the book', async () => {
  const { previousScene } = await import('../src/slice.ts')
  const canon = JSON.parse((await import('../src/canon.ts')).canonJson())
  assert.equal(previousScene(canon, { chapter: 'ch.09-unlisted', sceneId: 'sc.09-1' }, proseScenes())?.scene, SCENE,
    'it ranks by the number in its id, so the scene before it is still found')
})

test('a handoff that follows text the author has not accepted says so, whatever the frontmatter says', () => {
  const file = path.join(STORY, scene().file)
  const original = fs.readFileSync(file, 'utf8')
  const head = git(STORY, 'rev-parse', 'HEAD').trim()
  const handoff = () => assembleWritingSlice(rowWith(40_000), { chapter: scene().chapter, sceneId: 'sc.01-2' })
    .blocks.find(b => b.layer === 'handoff')!.text
  try {
    // Accepted and promoted: canon in the frontmatter, byte-equal to HEAD.
    fs.writeFileSync(file, original.replace('status: proposed', 'status: canon'))
    git(STORY, 'commit', '-qam', 'accepted and promoted, for the test')
    assert.ok(!handoff().includes('FOLLOWS A'), 'no warning of either kind')

    // Then edited: the draft layer holds the edit, and the ground may move.
    fs.appendFileSync(file, '\nA paragraph the author has not accepted yet.\n')
    assert.match(handoff(), /FOLLOWS A DRAFT — NOT YET ACCEPTED/)
  } finally {
    git(STORY, 'reset', '-q', '--hard', head)
  }
})

test('the draft layer keeps a scene whose file name is not ASCII', async () => {
  const { proseDraft } = await import('../src/story.ts')
  const file = path.join(STORY, 'prose', 'ch-01', 'scene-09-señor.md')
  fs.writeFileSync(file, '---\nscene: sc.01-9\nchapter: ch.01-ninety-one-stairs\nstatus: proposed\n---\n\nUn señor.\n')
  try {
    // git quotes a non-ASCII path unless told not to; a quoted path is not a
    // `.md` path, and the scene would fall out of the draft layer unseen.
    assert.ok(proseDraft().changes.some(c => c.file === 'prose/ch-01/scene-09-señor.md'))
  } finally {
    fs.rmSync(file, { force: true })
  }
})

// ---- position and voice (A69-7) --------------------------------------------

test('position says where the scene sits: the chapter and the one before, the road here, the siblings on a ladder', () => {
  const s = assembleWritingSlice(rowWith(40_000), { chapter: scene().chapter, sceneId: 'sc.01-2' })
  const position = s.manifest.find(l => l.layer === 'position')!
  assert.equal(position.status, 'given')
  assert.deepEqual(position.ids, ['ch.01-ninety-one-stairs', 'char.ines', 'sc.01-1'])
  assert.deepEqual(position.rungs, [{ scene: 'sc.01-1', rung: 'full' }], 'the scene before is on the full rung')
  assert.match(position.note!, /sc\.01-1 at full/)
  // And the receipt carries the rung, by name.
  const onReceipt = s.forReceipt().layers.find(l => l.layer === 'position')!
  assert.deepEqual(onReceipt.rungs, [{ scene: 'sc.01-1', rung: 'full' }])

  const text = s.blocks.find(b => b.layer === 'position')!.text
  assert.match(text, /CHAPTER 1 · Ninety-One Stairs — A month of nothing/, 'this chapter, with its summary')
  assert.match(text, /THE CHAPTER BEFORE — none; this is the first chapter/)
  assert.match(text, /ROAD HERE — char\.ines\n  as of 1910 \(year precision\) \(their state at this moment\)/, 'the trajectory, dated')
  assert.match(text, /sc\.01-1 \(full\) — prose\/ch-01\/scene-01\.md\n/, 'and the sibling in full')
  assert.ok(text.includes(scene().body.trim().slice(0, 60)))
})

test('across a chapter boundary the position names the chapter before, with its summary', () => {
  const s = assembleWritingSlice(rowWith(40_000), { chapter: 'ch.02-the-aurelia', sceneId: 'sc.02-1' })
  const text = s.blocks.find(b => b.layer === 'position')!.text
  assert.match(text, /CHAPTER 2 · The Aurelia — The wreck and the six days after it/)
  assert.match(text, /THE CHAPTER BEFORE — 1 · Ninety-One Stairs — A month of nothing/)
  assert.match(text, /OTHER SCENES: none yet/)
  assert.match(s.manifest.find(l => l.layer === 'position')!.note!, /no other scenes/)
})

test('the ladder lowers a rung at a time before the layer drops, and the manifest names each rung', () => {
  const at = (budget: number) => {
    const s = assembleWritingSlice(rowWith(budget), { chapter: scene().chapter, sceneId: 'sc.01-2' })
    return { s, position: s.manifest.find(l => l.layer === 'position')!, text: s.blocks.find(b => b.layer === 'position')?.text ?? '' }
  }
  const full = at(40_000)
  assert.deepEqual(full.position.rungs, [{ scene: 'sc.01-1', rung: 'full' }])

  const contract = at(full.s.estimate - 5)
  assert.equal(contract.position.status, 'given', 'too big by a hair: the sibling steps down, the layer stays')
  assert.deepEqual(contract.position.rungs, [{ scene: 'sc.01-1', rung: 'contract' }])
  assert.match(contract.position.note!, /sc\.01-1 at contract/)
  assert.match(contract.text, /sc\.01-1 \(contract\)[^]*purpose: /)
  assert.ok(!contract.text.includes(scene().body.trim().slice(0, 60)), 'the prose is gone from that rung')
  assert.ok(contract.s.estimate < full.s.estimate)

  const summary = at(contract.s.estimate - 5)
  assert.deepEqual(summary.position.rungs, [{ scene: 'sc.01-1', rung: 'summary' }])
  assert.match(summary.text, /sc\.01-1 \(summary\): Render one night of the watch/)

  const gone = at(summary.s.estimate - 5)
  assert.equal(gone.position.status, 'not shown', 'as small as it can be and still too big: now it drops')
  assert.equal(gone.position.because, 'room ran out')
  assert.equal(gone.position.rungs, undefined, 'a layer that was not sent names no rung')
  for (const l of WRITING_SLICE.floor) {
    assert.notEqual(gone.s.manifest.find(m => m.layer === l)!.status, 'not shown', `${l} is floor`)
  }
})

test('voice carries the point-of-view rule from §1 and every present voice by id', () => {
  const s = assembleWritingSlice(rowWith(40_000), { chapter: scene().chapter, sceneId: 'sc.01-2' })
  const voice = s.manifest.find(l => l.layer === 'voice')!
  assert.equal(voice.status, 'given')
  assert.deepEqual(voice.ids, ['char.ines', 'char.wren'], 'the point of view first, then who the chapter has put on the page')
  const text = s.blocks.find(b => b.layer === 'voice')!.text
  assert.match(text, /THE POINT-OF-VIEW RULE \(your style contract, §1\)\n- \*\*POV\.\*\* Close third on Ines throughout/)
  assert.match(text, /char\.ines \(point of view\) — Speaks aloud constantly/)
  assert.match(text, /char\.wren — \(Behavioral signature\)/, 'the second voice, which no brief carried before')
  assert.match(voice.note!, /2 voices on record/)
  assert.match(voice.note!, /read from the chapter, since this scene is not written yet/)
})

test('a character with no voice recorded is listed as such — the gap is the author\'s to see', () => {
  const file = path.join(STORY, 'canon', 'entities', 'characters', 'wren.yaml')
  const original = fs.readFileSync(file, 'utf8')
  assert.ok(/\nvoice: >\n/.test(original))
  try {
    fs.writeFileSync(file, original.replace(/\nvoice: >\n(?:  .*\n)+/, '\n'))
    const s = assembleWritingSlice(rowWith(40_000), { chapter: scene().chapter, sceneId: 'sc.01-2' })
    const text = s.blocks.find(b => b.layer === 'voice')!.text
    assert.match(text, /char\.wren — no voice recorded/)
    assert.match(s.manifest.find(l => l.layer === 'voice')!.note!, /no voice recorded for char\.wren/)
  } finally {
    fs.writeFileSync(file, original)
  }
})

test('the point of view\'s road places era-only states by the record\'s own time, and marks the present only when it can', async () => {
  const { povRoad } = await import('../src/slice.ts')
  const { dk } = await import('arc-canon-graph/canon-graph.ts')
  const canon = {
    timeline: { eras: [
      { id: 'era.before', span: { start: '1900', end: '1909' } },
      { id: 'era.keeping', span: { start: '1910', end: '1911-01' } },
      { id: 'era.after', span: { start: '1911-02', end: '1920' } },
    ] },
    entities: { 'char.x': { id: 'char.x', type: 'character', states: [
      // File order is not time order, and none of these carries a date.
      { at: { era: 'era.after' }, condition: 'spent' },
      { at: { era: 'era.before' }, condition: 'young' },
      { at: { era: 'era.keeping' }, condition: 'content' },
    ] } },
  } as never
  const at1910 = povRoad(canon, 'char.x', dk('1910-11', true))
  assert.match(at1910, /as of era\.before[^\n]*: young\n  as of era\.keeping[^\n]* \(their state at this moment\): content$/, 'in time order, the present marked, the later one absent')
  assert.ok(!at1910.includes('spent'), 'a state from after this moment is not on the road')
  const unplaced = povRoad(canon, 'char.x', undefined)
  assert.match(unplaced, /cannot be placed/)
  assert.ok(!unplaced.includes('at this moment'), 'no present is claimed when there is no moment to measure from')
  assert.equal(unplaced.split('\n').length, 4, 'every state listed, in time order')
})

test('voice reads the point-of-view rule from this book\'s contract, never the author\'s constant layer', () => {
  const authorLayer = process.env.ARC_AUTHOR_STYLE!
  fs.writeFileSync(authorLayer, '# Me\n\n## 1. Always\n- **POV.** AUTHOR-LAYER-ONLY close third.\n')
  try {
    const s = assembleWritingSlice(rowWith(40_000), { chapter: scene().chapter, sceneId: 'sc.01-2' })
    const text = s.blocks.find(b => b.layer === 'voice')!.text
    assert.ok(!text.includes('AUTHOR-LAYER-ONLY'), 'the author layer\'s §1 is about every book, not this one')
    assert.match(text, /Close third on Ines throughout/, 'the book\'s own §1 rule')
  } finally {
    fs.rmSync(authorLayer, { force: true })
  }
})

test('the point-of-view rule is read from §1 alone, one bullet or several, and its absence is said', async () => {
  const { povRuleOf } = await import('../src/slice.ts')
  const two = povRuleOf([
    '# Style', '', '## 1. The contract', '',
    '- **Prologue POV.** Close external third on the man while', '  he is present.',
    '- **POV elsewhere.** Carlos chapters: close third.',
    '- **Tense.** Past.', '',
    '## 2. Rhythm', '- **POV.** this is not §1 and must not be read',
  ].join('\n'))
  assert.equal(two, '- **Prologue POV.** Close external third on the man while he is present.\n- **POV elsewhere.** Carlos chapters: close third.')
  // An indented bullet is a qualification of the rule above it, and travels with it.
  assert.equal(povRuleOf('## 1. The contract\n- **POV.** Close third.\n  - never enter the dog\'s thoughts\n- **Tense.** Past.\n'),
    '- **POV.** Close third. never enter the dog\'s thoughts')
  assert.equal(povRuleOf('## 1. The contract\n- **Tense.** Past.\n'), '', 'a §1 with no such bullet')
  assert.equal(povRuleOf('## 2. Rhythm\n- **POV.** x\n'), '', 'no §1 at all')
})

test('the handoff is floor: a budget that cannot hold it refuses before a token', () => {
  assert.throws(
    () => assembleWritingSlice(rowWith(60), { chapter: scene().chapter, sceneId: 'sc.01-2' }),
    /does not fit in one pass/)
})

// ---- canon with status, freshness, and what is live here (A69-6) --------

const draftOf = () => assembleWritingSlice(rowWith(40_000), { chapter: scene().chapter, sceneId: 'sc.01-2' })

test('every fact in the record layer is tagged with whether it may bear weight, and the rule is stated once', () => {
  const text = draftOf().blocks.find(b => b.layer === 'canon')!.text
  assert.ok(text.startsWith('WEIGHT.'), 'the weight rule heads the layer')
  assert.equal((text.match(/^WEIGHT\./gm) ?? []).length, 1, 'stated once')
  assert.match(text, /`char\.ines` \[canon\]/)
  assert.match(text, /`obj\.keepers-log` \[proposed — reference only\]/, 'the log the author has not decided on')
  assert.match(text, /`rel\.ines-log` \[proposed — reference only\]/, 'and the edge that hangs off it')
})

test('a state fact says when the record last looked, and one past the freshness distance is marked and listed', () => {
  const s = draftOf()
  const text = s.blocks.find(b => b.layer === 'canon')!.text
  assert.match(text, /`char\.ines` \[canon\][^\n]*\n  — included: [^\n]*\n  as of: 1910 \(year precision\)\n  AGED: /,
    'what it is, why it is here, when it was last true — in that order')
  const leaned = s.forReceipt().leaned_on
  assert.deepEqual(leaned.map(l => l.id), ['char.ines'], 'the keeper\'s year-precision snapshot against a November scene')
  assert.equal(leaned[0].as_of, '1910 (year precision)')
  assert.ok(leaned[0].older_by_days > 0)
  assert.deepEqual(s.manifest.find(l => l.layer === 'canon')!.leaned_on, leaned, 'proven from the manifest, not argued')

  // No freshness on the row: nothing is aged, nothing is listed.
  const loose = assembleWritingSlice(
    { ...rowWith(40_000), slice: { ...WRITING_SLICE, freshness: undefined } },
    { chapter: scene().chapter, sceneId: 'sc.01-2' })
  assert.ok(!/\n\s*AGED: /.test(loose.blocks.find(b => b.layer === 'canon')!.text), 'no state fact is marked aged')
  assert.deepEqual(loose.forReceipt().leaned_on, [])
})

test('what is live here: every present stance, and what the story owes in this chapter with the scene expected to discharge it', () => {
  const live = draftOf().blocks.find(b => b.layer === 'dramatic-condition')!
  assert.equal(live.status, 'given')
  assert.match(live.text, /HOW THEY STAND TO EACH OTHER\nchar\.ines \(as of 1910/)
  assert.match(live.text, /  → char\.wren: /)
  assert.match(live.text, /WHAT THE STORY OWES IN THIS CHAPTER\n- mat\.light-must-nearly-fail — [^\n]* · no scene claims it yet/)
  assert.match(live.text, /window ch\.01-ninety-one-stairs → ch\.02-the-aurelia/)
  assert.deepEqual(live.ids, ['char.ines', 'mat.light-must-nearly-fail'])

  // Claimed by a scene the book does not have yet: still owed, and the pass
  // is told where it is expected.
  const claimed = path.join(STORY, 'material', 'mat-test-claimed.yaml')
  fs.writeFileSync(claimed, ['id: mat.test-claimed', 'type: obligation', 'status: placed',
    'body: the burn must be seen to heal', 'related: [char.ines]', 'satisfied_by: [sc.05-1]',
    'window: { from: ch.01-ninety-one-stairs }'].join('\n') + '\n')
  try {
    assert.match(draftOf().blocks.find(b => b.layer === 'dramatic-condition')!.text, /- mat\.test-claimed — [^\n]* · expected in sc\.05-1/)
  } finally {
    fs.rmSync(claimed, { force: true })
  }
})

test('what may bear weight: the record split by status, and material never settled', async () => {
  const { weightOf } = await import('../src/slice.ts')
  const { materialItems } = await import('../src/story.ts')
  const canon = JSON.parse((await import('../src/canon.ts')).canonJson())
  const w = weightOf(canon, materialItems())
  assert.ok(w.settled.includes('char.ines'))
  assert.ok(w.settled.includes('rel.ines-wren'))
  for (const id of ['obj.keepers-log', 'rel.ines-log', 'mat.light-must-nearly-fail']) {
    assert.ok(w.unsettled.includes(id), `${id} may be mentioned and not rested on`)
    assert.ok(!w.settled.includes(id))
  }
})

test('a chapter whose span states no date ages nothing, and says why', () => {
  const chapters = path.join(STORY, 'canon', 'chapters.yaml')
  const original = fs.readFileSync(chapters, 'utf8')
  const dated = 'span: { start: "1910-11", end: "1910-12" }'
  assert.ok(original.includes(dated), 'the example chapter states a dated span')
  try {
    fs.writeFileSync(chapters, original.replace(dated, 'span: { start: { era: era.keeping }, end: { era: era.keeping } }'))
    const s = draftOf()
    const text = s.blocks.find(b => b.layer === 'canon')!.text
    assert.ok(!/\n\s*AGED: /.test(text), 'nothing is measured against the end of time')
    assert.match(text, /as of: the chapter states no dated span/)
    assert.deepEqual(s.forReceipt().leaned_on, [])
  } finally {
    fs.writeFileSync(chapters, original)
  }
})

test('the record and what is live here agree on who is present: a witness is in both', () => {
  // An event with a witness, bound by the scene being drafted through its
  // chapter: the pack lists the witness under the cast, and the stances
  // layer must too.
  const eventsDir = path.join(STORY, 'canon', 'events')
  const evFile = path.join(eventsDir, 'ev-test-witnessed.yaml')
  fs.writeFileSync(evFile, ['id: event.test-witnessed', 'type: event', 'status: canon', 'title: A test', 'summary: a test event',
    'when: { era: era.keeping, date: "1910-11-02" }', 'where: place.whitcombe-light', 'on_page: false',
    'participants: [{ entity: char.ines, role: keeper }]', 'witnesses: [char.wren]'].join('\n') + '\n')
  const sceneFile = path.join(STORY, scene().file)
  const original = fs.readFileSync(sceneFile, 'utf8')
  try {
    fs.writeFileSync(sceneFile, original.replace('events: []', 'events: [event.test-witnessed]'))
    const s = assembleWritingSlice(rowWith(40_000), subject())
    const live = s.blocks.find(b => b.layer === 'dramatic-condition')!.text
    assert.match(live, /char\.wren \(as of /, 'the witness has a stance on record, and it is here')
  } finally {
    fs.writeFileSync(sceneFile, original)
    fs.rmSync(evFile, { force: true })
  }
})

