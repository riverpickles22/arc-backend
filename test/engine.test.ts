// The engine seam: which engine runs, and how the CLI's output is read.
// No live model calls — availability and spawning are the integration
// stories' concern.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseEngine, parseCliResult, stripFences } from '../src/engine.ts'

test('chooseEngine: override wins, none disables, key → sdk, cli-only → claude-cli', () => {
  assert.equal(chooseEngine({ ARC_DRAFT_ENGINE: 'claude-cli', ANTHROPIC_API_KEY: 'k' }, false), 'claude-cli')
  assert.equal(chooseEngine({ ARC_DRAFT_ENGINE: 'none', ANTHROPIC_API_KEY: 'k' }, true), null)
  assert.equal(chooseEngine({ ANTHROPIC_API_KEY: 'k' }, true), 'sdk')
  assert.equal(chooseEngine({ ANTHROPIC_AUTH_TOKEN: 't' }, false), 'sdk')
  assert.equal(chooseEngine({}, true), 'claude-cli')
  assert.equal(chooseEngine({}, false), null)
})

test('parseCliResult: success shape, failure shapes, non-JSON', () => {
  const ok = parseCliResult(JSON.stringify({ subtype: 'success', is_error: false, result: 'text', session_id: 's1' }))
  assert.deepEqual(ok, { text: 'text', sessionId: 's1' })
  assert.throws(() => parseCliResult(JSON.stringify({ subtype: 'error_max_turns', is_error: true, result: 'x' })), /run failed/)
  assert.throws(() => parseCliResult('not json at all'), /did not return JSON/)
})

test('stripFences: unwraps a single wrapping fence, leaves bare text alone', () => {
  assert.equal(stripFences('```markdown\n---\nscene: sc.x\n---\nBody.\n```'), '---\nscene: sc.x\n---\nBody.')
  assert.equal(stripFences('  ---\nscene: sc.x\n---\nBody.  '), '---\nscene: sc.x\n---\nBody.')
})
