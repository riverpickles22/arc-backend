// The scenarios behind every recorded answer in fixtures/ (A67-9).
//
// A fixture is a brief the engine has seen before, and a brief is rendered by
// the pass from the story — so the only honest way to know a fixture's
// fingerprint is to run the pass and watch what reaches the seam. This module
// is that: one scenario per fixture, each a story state plus a request, run
// against the worked example under the fixture engine with the seam observed.
// Two consumers share it so they cannot disagree: fixture-engine.test.ts
// asserts the recorded fingerprint is still what the scenario renders, and
// rekey-fixtures.ts records it when a brief has deliberately changed.
//
// Importing this module sets the environment, because config resolves the
// story at load: import it before anything under src/.
import fs from 'node:fs'
import path from 'node:path'
import type { RouteAlternative } from 'arc-canon-graph/api-types.ts'
// type-only, so nothing under src/ loads before the environment is set
import type { BriefSeen } from '../src/fixtures.ts'
import type { RowKey } from '../src/registry.ts'
import { copyExampleStory, git } from './fixture.ts'

export const STORY = copyExampleStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'fixture'
// No author layer: the brief must be the example's own, on any machine.
process.env.ARC_AUTHOR_STYLE = path.join(STORY, 'no-author-layer.md')
// And no key, no subscription — the whole point of the engine.
delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_AUTH_TOKEN

const { runReroute, runRevise, addRouteNote } = await import('../src/reroute.ts')
const { runDraft } = await import('../src/draft.ts')
const { runRedraft } = await import('../src/redraft.ts')
const { runWorkNotes } = await import('../src/work-notes.ts')
const { runSuggest } = await import('../src/suggest.ts')
const { createAnnotation } = await import('../src/annotations.ts')
const { ROWS, rowKey } = await import('../src/registry.ts')
const { observeBriefs } = await import('../src/fixtures.ts')

export const SCENE = 'sc.01-1'
/** The example's author note that quotes the prose — shipped resolved, so
 *  the pass is not handed it; the leak scenarios open it. */
const QUOTING_NOTE = path.join(STORY, 'annotations', 'note-005.yaml')
/** The sentence that note quotes: a span of the withheld prose. */
export const QUOTED_SENTENCE = 'a light that stopped turning was a light that lied'
/** The beat the coverage-drop answers claim and the destination never held. */
export const STRAY_CLAIM = 'The supply boat is a month out'

export interface Scenario {
  /** The row key, as the registry spells it (A69-1). `RowKey` is a string
   *  alias, not a union, and `test/` is not typechecked — so this buys no
   *  compile-time check and does not pretend to. What holds the line is the
   *  assertion below: every scenario must name a row that exists. The writing
   *  rows of slice 2 join by adding a scenario here; nothing else changes. */
  row: RowKey
  name: string
  /** what the fixture's `expect` field must say. `leak` is the one that
   *  never reaches the engine: the gate proves the brief and refuses before
   *  the send (A67-7), so the scenario carries no recorded answer. */
  expect: 'lands' | 'overlap' | 'coverage-drop' | 'leak' | 'validator-refused' | 'leaned-on' | 'lock-touched' | 'conflict-found'
  /** the story state and request, in one breath — copied into the fixture */
  scenario: string
  prepare?: () => Promise<void>
  /** What the pass returns. The harness only watches the briefs that reach
   *  the seam, so what comes back is the scenario's own business — a route
   *  response today, a drafting response when U1 has its row. */
  run: () => Promise<unknown>
}

/** ONE OPEN NOTE ON THE SCENE. The example ships keypoints on sc.01-1 —
 *  markers of what a passage must get across, never requests for change — so
 *  a notes revision has nothing to work until the author leaves a note. */
function oneNote(): void {
  createAnnotation({ scene: SCENE, paragraph: 4, quote: 'Then the log.', body: 'the log entry should cost her something', by: 'author' })
}

/** TWO NOTES THAT CANNOT BOTH BE SATISFIED. The reading's whole job. */
function opposedNotes(): void {
  createAnnotation({ scene: SCENE, paragraph: 0, quote: 'Ninety-one stairs.', body: 'more of the dog on the way up — he should be the reason she counts', by: 'author' })
  createAnnotation({ scene: SCENE, paragraph: 0, quote: 'Ninety-one stairs.', body: 'less of the dog here; he is doing too much work this early', by: 'author' })
}

/** The example exactly as committed: every edit and every route gone. */
export function reset(): void {
  git(STORY, 'checkout', 'HEAD', '--', '.')
  git(STORY, 'clean', '-fdxq')
}

function openTheQuotingNote(): void {
  const text = fs.readFileSync(QUOTING_NOTE, 'utf8')
  if (!/^status: resolved$/m.test(text)) throw new Error('the example note-005 is no longer shipped resolved')
  fs.writeFileSync(QUOTING_NOTE, text.replace(/^status: resolved$/m, 'status: open'))
}

/** A landed U4 route on the example scene, for the U5 scenarios to rewrite.
 *  Depends on the explore.scene.one-shot/lands fixture being recorded — which is why the
 *  scenarios below are ordered, and why rekey runs them in order. */
async function landedRoute(): Promise<RouteAlternative> {
  const res = await runReroute({ scene: SCENE, count: 1 })
  const alt = res.alternatives[0]
  if (!alt) throw new Error(`no route landed to rewrite: ${res.refused.map(r => r.reason).join('; ')}`)
  return alt
}

const rewrite = (name: string, expect: Scenario['expect'], scenario: string, note: string, paragraph: number | null): Scenario => {
  let parent: RouteAlternative | undefined
  return {
    row: 'explore.route.one-shot', name, expect, scenario,
    prepare: async () => {
      parent = await landedRoute()
      addRouteNote(SCENE, parent.id, note, paragraph)
    },
    run: () => runRevise({ scene: SCENE, alt: parent!.id }),
  }
}

export const SCENARIOS: Scenario[] = [
  {
    row: 'explore.scene.one-shot', name: 'lands', expect: 'lands',
    scenario: 'the example scene as shipped; another way through, one route, no guidance',
    run: () => runReroute({ scene: SCENE, count: 1 }),
  },
  {
    row: 'explore.scene.one-shot', name: 'overlap', expect: 'overlap',
    scenario: 'the example scene as shipped; another way through with the guidance "keep every sentence you can" — the answer reuses the current wording and the overlap gate refuses it',
    run: () => runReroute({ scene: SCENE, count: 1, guidance: 'keep every sentence you can' }),
  },
  {
    row: 'explore.scene.one-shot', name: 'coverage-drop', expect: 'coverage-drop',
    scenario: 'the example scene as shipped; another way through with the guidance "give the supply boat a line" — the answer claims a beat the destination never held',
    run: () => runReroute({ scene: SCENE, count: 1, guidance: 'give the supply boat a line' }),
  },
  {
    row: 'explore.scene.one-shot', name: 'leak', expect: 'leak',
    scenario: 'the example scene with its quoting author note (note.005) open, so the brief would carry a sentence of the withheld prose; another way through, one route, no guidance. The leak gate refuses before the send, so nothing reaches the engine and there is no recorded answer.',
    prepare: async () => openTheQuotingNote(),
    run: () => runReroute({ scene: SCENE, count: 1 }),
  },
  rewrite('lands', 'lands',
    'the landed explore.scene.one-shot/lands route with one note on its third paragraph: "colder in the lamp room — let her feel the glass"; rewrite from the notes',
    'colder in the lamp room — let her feel the glass', 3),
  rewrite('overlap', 'overlap',
    'the landed explore.scene.one-shot/lands route with one note on the whole route: "bring the wording back toward the book\'s own" — the answer reuses the manuscript and the overlap gate refuses it',
    "bring the wording back toward the book's own", null),
  rewrite('coverage-drop', 'coverage-drop',
    'the landed explore.scene.one-shot/lands route with one note on its fifth paragraph: "the boat is a month out; say so" — the answer claims a beat the destination never held',
    'the boat is a month out; say so', 5),
  {
    row: 'draft.scene.one-shot.write', name: 'lands', expect: 'lands',
    scenario: 'the worked example as shipped; draft the next scene of ch.01, no line said',
    run: () => runDraft('ch.01-ninety-one-stairs'),
  },
  {
    row: 'draft.scene.one-shot.write', name: 'validator-refused', expect: 'validator-refused',
    scenario: 'the same story, with a craft plan the author settled, so the write stage runs on the second call; the answer binds a character canon does not hold, and the story\'s own validator refuses it',
    run: () => runDraft('ch.01-ninety-one-stairs', 'bring the inspector up the point', {
      moves: [{ move: 'structure', how: 'open on the arrival and let the watch come second' }],
    }),
  },
  {
    row: 'draft.scene.one-shot.write', name: 'leans-on-proposed', expect: 'leaned-on',
    scenario: 'the author said "lean on the log" and settled a plan naming it; the answer validates, and its briefing rests the prose on obj.keepers-log and rel.ines-log, both proposed — the leaned-on gate refuses',
    run: () => runDraft('ch.01-ninety-one-stairs', 'lean on the log', {
      moves: [{ move: 'inventory', how: 'name the log and its six columns; let the entry be the last thing she does' }],
    }),
  },
  {
    row: 'draft.scene.one-shot.craft-plan', name: 'plan-dread', expect: 'lands',
    scenario: 'the worked example; the author said "more dread" about the scene to be drafted, and the reading turns it into craft',
    run: () => runDraft('ch.01-ninety-one-stairs', 'more dread'),
  },
  {
    row: 'draft.scene.one-shot.write', name: 'lands-from-plan', expect: 'lands',
    scenario: 'the author said "more dread", read the plan the reading returned and settled it as it stood; the write stage is briefed with that craft and never with their line',
    run: async () => {
      const first = await runDraft('ch.01-ninety-one-stairs', 'more dread')
      return runDraft('ch.01-ninety-one-stairs', 'more dread', first.plan!)
    },
  },
  {
    row: 'revise.scene.one-shot.craft-plan', name: 'plan-dread', expect: 'lands',
    scenario: 'the worked example; the author said "more dread" about sc.01-1 and asked for a clean pass, and the reading turns it into craft',
    run: () => runRedraft({ scene: SCENE, guidance: 'more dread' }),
  },
  {
    row: 'revise.scene.one-shot.write', name: 'lands', expect: 'lands',
    scenario: 'the worked example as shipped; a clean pass over the whole of sc.01-1, no line said — the answer rebuilds around the settled paragraph and keeps it word for word',
    run: () => runRedraft({ scene: SCENE }),
  },
  {
    row: 'revise.scene.one-shot.write', name: 'lock-touched', expect: 'lock-touched',
    scenario: 'a clean pass the author asked for with a line, whose plan they settled as it stood — and the answer rewrites the paragraph they had settled. The locks gate refuses it whole, and the one repair has no recorded answer',
    run: () => runRedraft({ scene: SCENE, guidance: 'harder on the stair' }, {
      moves: [{ move: 'structure', how: 'put the step that costs her something first, and let the order follow it' }],
    }),
  },
  {
    row: 'revise.selection.one-shot.craft-plan', name: 'plan-dread', expect: 'lands',
    scenario: 'the same line — "more dread" — said over a paragraph range of sc.01-1, so the request is selection scope and the reading is the selection row\'s own',
    run: () => runRedraft({ scene: SCENE, paragraphs: [2, 3], guidance: 'more dread' }),
  },
  {
    row: 'revise.selection.one-shot.write', name: 'lands', expect: 'lands',
    scenario: 'a clean pass over ¶3–¶4 of sc.01-1 — the lamp room and the drive weight — no line said; the answer is the passage alone and its two seams are handed over unchanged',
    run: () => runRedraft({ scene: SCENE, paragraphs: [2, 3] }),
  },
  {
    row: 'revise.scene.one-shot.quick.conflict', name: 'conflict-none', expect: 'lands',
    scenario: 'the worked example with one open note on sc.01-1 — one note cannot pull against itself, so the reading answers with the empty array and the revision goes ahead',
    prepare: async () => { oneNote() },
    run: () => runWorkNotes({ scene: SCENE }),
  },
  {
    row: 'revise.scene.one-shot.quick.write', name: 'lands', expect: 'lands',
    scenario: 'the same one note, past a reading that found no conflict: the minimal revision answers it and leaves the rest of the scene to the character',
    prepare: async () => { oneNote() },
    run: () => runWorkNotes({ scene: SCENE }),
  },
  {
    row: 'revise.scene.one-shot.quick.craft-plan', name: 'plan-dread', expect: 'lands',
    scenario: 'one open note on sc.01-1 and a line said with it — "more dread" — so the minimal revision stages its craft plan between the reading and the write',
    prepare: async () => { oneNote() },
    run: () => runWorkNotes({ scene: SCENE, guidance: 'more dread' }),
  },
  {
    row: 'revise.scene.one-shot.quick.conflict', name: 'conflict-found', expect: 'conflict-found',
    scenario: 'two notes on sc.01-1 that pull against each other — more of the dog, and less of the dog. The reading names the tension, the run waits for the author, and nothing is written',
    prepare: async () => { opposedNotes() },
    run: () => runWorkNotes({ scene: SCENE }),
  },
  {
    row: 'revise.selection.one-shot.quick', name: 'lands', expect: 'lands',
    scenario: 'the author selected one sentence of sc.01-1 and asked for other wordings of it. The pass is shown their style contract, the scene\'s line and the paragraph the selection sits in — never the rest of the book — and answers with a list it writes nothing from',
    run: () => runSuggest({
      kind: 'rephrase',
      selection: 'The eighty-fourth was loose.',
      paragraph: 'The eighty-fourth was loose. It had been loose when she came and it would be loose when she left.',
      file: 'prose/ch-01/scene-01.md',
    }),
  },
  {
    row: 'explore.selection.one-shot', name: 'lands', expect: 'lands',
    scenario: 'the author selected one word of sc.01-1 and asked what else it could be. The pass answers with replacements, each carrying a clause of nuance, and nothing is written',
    run: () => runSuggest({
      kind: 'synonyms',
      selection: 'loose',
      paragraph: 'The eighty-fourth was loose.',
      file: 'prose/ch-01/scene-01.md',
    }),
  },
  rewrite('leak', 'leak',
    `the landed explore.scene.one-shot/lands route with one note on the whole route that quotes the manuscript — "${QUOTED_SENTENCE}" — so the brief would carry a sentence of the withheld prose. The leak gate refuses before the send.`,
    `the book has "${QUOTED_SENTENCE}"; get that pressure in without the sentence`, null),
]

/** EVERY SCENARIO NAMES A REAL LAUNCH — a row, or a stage of one, which is
 *  what a brief belongs to. The row key is a string, so a typo would
 *  otherwise surface as `no fixture on disk` during a rekey, or as an empty
 *  `seen[]` in a test that then asserts nothing. Checked once, at import, so
 *  it fails before any scenario runs. */
const KNOWN = new Set(ROWS.flatMap(r =>
  r.pattern === 'staged' && r.stages.length
    ? r.stages.map(st => rowKey({ ...r, stage: st.id }))
    : [rowKey(r)]))
for (const s of SCENARIOS) {
  if (!KNOWN.has(s.row)) {
    throw new Error(
      `scenario ${s.row}/${s.name} names a row the registry does not have. ` +
      `Rows today: ${[...KNOWN].join(', ')}`)
  }
}

/** Run one scenario from a clean story, watching every brief that reaches
 *  the fixture engine. `seen[0]` is the scenario's own brief; a refusal's
 *  repair attempt, when the pass makes one, is `seen[1]`.
 *
 *  A PASS THAT THROWS STILL RENDERED ITS BRIEF, and the brief is what this
 *  function is for. Most passes report a refusal by returning one, but a
 *  pass with nothing to return reports it as an error the route hands the
 *  author — the writer's menu has no half-answer to give (A69-10). Recording
 *  its fixture must not depend on which of the two it does, so the throw is
 *  caught and handed back as the result for the caller to read. */
export async function renderScenario(s: Scenario): Promise<{ seen: BriefSeen[]; result: unknown; threw?: unknown }> {
  reset()
  await s.prepare?.()
  const seen: BriefSeen[] = []
  const stop = observeBriefs(b => { if (b.row === s.row) seen.push(b) })
  try {
    const result = await s.run()
    return { seen, result }
  } catch (e) {
    return { seen, result: undefined, threw: e }
  } finally {
    stop()
  }
}
