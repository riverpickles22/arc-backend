// WHAT THE AUTHOR READS WHEN SOMETHING WOULD NOT GO IN (A72-11).
//
// Two checks live here. The first is the translation A69-12's walk asked
// for: the story validator's own summary line, turned into a sentence about
// the author's book. The second is the boundary itself — a sweep over the
// sentences arc's code actually renders, against arc-core's shared reading
// of what a diagnostic looks like. It is a TEST, not a filter: nothing in
// arc scans a message on its way out, and nothing here is applied to the
// author's prose, their quotes, or a receipt they deliberately opened.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { diagnosticComplaint, diagnosticsIn } from 'arc-canon-graph/author-language.ts'
import { makeStory } from './fixture.ts'

const STORY = makeStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

const { readValidatorOutput, findingSentence, validatorSentence, validatorDetail, landedThenFailed } = await import('../src/refusal.ts')
const { outcomeSentence } = await import('../src/run.ts')
const { overreachSentence } = await import('../src/blast-radius.ts')
const { inspectReply } = await import('../src/inspect.ts')
const { movedSentence } = await import('../src/landing.ts')
const { GATES } = await import('../src/gates.ts')
const { gateCtx } = await import('../src/reroute.ts')

/** What `validate.py` prints when a draft names an id the record lacks. */
const FAILED = `FAIL — 1 finding(s):
  ${STORY}/prose/ch-01/scene-01.md: scene sc.01-1: unresolved binding id: char.nobody-at-all`

const clean = (s: string) => assert.deepEqual(diagnosticsIn(s), [], diagnosticComplaint(s, diagnosticsIn(s)))

/** HOW MANY REFUSALS STILL NAME A FILE instead of the scene it holds. A
 *  standing debt, counted so it cannot grow: every one of these is a writer
 *  being handed a path. A72-11 closed what it owned — the validator's
 *  summary line, the material edit, the canon layer's note, the landing
 *  paths, the canon export, the two "not a git repository" sentences — and
 *  recorded the rest here rather than claiming the surface is clean. */
const PATHS_STILL_NAMED = 16

// ---- the validator, translated ------------------------------------------------

test('the story\'s own check is read, not quoted: the path and the summary line go, the fault stays', () => {
  const findings = readValidatorOutput(FAILED)
  assert.equal(findings.length, 1, 'the FAIL line is a summary, not a finding')
  assert.equal(findings[0].scene, 'sc.01-1')
  assert.equal(findings[0].said, 'unresolved binding id: char.nobody-at-all')
  assert.ok(!findings[0].said.includes(STORY), 'and no path survives it')
})

test('each fault a draft can cause has a sentence about the author\'s book', () => {
  const said = (s: string) => findingSentence({ scene: 'sc.01-1', said: s })
  assert.equal(said('unresolved binding id: char.nobody'), 'it names char.nobody, which your record does not hold')
  assert.equal(said('satisfies names unknown material: mat.lamp'), 'it says it answers mat.lamp, which your record does not hold')
  assert.equal(said('unresolved wikilink: [[the keeper]]'), 'it links to the keeper, which your record does not hold')
  assert.equal(said('frontmatter canon id unresolved: place.nowhere'), 'its heading names place.nowhere, which your record does not hold')
  assert.match(said('scene frontmatter: pov: is not of type string'), /its heading is not the shape/)
  assert.match(said('duplicate scene id sc.01-1'), /a scene name your book already has/)
  assert.match(said('line 4: a scene holds the prose and its frontmatter, nothing else — report here'), /not the scene/)
  // and a fault arc has no sentence for says only what it can support
  assert.equal(said('something arc has never seen'), 'your story\'s own check would not take it')
})

test('the refusal the author reads names the fault and the next thing to do — never the check\'s own summary', () => {
  const sentence = validatorSentence(FAILED)
  assert.match(sentence, /that draft does not fit your record — it names char\.nobody-at-all, which your record does not hold\. Nothing was written; ask again\./)
  clean(sentence)
  assert.doesNotMatch(sentence, /FAIL|finding\(s\)/)

  // several faults: a count, not a list — a sentence of five faults is read as none
  const many = `FAIL — 3 finding(s):\n  ${STORY}/prose/ch-01/scene-01.md: scene sc.01-1: unresolved binding id: a.one\n  ${STORY}/prose/ch-01/scene-01.md: scene sc.01-1: unresolved binding id: a.two\n  ${STORY}/prose/ch-01/scene-01.md: scene sc.01-1: unresolved binding id: a.three`
  assert.match(validatorSentence(many), /it names a\.one, which your record does not hold \(and 2 other things the check named\)/)
  clean(validatorSentence(many))

  // a fault arc has no sentence for still says something true and nothing
  // it cannot support — and an answer with no findings at all says so too
  assert.match(validatorSentence('the tool fell over'), /your story's own check would not take it/)
  clean(validatorSentence('the tool fell over'))
  assert.match(validatorSentence('FAIL — 0 finding(s):'), /would not take that draft/)
  clean(validatorSentence('FAIL — 0 finding(s):'))
})

test('the check\'s own words are kept for the receipt, where the author opens them on purpose', () => {
  const detail = validatorDetail(FAILED)
  assert.equal(detail, 'unresolved binding id: char.nobody-at-all', 'the trade\'s language, the machinery stripped')
  assert.ok(!detail.includes(STORY))
})

// ---- the claim that has to be true ---------------------------------------------

test('"nothing was written" is a statement about the disk, and only the paths that wrote nothing make it', () => {
  const SRC = path.join(import.meta.dirname, '..', 'src')
  const claims = fs.readdirSync(SRC).filter(f => f.endsWith('.ts'))
    .filter(f => /nothing was written/i.test(fs.readFileSync(path.join(SRC, f), 'utf8')))
  // WHAT THIS PROVES, exactly: no NEW module starts making the claim
  // without someone reading it against its own write path. The modules
  // below were read when this was written — the gates refuse before the
  // write by construction, `story.ts`'s two are before any write (the
  // material edit puts the file back first; the paragraph count is checked
  // before anything is merged), and the lane, which is the one place that
  // commits, is not on the list and must never join it.
  const ALLOWED = new Set([
    'blast-radius.ts', 'capability.ts', 'draft.ts', 'engine.ts', 'gates.ts', 'redraft.ts',
    'refusal.ts', 'request.ts', 'reroute.ts', 'story.ts', 'suggest.ts', 'work-notes.ts',
  ])
  for (const f of claims) {
    assert.ok(ALLOWED.has(f), `${f} says "nothing was written" — if it can say so after a write has landed, it must say what landed instead (A72-11)`)
  }
  // and the lane, which is the one place that commits, never says it
  assert.ok(!claims.includes('lane.ts'), 'the lane commits; it cannot claim nothing was written')
  // the sentence for the other case exists and says the opposite plainly
  const after = landedThenFailed('the note it answered is still open')
  assert.match(after, /your words are in the book/)
  assert.doesNotMatch(after, /[Nn]othing was written/)
  clean(after)
})

// ---- the sweep: what arc's own code renders -------------------------------------

test('no refusal sentence in src carries a diagnostic — interpolated ones included', () => {
  // THE SHAPE THAT CAN LEAK is the one that interpolates: a literal cannot
  // carry a tool's words, and a template can. Each `${…}` is replaced by
  // what a tool actually says there — the validator's summary line — and
  // the result read the way the author would read it.
  const SRC = path.join(import.meta.dirname, '..', 'src')
  // WHAT EACH HOLE COULD HOLD, by what the expression reads: a tool's own
  // answer, a path, or something of the author's. Substituting the tool's
  // words everywhere would flag a scene id as a leak and prove nothing.
  const fill = (expr: string): string =>
    /output|stderr|stdout|\bmessage\b|\berr\b|Error|check\./i.test(expr) ? 'FAIL — 1 finding(s):'
      : /\bfile\b|\bpath\b|\babs\b|\brel\b/i.test(expr) ? 'prose/ch-01/scene-01.md'
        : 'that'
  const leaks: string[] = []
  const namesAFile: string[] = []
  for (const f of fs.readdirSync(SRC).filter(x => x.endsWith('.ts'))) {
    const body = fs.readFileSync(path.join(SRC, f), 'utf8')
    for (const m of body.matchAll(/(?:HttpError\([0-9]+,\s*|refuse\(\s*|reason:\s*)`([^`]{20,400})`/g)) {
      const rendered = m[1].replace(/\$\{([^}]*)\}/g, (_, e: string) => fill(e))
      const d = diagnosticsIn(rendered)
      if (!d.length) continue
      // A SENTENCE THAT NAMES THE FILE is a different debt from one that
      // quotes a tool: the writer has scenes, and these say `prose/…`
      // instead. They are counted rather than tolerated — the number may
      // only fall, like the seam ratchet, and A72-11 closed the two that
      // mattered (the validator's summary and the canon layer's note).
      if (d.every(x => x.kind === 'a path into the machinery')) namesAFile.push(`${f}: ${rendered}`)
      else leaks.push(`${f}: ${diagnosticComplaint(rendered, d)}`)
    }
  }
  assert.deepEqual(leaks, [], `a tool's own words reach the author:\n${leaks.join('\n')}`)
  assert.ok(namesAFile.length <= PATHS_STILL_NAMED,
    `${namesAFile.length} refusals name a file where they could name the scene, more than the ${PATHS_STILL_NAMED} recorded:\n${namesAFile.join('\n')}`)
  assert.equal(namesAFile.length, PATHS_STILL_NAMED,
    `${namesAFile.length} refusals name a file, fewer than the ${PATHS_STILL_NAMED} recorded — lower PATHS_STILL_NAMED in the same change:\n${namesAFile.join('\n')}`)
})

test('no literal refusal sentence in src carries a diagnostic', () => {
  // The sweep below reads what the renderers PRODUCE; this reads what the
  // code SAYS — every sentence handed straight to the author as a refusal.
  // It caught two ("this story is not a git repository") that no rendered
  // path in the sweep reaches, because they refuse before any run exists.
  const SRC = path.join(import.meta.dirname, '..', 'src')
  const found: string[] = []
  for (const f of fs.readdirSync(SRC).filter(x => x.endsWith('.ts'))) {
    const body = fs.readFileSync(path.join(SRC, f), 'utf8')
    for (const m of body.matchAll(/(?:HttpError\([0-9]+, |refuse\(|reason: )[`']([^`']{30,240})[`']/g)) {
      const d = diagnosticsIn(m[1])
      if (d.length) found.push(`${f}: ${diagnosticComplaint(m[1], d)}`)
    }
  }
  assert.deepEqual(found, [], found.join('\n'))
})


test('every sentence arc renders for a refusal is the author\'s language', () => {
  const ctx = gateCtx({
    sceneName: 'sc.01-1', sceneBody: 'One.\n\nTwo.', sceneLocks: [], lockedTexts: ['Two.'],
    literals: ['the light'], andCap: 3, wordCap: 20, destination: ['the wreck is known'], known: [],
  })
  const answer = { body: 'One.\n\nTwo, rewritten.', prose: 'One.\n\nTwo, rewritten.', briefing: '', coverage: null, dropped: [], returned: 0, overlap: null, leansOn: null }
  const sentences: string[] = [
    // every ending the run can have
    ...(['refused', 'could not run', 'timed out', 'budget', 'unreadable', 'cancelled', 'unfinished'] as const)
      .map(ending => outcomeSentence({ ending, gates: [] }) ?? ''),
    // a refusal from each gate that can produce one here
    ...Object.entries(GATES).map(([id, fn]) => {
      try {
        const v = fn(ctx, answer as never)
        return v.verdict === 'refused' ? `${id}: ${v.reason}` : ''
      } catch { return '' }
    }),
    // THE WALK'S OWN CASE (A69-12): the validator gate, with a check that
    // actually refused. This is the sentence that read *the answer did not
    // validate (FAIL — 1 finding(s): …)* before this card.
    (() => {
      const v = GATES.validator!({ ...ctx, validate: () => ({ ok: false, output: FAILED }) }, answer as never)
      assert.equal(v.verdict, 'refused')
      assert.equal(v.record.measured, 'unresolved binding id: char.nobody-at-all', 'and the check\'s own words are on the record')
      return v.verdict === 'refused' ? v.reason : ''
    })(),
    // and the sentences the passes render themselves
    validatorSentence(FAILED),
    overreachSentence(['¶3', 'a new paragraph before ¶1']),
    inspectReply(2, 1), inspectReply(0, 3), inspectReply(0, 0),
    movedSentence('sc.01-1'),
  ].filter(Boolean)

  assert.ok(sentences.length >= 12, `the sweep found ${sentences.length} sentences — too few to be reading what arc renders`)
  for (const s of sentences) {
    const found = diagnosticsIn(s.replace(/^[\w-]+: /, ''))
    assert.deepEqual(found, [], diagnosticComplaint(s, found))
  }
})
