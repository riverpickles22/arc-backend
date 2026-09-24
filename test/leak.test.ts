// The leak gate proves the brief BEFORE the send (A67-7; agent-workflows §4,
// envelope rule 4).
//
// U4 and U5 are defined by not being shown the current prose, and the leak
// that existed before this gate was arc's own doing: the pass is handed the
// scene's open notes, and a note quotes the prose. The gate proves the
// assembled brief carries no span of the withheld set — the scene as it
// stands, less the locked paragraphs the pass is told to reproduce and the
// contract literals it is told to avoid — and refuses before a token.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
// Sets the story and the fixture engine before anything under src/ loads.
import { QUOTED_SENTENCE, SCENE, STORY, reset } from './fixture-scenarios.ts'

const { leaks, leakGate } = await import('../src/gates.ts')
const { withheldSet, runReroute, flattenPrompt, buildReroutePrompt } = await import('../src/reroute.ts')
const { ROW_EXPLORE_SCENE, ROW_EXPLORE_ROUTE } = await import('../src/registry.ts')
const { readWorkingReceipt } = await import('../src/run.ts')
const { proseScenes } = await import('../src/story.ts')
const { annotations } = await import('../src/annotations.ts')

const scene = () => proseScenes().find(s => s.scene === SCENE)!
const NOTE = path.join(STORY, 'annotations', 'note-005.yaml')

// ---- the row declares the set; the pass realises it -----------------------

test('the withheld set is defined on the ROW, not in the pass', () => {
  for (const row of [ROW_EXPLORE_SCENE, ROW_EXPLORE_ROUTE]) {
    assert.ok(row.withholding)
    assert.equal(row.withheld?.source, 'the scene as it stands')
    assert.deepEqual(row.withheld?.less, ['locked paragraphs', 'quoted contract literals'])
    assert.deepEqual(row.withheld?.plus, ['note quotes', 'touchstones drawn from the scene'])
    assert.equal(row.withheld?.spanWords, 8)
  }
  // A row that withholds nothing has no set, and the gate never runs for it.
  assert.equal(withheldSet({ ...ROW_EXPLORE_SCENE, withheld: undefined }, { sceneBody: 'x', locked: [], literals: [] }), undefined)
})

test('the set is the scene less what the pass is told to send: the locked paragraphs, and the quoted literals', () => {
  reset()
  const s = scene()
  const locked = 'The eighty-fourth was loose. It had been loose when she came and it would be loose when she left, and between those two facts she had learned to put her weight on the outer edge.'
  const set = withheldSet(ROW_EXPLORE_SCENE, { sceneBody: s.body, locked: [locked], literals: ['her sister'] })!
  assert.deepEqual(set.text, [s.body], 'the scene, and only the scene — a quote of it is a span of it')
  assert.deepEqual(set.allowed, [locked, 'her sister'])
  assert.equal(set.spanWords, 8)
})

// ---- the measure ----------------------------------------------------------

test('a span of the withheld set above the bar is a leak; an ordinary phrase is not', () => {
  const withheld = { text: ['She went down at nine to eat and up again at one, and it was at the one o\'clock turn.'], allowed: [], spanWords: 8 }
  const clean = leaks('A brief with nothing of the scene in it at all.', withheld)
  assert.deepEqual(clean, [])

  const quoted = leaks('The author says: "She went down at nine to eat and up again at one" — work from that.', withheld)
  assert.equal(quoted.length, 1, 'one finding for one quoted passage, not one per window inside it')
  assert.equal(quoted[0].span, 'she went down at nine to eat and up again at one', 'the whole run that leaked')

  // Seven words of it is under the bar, and stays under.
  assert.deepEqual(leaks('the note says she went down at nine to eat, roughly', withheld), [])
  // Punctuation and case do not hide a leak.
  assert.equal(leaks('SHE WENT DOWN AT NINE, TO EAT — AND UP AGAIN AT ONE!', withheld).length, 1)
})

test('a locked paragraph in the brief does not fire the gate', () => {
  const locked = 'The eighty-fourth was loose and it had been loose when she came, and it would be loose when she left.'
  const withheld = { text: [`Something before it.\n\n${locked}\n\nSomething after.`], allowed: [locked], spanWords: 8 }
  // The brief carries the locked paragraph on purpose: reproduced verbatim.
  assert.deepEqual(leaks(`=== LOCKED PARAGRAPHS ===\n${locked}`, withheld), [], 'what the row allows through is not a leak')
  // ...and an unlocked span of the same scene still is.
  assert.equal(leaks('the note quotes: Something before it. Something after. Something before it again and again', withheld).length, 0)
  const withMore = { ...withheld, text: [`${locked}\n\nA sentence of eight or more words that is not settled at all here.`] }
  assert.equal(leaks('A sentence of eight or more words that is not settled at all here.', withMore).length, 1)
})

test('the gate\'s record carries its measured value and its bar, and its refusal is an author sentence', () => {
  const withheld = { text: ['She had counted forty-one steps before she let herself hear it at all.'], allowed: [], spanWords: 8 }
  const held = leakGate('a brief with none of it', withheld, 1, 'late-entry-1')
  assert.equal(held.record.verdict, 'held')
  assert.equal(held.record.stage, 'brief', 'before the send')
  // Measured and bar in the same units: passages leaked, against none
  // allowed. The span length is in the bar's description.
  assert.equal(held.record.bar, 0)
  assert.equal(held.record.measured, 0)
  assert.match(String(held.record.bar_from), /no run of 8 consecutive words/)
  assert.equal(held.record.launch, 'late-entry-1')
  assert.equal(held.reason, undefined)

  const fired = leakGate('the note says "She had counted forty-one steps before she let herself hear it"', withheld, 1)
  assert.equal(fired.record.verdict, 'refused')
  assert.equal(fired.record.measured, 1, 'one passage leaked')
  assert.equal(fired.record.bar, 0, 'against none allowed')
  assert.ok(Array.isArray(fired.record.measured_against))
  assert.match(fired.reason!, /a piece of the scene it is meant to work without/)
  assert.match(fired.reason!, /ask again\.$/, 'ending in the next keystroke')
  assert.doesNotMatch(fired.reason!, /gate|span|brief|token/i, 'and carrying no machine word')
})

// ---- end to end, on the worked example ------------------------------------

async function routeWithNote(open: boolean): Promise<{ refused: string | null; run: string }> {
  reset()
  if (open) {
    const text = fs.readFileSync(NOTE, 'utf8')
    fs.writeFileSync(NOTE, text.replace(/^status: resolved$/m, 'status: open'))
  }
  const out = await runReroute({ scene: SCENE, count: 1 })
  return { refused: out.refused[0]?.reason ?? null, run: out.run! }
}

test('a seeded author note quoting the scene fires the gate, before anything is sent', async () => {
  const { refused, run } = await routeWithNote(true)
  assert.ok(refused, 'the request was refused')
  assert.match(refused!, /a piece of the scene it is meant to work without/)
  assert.match(refused!, new RegExp(QUOTED_SENTENCE.split(' ').slice(0, 6).join(' '), 'i'), 'and says which piece')

  const receipt = readWorkingReceipt(run)!
  assert.equal(receipt.ending, 'refused')
  const gate = receipt.gates!.find(g => g.gate === 'leak')!
  assert.equal(gate.verdict, 'refused')
  assert.equal(gate.stage, 'brief')
  assert.equal(gate.attempt, 1)
  assert.equal(receipt.answers, undefined, 'nothing was ever answered')
  assert.equal(receipt.gates!.filter(g => g.gate === 'leak').length, 1, 'and no repair was attempted: the fix is the author\'s note, not the model\'s')
})

test('with the note resolved, the same route lands and the gate holds with its measure under the bar', async () => {
  const { refused, run } = await routeWithNote(false)
  assert.equal(refused, null)
  const receipt = readWorkingReceipt(run)!
  assert.equal(receipt.ending, 'landed')
  const gate = receipt.gates!.find(g => g.gate === 'leak')!
  assert.equal(gate.verdict, 'held')
  assert.equal(gate.measured, 0)
  assert.equal(gate.bar, 0)
})

test('the rewrite may be shown the route it is rewriting: a span of the scene that survived into a landed route is its subject, not a leak', async () => {
  const { runRevise, listAlternatives } = await import('../src/reroute.ts')
  const { addRouteNote } = await import('../src/reroute.ts')
  reset()
  // A route that legitimately carries a sentence of the scene — under the
  // overlap bar, so it landed.
  const s = scene()
  const carried = s.body.split('\n\n')[3]
  const { writeAlternative } = await import('../src/reroute.ts')
  writeAlternative({
    id: 'alt-deadbeef', scene: SCENE, seed: 'late-entry', based_on: 'x', created_at: new Date().toISOString(),
    body: `A different opening entirely, in words of its own.\n\n${carried}\n\nAnd out again by another door.`,
    briefing: 'argued', coverage: null, overlap: 0.2, run: 'run.0001',
  })
  addRouteNote(SCENE, 'alt-deadbeef', 'colder in the lamp room', null)
  const out = await runRevise({ scene: SCENE, alt: 'alt-deadbeef' })
  // The fixture engine has no answer for this brief, so it cannot land —
  // but it must not be REFUSED by the leak gate for carrying its own
  // subject.
  assert.doesNotMatch(out.refused[0]?.reason ?? '', /a piece of the scene it is meant to work without/,
    'the route it is rewriting is not withheld from it')
  assert.equal(listAlternatives(SCENE).some(a => a.id === 'alt-deadbeef'), true)
})

test('the brief a landing route sends carries the locked paragraph and no other span of the scene', () => {
  reset()
  const s = scene()
  const kps = annotations().filter(a => a.kind === 'keypoint' && a.anchor.scene === SCENE)
  assert.ok(kps.length > 0)
  // The brief as the pass assembles it, with the note resolved.
  const prompt = buildReroutePrompt({
    scene: s, pack: 'PACK', style: 'STYLE', siblings: '', notes: [],
    destination: ['x'], knownRoute: 'k', inferred: '',
    locked: [{ paragraph: 1, text: s.body.split('\n\n')[1] }],
    seed: { id: 's', text: 'SEED' },
  })
  const set = withheldSet(ROW_EXPLORE_SCENE, { sceneBody: s.body, locked: [s.body.split('\n\n')[1]], literals: [] })!
  assert.deepEqual(leaks(flattenPrompt(prompt), set), [], 'the locked paragraph is allowed; nothing else of the scene is there')
})
