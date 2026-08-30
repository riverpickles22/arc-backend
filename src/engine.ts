// The generation engine seam. Two ways to reach a model — the Anthropic SDK
// (needs an API key) or headless `claude -p` on the author's existing
// subscription login — behind one choice, so every generating feature
// (drafting, analysis, later lenses) inherits the no-key path.
//
// The seam decides only WHERE the tokens come from. What a pass is allowed to
// do with the answer stays with the pass: drafting writes through the
// validate-or-revert gate, analysis writes nothing at all.
import { spawn, spawnSync } from 'node:child_process'

export type Engine = 'sdk' | 'claude-cli'

/** Pick the engine. Pure: env and CLI availability come in as arguments.
 *  ARC_DRAFT_ENGINE: 'sdk' | 'claude-cli' force an engine; 'none' disables
 *  generation outright (tests, metered environments). */
export function chooseEngine(
  env: { ARC_DRAFT_ENGINE?: string; ANTHROPIC_API_KEY?: string; ANTHROPIC_AUTH_TOKEN?: string },
  cliAvailable: boolean,
): Engine | null {
  if (env.ARC_DRAFT_ENGINE === 'none') return null
  if (env.ARC_DRAFT_ENGINE === 'sdk' || env.ARC_DRAFT_ENGINE === 'claude-cli') return env.ARC_DRAFT_ENGINE
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

/** Strip a wrapping markdown code fence, if the model added one. */
export function stripFences(text: string): string {
  const m = text.trim().match(/^```[a-z]*\n([\s\S]*?)\n```$/)
  return m ? m[1] : text.trim()
}

/** Parse `claude -p --output-format json` output. */
export function parseCliResult(stdout: string): { text: string; sessionId: string | null } {
  let parsed: { result?: unknown; session_id?: unknown; is_error?: unknown; subtype?: unknown }
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(`claude CLI did not return JSON: ${stdout.slice(0, 200)}`)
  }
  if (parsed.is_error || parsed.subtype !== 'success' || typeof parsed.result !== 'string') {
    throw new Error(`claude CLI run failed (${String(parsed.subtype ?? 'unknown')}): ${String(parsed.result ?? '').slice(0, 300)}`)
  }
  return { text: parsed.result, sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null }
}

const CLI_TIMEOUT_MS = 600_000
const CLI_MAX_OUTPUT = 16 * 1024 * 1024

/** One headless `claude -p` turn on the subscription login. The API key is
 *  stripped from the child's environment deliberately — the whole point of
 *  this path is that it needs no key.
 *
 *  ASYNC ON PURPOSE (A13-6). This was spawnSync, which blocks the Node event
 *  loop for as long as the model takes — up to the ten-minute timeout. Every
 *  generating pass goes through here, so on the claude-cli engine a single
 *  draft froze the whole backend: no /api/canon, no /api/runs/stream
 *  heartbeat, the viewer's event stream silent exactly while there was
 *  something to show. It also made the lens fan-out a lie — four spawnSync
 *  calls inside Promise.all run strictly one after another, so the wall-clock
 *  the fan-out reports against serial could never move. Concurrency here is
 *  the property the read-only fan-out exists to demonstrate, so the seam has
 *  to be genuinely async or the demonstration proves nothing.
 *
 *  `runId` threads ARC_RUN_ID into the child. A `claude -p` arc launches fires
 *  the same hooks an interactive session does, so without it the hook would
 *  open a SECOND run for work arc already holds one for — the duplicate-run
 *  problem, solved by telling the child which run it belongs to. */
export function runCliPrompt(
  prompt: string,
  opts: { cwd: string; resume?: string | null; runId?: string; noTools?: boolean; timeoutMs?: number },
): Promise<{ text: string; sessionId: string | null }> {
  // `noTools`: the child answers from the prompt alone. A pass that WITHHOLDS
  // something from the model (reroute withholds the current prose) has to
  // mean it: a `claude -p` child in the story directory otherwise has the
  // whole working tree one Read away, and the first live run proved it looks.
  const args = ['-p', '--output-format', 'json', ...(opts.noTools ? ['--tools', ''] : []), ...(opts.resume ? ['--resume', opts.resume] : [])]
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd: opts.cwd,
      env: { ...process.env, ANTHROPIC_API_KEY: undefined, ...(opts.runId ? { ARC_RUN_ID: opts.runId } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const fail = (message: string) => finish(() => {
      child.kill('SIGKILL')
      reject(new Error(message))
    })

    // The bounds spawnSync used to enforce for us, kept identical in effect.
    const limit = opts.timeoutMs ?? CLI_TIMEOUT_MS
    const timer = setTimeout(() => fail(`claude CLI failed to run: timed out after ${limit}ms`), limit)
    timer.unref?.()

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      stdout += d
      if (stdout.length > CLI_MAX_OUTPUT) fail(`claude CLI failed to run: output exceeded ${CLI_MAX_OUTPUT} bytes`)
    })
    child.stderr.on('data', (d: string) => { stderr += d.slice(0, 4000) })

    child.on('error', e => fail(`claude CLI failed to run: ${e.message}`))
    child.on('close', code => finish(() => {
      if (code !== 0) return reject(new Error(`claude CLI exited ${code}: ${(stderr || stdout).slice(0, 300)}`))
      try {
        resolve(parseCliResult(stdout))
      } catch (e) {
        reject(e)
      }
    }))

    // A child that dies before reading the prompt gives us EPIPE here; the
    // close handler carries the real reason, so this must not mask it.
    child.stdin.on('error', () => {})
    child.stdin.end(prompt)
  })
}
