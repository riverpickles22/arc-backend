// The envelope is proven from the runtime's own init event, or recorded,
// never declared (A67-5; agent-workflows §4, rules 1–3).
//
// Two halves. The proof is pure and runs against the REAL capture and against
// seeded ones. The launch half drives a stub `claude` that reports what the
// test tells it to: a tool where the row declared none refuses before the
// answer is read, with an author sentence and the ending `could not run`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installStubCli, makeStory } from './fixture.ts'

process.env.ARC_STORY_PATH = makeStory()
process.env.ARC_DRAFT_ENGINE = 'claude-cli'
delete process.env.ANTHROPIC_API_KEY
const STUB_LOG = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-env-log-'))
process.env.STUB_LOG = STUB_LOG
// The stub reports whatever the test asks for: STUB_TOOLS, STUB_SERVERS,
// STUB_CWD, STUB_SESSION override what it says it loaded.
process.env.PATH = `${installStubCli({
  name: 'envelope',
  before: [
    "const over = { tools: process.env.STUB_TOOLS, servers: process.env.STUB_SERVERS, cwd: process.env.STUB_CWD, session: process.env.STUB_SESSION, noinit: process.env.STUB_NOINIT }",
    "require('node:fs').writeFileSync(require('node:path').join(process.env.STUB_LOG, 'over.json'), JSON.stringify(over))",
  ].join('\n  '),
  answer: "'an answer the gate never sees'",
})}${path.delimiter}${process.env.PATH}`

const { launchCli, proveEnvelope, recordedEnvelope, userLevelFiles, parseStream, EngineError, askRow } = await import('../src/engine.ts')
const { ROW_EXPLORE_SCENE, ROW_EXPLORE_ROUTE } = await import('../src/registry.ts')

const CAPTURE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'captures', 'claude-cli-2.1.270-stream.jsonl'), 'utf8')
const REAL_INIT = parseStream(CAPTURE).init!
const BRIEF = { blocks: [{ id: 'user', text: 'ask', cached: false }] }

// ---- the row declares, in runtime-neutral terms ---------------------------

test('U4 and U5 declare the envelope rule 1 names, and a sealed row has no session to set', () => {
  for (const row of [ROW_EXPLORE_SCENE, ROW_EXPLORE_ROUTE]) {
    assert.equal(row.envelope.tools, 'none')
    assert.equal(row.envelope.subagents, 'none')
    assert.equal(row.envelope.projectContext, 'none')
    assert.equal(row.envelope.network, 'none')
    assert.equal(row.envelope.directory, 'scratch')
    assert.equal(row.envelope.runtimeAdditions, 'user-level', 'what no engine on subscription auth can withhold')
    assert.equal(row.envelope.transcript, 'delete-at-decision', 'retention is declared')
    assert.ok(!('session' in row.envelope), 'session none, by the sealed type')
  }
})

// ---- the proof, against the real capture and seeded ones -------------------

const expect = { scratchDir: REAL_INIT.cwd!, sessionId: REAL_INIT.sessionId }

test('the real capture proves the envelope U4 declares', () => {
  const proof = proveEnvelope(ROW_EXPLORE_SCENE, REAL_INIT, expect)
  assert.equal(proof.ok, true)
  assert.equal(proof.proven.tools.value, 'none')
  assert.match(proof.proven.tools.from, /init event's `tools`/)
  assert.equal(proof.proven.network.value, 'none')
  assert.match(proof.proven.network.from, /no tool loaded/, 'network is proven THROUGH the toolbelt, not asserted')
  assert.equal(proof.proven.subagents.value, 'none')
  assert.equal(proof.proven.mcp_servers.value, 'none')
  assert.equal(proof.proven.working_directory.value, REAL_INIT.cwd)
  assert.equal(proof.proven.project_context_in_the_launch_directory.value, 'none', 'only what arc made is proven')
  assert.ok(proof.proven.session)
})

test('a recorded field names where it was observed, and "none" is never written for one the runtime cannot withhold', () => {
  const recorded = recordedEnvelope(REAL_INIT)
  assert.ok((recorded.user_level_skills.value as string[]).length > 0)
  assert.match(recorded.user_level_skills.observed_in, /init event's `skills`/)
  assert.match(recorded.memory.observed_in, /`memory_paths`/)
  assert.match(recorded.subagents_available.observed_in, /unreachable with no tool/)
  // The instructions the init event does NOT report are listed from disk.
  assert.match(recorded.user_level_instructions.observed_in, /present on disk/)
  assert.ok(Array.isArray(recorded.user_level_instructions.value))
  for (const [field, v] of Object.entries(recorded)) {
    assert.notEqual(v.value, 'none', `${field} is observed, never declared none`)
  }
  const files = userLevelFiles('/nowhere')
  assert.deepEqual(files.map(f => f.present), [false, false, false], 'and absence is honest too')
})

test('what an ancestor of the launch directory carries is RECORDED, never proven away', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arc-ancestor-')))
  const scratch = path.join(home, 'scratch', 'story', 'run-0001', '1')
  fs.mkdirSync(scratch, { recursive: true })
  fs.writeFileSync(path.join(home, 'CLAUDE.md'), "the author's own instructions")

  const proof = proveEnvelope(ROW_EXPLORE_SCENE, { ...REAL_INIT, cwd: scratch }, { scratchDir: scratch, sessionId: REAL_INIT.sessionId }, home)
  assert.equal(proof.ok, true)
  // arc proves what IT made: the directory it created is empty.
  assert.equal(proof.proven.project_context_in_the_launch_directory.value, 'none')
  assert.ok(!('project_context' in proof.proven), 'and never claims the whole of project context')
  // What the runtime finds by walking up is recorded, by path.
  const carried = proof.recorded.project_instructions_above_the_launch_directory
  assert.ok(carried, 'a CLAUDE.md above the launch directory is recorded')
  assert.deepEqual(carried.value, [path.join(home, 'CLAUDE.md')])
  assert.match(carried.observed_in, /walking up, and arc cannot withhold them/)
  // And when there is nothing above it, nothing is claimed either way.
  const clean = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arc-clean-')))
  const quiet = proveEnvelope(ROW_EXPLORE_SCENE, { ...REAL_INIT, cwd: clean }, { scratchDir: clean, sessionId: REAL_INIT.sessionId }, clean)
  assert.ok(!quiet.recorded.project_instructions_above_the_launch_directory)
})

test('a row this adapter cannot prove is refused rather than admitted with an empty proof', () => {
  const toolbelt = { ...ROW_EXPLORE_SCENE, envelope: { ...ROW_EXPLORE_SCENE.envelope, tools: { read: ['Read'] } } } as unknown as typeof ROW_EXPLORE_SCENE
  const withTools = proveEnvelope(toolbelt, REAL_INIT, expect)
  assert.equal(withTools.ok, false)
  assert.match(withTools.refusal.sentence, /asked for tools, and arc cannot yet prove/)

  const elsewhere = { ...ROW_EXPLORE_SCENE, envelope: { ...ROW_EXPLORE_SCENE.envelope, directory: 'story' } } as unknown as typeof ROW_EXPLORE_SCENE
  assert.equal(proveEnvelope(elsewhere, REAL_INIT, expect).ok, false)

  // A row that declares the runtime adds nothing: no runtime on subscription
  // auth can promise that, so it is refused rather than written as "none".
  const hermetic = { ...ROW_EXPLORE_SCENE, envelope: { ...ROW_EXPLORE_SCENE.envelope, runtimeAdditions: 'none' } } as unknown as typeof ROW_EXPLORE_SCENE
  const refusedHermetic = proveEnvelope(hermetic, REAL_INIT, expect)
  assert.equal(refusedHermetic.ok, false)
  assert.equal(refusedHermetic.refusal.field, 'runtime_additions')
})

test('a proven field that does not match refuses, with a sentence that ends in the next keystroke', () => {
  const withTool = proveEnvelope(ROW_EXPLORE_SCENE, { ...REAL_INIT, tools: ['Read'] }, expect)
  assert.equal(withTool.ok, false)
  assert.equal(withTool.refusal.field, 'tools')
  assert.deepEqual(withTool.refusal.observed, ['Read'])
  assert.match(withTool.refusal.sentence, /no tools and the runtime loaded 1 \(Read\)/)
  assert.match(withTool.refusal.sentence, /ask again\.$/, 'it ends in the next keystroke')
  assert.doesNotMatch(withTool.refusal.sentence, /git|commit|stderr|EngineError/, 'and carries no machine word')
  // the recorded half survives a refusal: the author still sees what loaded
  assert.ok(Object.keys(withTool.recorded).length > 0)

  const withServer = proveEnvelope(ROW_EXPLORE_SCENE, { ...REAL_INIT, mcpServers: [{ name: 'notes', status: 'connected' }] }, expect)
  assert.equal(withServer.ok, false)
  assert.equal(withServer.refusal.field, 'mcp_servers')

  const elsewhere = proveEnvelope(ROW_EXPLORE_SCENE, { ...REAL_INIT, cwd: '/somewhere/else' }, expect)
  assert.equal(elsewhere.ok, false)
  assert.equal(elsewhere.refusal.field, 'working_directory')
  assert.match(elsewhere.refusal.sentence, /outside the story and it ran somewhere else/)

  const otherSession = proveEnvelope(ROW_EXPLORE_SCENE, { ...REAL_INIT, sessionId: 'a-session-arc-did-not-open' }, expect)
  assert.equal(otherSession.ok, false)
  assert.equal(otherSession.refusal.field, 'session')

  const nothing = proveEnvelope(ROW_EXPLORE_SCENE, null, expect)
  assert.equal(nothing.ok, false)
  assert.equal(nothing.refusal.field, 'init', 'a field the adapter can neither prove nor record refuses the launch')
})

// ---- the launch: proven before the run wears its label ---------------------

test('a launch whose runtime loaded a tool is refused before its answer is read', async () => {
  process.env.STUB_TOOLS = 'Read,Edit'
  try {
    let proof: { ok: boolean } | null = null
    await assert.rejects(
      launchCli(ROW_EXPLORE_SCENE, BRIEF, { runId: 'run.0001', onProof: p => { proof = p } }).result,
      (e: unknown) => e instanceof EngineError && e.kind === 'envelope' && /no tools and the runtime loaded 2/.test(e.message))
    assert.equal(proof!.ok, false, 'and the proof reached the caller, so the receipt can show it')
  } finally {
    delete process.env.STUB_TOOLS
  }
})

test('a launch the runtime answers honestly is admitted, and the proof comes back with the answer', async () => {
  const launch = launchCli(ROW_EXPLORE_SCENE, BRIEF, { runId: 'run.0002' })
  const a = await launch.result
  assert.equal(a.text, 'an answer the gate never sees')
  assert.equal(a.envelope?.ok, true)
  assert.equal(a.envelope!.proven.tools.value, 'none')
  assert.equal(a.envelope!.proven.working_directory.value, launch.scratchDir)
  assert.ok(a.envelope!.recorded.user_level_instructions, 'and what the runtime added is recorded beside it')
})

test('a runtime that says nothing about what it loaded proves nothing, and the launch refuses', async () => {
  process.env.STUB_NOINIT = '1'
  try {
    await assert.rejects(launchCli(ROW_EXPLORE_SCENE, BRIEF, { runId: 'run.0003' }).result,
      (e: unknown) => e instanceof EngineError && e.kind === 'envelope' && /reported no init event/.test(e.message))
  } finally {
    delete process.env.STUB_NOINIT
  }
})

test('under the sdk engine a withholding row refuses at launch — that adapter proves no envelope in this slice', async () => {
  process.env.ARC_DRAFT_ENGINE = 'sdk'
  process.env.ANTHROPIC_API_KEY = 'a-key-that-must-never-be-used'
  try {
    for (const row of [ROW_EXPLORE_SCENE, ROW_EXPLORE_ROUTE]) {
      await assert.rejects(askRow(row, BRIEF, { runId: 'run.0004' }), (e: unknown) => {
        assert.ok(e instanceof EngineError)
        assert.equal(e.kind, 'envelope')
        assert.match(e.message, /cannot show what that pass was given on this engine/)
        assert.match(e.message, /ask again\.$/)
        return true
      })
    }
  } finally {
    process.env.ARC_DRAFT_ENGINE = 'claude-cli'
    delete process.env.ANTHROPIC_API_KEY
  }
})
