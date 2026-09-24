// The engine seam: the row in, the brief in, an answer out (A67-2;
// agent-workflows.md §4, "The engine seam").
//
// Three engines stand behind one call. `askRow(row, brief, opts)` takes the
// registry row FIRST — the toolbelt from its envelope, the wall clock and
// the output ceiling from its budget, the session from the run and the
// launch directory from the run; a caller may narrow the envelope (add "no
// tools") and never widen it; a launch with no row throws before any
// token. Behind the seam: the FIXTURE (fixtures.ts), a recorded answer
// keyed by the fingerprint of the rendered brief; the claude CLI on the
// author's subscription login (launchCli below); and the Anthropic SDK with
// a key. A `dry` flag renders the brief and never spawns.
//
// The CLI child is asked for STREAMED output so its `system/init` event can
// be read — the envelope the runtime says it loaded (tools, MCP servers,
// model, working directory, session, version), which A67-5 proves the row
// against. It launches from a fresh scratch directory under one arc-owned
// parent per story, outside the story tree, so no project instructions,
// settings or hooks reach it and the story is not one Read away; the run id
// reaches it as ARC_RUN_ID, and each launch of the run — a seed, a repair —
// gets its own --session-id derived from the run id and the attempt, so the
// transcript is named before the run and no two launches share one; and the
// launch returns a handle a stop can kill, ending the run as `cancelled`
// rather than `timed out`.
//
// The seam decides WHERE the tokens come from and what the runtime may put
// in front of the model. What a pass does with the answer stays with the
// pass and its gates.
//
// The passes not yet on a row still call the interim `runCliPrompt` with a
// pass name; test/pass-registry.test.ts holds the ratchet on how many.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { MODEL, STORY } from './config'
import { runFixturePrompt } from './fixtures'
import { buildCliArgs, type InvocationOpts } from './invocation'
import { sha16 } from './records'
import { rowKey, type SealedRow } from './registry'

export type Engine = 'sdk' | 'claude-cli' | 'fixture'

/** Pick the engine. Pure: env and CLI availability come in as arguments.
 *  ARC_DRAFT_ENGINE: 'sdk' | 'claude-cli' force an engine; 'fixture' answers
 *  from the recorded briefs and never a model (A67-9); 'none' disables
 *  generation outright (tests, metered environments). The fixture is never
 *  chosen by default — it is asked for, or it is not there. */
export function chooseEngine(
  env: { ARC_DRAFT_ENGINE?: string; ANTHROPIC_API_KEY?: string; ANTHROPIC_AUTH_TOKEN?: string },
  cliAvailable: boolean,
): Engine | null {
  if (env.ARC_DRAFT_ENGINE === 'none') return null
  if (env.ARC_DRAFT_ENGINE === 'sdk' || env.ARC_DRAFT_ENGINE === 'claude-cli' || env.ARC_DRAFT_ENGINE === 'fixture') return env.ARC_DRAFT_ENGINE
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return 'sdk'
  if (cliAvailable) return 'claude-cli'
  return null
}

let cliChecked: boolean | undefined
/** Is the claude CLI on PATH? Checked once per process. */
function claudeCliAvailable(): boolean {
  if (cliChecked === undefined) {
    try {
      cliChecked = spawnSync('claude', ['--version'], { timeout: 10_000 }).status === 0
    } catch {
      cliChecked = false
    }
  }
  return cliChecked
}

/** The engine the server would use right now, or null when neither works. */
export function currentEngine(): Engine | null {
  return chooseEngine(process.env, claudeCliAvailable())
}

/** Can the engine that would answer now RESUME a transcript?
 *
 *  Only the CLI keeps one. The SDK is stateless and the fixture answers a
 *  brief it has seen, so on both of those the one repair has to carry the
 *  whole brief again — the same slice, never a fresh one — with the refusal
 *  appended (invariant 5; A67-6). The gate runner asks before it repairs. */
export const engineResumes = (engine: Engine | null = currentEngine()): boolean => engine === 'claude-cli'

/** Strip a wrapping markdown code fence, if the model added one. */
export function stripFences(text: string): string {
  const m = text.trim().match(/^```[a-z]*\n([\s\S]*?)\n```$/)
  return m ? m[1] : text.trim()
}

// ---- the brief ---------------------------------------------------------------

/** The brief is structured — blocks with ids — and rendered to plain text
 *  per engine, so an engine that caches a block can, and one that cannot
 *  gets the same words. The receipt names the blocks by id and
 *  fingerprint, never by text (A67-4). */
export interface BriefBlock { id: string; text: string; cached: boolean }
export interface Brief { blocks: BriefBlock[] }

/** The rendered brief: what the fixture fingerprints and the model reads. */
export const renderBrief = (b: Brief): string => b.blocks.map(x => x.text).join('\n\n')

/** The CLI's rendering of a sealed envelope, appended after the brief and
 *  never part of it: the child has no tools and no files, and its first
 *  line is the answer's first line. */
export const CLI_ENGINE_NOTE = 'ENGINE NOTE: you have no tools and no files — everything you may know is in this prompt. Do not narrate, plan, or report what you checked; the first line of your answer is the first sentence of the prose.'

// ---- what the runtime reports --------------------------------------------------

/** The `system/init` event of a streamed `claude -p` run, as the runtime
 *  reported it (test/captures/claude-cli-2.1.270-stream.jsonl). PROVEN
 *  fields of the envelope come from here — tools, MCP servers, working
 *  directory, session — and so do RECORDED ones: the skills and memory the
 *  runtime loaded on its own. `raw` keeps the whole event for the receipt. */
export interface InitEvent {
  sessionId: string | null
  cwd: string | null
  tools: string[]
  mcpServers: { name: string; status: string }[]
  model: string | null
  permissionMode: string | null
  apiKeySource: string | null
  runtimeVersion: string | null
  skills: string[]
  agents: string[]
  memoryPaths: Record<string, string>
  plugins: unknown[]
  raw: Record<string, unknown>
}

/** Tokens as the runtime reported them. `input` is the whole prompt —
 *  uncached, cache-creating and cache-read together, since the brief is
 *  the brief whichever way it was priced — with the parts beside it. */
export interface Tokens { input: number; output: number; cacheCreation: number; cacheRead: number }

export interface StreamResult {
  text: string
  sessionId: string | null
  isError: boolean
  subtype: string
  durationMs: number | null
  tokens: Tokens
  apiErrorStatus: number | null
}

/** What the seam returns: the text, and everything the receipt needs as the
 *  runtime reported it, including the envelope proof. */
export interface CliAnswer {
  /** proven against the init event, or recorded where no runtime can
   *  withhold it (A67-5). Absent only for the fixture, which is arc itself
   *  and has no runtime to prove. */
  envelope?: EnvelopeProof
  text: string
  sessionId: string | null
  init: InitEvent | null
  tokens: Tokens
  wallClockMs: number
  transcriptPath: string | null
  model: string | null
  runtimeVersion: string | null
  cwd: string | null
}

/** The closed set of ways a launch fails short of an answer (§4). A stop
 *  ends as `cancelled`; a transport failure earns no repair (invariant 5). */
export type EngineErrorKind = 'unreachable' | 'rate-limited' | 'died' | 'timed out' | 'cancelled' | 'envelope'

export class EngineError extends Error {
  constructor(readonly kind: EngineErrorKind, message: string, readonly init: InitEvent | null = null) {
    super(message)
    this.name = 'EngineError'
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function parseInitEvent(d: Record<string, unknown>): InitEvent {
  const servers = Array.isArray(d.mcp_servers) ? d.mcp_servers : []
  const memory = d.memory_paths && typeof d.memory_paths === 'object' ? d.memory_paths as Record<string, unknown> : {}
  return {
    sessionId: str(d.session_id),
    cwd: str(d.cwd),
    tools: strs(d.tools),
    mcpServers: servers
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      .map(s => ({ name: str(s.name) ?? '', status: str(s.status) ?? '' })),
    model: str(d.model),
    permissionMode: str(d.permissionMode),
    apiKeySource: str(d.apiKeySource),
    runtimeVersion: str(d.claude_code_version),
    skills: strs(d.skills),
    agents: strs(d.agents),
    memoryPaths: Object.fromEntries(Object.entries(memory).filter((e): e is [string, string] => typeof e[1] === 'string')),
    plugins: Array.isArray(d.plugins) ? d.plugins : [],
    raw: d,
  }
}

/** Read a `--output-format stream-json --verbose` stdout: one JSON object
 *  per line. Lines that are not JSON are skipped — the runtime's stdout is
 *  the runtime's — and the two events the seam needs are picked out: the
 *  init, and the result. `rateLimited` is true when a rate_limit_event said
 *  the run was rejected, whether or not a result followed. */
export function parseStream(stdout: string): { init: InitEvent | null; result: StreamResult | null; rateLimited: boolean; events: number } {
  let init: InitEvent | null = null
  let result: StreamResult | null = null
  let rateLimited = false
  let events = 0
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    let d: Record<string, unknown>
    try { d = JSON.parse(t) as Record<string, unknown> } catch { continue }
    events++
    if (d.type === 'system' && d.subtype === 'init') init = parseInitEvent(d)
    else if (d.type === 'rate_limit_event') {
      const info = d.rate_limit_info as Record<string, unknown> | undefined
      // The runtime's statuses are allowed · allowed_warning · rejected; a
      // warning is a permitted run.
      if (info && info.status === 'rejected') rateLimited = true
    } else if (d.type === 'result') {
      const usage = d.usage as Record<string, unknown> | undefined
      result = {
        text: typeof d.result === 'string' ? d.result : '',
        sessionId: str(d.session_id),
        isError: d.is_error === true,
        subtype: str(d.subtype) ?? 'unknown',
        durationMs: typeof d.duration_ms === 'number' ? d.duration_ms : null,
        tokens: {
          input: num(usage?.input_tokens) + num(usage?.cache_creation_input_tokens) + num(usage?.cache_read_input_tokens),
          output: num(usage?.output_tokens),
          cacheCreation: num(usage?.cache_creation_input_tokens),
          cacheRead: num(usage?.cache_read_input_tokens),
        },
        apiErrorStatus: typeof d.api_error_status === 'number' ? d.api_error_status : null,
      }
    }
  }
  return { init, result, rateLimited, events }
}

/** The runtime's per-project directory name for a working directory:
 *  every character that is not a letter or a digit becomes a dash (so
 *  `/Users/x/.arc/scratch/s/run-1/1` is `-Users-x--arc-scratch-s-run-1-1`).
 *  Checked against the real capture and a live launch on 2026-09-13. */
export const encodeProjectDir = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

/** Where the runtime WILL write a launch's transcript, before it runs: its
 *  projects directory, the working directory encoded, the session id. This
 *  is what lets the run name the transcript before the first token, and
 *  delete it by id whether or not the run ever reported back. */
export function expectedTranscriptPath(scratchDir: string, sessionId: string, home: string = os.homedir()): string {
  return path.join(home, '.claude', 'projects', encodeProjectDir(scratchDir), `${sessionId}.jsonl`)
}

/** Where the runtime wrote the transcript, from what it reported: the init
 *  event names its per-project directory (`memory_paths.auto` sits inside
 *  it) and the session id names the file. Null when the runtime said
 *  neither — never guessed from the working directory. */
export function transcriptPathFor(init: InitEvent | null): string | null {
  const auto = init?.memoryPaths.auto
  if (!auto || !init?.sessionId) return null
  const projectDir = path.dirname(auto.replace(/\/+$/, ''))
  return path.join(projectDir, `${init.sessionId}.jsonl`)
}

// ---- the run's names, before the launch ----------------------------------------

/** The session id a run pre-assigns to one of its launches: a UUID derived
 *  from the run id and the attempt — a seed, a repair — so the transcript is
 *  named before the run, the same launch always names the same transcript,
 *  and no two launches of one run share a session (the runtime refuses a
 *  session id already in use). */
export function sessionIdFor(runId: string, attempt = '1'): string {
  const h = createHash('sha256').update(`arc-session:${runId}#${attempt}`).digest('hex')
  // UUID shape, version 4 and variant bits set, so the runtime accepts it.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(parseInt(h[16], 16) & 0x3 | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** One arc-owned parent per story, outside the story tree (envelope rule 5):
 *  <ARC_HOME>/scratch/<story name>-<hash of its path>/. The run's own
 *  directory sits under it. */
export function scratchParent(env: { ARC_HOME?: string } = process.env, home: string = os.homedir(), story: string = STORY): string {
  const key = `${path.basename(story).replace(/[^A-Za-z0-9-]/g, '-')}-${sha16(story).slice(0, 8)}`
  return path.join(env.ARC_HOME ?? path.join(home, '.arc'), 'scratch', key)
}

/** One fresh directory per launch: the run's, then the attempt's. */
export const scratchDirFor = (runId: string, attempt = '1', parent: string = scratchParent()): string =>
  path.join(parent, runId.replace(/[^A-Za-z0-9-]/g, '-'), attempt.replace(/[^A-Za-z0-9-]/g, '-'))

// ---- the envelope: proven, or recorded, never declared -------------------------------
//
// agent-workflows §4, rules 1–3. Each field of a row's envelope has a PROOF
// CLASS. A *proven* field is asserted against what the runtime itself
// reported loading — the `system/init` event — before the run wears its
// label, or the launch is refused; a downgrade is never silent. A *recorded*
// field is one no engine on subscription auth can withhold (harness §5): it
// is listed as observed, with where it was observed, and never written as
// "none".
//
// The proof runs the moment the init event arrives, so a mismatch costs no
// tokens beyond the ones already spent reaching it.

export interface ProvenField { value: unknown; from: string }
export interface RecordedField { value: unknown; observed_in: string }

export interface EnvelopeRefusal {
  field: string
  declared: unknown
  observed: unknown
  /** rendered by code, ending in the next keystroke — never phrased by a model */
  sentence: string
}

export type EnvelopeProof =
  | { ok: true; proven: Record<string, ProvenField>; recorded: Record<string, RecordedField> }
  | { ok: false; refusal: EnvelopeRefusal; proven: Record<string, ProvenField>; recorded: Record<string, RecordedField> }

/** The files the runtime is known to load on subscription auth, whether or
 *  not its init event names them (harness §5). A recorded field names where
 *  it was observed: the init event's own field when it reports one, else
 *  these, listed as present on disk. */
export function userLevelFiles(home: string = os.homedir()): { path: string; present: boolean }[] {
  return ['CLAUDE.md', 'memory', 'skills'].map(name => {
    const p = path.join(home, '.claude', name)
    let present = false
    try { present = fs.existsSync(p) } catch { present = false }
    return { path: p, present }
  })
}

/** Project instruction files an ancestor of the launch directory carries.
 *
 *  The runtime finds CLAUDE.md by walking up from where it runs, and arc's
 *  scratch parent lives under the author's own `~/.arc/` — so a
 *  `~/CLAUDE.md` reaches a child launched three directories below it. arc
 *  cannot stop that, so it does not claim it did: the directory arc created
 *  is empty and that much is proven, and anything an ancestor carries is
 *  RECORDED, listed by path, exactly like the user-level files. */
export function ancestorProjectFiles(dir: string, stopAt: string = path.parse(dir).root): string[] {
  const out: string[] = []
  let here = path.resolve(dir)
  for (let i = 0; i < 64; i++) {
    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
      const p = path.join(here, name)
      try { if (fs.existsSync(p)) out.push(p) } catch { /* unreadable is not present */ }
    }
    const up = path.dirname(here)
    if (up === here || here === stopAt) break
    here = up
  }
  return out
}

/** What the runtime added on its own, as observed — never as "none". */
export function recordedEnvelope(init: InitEvent | null, home: string = os.homedir(), launchDir?: string): Record<string, RecordedField> {
  const files = userLevelFiles(home)
  const onDisk = files.filter(f => f.present).map(f => f.path)
  const ancestors = launchDir ? ancestorProjectFiles(launchDir) : []
  const project: Record<string, RecordedField> = ancestors.length
    ? { project_instructions_above_the_launch_directory: { value: ancestors, observed_in: 'files on disk in the directories above where the runtime ran — it finds them by walking up, and arc cannot withhold them' } }
    : {}
  if (!init) {
    return {
      user_level_instructions: { value: onDisk, observed_in: 'the files the runtime loads on subscription auth, listed as present on disk' },
      ...project,
    }
  }
  return {
    ...project,
    user_level_skills: { value: init.skills, observed_in: "the init event's `skills`" },
    subagents_available: { value: init.agents, observed_in: "the init event's `agents` — unreachable with no tool, and listed because the runtime loaded them" },
    memory: { value: init.memoryPaths, observed_in: "the init event's `memory_paths`" },
    plugins: { value: init.plugins, observed_in: "the init event's `plugins`" },
    user_level_instructions: { value: onDisk, observed_in: 'the init event does not report them; listed as present on disk' },
    runtime: { value: { version: init.runtimeVersion, model: init.model, api_key_source: init.apiKeySource }, observed_in: 'the init event' },
  }
}

const refusal = (field: string, declared: unknown, observed: unknown, sentence: string): EnvelopeRefusal =>
  ({ field, declared, observed, sentence })

/** Assert a sealed row's envelope against the runtime's own init event.
 *  Proven: tools, MCP servers, the working directory, the session, and
 *  through the empty toolbelt both network and subagents. */
export function proveEnvelope(
  row: SealedRow,
  init: InitEvent | null,
  expect: { scratchDir: string; sessionId: string | null },
  home: string = os.homedir(),
): EnvelopeProof {
  const recorded = recordedEnvelope(init, home, expect.scratchDir)
  const proven: Record<string, ProvenField> = {}
  const no = (r: EnvelopeRefusal): EnvelopeProof => ({ ok: false, refusal: r, proven, recorded })

  if (!init) {
    return no(refusal('init', 'an init event', null,
      'arc could not tell what that run loaded — the runtime reported no init event, so its envelope is unproven and the route was not written. Try again, or run `arc doctor` to see what the runtime is.'))
  }

  // Nothing about this envelope may be left unexamined: a declaration this
  // adapter can neither prove nor record refuses the launch (rule 2). The
  // checks below cover every field a sealed row can carry; anything else is
  // a row this adapter has no proof for.
  if (row.envelope.runtimeAdditions === 'none') {
    return no(refusal('runtime_additions', 'none', 'user-level, always',
      'that pass asked for a runtime that adds nothing of its own, and no runtime on your login can promise that — nothing was written. Ask again without it.'))
  }
  if (row.envelope.tools !== 'none') {
    return no(refusal('tools', row.envelope.tools, init.tools,
      'that pass asked for tools, and arc cannot yet prove which ones a runtime loaded — nothing was written. Ask again when the toolbelt is proved.'))
  }
  if (row.envelope.directory !== 'scratch') {
    return no(refusal('working_directory', row.envelope.directory, init.cwd,
      'that pass asked to run somewhere arc does not control, so what it could read cannot be accounted for — nothing was written. Ask again.'))
  }

  // tools: declared none means none loaded, and with no tool there is no
  // network and no subagent — both proven through the same fact.
  if (row.envelope.tools === 'none') {
    if (init.tools.length) {
      return no(refusal('tools', 'none', init.tools,
        `arc asked for a pass with no tools and the runtime loaded ${init.tools.length} (${init.tools.slice(0, 3).join(', ')}${init.tools.length > 3 ? '…' : ''}) — a pass that can read the book cannot be trusted not to, so nothing was written. Check the runtime's settings, or ask again.`))
    }
    proven.tools = { value: 'none', from: "the init event's `tools`, empty" }
    proven.network = { value: 'none', from: 'no tool loaded, so nothing can reach the network' }
    proven.subagents = { value: 'none', from: 'no tool loaded, so no subagent can be started' }
  }

  if (init.mcpServers.length) {
    return no(refusal('mcp_servers', 'none', init.mcpServers.map(m => m.name),
      `arc asked for a pass with no servers and the runtime loaded ${init.mcpServers.length} (${init.mcpServers.map(m => m.name).join(', ')}) — nothing was written. Start the runtime with only the servers arc asked for, or ask again.`))
  }
  proven.mcp_servers = { value: 'none', from: "the init event's `mcp_servers`, empty" }

  // the working directory: arc's own scratch directory, which is empty, so
  // no project instructions and no story file are reachable from it.
  const same = (a: string, b: string): boolean => {
    const real = (x: string): string => { try { return fs.realpathSync(x) } catch { return path.resolve(x) } }
    return real(a) === real(b)
  }
  if (row.envelope.directory === 'scratch') {
    if (!init.cwd || !same(init.cwd, expect.scratchDir)) {
      return no(refusal('working_directory', expect.scratchDir, init.cwd,
        'arc asked the runtime to run outside the story and it ran somewhere else, so the pass could have read the book it was meant to work without — nothing was written. Ask again.'))
    }
    proven.working_directory = { value: init.cwd, from: "the init event's `cwd`" }
    // Only what arc made is proven: the directory it created is empty. What
    // the runtime may find by walking UP from it is recorded above, by path
    // — arc cannot withhold it, so it never says "none".
    proven.project_context_in_the_launch_directory = {
      value: 'none',
      from: "arc created the working directory for this launch and put nothing in it; anything above it is recorded, not withheld",
    }
  }

  // the session: a sealed row never resumes, and the id the runtime reports
  // is the one arc assigned before the run.
  if (expect.sessionId && init.sessionId !== expect.sessionId) {
    return no(refusal('session', expect.sessionId, init.sessionId,
      'that run answered under a session arc did not open, so what it had already read cannot be accounted for — nothing was written. Ask again.'))
  }
  proven.session = { value: expect.sessionId ? 'the session arc opened for this launch' : 'none', from: "the init event's `session_id`" }

  return { ok: true, proven, recorded }
}

// ---- the CLI adapter ---------------------------------------------------------------

const CLI_TIMEOUT_MS = 600_000
const CLI_MAX_OUTPUT = 16 * 1024 * 1024
/** How long a stopped child gets to exit on SIGTERM before it is killed. */
const STOP_GRACE_MS = 5_000

/** A launched child: what the run holds so a stop can reach it. */
export interface Launch {
  readonly attempt: string
  readonly sessionId: string | null
  readonly scratchDir: string
  /** where the transcript will be, derived before the run; null for an
   *  interim launch with no pre-assigned session */
  readonly expectedTranscript: string | null
  readonly result: Promise<CliAnswer>
  /** End the run now. The child is killed and the promise rejects with the
   *  `cancelled` kind — never `timed out`. */
  stop(): void
}

interface SpawnPlan {
  attempt: string
  args: string[]
  prompt: string
  /** asserted the moment the init event arrives — before the run wears its
   *  label, and before another token is spent */
  prove?: (init: InitEvent | null) => EnvelopeRefusal | null
  scratchDir: string
  sessionId: string | null
  runId: string | null
  timeoutMs: number
  /** the row's output ceiling, handed to the child as its own cap */
  maxOutputTokens: number | null
}

/** One headless `claude -p` child. The API key is stripped from its
 *  environment deliberately — the whole point of this path is that it needs
 *  no key. ASYNC ON PURPOSE (A13-6): every generating pass goes through
 *  here, so a blocking spawn froze the whole backend for as long as a model
 *  took, and made the lens fan-out a lie. */
function spawnClaude(plan: SpawnPlan): Launch {
  fs.mkdirSync(plan.scratchDir, { recursive: true })
  // Resolved now, while it exists: the child reports where it really ran,
  // and on macOS the temp root is a symlink. The proof must not depend on
  // the directory still being there when it runs.
  try { plan.scratchDir = fs.realpathSync(plan.scratchDir) } catch { /* keep the path as given */ }
  const started = Date.now()
  let child: ChildProcess | null = null
  let stopped = false
  let stopRequested: (() => void) | null = null
  let settle: { resolve: (a: CliAnswer) => void; reject: (e: Error) => void } | null = null

  let timer: NodeJS.Timeout | null = null
  let grace: NodeJS.Timeout | null = null
  const result = new Promise<CliAnswer>((resolve, reject) => {
    settle = { resolve, reject }
    try {
      child = spawn('claude', plan.args, {
        cwd: plan.scratchDir,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: undefined,
          ...(plan.runId ? { ARC_RUN_ID: plan.runId } : {}),
          ...(plan.maxOutputTokens ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(plan.maxOutputTokens) } : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (e) {
      fs.rmSync(plan.scratchDir, { recursive: true, force: true })
      reject(new EngineError('unreachable', `claude CLI failed to run: ${(e as Error).message}`))
      return
    }
    const proc = child

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    // The scratch directory goes when the child has EXITED — never from
    // under a child that is still being torn down.
    proc.on('close', () => fs.rmSync(plan.scratchDir, { recursive: true, force: true }))
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (grace) clearTimeout(grace)
      fn()
    }
    const fail = (kind: EngineErrorKind, message: string) => finish(() => {
      proc.kill('SIGKILL')
      reject(new EngineError(kind, message, parseStream(stdout).init))
    })

    timer = setTimeout(() => { timedOut = true; fail('timed out', `claude CLI failed to run: timed out after ${plan.timeoutMs}ms`) }, plan.timeoutMs)
    timer.unref?.()
    // A stop that the child does not honour within the grace period is
    // finished for it — as cancelled, never as timed out.
    stopRequested = () => {
      if (settled) return
      if (timer) clearTimeout(timer)
      proc.kill('SIGTERM')
      grace = setTimeout(() => fail('cancelled', 'the run was stopped'), STOP_GRACE_MS)
      grace.unref?.()
    }

    proc.stdout!.setEncoding('utf8')
    proc.stderr!.setEncoding('utf8')
    let proved = false
    proc.stdout!.on('data', (d: string) => {
      stdout += d
      if (stdout.length > CLI_MAX_OUTPUT) {
        fail('died', `claude CLI failed to run: output exceeded ${CLI_MAX_OUTPUT} bytes`)
        return
      }
      // The envelope, the moment the runtime says what it loaded.
      if (!proved && plan.prove) {
        const init = parseStream(stdout).init
        if (init) {
          proved = true
          const bad = plan.prove(init)
          if (bad) fail('envelope', bad.sentence)
        }
      }
    })
    proc.stderr!.on('data', (d: string) => { stderr += d.slice(0, 4000) })

    proc.on('error', e => fail((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'unreachable' : 'died', `claude CLI failed to run: ${e.message}`))
    proc.on('close', (code, signal) => finish(() => {
      const parsed = parseStream(stdout)
      if (stopped) return reject(new EngineError('cancelled', 'the run was stopped', parsed.init))

      if (timedOut) return reject(new EngineError('timed out', `claude CLI failed to run: timed out after ${plan.timeoutMs}ms`, parsed.init))
      if (code !== 0) {
        const kind: EngineErrorKind = parsed.rateLimited || parsed.result?.apiErrorStatus === 429 ? 'rate-limited' : 'died'
        return reject(new EngineError(kind, `claude CLI exited ${code ?? signal}: ${(stderr || stdout).slice(0, 300)}`, parsed.init))
      }
      if (!parsed.result) {
        return reject(new EngineError(parsed.rateLimited ? 'rate-limited' : 'died', `claude CLI ended without a result (${parsed.events} events): ${(stderr || stdout).slice(0, 300)}`, parsed.init))
      }
      // A run that answered but never said what it loaded proves nothing:
      // checked here, after the transport failures above, so a crash is
      // reported as a crash and not as an unproven envelope.
      if (plan.prove && !proved) {
        const bad = plan.prove(parsed.init)
        if (bad) return reject(new EngineError('envelope', bad.sentence, parsed.init))
      }
      const r = parsed.result
      if (r.isError || r.subtype !== 'success') {
        const kind: EngineErrorKind = parsed.rateLimited || r.apiErrorStatus === 429 || /rate.?limit/i.test(r.subtype) ? 'rate-limited' : 'died'
        return reject(new EngineError(kind, `claude CLI run failed (${r.subtype}): ${r.text.slice(0, 300)}`, parsed.init))
      }
      const init = parsed.init
      resolve({
        text: r.text,
        sessionId: r.sessionId ?? init?.sessionId ?? plan.sessionId,
        init,
        tokens: r.tokens,
        wallClockMs: Date.now() - started,
        transcriptPath: transcriptPathFor(init),
        model: init?.model ?? null,
        runtimeVersion: init?.runtimeVersion ?? null,
        cwd: init?.cwd ?? plan.scratchDir,
      })
    }))

    // A child that dies before reading the prompt gives us EPIPE here; the
    // close handler carries the real reason, so this must not mask it.
    proc.stdin!.on('error', () => {})
    proc.stdin!.end(plan.prompt)
  })

  return {
    attempt: plan.attempt,
    sessionId: plan.sessionId,
    scratchDir: plan.scratchDir,
    expectedTranscript: plan.sessionId ? expectedTranscriptPath(plan.scratchDir, plan.sessionId) : null,
    result,
    stop() {
      stopped = true
      if (stopRequested) stopRequested()
      else if (!child && settle) settle.reject(new EngineError('cancelled', 'the run was stopped'))
    },
  }
}

export interface RowLaunchOpts {
  /** what the runtime reported it loaded, proven against the row — handed
   *  over the moment it is known, so a refusal reaches the receipt even
   *  though the launch throws */
  onProof?: (proof: EnvelopeProof) => void
  /** the ONE bounded repair (invariant 5): resume the transcript this
   *  earlier attempt of the same run opened, so the refusal and the previous
   *  answer are the only new input. Not a session in the registry's sense —
   *  a sealed row still has none to set, and nothing resumes across jobs. */
  resumeAttempt?: string
  /** the run this launch belongs to — minted before the first token, and
   *  what names the transcript */
  runId: string
  /** which launch of the run this is — a seed, a repair — so each has its
   *  own session and scratch directory; '1' when the run launches once */
  attempt?: string
  /** a caller may narrow the envelope, never widen it */
  noTools?: boolean
  /** overrides the row's wall clock; only ever lower */
  timeoutMs?: number
}

/** Launch the claude CLI for a row: from a fresh scratch directory, with
 *  streamed output, the run id in its environment and its session
 *  pre-assigned. Returns the handle; the answer is `result`. A launch with
 *  no row throws here, before the spawn. */
export function launchCli(row: SealedRow, brief: Brief, opts: RowLaunchOpts): Launch {
  if (!row) throw new Error('a launch needs a registry row — no row, no launch')
  if (!opts?.runId) throw new Error(`a launch of ${rowKey(row)} needs its run id before the first token`)
  const attempt = opts.attempt ?? '1'
  // The repair resumes the earlier attempt's transcript, and runs from the
  // same directory: the runtime keeps a transcript per working directory,
  // and the directory the earlier launch used was removed when it exited.
  //
  // Verified against claude 2.1.270 on 2026-09-13: a `--session-id` call,
  // then the directory deleted and recreated, then `--resume <that id>` —
  // the init event came back with the SAME session id and the model had its
  // own previous answer. That is what lets the proof below expect the
  // opened session, and what makes attempt 2's transcript attempt 1's.
  const resuming = opts.resumeAttempt
  const sessionId = resuming ? sessionIdFor(opts.runId, resuming) : sessionIdFor(opts.runId, attempt)
  const args = buildCliArgs(resuming ? { row, noTools: opts.noTools, repairResume: sessionId } : { row, noTools: opts.noTools, sessionId })
  const budget = row.budget.wallClockMs
  const scratchDir = scratchDirFor(opts.runId, resuming ?? attempt)
  let proof: EnvelopeProof | null = null
  const launch = spawnClaude({
    attempt,
    args,
    prompt: `${renderBrief(brief)}\n\n${CLI_ENGINE_NOTE}`,
    scratchDir,
    sessionId,
    runId: opts.runId,
    timeoutMs: opts.timeoutMs !== undefined ? Math.min(opts.timeoutMs, budget) : budget,
    maxOutputTokens: row.budget.outputTokens,
    // The envelope is asserted the moment the runtime says what it loaded —
    // before the run wears its label (§4, rule 2).
    prove: init => {
      proof = proveEnvelope(row, init, { scratchDir, sessionId })
      opts.onProof?.(proof)
      return proof.ok ? null : proof.refusal
    },
  })
  return { ...launch, result: launch.result.then(a => ({ ...a, envelope: proof ?? undefined })) }
}

// ---- the SDK adapter ----------------------------------------------------------------

async function askSdk(row: SealedRow, brief: Brief, opts: AskOpts): Promise<CliAnswer> {
  // Lazily: agent.ts holds the client and reads this module's engine choice.
  const { getClient } = await import('./agent')
  const started = Date.now()
  const system: Anthropic.Beta.BetaTextBlockParam[] = brief.blocks
    .filter(b => b.cached)
    .map(b => ({ type: 'text', text: b.text, cache_control: { type: 'ephemeral' } }))
  const user = brief.blocks.filter(b => !b.cached).map(b => b.text).join('\n\n')
  // A stop must reach this call too: the run holds a handle whose stop()
  // aborts the request, exactly as the CLI path's kills the child.
  const abort = new AbortController()
  const attempt = opts.attempt ?? '1'
  const result = getClient().beta.messages.create({
    model: MODEL,
    max_tokens: row.budget.outputTokens,
    system,
    messages: [{ role: 'user', content: user }],
  }, { signal: abort.signal })
  opts.onLaunch?.({
    attempt,
    sessionId: null,
    scratchDir: '',
    expectedTranscript: null,
    // The answer is awaited below, by askRow. This handle exists so a stop
    // can abort the request; its `result` must never be a live promise
    // nobody awaits, or its rejection would take the backend down.
    result: Promise.resolve(undefined as unknown as CliAnswer),
    stop: () => abort.abort(),
  })
  const message = await result.catch((e: unknown) => {
    if (abort.signal.aborted) throw new EngineError('cancelled', 'the run was stopped')
    const status = (e as { status?: number }).status
    throw new EngineError(status === 429 ? 'rate-limited' : status === undefined ? 'unreachable' : 'died', `the SDK refused: ${(e as Error).message}`)
  })
  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')
  return {
    text, sessionId: null, init: null,
    tokens: {
      input: (message.usage?.input_tokens ?? 0) + (message.usage?.cache_creation_input_tokens ?? 0) + (message.usage?.cache_read_input_tokens ?? 0),
      output: message.usage?.output_tokens ?? 0,
      cacheCreation: message.usage?.cache_creation_input_tokens ?? 0,
      cacheRead: message.usage?.cache_read_input_tokens ?? 0,
    },
    wallClockMs: Date.now() - started, transcriptPath: null,
    model: message.model ?? MODEL, runtimeVersion: 'anthropic-sdk', cwd: null,
  }
}

// ---- the seam ------------------------------------------------------------------------

export interface AskOpts extends RowLaunchOpts {
  /** render the brief and never spawn — the slice, the brief and every
   *  before-any-token refusal run; no engine is consulted */
  dry?: boolean
  /** the run keeps the handle, so a stop can reach the child */
  onLaunch?: (launch: Launch) => void
}

export type DryAnswer = { dry: true; brief: string }

/** The row in, the brief in, the answer out — from whichever engine is
 *  configured. Throws before anything is spent when there is no row. */
export async function askRow(row: SealedRow, brief: Brief, opts: AskOpts): Promise<CliAnswer | DryAnswer> {
  if (!row) throw new Error('a launch needs a registry row — no row, no launch')
  const rendered = renderBrief(brief)
  if (opts.dry) return { dry: true, brief: rendered }
  const engine = currentEngine()
  if (engine === 'fixture') {
    const r = await runFixturePrompt(rendered, { row: rowKey(row) })
    // The fixture is arc answering itself from a recorded brief: no runtime
    // started, so nothing was loaded and there is nothing to prove. Said
    // plainly rather than left blank, and never as a list of files some
    // runtime would have read.
    return {
      text: r.text, sessionId: sessionIdFor(opts.runId, opts.attempt), init: null,
      envelope: {
        ok: true,
        proven: { runtime: { value: 'none', from: 'the fixture engine started no runtime: the answer was recorded against this exact brief' } },
        recorded: {},
      },
      tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      wallClockMs: 0, transcriptPath: null, model: 'fixture', runtimeVersion: 'fixture', cwd: null,
    }
  }
  if (engine === 'claude-cli') {
    const launch = launchCli(row, brief, opts)
    opts.onLaunch?.(launch)
    return launch.result
  }
  if (engine === 'sdk') {
    // Slice 6 proves the second runtime (agent-workflows §11). Until then
    // this adapter reports nothing about what it loaded, so a withholding
    // row cannot be honest on it and refuses rather than promising.
    if (row.withholding) {
      throw new EngineError('envelope',
        'arc cannot show what that pass was given on this engine, and this one is defined by what it is not shown — so nothing was written. Log in to the claude CLI and ask again.')
    }
    return askSdk(row, brief, opts)
  }
  throw new EngineError('unreachable', 'no engine configured — set ANTHROPIC_API_KEY in arc-backend/.env, or log in to the claude CLI')
}

export const isDry = (a: CliAnswer | DryAnswer): a is DryAnswer => (a as DryAnswer).dry === true

// ---- the interim: passes not yet on a row ------------------------------------------------

/** One headless `claude -p` turn for a pass that names its PASS_REGISTRY
 *  entry rather than a row (the eleven not yet migrated; the ratchet).
 *  Streamed, from a scratch directory of its own, with the run id in its
 *  environment when the caller has one; no session is pre-assigned unless
 *  the caller names one, the wall clock is the seam's default, and no
 *  output ceiling reaches the child — the row's budgets and proof are what
 *  the migration adds. */
export function runCliPrompt(
  prompt: string,
  opts: InvocationOpts & { runId?: string; timeoutMs?: number },
): Promise<CliAnswer> {
  const args = buildCliArgs(opts)
  const runId = opts.runId ?? null
  const attempt = sha16(`${Date.now()}-${Math.random()}`).slice(0, 12)
  return spawnClaude({
    attempt,
    args,
    prompt,
    scratchDir: scratchDirFor(runId ?? 'bare', attempt),
    sessionId: opts.sessionId ?? null,
    runId,
    timeoutMs: opts.timeoutMs ?? CLI_TIMEOUT_MS,
    maxOutputTokens: null,
  }).result
}
