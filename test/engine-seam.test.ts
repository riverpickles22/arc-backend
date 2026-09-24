// The seam takes the row (A67-2): a launch derives everything from it,
// runs from a scratch directory with the run id in hand, returns the init
// event beside the text, fails with a kind from the closed set, and can be
// stopped. A stub `claude` on PATH speaks the streamed shape; ARC_HOME is a
// temp dir so nothing lands in the author's home.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installStubCli, makeStory } from './fixture.ts'

process.env.ARC_STORY_PATH = makeStory()
process.env.ARC_DRAFT_ENGINE = 'claude-cli'
// realpath'd: macOS's tmpdir is a symlink, and the child reports where it
// really ran
process.env.ARC_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arc-home-')))
delete process.env.ANTHROPIC_API_KEY
const STUB_LOG = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-seam-log-'))
process.env.STUB_LOG = STUB_LOG
process.env.STUB_PROJECTS = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arc-seam-projects-')), 'proj')
const STUB = installStubCli({
  name: 'seam',
  before: [
    "if (process.env.STUB_FAIL === '1') { process.stderr.write('stub refused'); process.exit(3) }",
    "if (process.env.STUB_SLOW) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.STUB_SLOW))",
    "if (process.env.STUB_LIMIT === '1') { process.stdout.write(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }) + '\\n'); process.exit(1) }",
    "require('node:fs').writeFileSync(require('node:path').join(process.env.STUB_LOG, 'last.json'), JSON.stringify({ cwd: process.cwd(), argv, run: process.env.ARC_RUN_ID ?? null, maxOutput: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? null, prompt }))",
  ].join('\n  '),
  answer: "'the answer'",
})
process.env.PATH = `${STUB}${path.delimiter}${process.env.PATH}`

const { askRow, launchCli, runCliPrompt, isDry, EngineError, scratchParent, sessionIdFor, CLI_ENGINE_NOTE } = await import('../src/engine.ts')
const { ROW_EXPLORE_SCENE } = await import('../src/registry.ts')
const lastLaunch = () => JSON.parse(fs.readFileSync(path.join(STUB_LOG, 'last.json'), 'utf8')) as { cwd: string; argv: string[]; run: string | null; prompt: string }
const BRIEF = { blocks: [{ id: 'stable', text: 'RULES', cached: true }, { id: 'user', text: 'ask', cached: false }] }

test('a launch with no row throws before any spawn', async () => {
  fs.rmSync(path.join(STUB_LOG, 'last.json'), { force: true })
  assert.throws(() => launchCli(undefined as never, BRIEF, { runId: 'run.0001' }), /no row, no launch/)
  await assert.rejects(askRow(undefined as never, BRIEF, { runId: 'run.0001' }), /no row, no launch/)
  assert.throws(() => launchCli(ROW_EXPLORE_SCENE, BRIEF, {} as never), /run id before the first token/)
  assert.ok(!fs.existsSync(path.join(STUB_LOG, 'last.json')), 'nothing was spawned')
})

test('dry: the brief is rendered and no child is spawned', async () => {
  fs.rmSync(path.join(STUB_LOG, 'last.json'), { force: true })
  const a = await askRow(ROW_EXPLORE_SCENE, BRIEF, { runId: 'run.0001', dry: true })
  assert.ok(isDry(a))
  assert.equal(a.brief, 'RULES\n\nask')
  assert.ok(!fs.existsSync(path.join(STUB_LOG, 'last.json')), 'no child ran')
})

test('a rowed launch runs from a fresh scratch directory under the arc-owned parent, never the story, and removes it after', async () => {
  const a = await askRow(ROW_EXPLORE_SCENE, BRIEF, { runId: 'run.0002' })
  assert.ok(!isDry(a))
  const seen = lastLaunch()
  const parent = scratchParent()
  assert.ok(seen.cwd.startsWith(parent), `${seen.cwd} is under ${parent}`)
  assert.equal(path.basename(path.dirname(seen.cwd)), 'run-0002', 'named for the run')
  assert.equal(path.basename(seen.cwd), '1', 'and the launch')
  assert.ok(!seen.cwd.startsWith(process.env.ARC_STORY_PATH!), 'not the story tree')
  assert.ok(parent.startsWith(process.env.ARC_HOME!), 'the parent is under ARC_HOME')
  assert.ok(!fs.existsSync(seen.cwd), 'the scratch directory is gone once the child has exited')
  assert.equal(a.cwd, seen.cwd, 'the working directory as the runtime reported it')
})

test('the run id reaches the child as ARC_RUN_ID and as its pre-assigned --session-id', async () => {
  await askRow(ROW_EXPLORE_SCENE, BRIEF, { runId: 'run.0003' })
  const seen = lastLaunch()
  assert.equal(seen.run, 'run.0003')
  const i = seen.argv.indexOf('--session-id')
  assert.notEqual(i, -1)
  assert.equal(seen.argv[i + 1], sessionIdFor('run.0003'))
  assert.deepEqual(seen.argv.slice(0, 4), ['-p', '--output-format', 'stream-json', '--verbose'], 'streamed output, always')
  assert.equal(seen.argv[seen.argv.indexOf('--tools') + 1], '', 'the sealed row: no tools')
  assert.ok(seen.prompt.startsWith('RULES\n\nask'), 'the rendered brief')
  assert.ok(seen.prompt.endsWith(CLI_ENGINE_NOTE), 'and the CLI\'s rendering of the envelope after it, never part of the brief')
})

test('the init event comes back beside the text, with the session, tokens, wall clock, transcript, model and version as reported', async () => {
  const a = await askRow(ROW_EXPLORE_SCENE, BRIEF, { runId: 'run.0004' })
  const seen = lastLaunch()
  assert.ok(!isDry(a))
  assert.equal(a.text, 'the answer')
  assert.equal(a.sessionId, sessionIdFor('run.0004'))
  assert.ok(a.init)
  assert.deepEqual(a.init.tools, [])
  assert.equal(a.init.sessionId, sessionIdFor('run.0004'))
  assert.equal(a.model, 'stub-model')
  assert.equal(a.runtimeVersion, 'stub 1.0')
  assert.deepEqual(a.init.skills, ['arc-canon'], 'what the runtime added on its own, recorded')
  assert.ok(a.tokens.input > 0 && a.tokens.output > 0)
  assert.equal(seen.argv.length > 0, true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(STUB_LOG, 'last.json'), 'utf8')).maxOutput, String(ROW_EXPLORE_SCENE.budget.outputTokens), 'the output ceiling reaches the child')
  assert.ok(a.wallClockMs >= 0)
  assert.equal(a.transcriptPath, path.join(process.env.STUB_PROJECTS!, `${sessionIdFor('run.0004')}.jsonl`), 'named from the runtime\'s own project directory')
})

test('a caller may narrow the envelope and never widen it', async () => {
  await askRow(ROW_EXPLORE_SCENE, BRIEF, { runId: 'run.0005', noTools: false })
  const seen = lastLaunch()
  assert.equal(seen.argv[seen.argv.indexOf('--tools') + 1], '', 'noTools: false does not give a sealed row tools')
})

test('a stopped child ends with the cancelled kind, not timed out — even when the wall clock would have fired first', async () => {
  process.env.STUB_SLOW = '4000'
  try {
    const launch = launchCli(ROW_EXPLORE_SCENE, BRIEF, { runId: 'run.0006', timeoutMs: 60_000 })
    setTimeout(() => launch.stop(), 150)
    await assert.rejects(launch.result, (e: unknown) => e instanceof EngineError && e.kind === 'cancelled')
    assert.ok(!fs.existsSync(launch.scratchDir), 'the scratch directory does not outlive the child')
    // A child that ignores SIGTERM (Atomics.wait blocks the stub's loop) with
    // less wall clock left than the stop's grace: the stop wins, as cancelled.
    const stubborn = launchCli(ROW_EXPLORE_SCENE, BRIEF, { runId: 'run.0006', attempt: '2', timeoutMs: 300 })
    setTimeout(() => stubborn.stop(), 50)
    await assert.rejects(stubborn.result, (e: unknown) => e instanceof EngineError && e.kind === 'cancelled')
  } finally {
    delete process.env.STUB_SLOW
  }
})

test('two launches of one run — a seed and its repair — get their own session and directory', async () => {
  await askRow(ROW_EXPLORE_SCENE, BRIEF, { runId: 'run.0012', attempt: 'late-entry-1' })
  const first = lastLaunch()
  await askRow(ROW_EXPLORE_SCENE, BRIEF, { runId: 'run.0012', attempt: 'late-entry-2' })
  const second = lastLaunch()
  assert.notEqual(first.argv[first.argv.indexOf('--session-id') + 1], second.argv[second.argv.indexOf('--session-id') + 1])
  assert.notEqual(first.cwd, second.cwd)
  assert.equal(path.dirname(first.cwd), path.dirname(second.cwd), 'under the same run')
})

test('the failure kinds are the closed set: timed out, died, rate-limited, unreachable', async () => {
  process.env.STUB_SLOW = '4000'
  try {
    await assert.rejects(launchCli(ROW_EXPLORE_SCENE, BRIEF, { runId: 'run.0007', timeoutMs: 100 }).result,
      (e: unknown) => e instanceof EngineError && e.kind === 'timed out')
  } finally { delete process.env.STUB_SLOW }

  process.env.STUB_FAIL = '1'
  try {
    await assert.rejects(launchCli(ROW_EXPLORE_SCENE, BRIEF, { runId: 'run.0008' }).result,
      (e: unknown) => e instanceof EngineError && e.kind === 'died' && /claude CLI exited 3: stub refused/.test(e.message))
  } finally { delete process.env.STUB_FAIL }

  process.env.STUB_LIMIT = '1'
  try {
    await assert.rejects(launchCli(ROW_EXPLORE_SCENE, BRIEF, { runId: 'run.0009' }).result,
      (e: unknown) => e instanceof EngineError && e.kind === 'rate-limited')
  } finally { delete process.env.STUB_LIMIT }

  const PATH = process.env.PATH
  process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-no-claude-'))
  try {
    await assert.rejects(launchCli(ROW_EXPLORE_SCENE, BRIEF, { runId: 'run.0010' }).result,
      (e: unknown) => e instanceof EngineError && e.kind === 'unreachable')
  } finally { process.env.PATH = PATH }
})

test('the interim launch for an unrowed pass runs the same way: streamed, from scratch, no cwd in the story', async () => {
  const a = await runCliPrompt('read this', { pass: 'analyze', runId: 'run.0011' })
  const seen = lastLaunch()
  assert.equal(a.text, 'the answer')
  assert.ok(seen.cwd.startsWith(scratchParent()))
  assert.equal(seen.run, 'run.0011')
  assert.ok(!seen.argv.includes('--session-id'), 'no session is pre-assigned unless the caller names one')
  const b = await runCliPrompt('read this', { pass: 'analyze' })
  assert.ok(lastLaunch().cwd.startsWith(scratchParent()), 'even without a run id, never the story')
  assert.equal(b.sessionId, 'stub-session')
})
