// The invocation builder and pass registry (A55-2): flags are launch
// properties decided by the registry, never a caller's memory.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PASS_REGISTRY, assertSessionAllowed, buildCliArgs } from '../src/invocation.ts'
import { ROW_EXPLORE_ROUTE, ROW_EXPLORE_SCENE } from '../src/registry.ts'

test('a call that names no pass is refused — the registry decides a posture, never the call site', () => {
  // `pass` is required by the type since A55-4, so a caller in TypeScript
  // cannot reach this. These are the two cases the type cannot cover: a
  // JavaScript caller, and a name whose row was deleted without its call
  // site. Both must refuse rather than launch with an undeclared posture.
  assert.throws(() => buildCliArgs({} as never), /unregistered pass/)
})

/** ANY still-unrowed pass: this file is about the argv the builder makes,
 *  not about whose brief it carries. `material` is the one that outlives the
 *  migration longest (U13, slices 7+), so the name here does not move every
 *  time a pass takes its row — it moved off `revise` when A69-9 rowed it.
 *  An UNPINNED pass, so the --tools assertions below still mean what they
 *  say: material is withholding: false, as revise was. */
const SOME_UNROWED_PASS = 'material' as const

const BASE = ['-p', '--output-format', 'stream-json', '--verbose']   // streamed, always (A67-2)

test('a non-withholding pass builds exactly the argv engine.ts always built', () => {
  assert.deepEqual(buildCliArgs({ pass: SOME_UNROWED_PASS }), BASE)
  assert.deepEqual(buildCliArgs({ pass: SOME_UNROWED_PASS, noTools: true }), [...BASE, '--tools', ''])
  assert.deepEqual(buildCliArgs({ pass: SOME_UNROWED_PASS, resume: 'abc' }), [...BASE, '--resume', 'abc'])
  // Both together, in the historical order — the exact sequence the old
  // inline construction emitted (tools before resume).
  assert.deepEqual(buildCliArgs({ pass: SOME_UNROWED_PASS, noTools: true, resume: 'abc' }),
    [...BASE, '--tools', '', '--resume', 'abc'])
})

test('a circular settings object gets the curated refusal, not a raw TypeError', () => {
  const circular: Record<string, unknown> = {}
  circular.self = circular
  assert.throws(() => buildCliArgs({ pass: SOME_UNROWED_PASS, settings: circular }), /could not be serialized/)
})

test('a withholding pass gets --tools "" even when the caller says otherwise', () => {
  const args = buildCliArgs({ pass: 'analyze', noTools: false })
  const i = args.indexOf('--tools')
  assert.notEqual(i, -1, 'analyze must always run tools-off')
  assert.equal(args[i + 1], '')
  // capture is registered withholding ahead of its CLI path existing
  assert.ok(buildCliArgs({ pass: 'capture' }).includes('--tools'))
})

test('a non-withholding pass keeps tools unless the caller turns them off', () => {
  assert.ok(!buildCliArgs({ pass: SOME_UNROWED_PASS }).includes('--tools'))
  assert.ok(buildCliArgs({ pass: SOME_UNROWED_PASS, noTools: true }).includes('--tools'))
})

test('an unregistered pass throws instead of launching with an undeclared posture', () => {
  assert.throws(() => buildCliArgs({ pass: 'made-up' as never }), /unregistered pass/)
})

test('sessions are refused for withholding passes, in code', () => {
  assert.throws(() => assertSessionAllowed('capture'), /cannot unsee/)
  assert.throws(() => assertSessionAllowed('analyze'), /cannot unsee/)
  // material is the non-withholding row whose own answer is still no
  assert.throws(() => assertSessionAllowed('material'), /does not allow/)
  // AND NOTHING LEFT HERE ALLOWS ONE (A69-9). A session is for an iterative
  // verb, and every iterative verb — draft, redraft, revise — has taken its
  // row; what is left in the interim registry is readings and record
  // workers. The first row to want a session will declare it on the row.
  for (const [name, spec] of Object.entries(PASS_REGISTRY)) {
    assert.equal(spec.sessionAllowed, false, `${name} still claims a session in the interim registry`)
    assert.throws(() => assertSessionAllowed(name as keyof typeof PASS_REGISTRY))
  }
})

test('every registry row that allows sessions is a non-withholding iterative verb', () => {
  for (const [name, spec] of Object.entries(PASS_REGISTRY)) {
    if (spec.sessionAllowed) assert.equal(spec.withholding, false, `${name} cannot be both`)
  }
})

test('invalid settings JSON throws before any spawn — print mode would ignore it silently', () => {
  assert.throws(() => buildCliArgs({ pass: SOME_UNROWED_PASS, settings: '{not json' }), /silently ignore/)
  const args = buildCliArgs({ pass: SOME_UNROWED_PASS, settings: { hooks: {} } })
  assert.equal(args[args.indexOf('--settings') + 1], '{"hooks":{}}')
  const passthrough = buildCliArgs({ pass: SOME_UNROWED_PASS, settings: '{"a":1}' })
  assert.equal(passthrough[passthrough.indexOf('--settings') + 1], '{"a":1}')
})

test('a launch that carries a sealed row runs tools-off from the row, and the caller cannot widen it (A67-1)', () => {
  const args = buildCliArgs({ row: ROW_EXPLORE_SCENE, noTools: false })
  const i = args.indexOf('--tools')
  assert.notEqual(i, -1, 'a sealed row launches with --tools')
  assert.equal(args[i + 1], '', 'and an empty toolbelt, whatever the caller said')
  assert.deepEqual(buildCliArgs({ row: ROW_EXPLORE_ROUTE }), [...BASE, '--tools', ''])
})

test('a sealed row\'s launch cannot resume a session, whatever the caller hands over', () => {
  assert.throws(() => buildCliArgs({ row: ROW_EXPLORE_SCENE, resume: 'abc' }), /sealed and cannot resume/)
  assert.throws(() => buildCliArgs({ row: ROW_EXPLORE_ROUTE, resume: 'abc', sessionId: 'f2f2f2f2-0000-4000-8000-000000000000' }), /cannot resume/)
  // the pre-assigned id names the transcript before the run; it is not a resume
  const args = buildCliArgs({ row: ROW_EXPLORE_SCENE, sessionId: 'f2f2f2f2-0000-4000-8000-000000000000' })
  assert.equal(args[args.indexOf('--session-id') + 1], 'f2f2f2f2-0000-4000-8000-000000000000')
  assert.ok(!args.includes('--resume'))
})

test('--json-schema and --session-id become first-class flags', () => {
  const args = buildCliArgs({ pass: SOME_UNROWED_PASS, jsonSchema: { type: 'object' }, sessionId: 'f2f2f2f2-0000-4000-8000-000000000000' })
  assert.equal(args[args.indexOf('--json-schema') + 1], '{"type":"object"}')
  assert.equal(args[args.indexOf('--session-id') + 1], 'f2f2f2f2-0000-4000-8000-000000000000')
})

test('every reading pass runs tools-off on the CLI engine (A55-4)', () => {
  // The author's decision of 2026-09-11: a pass whose worth is reading the
  // record cold must not be able to open the working tree instead. Before
  // this, "read-only by construction" held on the SDK path and, on the CLI
  // path, only because the prompt asked.
  for (const pass of ['analyze', 'judge', 'suggest', 'intent', 'lenses', 'bootstrap'] as const) {
    assert.equal(PASS_REGISTRY[pass].withholding, true, `${pass} must be withholding`)
    const args = buildCliArgs({ pass })
    const i = args.indexOf('--tools')
    assert.notEqual(i, -1, `${pass} must launch with --tools`)
    assert.equal(args[i + 1], '', `${pass} must launch with an empty toolbelt`)
  }
})

test('the prose-writing passes and the record workers are deliberately not pinned', () => {
  // Their envelope is slice 4's business. The prose-writing passes that used
  // to be here — draft, redraft, revise — have taken their rows, so what is
  // left unpinned is the record workers alone.
  for (const pass of ['material', 'learn-style'] as const) {
    assert.equal(PASS_REGISTRY[pass].withholding, false, `${pass} must not be pinned here`)
  }
})
