// Annotations (conventions §14). The property that matters: a note follows
// its quote, and when the quote is gone it orphans honestly rather than
// reattaching to whatever now occupies its index.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { load as yamlLoad } from 'js-yaml'
import { git, makeStory, writeScene } from './fixture.ts'

const story = makeStory()
process.env.ARC_STORY_PATH = story
const { annotations, createAnnotation, deleteAnnotation, updateAnnotation, orphaned } = await import('../src/annotations.ts')
const { CORE } = await import('../src/config.ts')
const { HttpError } = await import('../src/http.ts')

function resetScene(body: string) {
  writeScene(story, 'prose/ch-01/scene-01.md', 'sc.01-1', body)
}

test('a note is filed against a real scene and comes back resolved', () => {
  resetScene('First paragraph here.\n\nSecond paragraph mentions Diego in the doorway.')
  const n = createAnnotation({ scene: 'sc.01-1', paragraph: 1, quote: 'Diego in the doorway', body: 'Diego is furniture here.' })
  assert.match(n.id, /^note\.\d{3}$/)
  assert.equal(n.status, 'open')
  assert.equal(n.resolution.state, 'resolved')
  assert.equal(n.resolution.paragraph, 1)
})

test('an edit above the note drifts it — the quote wins over the index', () => {
  resetScene('A NEW opening paragraph.\n\nFirst paragraph here.\n\nSecond paragraph mentions Diego in the doorway.')
  const n = annotations().find(x => x.body.startsWith('Diego is furniture'))!
  assert.equal(n.resolution.state, 'drifted')
  assert.equal(n.resolution.paragraph, 2)
  assert.match(n.resolution.note!, /moved from paragraph 2 to 3/)
})

test('when the passage is rewritten away the note orphans, keeping its quote', () => {
  resetScene('Something else entirely.\n\nAnd another thing.')
  const n = annotations().find(x => x.body.startsWith('Diego is furniture'))!
  assert.equal(n.resolution.state, 'orphaned')
  assert.equal(n.resolution.paragraph, null)
  assert.equal(n.anchor.quote, 'Diego in the doorway')   // the thought survives its anchor
  assert.equal(orphaned().length, 1)
})

test('a dropped note leaves the orphan list — it is no longer the author’s problem', () => {
  const n = annotations()[0]
  updateAnnotation(n.id, { status: 'dropped' })
  assert.equal(orphaned().length, 0)
  assert.equal(annotations()[0].status, 'dropped')
})

test('guards: unknown scene, empty body, bad status, unknown id', () => {
  assert.throws(() => createAnnotation({ scene: 'sc.99-9', paragraph: 0, quote: 'x', body: 'y' }), HttpError)
  assert.throws(() => createAnnotation({ scene: 'sc.01-1', paragraph: 0, quote: 'x', body: '   ' }), HttpError)
  assert.throws(() => updateAnnotation('note.001', { status: 'nonsense' }), HttpError)
  assert.throws(() => updateAnnotation('note.999', { status: 'open' }), HttpError)
})

// A note may be about the section rather than a sentence in it — the only
// shape available for the observation that something is MISSING, which is
// the case that motivated it: nothing to select, because the absence is the
// point. It must outlive any rewrite that leaves the absence in place.
test('a note can be about the whole scene, with nothing selected', () => {
  resetScene('First paragraph here.\n\nSecond paragraph mentions Diego in the doorway.')
  const n = createAnnotation({ scene: 'sc.01-1', body: 'we never reference the tide in this section' })
  assert.equal(n.anchor.paragraph, undefined)
  assert.equal(n.anchor.quote, undefined)
  assert.equal(n.resolution.state, 'resolved')
  assert.equal(n.resolution.paragraph, null)
  assert.equal(n.status, 'open')
})

test('a scene note survives a rewrite that a passage note would not', () => {
  const before = annotations().find(x => x.body.startsWith('we never reference'))!
  resetScene('Nothing of the previous text remains here at all.')
  const after = annotations().find(x => x.id === before.id)!
  assert.equal(after.resolution.state, 'resolved')
  assert.equal(after.body, 'we never reference the tide in this section')
  assert.equal(orphaned().find(x => x.id === before.id), undefined)
})

test('a scene note leads its scene, and its file records no paragraph', () => {
  resetScene('First paragraph here.\n\nSecond paragraph mentions Diego in the doorway.')
  const scoped = createAnnotation({ scene: 'sc.01-1', paragraph: 1, quote: 'Diego in the doorway', body: 'on a passage' })
  const inScene = annotations().filter(x => x.anchor.scene === 'sc.01-1')
  assert.ok(inScene.findIndex(x => x.body.startsWith('we never reference'))
            < inScene.findIndex(x => x.id === scoped.id),
    'the scene note sorts ahead of the passage note')
  const onDisk = fs.readFileSync(path.join(story, 'annotations',
    `note-${annotations().find(x => x.body.startsWith('we never reference'))!.id.slice(5)}.yaml`), 'utf8')
  assert.ok(!/paragraph:/.test(onDisk), 'no paragraph key is written for a scene note')
  assert.ok(!/quote:/.test(onDisk), 'no quote key is written for a scene note')
})

test('a quote with no paragraph is refused — that anchor could never resolve', () => {
  assert.throws(() => createAnnotation({ scene: 'sc.01-1', quote: 'Diego in the doorway', body: 'which passage?' }),
    HttpError)
  assert.throws(() => createAnnotation({ body: 'no scene at all' } as never), HttpError)
})

// Found by using the app: the HTTP layer sanitised an absent paragraph into
// Number(undefined ?? -1) === -1, so a scene note arrived as a passage note
// anchored to a paragraph that cannot exist — and the schema's minimum: 0
// would have rejected the file it wrote. Absence has to survive the coercion,
// and an index below zero is not a passage either.
test('a paragraph below zero is refused rather than stored as an anchor', () => {
  assert.throws(() => createAnnotation({ scene: 'sc.01-1', paragraph: -1, body: 'coerced from absence' }),
    HttpError)
  assert.throws(() => createAnnotation({ scene: 'sc.01-1', paragraph: 1.5, body: 'not a whole paragraph' }),
    HttpError)
})

test('a note can be revised — the thought changes, the anchor does not', () => {
  const before = annotations()[0]
  const after = updateAnnotation(before.id, { body: '  Sharper on the second reading.  ' })
  assert.equal(after.body, 'Sharper on the second reading.')   // trimmed
  assert.deepEqual(after.anchor, before.anchor)                // never re-anchored
  assert.equal(after.status, before.status)
  assert.equal(after.id, before.id)
})

test('status and body can move together, or one without the other', () => {
  const id = annotations()[0].id
  const both = updateAnnotation(id, { status: 'working', body: 'Revised while working.' })
  assert.equal(both.status, 'working')
  assert.equal(both.body, 'Revised while working.')
  assert.equal(updateAnnotation(id, { body: 'Body only.' }).status, 'working')
  assert.equal(updateAnnotation(id, { status: 'open' }).body, 'Body only.')
})

test('an edit cannot empty a note, and an empty patch is refused', () => {
  const id = annotations()[0].id
  assert.throws(() => updateAnnotation(id, { body: '   ' }), HttpError)   // that is what drop is for
  assert.throws(() => updateAnnotation(id, {}), HttpError)
  assert.ok(annotations()[0].body.trim().length > 0)
})

test('notes live in annotations/ as ordinary editable yaml', () => {
  const files = fs.readdirSync(path.join(story, 'annotations'))
  assert.ok(files.some(f => /^note-\d{3}\.yaml$/.test(f)))
  git(story, 'checkout', 'HEAD', '--', '.')
  git(story, 'clean', '-fdq')
})

// ---- keypoints (A30): a kind with no lifecycle, and the only hard delete --

test('a keypoint round-trips its kind and provenance, without a status', () => {
  const kp = createAnnotation({ scene: 'sc.01-1', paragraph: 0, quote: 'Original first paragraph.', body: 'The crossing begins.', kind: 'keypoint', by: 'agent' })
  assert.equal(kp.kind, 'keypoint')
  assert.equal(kp.by, 'agent')
  assert.equal(kp.status, undefined, 'a keypoint has no lifecycle')
  assert.equal(kp.resolution.state, 'resolved')
})

test('a legacy annotation without kind is a note, everywhere', () => {
  const note = createAnnotation({ scene: 'sc.01-1', paragraph: 0, quote: 'Original first paragraph.', body: 'A thought.' })
  assert.equal(note.kind, undefined)
  assert.equal(note.status, 'open')
})

test('delete removes a keypoint and refuses a note', () => {
  const kp = createAnnotation({ scene: 'sc.01-1', paragraph: 1, quote: 'Second paragraph.', body: 'Held.', kind: 'keypoint' })
  const note = createAnnotation({ scene: 'sc.01-1', paragraph: 1, quote: 'Second paragraph.', body: 'A kept thought.' })
  deleteAnnotation(kp.id)
  assert.ok(!annotations().some(a => a.id === kp.id), 'the keypoint is gone')
  assert.throws(() => deleteAnnotation(note.id), /never deleted/)
  assert.ok(annotations().some(a => a.id === note.id), 'the note survives')
})

// ---- the two repos hold each other to one shape -------------------------
//
// arc-core's schema decides what a keypoint may be; createAnnotation decides
// what one actually is. Nothing connected them: arc-core's test carried a
// dict typed out beside it, annotated "mirrored field for field", which is
// true until someone changes this function and does not know that file
// exists. So the shape lives in arc-core as a specimen — validated there
// against the schema, and held HERE against the real output.

test("the keypoint createAnnotation writes has the shape arc-core validates", () => {
  resetScene('First paragraph here.\n\nSecond paragraph mentions Diego in the doorway.')
  const kp = createAnnotation({
    scene: 'sc.01-1', paragraph: 1, quote: 'Second paragraph.',
    body: 'what this passage must get across', kind: 'keypoint', by: 'agent',
  })

  // What went to disk, not what the function returned — the file is what the
  // validator will read, and resolveAnnotations adds fields on the way out.
  const onDisk = yamlLoad(
    fs.readFileSync(path.join(story, 'annotations', `${kp.id.replace('.', '-')}.yaml`), 'utf8'),
  ) as Record<string, unknown>

  const specimen = yamlLoad(
    fs.readFileSync(path.join(CORE, 'schema', 'fixtures', 'keypoint-from-backend.yaml'), 'utf8'),
  ) as Record<string, unknown>

  assert.deepEqual(Object.keys(onDisk).sort(), Object.keys(specimen).sort(),
    'createAnnotation writes exactly the keys arc-core validates — no more, no fewer')
  assert.equal('status' in onDisk, false, 'and no status: a keypoint has no lifecycle')
  for (const k of Object.keys(specimen)) {
    assert.equal(typeof onDisk[k], typeof specimen[k], `${k} keeps the specimen's type`)
  }
  const anchor = onDisk.anchor as Record<string, unknown>
  assert.deepEqual(Object.keys(anchor).sort(), Object.keys(specimen.anchor as object).sort(),
    'the anchor too — a paragraph keypoint carries scene, paragraph and quote')
})

// A49-1: the anchor remembers its paragraphs — the verbatim text of what the
// note covers, captured at creation, because prose does not stand still.
test('a passage note captures its paragraph verbatim; a spanning quote captures each', () => {
  resetScene('The lamp had been lit for an hour.\n\nShe went down to the rocks anyway.\n\nThe tide argued all night.')
  const one = createAnnotation({ scene: 'sc.01-1', paragraph: 1, quote: 'down to the rocks', body: 'snapshot: one paragraph' })
  assert.deepEqual(one.anchor.paragraphs, ['She went down to the rocks anyway.'])

  // A quote reaching across the break covers both paragraphs, in order.
  const two = createAnnotation({
    scene: 'sc.01-1', paragraph: 1,
    quote: 'She went down to the rocks anyway. The tide argued all night.',
    body: 'snapshot: two paragraphs',
  })
  assert.deepEqual(two.anchor.paragraphs,
    ['She went down to the rocks anyway.', 'The tide argued all night.'])

  // No quote: exactly the anchored paragraph.
  const bare = createAnnotation({ scene: 'sc.01-1', paragraph: 0, body: 'snapshot: quoteless' })
  assert.deepEqual(bare.anchor.paragraphs, ['The lamp had been lit for an hour.'])

  // A scene note has no snapshot — the scene is its referent.
  const scenewide = createAnnotation({ scene: 'sc.01-1', body: 'about the whole section' })
  assert.equal(scenewide.anchor.paragraphs, undefined)

  // The snapshot is a record: it survives the passage being rewritten away,
  // which is the moment it is FOR.
  resetScene('Entirely new prose.\n\nNothing of the old scene remains.')
  const back = annotations().find(x => x.body === 'snapshot: one paragraph')!
  assert.equal(back.resolution.state, 'orphaned')
  assert.deepEqual(back.anchor.paragraphs, ['She went down to the rocks anyway.'])
})
