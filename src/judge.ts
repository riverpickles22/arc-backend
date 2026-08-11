// The judge (work-graph.md §7): review of a delta, under the same capability
// model as the worker that produced it.
//
// A second model producing a second opinion is not review. This one gets a
// fixed brief — the request, the granted claim, the context actually used,
// the record produced, the deterministic findings already computed, and only
// the author rules that BIND to this change — and answers five questions.
//
// It never re-derives what the checks proved. Everything it says is `argued`
// (conventions §11): claims with citations, for a human to judge. No scores —
// a number is a way of not saying what is wrong.
//
// Read-only by construction: no tools on either engine, and this module never
// opens a file for writing.
import type Anthropic from '@anthropic-ai/sdk'
import type { Register } from 'arc-canon-graph'
import { MODEL, STORY } from './config'
import { getClient } from './agent'
import { currentEngine, runCliPrompt, stripFences } from './engine'
import { HttpError } from './http'
import type { IntentEnvelope } from './intent'
import type { Capability } from './capability'

export type Verdict = 'accept' | 'revise' | 'reject'

export interface Judgment {
  verdict: Verdict
  /** Model-read claims about the change. Always `argued`, never proven. */
  argued: { about: string; claim: string; evidence: string }[]
  /** Creative questions the structure surfaces. Surfaced, never answered. */
  asked: { about: string; question: string }[]
  register: Extract<Register, 'argued'>
}

const JUDGE_RULES = `You are arc's JUDGE. A worker just changed the story's record under a claim
that bounded what it was allowed to touch. Review the CHANGE, not the story.

You answer exactly five questions:

1. Did the change do what the author asked?
2. Did it exceed its granted scope?
3. Is its reasoning supported by the evidence it was given — or did it assert
   things nothing in its context establishes?
4. Does it conflict with a standing author rule listed below? (If none are
   listed, none bind to this change. Do not invent rules, and do not fall
   back on generic craft advice — an author rule is true only because the
   author said so.)
5. Did it miss a consequential dependency?

THE REGISTER RULE (binding, conventions §11). The deterministic checks below
are PROVEN — do not restate, re-derive, or second-guess them; they are
interval arithmetic over the record and they are not your job. Everything YOU
say is ARGUED: a claim with a citation, for the author to judge. Creative
questions go to ASKED, and you never answer them.

THE MATERIAL RULE (conventions §12). If the change filed material, the bar is
NOT "is this good story material". It is: does it preserve what the author
left open? Material that invents a name, a date, or a placement the author did
not give is a FAILURE even if the invention is plausible — it converts an idea
into a decision behind the author's back. Vagueness is correct.

VERDICT: accept | revise | reject
  accept  the change is faithful and bounded
  revise  it is close, and you can name exactly what to change
  reject  it asserts something the author did not, or exceeded its scope

Answer with one JSON object and nothing else:

{"verdict":"accept|revise|reject",
 "argued":[{"about":"<id or file>","claim":"...","evidence":"..."}],
 "asked":[{"about":"<id>","question":"..."}]}

No scores. No prose outside the JSON.`

export interface JudgeBrief {
  envelope: IntentEnvelope
  rawAuthorInput: string
  claim: Capability
  contextUsed: string
  produced: { path: string; content: string }[]
  checks: { proven: string; ok: boolean }
  /** Author rules that bind to this change. Empty is the honest answer while
   *  the rules layer (work-graph.md §8) does not exist. */
  boundRules: string[]
  workerReply: string
}

export function buildJudgePrompt(b: JudgeBrief): string {
  const produced = b.produced.length
    ? b.produced.map(p => `--- ${p.path} ---\n${p.content}`).join('\n\n')
    : '(the worker wrote nothing)'
  return [
    JUDGE_RULES,
    `=== WHAT THE AUTHOR SAID ===\n${b.rawAuthorInput}`,
    `=== HOW INTAKE READ IT ===\n${JSON.stringify(b.envelope, null, 2)}`,
    `=== THE CLAIM THE WORKER HELD ===\n${JSON.stringify(b.claim, null, 2)}`,
    `=== THE CONTEXT THE WORKER WAS GIVEN (all of it — you get no more) ===\n${b.contextUsed}`,
    `=== WHAT THE WORKER PRODUCED ===\n${produced}`,
    `=== THE WORKER'S OWN ACCOUNT ===\n${b.workerReply}`,
    `=== PROVEN CHECKS (deterministic; not yours to re-derive) ===\n${b.checks.ok ? 'PASS' : 'FAIL'}\n${b.checks.proven}`,
    `=== AUTHOR RULES BINDING TO THIS CHANGE ===\n${b.boundRules.length ? b.boundRules.join('\n') : '(none bind)'}`,
    'Produce the judgment.',
  ].join('\n\n')
}

export function parseJudgment(text: string): Judgment {
  const raw = stripFences(text)
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error(`judge did not return JSON: ${raw.slice(0, 200)}`)
  const o = JSON.parse(raw.slice(start, end + 1)) as Partial<Judgment>
  const verdicts: Verdict[] = ['accept', 'revise', 'reject']
  return {
    // An unreadable verdict is not an approval.
    verdict: verdicts.includes(o.verdict as Verdict) ? (o.verdict as Verdict) : 'revise',
    argued: Array.isArray(o.argued) ? o.argued : [],
    asked: Array.isArray(o.asked) ? o.asked : [],
    register: 'argued',
  }
}

export async function runJudge(brief: JudgeBrief): Promise<Judgment> {
  const engine = currentEngine()
  if (!engine) throw new HttpError(503, 'No generation engine available.')
  const prompt = buildJudgePrompt(brief)

  if (engine === 'claude-cli') return parseJudgment(runCliPrompt(prompt, { cwd: STORY }).text)

  const message = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: prompt }],
  })
  return parseJudgment(
    message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map(b => b.text)
      .join('\n'),
  )
}
