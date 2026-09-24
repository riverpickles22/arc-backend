// The registry row's negative type tests (A67-1). Nothing runs here: the
// file is proven by `npm run typecheck`, which fails if any line marked
// with the expect-error directive stops being an error — if the type starts
// admitting a field a variant must not carry, or stops requiring one it
// must. tsconfig covers src/, which is why this sits beside registry.ts
// rather than under test/.
import type { InvestigationRow, SealedRow } from './registry'
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
