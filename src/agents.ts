// Connected agents: who is working on the story, and what they have done.
//
// Hooks report agent INTENT; they never do work. A Claude session in the story
// repo tells arc that it started, what the author asked it, which tools it
// ran, and when it stopped. arc holds the run; the session holds its own
// tools and its own reasoning.
//
// THE HONESTY RULE (work-graph.md §10, decision 4): never show a plan arc does
// not have. For a session working with its own tools arc has no plan, so
// everything recorded here is OBSERVED — what has happened, never what is
// next. A checklist with pending steps would promise knowledge arc lacks.
//
// THE BINDING CONSTRAINT: UserPromptSubmit is synchronous with a thirty-second
// timeout, while intake alone measures ~9s and the judge ~50s. So the hook
// path does exactly one thing that can be slow — nothing. It opens a run
// carrying the author's raw words and returns; the structured reading is
// somebody else's problem, later.
import fs from 'node:fs'
import path from 'node:path'
import type { Agent, HookRequest, HookResponse } from 'arc-canon-graph'
import { STORY } from './config'
import { publishStream } from './run'
import { openRun, observe } from './runs'

const agents = new Map<string, Agent>()
const MAX_ACTIONS = 50

export const listAgents = (): Agent[] => [...agents.values()]

/** Is this session working on the story this backend serves?
 *
 *  A session in some other repo must be IGNORED rather than mis-attributed:
 *  arc serves one story, and a prompt typed in a different project is not a
 *  fact about this one. Resolved through realpath so a symlinked checkout is
 *  recognised rather than rejected. */
export function servesThisStory(cwd: string): boolean {
  if (!cwd) return false
  try {
    const here = fs.realpathSync(STORY)
    const there = fs.realpathSync(cwd)
    return there === here || there.startsWith(here + path.sep)
  } catch {
    return false
  }
}

function announce(agent: Agent, event: string, detail?: unknown): void {
  publishStream({ run: agent.run, at: new Date().toISOString(), event, detail: { session: agent.session, ...(detail as object ?? {}) } })
}

/** One entry point for every hook, because there is one hook script.
 *
 *  Unknown events are accepted and ignored rather than refused: a Claude
 *  release that adds a hook type must not start failing an author's session
 *  because arc had not heard of it.
 *
 *  `input.run` is set when arc launched this session itself — see ARC_RUN_ID
 *  below. */
export function hook(input: HookRequest): HookResponse {
  if (!input.session) return { ok: true, ignored: true }
  if (!servesThisStory(input.cwd)) return { ok: true, ignored: true }

  switch (input.event) {
    case 'SessionStart': {
      const agent: Agent = {
        session: input.session,
        cwd: input.cwd,
        source: input.source || 'claude-code',
        since: new Date().toISOString(),
        run: null,
        state: 'idle',
        actions: [],
      }
      agents.set(agent.session, agent)
      announce(agent, 'agent.connected', { source: agent.source })
      return { ok: true }
    }

    case 'UserPromptSubmit': {
      // A prompt can be the first thing arc hears — SessionStart may predate
      // the backend, or have been missed. Register rather than drop it.
      if (!agents.has(input.session)) hook({ ...input, event: 'SessionStart' })
      const agent = agents.get(input.session)!
      // ARC_RUN_ID is threaded into a session arc launched itself. Without it
      // the hook would open a SECOND run for work arc already knows about.
      const run = input.run ?? openRun(input.prompt ?? '', 'claude-code').id
      agent.run = run
      agent.state = 'working'
      announce(agent, 'agent.prompt', { run, prompt: input.prompt ?? '' })
      return { ok: true, run }
    }

    case 'PostToolUse': {
      const agent = agents.get(input.session)
      if (!agent) return { ok: true, ignored: true }
      agent.actions.push({ at: new Date().toISOString(), detail: input.detail })
      if (agent.actions.length > MAX_ACTIONS) agent.actions.shift()
      // Observed, never planned: it goes on the run as something that HAPPENED.
      if (agent.run) {
        try { observe(agent.run, input.detail) } catch { /* the run closed under us */ }
      }
      announce(agent, 'agent.action', { detail: input.detail })
      return { ok: true }
    }

    case 'Stop': {
      const agent = agents.get(input.session)
      if (!agent) return { ok: true, ignored: true }
      agent.state = 'idle'
      announce(agent, 'agent.idle')
      agent.run = null
      return { ok: true }
    }

    case 'SessionEnd': {
      const agent = agents.get(input.session)
      if (!agent) return { ok: true, ignored: true }
      agents.delete(agent.session)
      announce(agent, 'agent.disconnected')
      return { ok: true }
    }

    default:
      return { ok: true, ignored: true }
  }
}

/** Test seam. */
export const _resetAgents = (): void => { agents.clear() }
