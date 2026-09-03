// The invocation builder and pass registry (A55-2): flags are launch
// properties decided by the registry, never a caller's memory.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PASS_REGISTRY, assertSessionAllowed, buildCliArgs } from '../src/invocation.ts'

test('a legacy call (no pass) builds exactly the argv engine.ts always built', () => {
  assert.deepEqual(buildCliArgs({}), ['-p', '--output-format', 'json'])
  assert.deepEqual(buildCliArgs({ noTools: true }), ['-p', '--output-format', 'json', '--tools', ''])
  assert.deepEqual(buildCliArgs({ resume: 'abc' }), ['-p', '--output-format', 'json', '--resume', 'abc'])
  // Both together, in the historical order — the exact sequence the old
  // inline construction emitted (tools before resume).
  assert.deepEqual(buildCliArgs({ noTools: true, resume: 'abc' }),
    ['-p', '--output-format', 'json', '--tools', '', '--resume', 'abc'])
})

test('a circular settings object gets the curated refusal, not a raw TypeError', () => {
  const circular: Record<string, unknown> = {}
  circular.self = circular
  assert.throws(() => buildCliArgs({ settings: circular }), /could not be serialized/)
})

test('a withholding pass gets --tools "" even when the caller says otherwise', () => {
  const args = buildCliArgs({ pass: 'reroute', noTools: false })
  const i = args.indexOf('--tools')
  assert.notEqual(i, -1, 'reroute must always run tools-off')
  assert.equal(args[i + 1], '')
  // capture is registered withholding ahead of its CLI path existing
  assert.ok(buildCliArgs({ pass: 'capture' }).includes('--tools'))
})

test('a non-withholding pass keeps tools unless the caller turns them off', () => {
  assert.ok(!buildCliArgs({ pass: 'draft' }).includes('--tools'))
  assert.ok(buildCliArgs({ pass: 'draft', noTools: true }).includes('--tools'))
})

test('an unregistered pass throws instead of launching with an undeclared posture', () => {
  assert.throws(() => buildCliArgs({ pass: 'made-up' as never }), /unregistered pass/)
})

test('sessions are refused for withholding passes, in code', () => {
  assert.throws(() => assertSessionAllowed('reroute'), /cannot unsee/)
  assert.throws(() => assertSessionAllowed('capture'), /cannot unsee/)
  assert.throws(() => assertSessionAllowed('analyze'), /does not allow/)
  assert.doesNotThrow(() => assertSessionAllowed('draft'))
  assert.doesNotThrow(() => assertSessionAllowed('redraft'))
})

test('every registry row that allows sessions is a non-withholding iterative verb', () => {
  for (const [name, spec] of Object.entries(PASS_REGISTRY)) {
    if (spec.sessionAllowed) assert.equal(spec.withholding, false, `${name} cannot be both`)
  }
})

test('invalid settings JSON throws before any spawn — print mode would ignore it silently', () => {
  assert.throws(() => buildCliArgs({ settings: '{not json' }), /silently ignore/)
  const args = buildCliArgs({ settings: { hooks: {} } })
  assert.equal(args[args.indexOf('--settings') + 1], '{"hooks":{}}')
  const passthrough = buildCliArgs({ settings: '{"a":1}' })
  assert.equal(passthrough[passthrough.indexOf('--settings') + 1], '{"a":1}')
})

test('--json-schema and --session-id become first-class flags', () => {
  const args = buildCliArgs({ jsonSchema: { type: 'object' }, sessionId: 'f2f2f2f2-0000-4000-8000-000000000000' })
  assert.equal(args[args.indexOf('--json-schema') + 1], '{"type":"object"}')
  assert.equal(args[args.indexOf('--session-id') + 1], 'f2f2f2f2-0000-4000-8000-000000000000')
})
