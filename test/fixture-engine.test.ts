// The fixture engine (A67-9): a recorded answer keyed by the fingerprint of
// the rendered brief. No key, no subscription, no model — every property
// here holds because the engine recognises a brief or refuses.
//
// Two things are under test. The engine itself: chosen only when asked for,
// a miss names the fingerprint, nothing is invented. And the fixtures: each
// one's recorded fingerprint is what its scenario renders TODAY, and the
// gate does with its answer what the fixture says. The first half is what
// makes a brief edit a test failure — change a word of the U4 row's rules in
// registry.ts and its fixtures fail here, naming the fingerprint that moved.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
// Sets the story and the engine before anything under src/ loads.
import type { RerouteResponse } from 'arc-canon-graph/api-types.ts'
import type { BriefSeen } from '../src/fixtures.ts'
import { SCENARIOS, SCENE, STORY, QUOTED_SENTENCE, STRAY_CLAIM, renderScenario } from './fixture-scenarios.ts'
import { paragraphsOf } from 'arc-canon-graph/annotations.ts'
import type { RouteAlternative } from 'arc-canon-graph/api-types.ts'

const { chooseEngine, currentEngine } = await import('../src/engine.ts')
const { briefFingerprint, loadFixtures, runFixturePrompt, FixtureMiss, FIXTURES_DIR } = await import('../src/fixtures.ts')
const { MAX_OVERLAP, buildDestination, sceneKeypoints } = await import('../src/reroute.ts')
const { ROW_EXPLORE_SCENE } = await import('../src/registry.ts')
const ROW_RULES_HEAD = ROW_EXPLORE_SCENE.rules.slice(0, 40)
const { annotations } = await import('../src/annotations.ts')
const { proseScenes } = await import('../src/story.ts')

// ---- the engine ------------------------------------------------------------

test('the fixture engine is chosen only when asked for', () => {
  assert.equal(chooseEngine({ ARC_DRAFT_ENGINE: 'fixture', ANTHROPIC_API_KEY: 'k' }, true), 'fixture')
  assert.equal(chooseEngine({ ANTHROPIC_API_KEY: 'k' }, true), 'sdk', 'a key never picks the fixture')
  assert.equal(chooseEngine({}, true), 'claude-cli', 'the CLI never picks the fixture')
  assert.equal(chooseEngine({}, false), null, 'and with nothing configured there is no engine, not a fixture')
  assert.equal(currentEngine(), 'fixture')
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined)
  assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, undefined)
})

test('a brief the store has never seen is refused with its fingerprint named — the fixture invents nothing', async () => {
  const brief = 'a brief nobody recorded'
  const fp = briefFingerprint(brief)
  assert.match(fp, /^[0-9a-f]{16}$/)
  await assert.rejects(runFixturePrompt(brief, { row: 'explore.scene.one-shot' }), (e: unknown) => {
    assert.ok(e instanceof FixtureMiss)
    assert.equal(e.fingerprint, fp)
    assert.match(e.message, new RegExp(`explore\\.scene\\.one-shot brief ${fp}`))
    assert.match(e.message, /fixtures:rekey/, 'the refusal says what to do when the change was meant')
    return true
  })
})

test('under the fixture engine an unrowed pass refuses before the SDK, even with a key in the environment', async () => {
  const { getClient } = await import('../src/agent.ts')
  const { runAnalysis } = await import('../src/analyze.ts')
  process.env.ANTHROPIC_API_KEY = 'a-key-that-must-never-be-used'
  try {
    assert.throws(() => getClient(), /this pass has no fixture/)
    // analyze is unrowed until slice 3: a draft change exists once the fixture
    // scenarios have run, so the only thing between it and the SDK is this.
    await assert.rejects(runAnalysis(), (e: unknown) => /this pass has no fixture|no draft changes/.test((e as Error).message))
  } finally {
    delete process.env.ANTHROPIC_API_KEY
  }
})

test('the fingerprint is exact: a changed byte is a changed brief', () => {
  assert.notEqual(briefFingerprint('the brief'), briefFingerprint('the brief '))
  assert.equal(briefFingerprint('the brief'), briefFingerprint('the brief'))
})

test('every fixture on disk has a scenario, and every scenario a fixture', () => {
  const onDisk = loadFixtures().map(f => `${f.row}/${f.name}`).sort()
  // Every scenario that REACHES the engine has a recorded answer; the leak
  // scenarios refuse before the send and have none (A67-7).
  const scripted = SCENARIOS.filter(s => s.expect !== 'leak').map(s => `${s.row}/${s.name}`).sort()
  assert.deepEqual(onDisk, scripted, `fixtures in ${FIXTURES_DIR} and the scenarios that send a brief must pair one to one`)
  for (const s of SCENARIOS.filter(x => x.expect !== 'leak')) {
    const f = loadFixtures().find(x => x.row === s.row && x.name === s.name)!
    assert.equal(f.expect, s.expect, `${s.row}/${s.name}: the fixture's expect field and the scenario disagree`)
    assert.match(f.fingerprint, /^[0-9a-f]{16}$/, `${s.row}/${s.name} has no recorded fingerprint — run npm run fixtures:rekey`)
  }
})

test('U4 and U5 each ship the scenarios the slice needs: one that lands, one the leak gate fires on, one the overlap gate refuses, one with a coverage claim to drop', () => {
  for (const row of ['explore.scene.one-shot', 'explore.route.one-shot']) {
    assert.deepEqual(SCENARIOS.filter(s => s.row === row).map(s => s.expect).sort(), ['coverage-drop', 'lands', 'leak', 'overlap'], row)
    // Three of the four send a brief and have a recorded answer; the leak
    // is refused before the send, so it has none.
    assert.deepEqual(loadFixtures().filter(f => f.row === row).map(f => f.expect).sort(), ['coverage-drop', 'lands', 'overlap'], row)
  }
})

// ---- the scene the fixtures run against ------------------------------------

const scene = () => proseScenes().find(s => s.scene === SCENE)!
const lockedParagraph = () => paragraphsOf(scene().body)[1]

test('the example scene carries what the slice has to prove against', () => {
  const s = scene()
  assert.ok(s, 'arc-core/examples/example-story ships sc.01-1')
  const literals = (s.contract?.must_withhold ?? []).map(String).filter(x => /^".*"$/.test(x))
  assert.deepEqual(literals, ['"her sister"'], 'a quoted withhold the gate can prove')
  assert.doesNotMatch(s.body, /her sister/)
  const kps = sceneKeypoints(SCENE, annotations())
  assert.equal(kps.author.length, 3, 'three author-marked key points')
  assert.equal(kps.agent.length, 1, "one of arc's own, which binds nothing")
  assert.equal(buildDestination(s.contract, kps.author).length, 6, 'the destination: the contract plus the author beats')
  assert.match(lockedParagraph(), /^The eighty-fourth was loose\./, 'the second paragraph is the locked one')
  assert.ok(s.body.includes(QUOTED_SENTENCE), 'the sentence the author note quotes is in the prose')
  assert.ok(!lockedParagraph().includes(QUOTED_SENTENCE), 'and not in the locked paragraph, so it is withheld')
})

// ---- each fixture: the brief it was recorded for, and what the gate does --

const expectLanded = (alt: RouteAlternative | undefined, refused: { reason: string }[]): RouteAlternative => {
  assert.deepEqual(refused, [], 'nothing refused')
  assert.ok(alt, 'one route landed')
  assert.ok(alt.body.includes(lockedParagraph()), 'the locked paragraph survives verbatim')
  assert.doesNotMatch(alt.body, /her sister/, 'the quoted withhold never appears')
  assert.notEqual(alt.overlap, null, 'the overlap gate could judge')
  assert.ok((alt.overlap as number) <= MAX_OVERLAP, `overlap ${alt.overlap} under the bar ${MAX_OVERLAP}`)
  assert.ok(alt.coverage && alt.coverage.length >= 6, 'every required beat has a coverage row')
  return alt
}

/** THE OTHER HALF OF arc-core's `test_example_writing_layers.py` (A69-1).
 *  That test proves the example still HOLDS what a writing brief reads; this
 *  one proves the brief actually CARRIES it. They are different claims: an
 *  object reaches a drafting context only through the POV's possessions at T,
 *  and an edge only when both endpoints are already in, so a proposed fact
 *  can be perfectly valid on disk and in no brief at all. */
test("the example's proposed fact reaches the brief, so a status layer has something to tag", async () => {
  const lands = SCENARIOS.find(s => s.row === 'explore.scene.one-shot' && s.name === 'lands')!
  const { seen } = await renderScenario(lands)
  const brief = seen[0]?.brief ?? ''
  assert.ok(brief.includes('obj.keepers-log'),
    'the proposed object is in the rendered brief — if this fails, it is reachable from nothing the pack walks')
  assert.ok(brief.includes('rel.ines-log'),
    'and so is the proposed edge, which needs both endpoints included')
})

for (const s of SCENARIOS) {
  test(`${s.row}/${s.name}: the brief is the one recorded, and the gate does what the fixture says`, async () => {
    const fixture = loadFixtures().find(f => f.row === s.row && f.name === s.name)
    // Route rows today; the harness itself is row-agnostic (A69-1).
    const { seen, result } = await renderScenario(s) as { seen: BriefSeen[]; result: RerouteResponse }

    // The leak scenario never reaches the engine: the gate proves the brief
    // and refuses before the send (A67-7), so there is no brief to compare
    // and no recorded answer to pair with.
    if (s.expect === 'leak') {
      assert.equal(seen.length, 0, 'nothing was sent')
      assert.equal(fixture, undefined, 'and nothing is recorded for it')
      assert.deepEqual(result.alternatives, [])
      assert.equal(result.refused.length, 1)
      assert.match(result.refused[0].reason, /a piece of the scene it is meant to work without/)
      return
    }

    assert.ok(fixture, `${s.row}/${s.name} has a recorded answer`)
    assert.ok(seen.length >= 1, 'the pass reached the fixture engine')
    const rendered = seen[0]
    assert.equal(rendered.fingerprint, fixture.fingerprint,
      `the ${s.row} brief for "${s.name}" changed: recorded ${fixture.fingerprint}, rendered ${rendered.fingerprint}. ` +
      `A rule, a slice layer or the example scene moved. If that was meant, run \`npm run fixtures:rekey\` and review the diff (${path.relative(process.cwd(), fixture.file)}).`)

    // WHAT THE BRIEF MAY CARRY IS THE ROW'S BUSINESS, not the harness's.
    // A withholding route row is shown none of the scene but its locked
    // paragraph — U4's whole premise. A drafting row is writing a scene that
    // does not exist; there is no current prose for it to be kept from, and
    // asserting otherwise would be testing the harness's memory of slice 1.
    if (s.row.startsWith('explore.')) {
      const paras = paragraphsOf(scene().body)
      paras.forEach((p, i) => {
        if (i === 1) assert.ok(rendered.brief.includes(p), 'the locked paragraph is in the brief, verbatim')
        else assert.ok(!rendered.brief.includes(p), `paragraph ${i + 1} of the manuscript reached the brief`)
      })
    }

    // A READING ANSWERS WITH A PLAN. The craft-plan stage writes nothing and
    // returns one line for the author to read, edit or drop (A69-4) — and
    // the one thing it must never contain is the word they said.
    if (s.row.endsWith('.craft-plan')) {
      const out = result as unknown as { file: string | null; run?: string; reply: string; plan?: { moves: { move: string; how: string }[] } }
      assert.ok(out.run, 'the reading is a run of its own, with its own receipt')
      assert.equal(out.file, null, 'and it writes nothing')
      assert.ok(out.plan?.moves.length, 'it answers with craft moves')
      assert.match(out.reply, /^Writing toward: /, 'shown to the author as one line')
      assert.ok(!/dread/i.test(JSON.stringify(out.plan)),
        'and never names the effect — a pass told to write dread writes about dread')
      return
    }

    // A draft answers with a file, not with routes, and is read on its own
    // terms (A69-3).
    if (s.row.startsWith('draft.')) {
      const draft = result as unknown as { file: string | null; run?: string; reply: string }
      assert.ok(draft.run, 'the response names the run that made it')
      if (s.expect === 'lands') {
        assert.equal(draft.file, 'prose/ch-01/scene-02.md', 'the scene is waiting in the draft layer')
        assert.match(draft.reply, /accept or discard/, 'and the author is told the next move')
      } else {
        assert.equal(draft.file, null, 'nothing was written')
        assert.match(draft.reply, /would not keep it|could not run|does not fit your record|did not check out/,
          'and the refusal says so in the author\'s words')
      }
      return
    }

    switch (s.expect) {
      case 'lands':
        expectLanded(result.alternatives[0], result.refused)
        assert.ok(!rendered.brief.includes(QUOTED_SENTENCE), 'and no note quote leaked into it')
        break
      case 'overlap':
        assert.deepEqual(result.alternatives, [], 'nothing lands')
        assert.equal(result.refused.length, 1)
        assert.match(result.refused[0].reason, /^reused \d+% of the current wording/, 'the overlap gate refused, and said so')
        // The one repair the pass attempts is a second brief; the fixture
        // engine has no answer for it and says so. A67-6 moves the repair
        // into the gate runner, where its fixture is recorded.
        assert.equal(seen.length, 2, 'one repair was attempted')
        assert.match(result.refused[0].reason, /arc tried once more, and: that pass ended before it answered/, 'the repair could not be answered, and the author is told so in words')
        break
      case 'coverage-drop': {
        const alt = expectLanded(result.alternatives[0], result.refused)
        // The claim named a beat the destination never held: dropped, and
        // counted by reason (A67-8) — never shown beside the required ones.
        assert.ok(!alt.coverage!.some(c => c.item === STRAY_CLAIM), 'the stray claim is not among the required beats')
        assert.deepEqual(alt.dropped, [{ reason: 'unresolvable', count: 1 }], 'and the count is on the route, where the route is')
        break
      }
    }
  })
}

test('a dry run renders the slice and the brief, consults no engine, and needs none', async () => {
  const { runReroute } = await import('../src/reroute.ts')
  const { STORY: story } = await import('./fixture-scenarios.ts')
  void story
  const engine = process.env.ARC_DRAFT_ENGINE
  process.env.ARC_DRAFT_ENGINE = 'none'
  try {
    const seen: string[] = []
    const { observeBriefs } = await import('../src/fixtures.ts')
    const stop = observeBriefs(b => seen.push(b.fingerprint))
    const out = await runReroute({ scene: SCENE, count: 2, dry: true })
    stop()
    assert.deepEqual(out.alternatives, [])
    assert.deepEqual(out.refused, [])
    assert.equal(out.briefs?.length, 2, 'one rendered brief per seed')
    assert.ok(out.briefs![0].startsWith(ROW_RULES_HEAD), 'the brief opens with the row\'s rules')
    assert.deepEqual(seen, [], 'no engine was consulted')
  } finally {
    process.env.ARC_DRAFT_ENGINE = engine
  }
})

test('the story copy is the example as shipped, not the tests\' augmented one', () => {
  assert.ok(!proseScenes().some(s => s.scene === 'sc.02-1'), `${STORY} must hold only the example's own prose`)
})
