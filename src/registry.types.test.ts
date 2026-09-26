// The registry row's negative type tests (A67-1). Nothing runs here: the
// file is proven by `npm run typecheck`, which fails if any line marked
// with the expect-error directive stops being an error — if the type starts
// admitting a field a variant must not carry, or stops requiring one it
// must. tsconfig covers src/, which is why this sits beside registry.ts
// rather than under test/.
import type { InvestigationRow, SealedRow, Stage } from './registry'
import { ROW_EXPLORE_SCENE } from './registry'

// A sealed row cannot carry a toolbelt, a session or a subagent depth.
export const sealedWithToolbelt: SealedRow = {
  ...ROW_EXPLORE_SCENE,
  // @ts-expect-error a sealed row has no toolbelt field to leave empty
  toolbelt: ['Read'],
}
export const sealedWithSession: SealedRow = {
  ...ROW_EXPLORE_SCENE,
  // @ts-expect-error a sealed envelope has no session to set — sealed means session none, by type
  envelope: { ...ROW_EXPLORE_SCENE.envelope, session: 'resume-once' },
}
export const sealedWithSubagentDepth: SealedRow = {
  ...ROW_EXPLORE_SCENE,
  // @ts-expect-error a sealed row has no subagent pool
  pool: { steps: 1, subagents: 1, subagentDepth: 1, wallClockMs: 1 },
}
export const sealedWithTools: SealedRow = {
  ...ROW_EXPLORE_SCENE,
  // @ts-expect-error a sealed envelope's tools are none, not a read set
  envelope: { ...ROW_EXPLORE_SCENE.envelope, tools: { read: ['Read'] } },
}

// An investigation row does not compile without its read set and its
// step/subagent/wall-clock pool.
const investigationBase = {
  job: 'inspect', scope: 'manuscript', mode: 'one-shot', depth: 'full', stage: null,
  pattern: 'investigation', withholding: false,
  slice: { id: 'x', layers: [], dropOrder: [], floor: [] },
  gates: [], answer: 'coverage-tail',
  budget: { outputTokens: 1, wallClockMs: 1 }, rules: 'x', fixtures: ['lands'],
} as const
// @ts-expect-error an investigation row requires its step/subagent/wall-clock pool
export const investigationWithoutPool: InvestigationRow = {
  ...investigationBase,
  envelope: { tools: { read: ['Read'] }, subagents: 'one-read', session: 'none', projectContext: 'none', runtimeAdditions: 'user-level', network: 'none', directory: 'scratch', transcript: 'delete-at-decision' },
}
export const investigationWithoutReadSet: InvestigationRow = {
  ...investigationBase,
  pool: { steps: 10, subagents: 1, subagentDepth: 1, wallClockMs: 1 },
  // @ts-expect-error an investigation envelope requires a named read set by tool id
  envelope: { tools: 'none', subagents: 'one-read', session: 'none', projectContext: 'none', runtimeAdditions: 'user-level', network: 'none', directory: 'scratch', transcript: 'delete-at-decision' },
}
// And the positive twin, so the errors above are the row's and not the base's.
export const investigation: InvestigationRow = {
  ...investigationBase,
  pool: { steps: 10, subagents: 1, subagentDepth: 1, wallClockMs: 1 },
  envelope: { tools: { read: ['Read'] }, subagents: 'one-read', session: 'none', projectContext: 'none', runtimeAdditions: 'user-level', network: 'none', directory: 'scratch', transcript: 'delete-at-decision' },
}

// ---- a stage is a sealed launch, and cannot be anything else (A69-3) -------
//
// Splitting a job into stages must not be a way to smuggle in a toolbelt or a
// session: a stage carries neither FIELD, so there is nothing to set wrongly.

const stageBase = {
  id: 'write', when: 'always' as const, rules: 'x',
  slice: { id: 's', layers: ['contract'], dropOrder: [], floor: ['contract'] },
  gates: [], answer: 'scene-file' as const,
  budget: { outputTokens: 1, wallClockMs: 1 }, fixtures: ['lands'],
}

export const stage: Stage = stageBase

// @ts-expect-error a stage has no toolbelt: it runs inside the row's sealed envelope
export const stageWithTools: Stage = { ...stageBase, tools: { read: ['Read'] } }

// @ts-expect-error a stage has no session either — a sealed launch cannot resume
export const stageWithSession: Stage = { ...stageBase, session: 'resume-once' }

// @ts-expect-error a stage has no envelope of its own; the envelope is the job's
export const stageWithEnvelope: Stage = { ...stageBase, envelope: { tools: 'none' } }

// @ts-expect-error `when` is closed: a stage runs always, or when the line names an effect
export const stageWithUnknownWhen: Stage = { ...stageBase, when: 'sometimes' }
