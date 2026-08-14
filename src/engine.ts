// The generation engine seam. Two ways to reach a model — the Anthropic SDK
// (needs an API key) or headless `claude -p` on the author's existing
// subscription login — behind one choice, so every generating feature
// (drafting, analysis, later lenses) inherits the no-key path.
//
// The seam decides only WHERE the tokens come from. What a pass is allowed to
// do with the answer stays with the pass: drafting writes through the
// validate-or-revert gate, analysis writes nothing at all.
import { spawnSync } from 'node:child_process'

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
export function claudeCliAvailable(): boolean {
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

/** One headless `claude -p` turn on the subscription login. The API key is
 *  stripped from the child's environment deliberately — the whole point of
 *  this path is that it needs no key. */
/** `runId` threads ARC_RUN_ID into the child. A `claude -p` arc launches fires
 *  the same hooks an interactive session does, so without it the hook would
 *  open a SECOND run for work arc already holds one for — the duplicate-run
 *  problem, solved by telling the child which run it belongs to. */
export function runCliPrompt(prompt: string, opts: { cwd: string; resume?: string | null; runId?: string }): { text: string; sessionId: string | null } {
  const args = ['-p', '--output-format', 'json', ...(opts.resume ? ['--resume', opts.resume] : [])]
  const res = spawnSync('claude', args, {
    input: prompt, encoding: 'utf8', cwd: opts.cwd, timeout: 600_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ANTHROPIC_API_KEY: undefined, ...(opts.runId ? { ARC_RUN_ID: opts.runId } : {}) },
  })
  if (res.error) throw new Error(`claude CLI failed to run: ${res.error.message}`)
  if (res.status !== 0) throw new Error(`claude CLI exited ${res.status}: ${(res.stderr || res.stdout).slice(0, 300)}`)
  return parseCliResult(res.stdout)
}
