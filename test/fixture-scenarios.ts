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
import type { RerouteResponse, RouteAlternative } from 'arc-canon-graph/api-types.ts'
// type-only, so nothing under src/ loads before the environment is set
import type { BriefSeen } from '../src/fixtures.ts'
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
  row: 'explore.scene.one-shot' | 'explore.route.one-shot'
  name: string
  /** what the fixture's `expect` field must say. `leak` is the one that
   *  never reaches the engine: the gate proves the brief and refuses before
   *  the send (A67-7), so the scenario carries no recorded answer. */
  expect: 'lands' | 'overlap' | 'coverage-drop' | 'leak'
  /** the story state and request, in one breath — copied into the fixture */
  scenario: string
  prepare?: () => Promise<void>
  run: () => Promise<RerouteResponse>
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
  rewrite('leak', 'leak',
    `the landed explore.scene.one-shot/lands route with one note on the whole route that quotes the manuscript — "${QUOTED_SENTENCE}" — so the brief would carry a sentence of the withheld prose. The leak gate refuses before the send.`,
    `the book has "${QUOTED_SENTENCE}"; get that pressure in without the sentence`, null),
]

/** Run one scenario from a clean story, watching every brief that reaches
 *  the fixture engine. `seen[0]` is the scenario's own brief; a refusal's
 *  repair attempt, when the pass makes one, is `seen[1]`. */
export async function renderScenario(s: Scenario): Promise<{ seen: BriefSeen[]; result: RerouteResponse }> {
  reset()
  await s.prepare?.()
  const seen: BriefSeen[] = []
  const stop = observeBriefs(b => { if (b.row === s.row) seen.push(b) })
  try {
    const result = await s.run()
    return { seen, result }
  } finally {
    stop()
  }
}
