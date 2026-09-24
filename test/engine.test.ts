// The engine seam, without a process: which engine runs, and how a streamed
// `claude -p` run is read — against the real capture, so the parser is
// tested on what the runtime says (test/captures/README.md).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chooseEngine, parseStream, sessionIdFor, stripFences, transcriptPathFor, scratchParent, scratchDirFor, renderBrief } from '../src/engine.ts'

const CAPTURE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'captures', 'claude-cli-2.1.270-stream.jsonl'), 'utf8')

test('chooseEngine: override wins, none disables, key → sdk, cli-only → claude-cli', () => {
  assert.equal(chooseEngine({ ARC_DRAFT_ENGINE: 'claude-cli', ANTHROPIC_API_KEY: 'k' }, false), 'claude-cli')
  assert.equal(chooseEngine({ ARC_DRAFT_ENGINE: 'none', ANTHROPIC_API_KEY: 'k' }, true), null)
  assert.equal(chooseEngine({ ANTHROPIC_API_KEY: 'k' }, true), 'sdk')
  assert.equal(chooseEngine({ ANTHROPIC_AUTH_TOKEN: 't' }, false), 'sdk')
  assert.equal(chooseEngine({}, true), 'claude-cli')
  assert.equal(chooseEngine({}, false), null)
})

test('the real capture: the init event is the envelope the runtime says it loaded', () => {
  const { init, result, rateLimited, events } = parseStream(CAPTURE)
  assert.equal(events, 4, 'init, rate limit, assistant, result')
  assert.ok(init)
  assert.deepEqual(init.tools, [], 'launched with --tools \'\': no tool loaded — proven, not promised')
  assert.deepEqual(init.mcpServers, [])
  assert.equal(init.sessionId, 'a67a67a6-0000-4000-8000-000000000002', 'the pre-assigned session id came back')
  assert.equal(init.cwd, '/Users/author/workspace/arc/scratch/init-capture', 'an empty scratch directory, not the story')
  assert.equal(init.model, 'claude-opus-5')
  assert.equal(init.runtimeVersion, '2.1.270')
  assert.equal(init.apiKeySource, 'none', 'subscription auth, no key')
  assert.equal(init.permissionMode, 'default')
  assert.ok(init.skills.length > 0, 'the runtime loads the author\'s skills on its own — a RECORDED field, never "none"')
  assert.ok(init.agents.length > 0, 'and names its agents, unreachable without a tool')
  assert.match(init.memoryPaths.auto, /\.claude\/projects\/.*\/memory\/$/)
  assert.equal(rateLimited, false, 'the rate_limit_event said allowed')
  assert.ok(result)
  assert.equal(result.text, 'ready')
  assert.equal(result.isError, false)
  assert.equal(result.subtype, 'success')
  assert.deepEqual(result.tokens, { input: 7358, output: 4, cacheCreation: 7356, cacheRead: 0 }, 'the whole prompt counts as input, cache included')
  assert.equal(result.durationMs, 1323)
  assert.equal(result.sessionId, init.sessionId)
})

test('the transcript is named from what the runtime reported, never guessed from the working directory', () => {
  const { init } = parseStream(CAPTURE)
  assert.equal(transcriptPathFor(init), '/Users/author/.claude/projects/-Users-author-workspace-arc-scratch-init-capture/a67a67a6-0000-4000-8000-000000000002.jsonl')
  assert.equal(transcriptPathFor(null), null)
  assert.equal(transcriptPathFor({ ...init!, memoryPaths: {} }), null)
})

test('parseStream: no init, no result, a rate limit, and lines that are not JSON', () => {
  assert.deepEqual(parseStream(''), { init: null, result: null, rateLimited: false, events: 0 })
  assert.deepEqual(parseStream('not json\n{"type":"assistant"}\n').events, 1)
  const limited = parseStream('{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}\n')
  assert.equal(limited.rateLimited, true)
  const warned = parseStream('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning"}}\n')
  assert.equal(warned.rateLimited, false, 'a warning is a permitted run')
  const failed = parseStream('{"type":"result","subtype":"error_max_turns","is_error":true,"result":"x","api_error_status":429}')
  assert.equal(failed.result?.isError, true)
  assert.equal(failed.result?.apiErrorStatus, 429)
})

test('a session id is derived from the run id and the attempt: stable, UUID-shaped, one per launch', () => {
  const a = sessionIdFor('run.0001')
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(a, sessionIdFor('run.0001', '1'), 'the same launch always names the same transcript')
  assert.notEqual(a, sessionIdFor('run.0002'))
  assert.notEqual(sessionIdFor('run.0001', 'late-entry-1'), sessionIdFor('run.0001', 'late-entry-2'), 'a seed and its repair never share a session — the runtime refuses one in use')
})

test('the scratch parent is arc-owned, per story, outside the story tree', () => {
  const parent = scratchParent({ ARC_HOME: '/arc-home' }, '/home/x', '/stories/feral-dogs-of-cuba')
  assert.match(parent, /^\/arc-home\/scratch\/feral-dogs-of-cuba-[0-9a-f]{8}$/)
  assert.notEqual(parent, scratchParent({ ARC_HOME: '/arc-home' }, '/home/x', '/elsewhere/feral-dogs-of-cuba'), 'two stories of one name do not share a parent')
  assert.equal(scratchParent({}, '/home/x', '/s/story').startsWith('/home/x/.arc/scratch/'), true, 'ARC_HOME defaults to ~/.arc')
  assert.equal(scratchDirFor('run.0007', 'late-entry-1', '/p'), '/p/run-0007/late-entry-1', 'one directory per launch')
})

test('renderBrief joins the blocks; stripFences unwraps a single wrapping fence', () => {
  assert.equal(renderBrief({ blocks: [{ id: 'a', text: 'A', cached: true }, { id: 'b', text: 'B', cached: false }] }), 'A\n\nB')
  assert.equal(stripFences('```markdown\n---\nscene: sc.x\n---\nBody.\n```'), '---\nscene: sc.x\n---\nBody.')
  assert.equal(stripFences('  ---\nscene: sc.x\n---\nBody.  '), '---\nscene: sc.x\n---\nBody.')
})
