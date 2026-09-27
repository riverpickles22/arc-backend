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
  for (const layer of ['dramatic-condition', 'position', 'research']) {
    assert.equal(by(layer).status, 'deferred',
      `${layer}: arc does not read this yet, and saying "none" would tell the author the book is empty here`)
  }
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
    assert.deepEqual(gone, droppableGiven.slice(0, gone.length).filter(l => gone.includes(l as never)),
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

test('the handoff is floor: a budget that cannot hold it refuses before a token', () => {
  assert.throws(
    () => assembleWritingSlice(rowWith(60), { chapter: scene().chapter, sceneId: 'sc.01-2' }),
    /does not fit in one pass/)
})
