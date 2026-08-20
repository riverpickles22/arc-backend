// The git draft layer — the code most able to lose an author's work.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { git, makeStory, writeScene } from './fixture.ts'

const story = makeStory()
process.env.ARC_STORY_PATH = story
const { proseAccept, proseAcceptParagraph, proseRejectParagraph, proseAcceptSentence, proseRejectSentence, proseDiscard, proseDraft, proseScenes, proseWrite } = await import('../src/story.ts')
const { HttpError } = await import('../src/http.ts')

function reset(): void {
  git(story, 'checkout', 'HEAD', '--', '.')
  git(story, 'clean', '-fdq')
}

test('clean tree reports no changes and real history', () => {
  reset()
  const d = proseDraft()
  assert.equal(d.git, true)
  assert.equal(d.changes.length, 0)
  assert.equal(d.history[0].subject, 'prose: first scene')
})

test('modified/added/deleted statuses, with main bodies', () => {
  reset()
  writeScene(story, 'prose/ch-01/scene-01.md', 'sc.01-1', 'Revised first paragraph.\n\nSecond paragraph.')
  writeScene(story, 'prose/ch-01/scene-02.md', 'sc.01-2', 'A new scene.')
  const d = proseDraft()
  const byFile = new Map(d.changes.map(c => [c.file, c]))
  assert.equal(byFile.get('prose/ch-01/scene-01.md')?.status, 'modified')
  assert.match(byFile.get('prose/ch-01/scene-01.md')?.main?.body ?? '', /Original first paragraph/)
  assert.equal(byFile.get('prose/ch-01/scene-02.md')?.status, 'added')
  assert.equal(byFile.get('prose/ch-01/scene-02.md')?.main, null)

  reset()
  fs.rmSync(path.join(story, 'prose/ch-01/scene-01.md'))
  const d2 = proseDraft()
  assert.equal(d2.changes[0]?.status, 'deleted')
  assert.match(d2.changes[0]?.main?.body ?? '', /Original first paragraph/)
})

test('accept commits prose only — a dirty canon file stays dirty', () => {
  reset()
  writeScene(story, 'prose/ch-01/scene-01.md', 'sc.01-1', 'Accepted revision.')
  fs.appendFileSync(path.join(story, 'canon/story.yaml'), 'logline: dirty\n')

  const result = proseAccept()
  assert.match(result.hash, /^[0-9a-f]{7,}$/)
  assert.deepEqual(result.files, ['prose/ch-01/scene-01.md'])
  assert.equal(proseDraft().changes.length, 0)
  assert.match(git(story, 'log', '-1', '--pretty=%s'), /accept draft \(1 scene\)/)
  // The canon edit must not have been swept into the commit.
  assert.match(git(story, 'status', '--porcelain'), /^ M canon\/story\.yaml/m)

  git(story, 'checkout', 'HEAD', '--', 'canon')
})

test('accept with a custom message uses it', () => {
  writeScene(story, 'prose/ch-01/scene-01.md', 'sc.01-1', 'Another revision.')
  proseAccept('prose: my own words')
  assert.equal(git(story, 'log', '-1', '--pretty=%s').trim(), 'prose: my own words')
})

test('accept with no changes is a 409', () => {
  reset()
  assert.throws(() => proseAccept(), (e: unknown) => e instanceof HttpError && e.status === 409)
})

test('discard reverts a modified file and deletes an added one', () => {
  reset()
  writeScene(story, 'prose/ch-01/scene-01.md', 'sc.01-1', 'Doomed edit.')
  proseDiscard('prose/ch-01/scene-01.md')
  assert.match(fs.readFileSync(path.join(story, 'prose/ch-01/scene-01.md'), 'utf8'), /Original first paragraph|Accepted|Another/)
  assert.equal(proseDraft().changes.length, 0)

  writeScene(story, 'prose/ch-01/scene-03.md', 'sc.01-3', 'Scrap.')
  proseDiscard('prose/ch-01/scene-03.md')
  assert.equal(fs.existsSync(path.join(story, 'prose/ch-01/scene-03.md')), false)
})

test('discard rejects traversal and unknown files', () => {
  reset()
  assert.throws(() => proseDiscard('../etc/passwd'), (e: unknown) => e instanceof HttpError && e.status === 400)
  assert.throws(() => proseDiscard('canon/story.yaml'), (e: unknown) => e instanceof HttpError && e.status === 400)
  assert.throws(() => proseDiscard('prose/../canon/story.yaml'), (e: unknown) => e instanceof HttpError && e.status === 400)
  assert.throws(() => proseDiscard('prose/ch-01/scene-01.md'), (e: unknown) => e instanceof HttpError && e.status === 404)
})

test('a scene in a brand-new chapter directory reports as added (not swallowed as `?? dir/`)', () => {
  reset()
  writeScene(story, 'prose/ch-09/scene-01.md', 'sc.09-1', 'First scene of a new chapter.')
  const d = proseDraft()
  const change = d.changes.find(c => c.file === 'prose/ch-09/scene-01.md')
  assert.ok(change, 'the new-directory scene must appear in the draft changes')
  assert.equal(change.status, 'added')
  fs.rmSync(path.join(story, 'prose/ch-09'), { recursive: true })
})

test('proseWrite replaces the body and leaves the frontmatter byte-identical', () => {
  const file = 'prose/ch-01/scene-01.md'
  const before = fs.readFileSync(path.join(story, file), 'utf8')
  const fm = before.slice(0, before.indexOf('---', 3) + 4)
  proseWrite(file, 'A wholly new body.\n')
  const after = fs.readFileSync(path.join(story, file), 'utf8')
  assert.ok(after.startsWith(fm), 'frontmatter untouched')
  assert.match(after, /A wholly new body\./)
  assert.doesNotMatch(after, /Original first paragraph/)
})

test('proseWrite refuses when the file moved underneath the edit', () => {
  const file = 'prose/ch-01/scene-01.md'
  assert.throws(() => proseWrite(file, 'x', 'a baseline that is not what is on disk'), HttpError)
})

test('proseWrite accepts a baseline that matches, ignoring trailing whitespace', () => {
  const file = 'prose/ch-01/scene-01.md'
  const current = proseScenes().find(s => s.file === file)!.body
  proseWrite(file, 'Second edit.\n', current.trimEnd() + '\n\n')
  assert.match(fs.readFileSync(path.join(story, file), 'utf8'), /Second edit\./)
})

test('proseWrite guards the path and the extension', () => {
  assert.throws(() => proseWrite('canon/story.yaml', 'x'), HttpError)
  assert.throws(() => proseWrite('prose/../canon/story.yaml', 'x'), HttpError)
  assert.throws(() => proseWrite('prose/ch-01/nope.md', 'x'), HttpError)
})

test('accepting one paragraph commits it and leaves the rest pending', () => {
  reset()
  const file = 'prose/ch-01/scene-01.md'
  const abs = path.join(story, file)
  const before = fs.readFileSync(abs, 'utf8')
  const fm = before.slice(0, before.indexOf('---', 3) + 4)
  fs.writeFileSync(abs, fm + 'FIRST changed.\n\nSECOND changed.\n')

  proseAcceptParagraph(file, { side: 'draft', paragraph: 0 })

  // HEAD took paragraph 0 only
  const head = git(story, 'show', `HEAD:${file}`)
  assert.match(head, /FIRST changed\./)
  assert.doesNotMatch(head, /SECOND changed\./)
  // the working tree still holds everything the author wrote
  const wt = fs.readFileSync(abs, 'utf8')
  assert.match(wt, /FIRST changed\./)
  assert.match(wt, /SECOND changed\./)
  // and the remaining diff is exactly the paragraph not yet accepted
  assert.equal(proseDraft().changes.filter(c => c.file === file).length, 1)
})

test('accepting the last pending paragraph leaves the scene matching main', () => {
  reset()
  const file = 'prose/ch-01/scene-01.md'
  const abs = path.join(story, file)
  const before = fs.readFileSync(abs, 'utf8')
  const fm = before.slice(0, before.indexOf('---', 3) + 4)
  fs.writeFileSync(abs, fm + 'Only one paragraph, changed.\n')
  proseAcceptParagraph(file, { side: 'draft', paragraph: 0 })
  assert.equal(proseDraft().changes.filter(c => c.file === file).length, 0)
})

test('a paragraph accept is refused on an added scene, and on a bad index', () => {
  reset()
  writeScene(story, 'prose/ch-01/scene-09.md', 'sc.01-9', 'Brand new.')
  assert.throws(() => proseAcceptParagraph('prose/ch-01/scene-09.md', { side: 'draft', paragraph: 0 }), HttpError)
  const file = 'prose/ch-01/scene-01.md'
  const abs = path.join(story, file)
  fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8') + '\n\nAn extra line.\n')
  assert.throws(() => proseAcceptParagraph(file, { side: 'draft', paragraph: 99 }), HttpError)
  reset()
})

// Reject is accept's mirror and the half of the gate that was missing: the
// only way to say no used to be Discard, which throws away every change in
// the scene.
test('rejecting one paragraph puts main back and leaves the rest pending', () => {
  reset()
  const file = 'prose/ch-01/scene-01.md'
  const abs = path.join(story, file)
  const before = fs.readFileSync(abs, 'utf8')
  const fm = before.slice(0, before.indexOf('---', 3) + 4)
  const mainFirst = before.slice(fm.length).split(/\n{2,}/)[0].trim()
  fs.writeFileSync(abs, fm + 'FIRST changed.\n\nSECOND changed.\n')

  proseRejectParagraph(file, { side: 'draft', paragraph: 0 })

  const wt = fs.readFileSync(abs, 'utf8')
  assert.match(wt, new RegExp(mainFirst.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    "the refused paragraph carries main's words again")
  assert.doesNotMatch(wt, /FIRST changed\./)
  assert.match(wt, /SECOND changed\./, 'the change NOT refused is still pending')
  assert.equal(proseDraft().changes.filter(c => c.file === file).length, 1)
})

test('rejecting commits nothing — HEAD is untouched by a refusal', () => {
  reset()
  const file = 'prose/ch-01/scene-01.md'
  const abs = path.join(story, file)
  const headBefore = git(story, 'rev-parse', 'HEAD').trim()
  const before = fs.readFileSync(abs, 'utf8')
  const fm = before.slice(0, before.indexOf('---', 3) + 4)
  fs.writeFileSync(abs, fm + 'CHANGED first.\n\nCHANGED second.\n')
  proseRejectParagraph(file, { side: 'draft', paragraph: 1 })
  assert.equal(git(story, 'rev-parse', 'HEAD').trim(), headBefore)
})

test('rejecting a paragraph the draft invented removes it', () => {
  reset()
  const file = 'prose/ch-01/scene-01.md'
  const abs = path.join(story, file)
  const before = fs.readFileSync(abs, 'utf8')
  const paras = before.slice(before.indexOf('---', 3) + 4).split(/\n{2,}/).map(s => s.trim()).filter(Boolean)
  fs.writeFileSync(abs, before.trimEnd() + '\n\nA paragraph main never had.\n')
  proseRejectParagraph(file, { side: 'draft', paragraph: paras.length })
  const wt = fs.readFileSync(abs, 'utf8')
  assert.doesNotMatch(wt, /never had/)
  assert.equal(proseDraft().changes.filter(c => c.file === file).length, 0,
    'refusing the only change leaves the scene clean')
})

test('rejecting the last pending change leaves the scene matching main', () => {
  reset()
  const file = 'prose/ch-01/scene-01.md'
  const abs = path.join(story, file)
  const before = fs.readFileSync(abs, 'utf8')
  const fm = before.slice(0, before.indexOf('---', 3) + 4)
  // Distinct text on purpose: the suite shares one fixture and HEAD carries
  // whatever earlier accept tests committed, so reusing their words would
  // mean writing a body git already has and testing nothing.
  fs.writeFileSync(abs, fm + 'One paragraph, and this one is refused.\n')
  proseRejectParagraph(file, { side: 'draft', paragraph: 0 })
  assert.equal(proseDraft().changes.filter(c => c.file === file).length, 0)
})

test('a paragraph reject is refused on an added scene, and on a bad index', () => {
  reset()
  writeScene(story, 'prose/ch-01/scene-09.md', 'sc.01-9', 'Brand new.')
  assert.throws(() => proseRejectParagraph('prose/ch-01/scene-09.md', { side: 'draft', paragraph: 0 }), HttpError)
  assert.throws(() => proseRejectParagraph('prose/ch-01/scene-01.md', { side: 'draft', paragraph: 99 }), HttpError)
  assert.throws(() => proseRejectParagraph('prose/ch-01/nope.md', { side: 'draft', paragraph: 0 }), HttpError)
  reset()
})

// ---- a paragraph is named, not counted ---------------------------------
//
// The positional scheme read an index off the DRAFT and applied it to MAIN.
// These are the shapes where those two disagree, which is every shape a
// rebuild produces and one an ordinary revision produces often enough.

/** Commit a fixture only when it differs from HEAD. The suite shares one
 *  story, so a second test asking for the same starting point finds git with
 *  nothing to do — and `git commit` calls that an error. Already-there is the
 *  outcome these fixtures want either way. */
function commitIfDirty(file: string, subject: string): void {
  git(story, 'add', '--', file)
  if (!git(story, 'status', '--porcelain', '--', file).trim()) return
  git(story, 'commit', '-m', subject, '--', file)
}

/** Put main at exactly [A, B, C] so the arithmetic is legible, and return the
 *  helpers each test needs. Committed, so it is HEAD rather than a change. */
function threeParagraphs(file: string) {
  reset()
  const abs = path.join(story, file)
  const before = fs.readFileSync(abs, 'utf8')
  const fm = before.slice(0, before.indexOf('---', 3) + 4)
  fs.writeFileSync(abs, fm + 'Paragraph A.\n\nParagraph B.\n\nParagraph C.\n')
  commitIfDirty(file, 'fixture: three paragraphs')
  const body = () => {
    const t = fs.readFileSync(abs, 'utf8')
    return t.slice(t.indexOf('---', 3) + 4)
  }
  const head = () => {
    const t = git(story, 'show', `HEAD:${file}`)
    return t.slice(t.indexOf('---', 3) + 4)
  }
  return { abs, fm, body, head }
}

test('accepting an inserted paragraph does not remove one the author never judged', () => {
  const file = 'prose/ch-01/scene-01.md'
  const { abs, fm, head } = threeParagraphs(file)
  // The draft inserts NEW between A and B. Under the old scheme this arrived
  // as index 1, which is B on main's side, and committing it dropped B.
  fs.writeFileSync(abs, fm + 'Paragraph A.\n\nParagraph NEW.\n\nParagraph B.\n\nParagraph C.\n')
  proseAcceptParagraph(file, { side: 'draft', paragraph: 1 })

  const committed = head()
  assert.match(committed, /Paragraph NEW/, 'the accepted insertion is in the book')
  for (const p of ['Paragraph A', 'Paragraph B', 'Paragraph C']) {
    assert.match(committed, new RegExp(p), `${p} survived an unrelated accept`)
  }
  assert.equal(committed.split(/\n{2,}/).filter(Boolean).length, 4)
  reset()
})

test('the insertion lands where it was written, not at the end', () => {
  const file = 'prose/ch-01/scene-01.md'
  const { abs, fm, head } = threeParagraphs(file)
  fs.writeFileSync(abs, fm + 'Paragraph A.\n\nParagraph NEW.\n\nParagraph B.\n\nParagraph C.\n')
  proseAcceptParagraph(file, { side: 'draft', paragraph: 1 })
  const paras = head().split(/\n{2,}/).map(x => x.trim()).filter(Boolean)
  assert.deepEqual(paras, ['Paragraph A.', 'Paragraph NEW.', 'Paragraph B.', 'Paragraph C.'])
  reset()
})

test('rejecting an inserted paragraph leaves no duplicate behind', () => {
  const file = 'prose/ch-01/scene-01.md'
  const { abs, fm, body } = threeParagraphs(file)
  fs.writeFileSync(abs, fm + 'Paragraph A.\n\nParagraph NEW.\n\nParagraph B.\n\nParagraph C.\n')
  proseRejectParagraph(file, { side: 'draft', paragraph: 1 })

  const paras = body().split(/\n{2,}/).map(x => x.trim()).filter(Boolean)
  assert.deepEqual(paras, ['Paragraph A.', 'Paragraph B.', 'Paragraph C.'],
    'the refusal restores main exactly — the old code wrote B twice')
  reset()
})

test('a deleted paragraph can be judged at all, and accepting commits the deletion', () => {
  const file = 'prose/ch-01/scene-01.md'
  const { abs, fm, head } = threeParagraphs(file)
  fs.writeFileSync(abs, fm + 'Paragraph A.\n\nParagraph C.\n')
  // Named on MAIN's side: the paragraph exists only there, which is exactly
  // why the draft-side scheme could not address it.
  proseAcceptParagraph(file, { side: 'main', paragraph: 1 })

  const committed = head()
  assert.doesNotMatch(committed, /Paragraph B/, 'the accepted deletion is in the book')
  assert.match(committed, /Paragraph A/)
  assert.match(committed, /Paragraph C/)
  reset()
})

test('rejecting a deletion puts the paragraph back where it stood', () => {
  const file = 'prose/ch-01/scene-01.md'
  const { abs, fm, body } = threeParagraphs(file)
  fs.writeFileSync(abs, fm + 'Paragraph A.\n\nParagraph C.\n')
  proseRejectParagraph(file, { side: 'main', paragraph: 1 })

  const paras = body().split(/\n{2,}/).map(x => x.trim()).filter(Boolean)
  assert.deepEqual(paras, ['Paragraph A.', 'Paragraph B.', 'Paragraph C.'])
  reset()
})

test('an unchanged paragraph has nothing to judge, and says so', () => {
  const file = 'prose/ch-01/scene-01.md'
  const { abs, fm } = threeParagraphs(file)
  fs.writeFileSync(abs, fm + 'Paragraph A.\n\nParagraph B rewritten.\n\nParagraph C.\n')
  assert.throws(() => proseAcceptParagraph(file, { side: 'draft', paragraph: 0 }), HttpError)
  reset()
})

test('a sentence decision reads the right before-text under an insertion', () => {
  const file = 'prose/ch-01/scene-01.md'
  reset()
  const abs = path.join(story, file)
  const before = fs.readFileSync(abs, 'utf8')
  const fm = before.slice(0, before.indexOf('---', 3) + 4)
  fs.writeFileSync(abs, fm + 'Paragraph A.\n\nOne sentence. Two sentence.\n')
  commitIfDirty(file, 'fixture: a paragraph with two sentences')

  // An insertion ABOVE shifts the target to draft index 2 while it is still
  // main's index 1. Positionally main[2] does not exist, and the old code
  // refused the decision outright.
  fs.writeFileSync(abs, fm + 'Inserted at the top.\n\nParagraph A.\n\nOne sentence. Two sentence. Three sentence.\n')
  proseAcceptSentence(file, { paragraph: 2, side: 'draft', sentence: 2 })

  const committed = git(story, 'show', `HEAD:${file}`)
  assert.match(committed, /Three sentence/, 'the accepted sentence reached the book')
  assert.match(committed, /One sentence/, 'and its paragraph kept what it had')
  assert.doesNotMatch(committed, /Inserted at the top/, 'the unjudged insertion stayed pending')
  reset()
})

// ---- judging one sentence (A37-3) --------------------------------------
//
// The unit an author actually disagrees at. A revision rewrites a paragraph to
// answer one note and usually the new second sentence is better while the new
// fourth loses something; the paragraph verbs force that into one decision.
// Every test here proves the same property from a different side: a verdict on
// one sentence changes that sentence and nothing else.

/** Put a two-sentence paragraph in main and a rewrite of it in the working
 *  tree. Returns the file and its absolute path. */
function twoSentenceDraft(draftBody: string): { file: string; abs: string } {
  reset()
  const file = 'prose/ch-01/scene-01.md'
  const abs = path.join(story, file)
  const before = fs.readFileSync(abs, 'utf8')
  const fm = before.slice(0, before.indexOf('---', 3) + 4)
  // main: two sentences in one paragraph, plus a second paragraph.
  fs.writeFileSync(abs, fm + 'He shipped the oars. The swell ran heavy.\n\nSecond paragraph.\n')
  // Only commit when this is the first call — a later one finds main already
  // holding the baseline, and `git commit` on nothing is an error.
  if (git(story, 'status', '--porcelain').trim()) {
    git(story, 'commit', '-qam', 'prose: a two-sentence paragraph')
  }
  fs.writeFileSync(abs, fm + draftBody)
  return { file, abs }
}

test('accepting one added sentence commits it and leaves the rest pending', () => {
  // The draft adds a third sentence and rewrites the second.
  const { file, abs } = twoSentenceDraft('He shipped the oars. The swell ran black. Salt burned.\n\nSecond paragraph.\n')
  const draftSents = ['He shipped the oars. ', 'The swell ran black. ', 'Salt burned.']
  assert.equal(draftSents.join(''), 'He shipped the oars. The swell ran black. Salt burned.')

  proseAcceptSentence(file, { paragraph: 0, side: 'draft', sentence: 2 })

  const head = git(story, 'show', `HEAD:${file}`)
  assert.match(head, /Salt burned\./)              // the accepted sentence landed
  assert.match(head, /The swell ran heavy\./)      // the un-judged rewrite did NOT
  assert.doesNotMatch(head, /ran black/)

  // and the author's working tree is untouched — every word still there
  const wt = fs.readFileSync(abs, 'utf8')
  assert.match(wt, /ran black/)
  assert.match(wt, /Salt burned\./)
})

test('rejecting one added sentence drops only it, and never commits', () => {
  const { file, abs } = twoSentenceDraft('He shipped the oars. The swell ran black. Salt burned.\n\nSecond paragraph.\n')
  const headBefore = git(story, 'rev-parse', 'HEAD').trim()

  proseRejectSentence(file, { paragraph: 0, side: 'draft', sentence: 2 })

  const wt = fs.readFileSync(abs, 'utf8')
  assert.doesNotMatch(wt, /Salt burned/)          // the refused sentence is gone
  assert.match(wt, /ran black/)                    // the other pending change survives
  assert.match(wt, /Second paragraph\./)           // and so does the other paragraph
  assert.equal(git(story, 'rev-parse', 'HEAD').trim(), headBefore, 'reject must not commit')
})

test('rejecting a deleted sentence puts it back; accepting the deletion keeps it gone', () => {
  // The draft removed the second sentence.
  const { file, abs } = twoSentenceDraft('He shipped the oars.\n\nSecond paragraph.\n')

  proseRejectSentence(file, { paragraph: 0, side: 'main', sentence: 1 })
  assert.match(fs.readFileSync(abs, 'utf8'), /The swell ran heavy\./, 'a refused deletion comes back')

  // Now the same deletion, accepted instead.
  const again = twoSentenceDraft('He shipped the oars.\n\nSecond paragraph.\n')
  proseAcceptSentence(again.file, { paragraph: 0, side: 'main', sentence: 1 })
  const head = git(story, 'show', `HEAD:${again.file}`)
  assert.doesNotMatch(head, /The swell ran heavy/, 'an accepted deletion is committed as a deletion')
  assert.match(head, /He shipped the oars\./)
})

test('a sentence verdict leaves other scenes untouched', () => {
  // The second scene is created and committed BEFORE the draft exists —
  // committing it afterwards would swallow scene-01's pending change and the
  // test would be proving nothing.
  reset()
  const other = 'prose/ch-01/scene-02.md'
  writeScene(story, other, 'sc.01-2', 'Another scene entirely.')
  git(story, 'add', '-A'); git(story, 'commit', '-qm', 'prose: second scene')

  const { file } = twoSentenceDraft('He shipped the oars. The swell ran black.\n\nSecond paragraph.\n')
  const otherAbs = path.join(story, other)
  fs.writeFileSync(otherAbs, fs.readFileSync(otherAbs, 'utf8').replace('Another scene entirely.', 'Another scene, changed.'))

  proseRejectSentence(file, { paragraph: 0, side: 'draft', sentence: 1 })

  assert.match(fs.readFileSync(otherAbs, 'utf8'), /Another scene, changed\./, 'the other scene keeps its pending change')
  reset()
})

test('sentence verbs refuse what they cannot honestly do', () => {
  const { file } = twoSentenceDraft('He shipped the oars. The swell ran black.\n\nSecond paragraph.\n')
  // A sentence nobody changed has no verdict to give.
  assert.throws(() => proseRejectSentence(file, { paragraph: 0, side: 'draft', sentence: 0 }), HttpError)
  // Nor does an index past the end.
  assert.throws(() => proseRejectSentence(file, { paragraph: 0, side: 'draft', sentence: 9 }), HttpError)
  // A whole-new paragraph has no before text to align against.
  assert.throws(() => proseRejectSentence(file, { paragraph: 5, side: 'draft', sentence: 0 }), HttpError)
  reset()
})

test('a failed sentence accept leaves the author\'s words on disk', () => {
  const { file, abs } = twoSentenceDraft('He shipped the oars. The swell ran black.\n\nSecond paragraph.\n')
  const working = fs.readFileSync(abs, 'utf8')
  // Nothing to accept at this identity — it throws before touching git.
  assert.throws(() => proseAcceptSentence(file, { paragraph: 0, side: 'main', sentence: 5 }), HttpError)
  assert.equal(fs.readFileSync(abs, 'utf8'), working, 'the working tree survives a refusal')
  reset()
})

test('a sentence appended after main\'s last one keeps a space at the seam', () => {
  // Real prose found this and no synthetic fixture had: the LAST sentence of a
  // version carries no trailing whitespace, so keeping it and then keeping
  // something after it used to produce `…backs.They sent…`.
  const { file } = twoSentenceDraft('He shipped the oars. The swell ran heavy. Salt burned.\n\nSecond paragraph.\n')
  proseAcceptSentence(file, { paragraph: 0, side: 'draft', sentence: 2 })
  const head = git(story, 'show', `HEAD:${file}`)
  assert.match(head, /ran heavy\. Salt burned\./, 'the seam must carry a space')
  assert.doesNotMatch(head, /heavy\.Salt/)
  reset()
})
