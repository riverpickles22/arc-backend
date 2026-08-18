// The intake pass (work-graph.md §3): what the author appears to mean, and
// nothing else.
//
// Deliberately NOT a router. It does not decide what to do — it produces an
// envelope, and the planner derives work from that. The split exists because
// "maybe Carlos should have a childhood friend" could mean remember this,
// file material, investigate placement, propose canon, revise scenes, or just
// talk, and one classifier deciding all of it in a single shot is wrong in
// the expensive direction.
//
// `authority` is the field that does the real work. `exploratory` grants no
// write capability at all, whatever else the envelope says.
import type Anthropic from '@anthropic-ai/sdk'
import { MODEL } from './config'
import { canonJson } from './canon'
import { getClient } from './agent'
import { currentEngine, runCliPrompt, stripFences } from './engine'
import { STORY } from './config'
import { HttpError } from './http'

type Operation = 'capture' | 'query' | 'research' | 'explore' | 'mutate' | 'review'
export type Authority = 'exploratory' | 'proposed' | 'author-directed'
export type Scope = 'local' | 'scene' | 'chapter' | 'arc' | 'story'

/** Inferred structural starting points — where traversal begins, never a
 *  statement about what the author meant. Kept separate from anchors so a
 *  wrong inference cannot corrupt the recorded meaning of the instruction. */
interface ScopeRoots {
  temporal: string[]
  location: string[]
  surface: string[]
}

export interface IntentEnvelope {
  operations: Operation[]
  /** What the author MEANT: ids they named, or that resolve from what they
   *  said with no ambiguity. Optimised for precision, not recall — typically
   *  one to three. Never a prediction of what a worker will need. */
  anchors: string[]
  /** Inferred, and marked as such. Arc's guess about where to start looking. */
  scope_roots: ScopeRoots
  inferred_scope: Scope
  authority: Authority
  ambiguity: 'low' | 'consequential'
  requested_outcome: string
  /** What the intake pass was unsure about — carried forward so the worker
   *  can preserve it rather than resolve it. */
  open_questions: string[]
}

const INTAKE_RULES = `You are arc's INTAKE PASS. The author said something to their story. Your
only job is to describe WHAT THEY APPEAR TO MEAN, as one JSON object. You do
not act, plan, write, or decide what work should happen.

The single most important thing you can get right: DO NOT RESOLVE THE
AUTHOR'S UNCERTAINTY. If they said "I don't know where he appears yet", that
uncertainty is part of the intent and belongs in open_questions — never
quietly settled into a decision.

FIELDS:

operations — every one that applies, from:
  capture   file this as material so it is not lost; no story truth asserted
  query     answer a question about the story as it stands
  research  find out something about the world or its history
  explore   think through options without committing to any
  mutate    change the record: canon, prose, or structure
  review    judge something that already exists

anchors — ONLY what the author actually meant. An id belongs here if they
  named it, or if what they said resolves to it with no ambiguity at all.
  Optimise for PRECISION, NOT RECALL: one to three ids is the normal answer,
  and an empty list is a valid one.

  YOU ARE NOT RETRIEVING. Do not list what a worker might find useful, might
  need to read, or happens to sit nearby — that is the worker's job, done
  later, from its own selectors. Given "Carlos needs a childhood friend,
  maybe someone from the neighbourhood", the anchors are [char.carlos]. NOT
  the café, the parents, the neighbourhood, the chapters, or the eras. Every
  one of those is a reasonable thing to read and none of them is what the
  author was talking about.

  The test: arc will later be asked why a piece of work happened. "Because
  the author was talking about Carlos" is an answer. "Because intake
  retrieved nine nearby entities" is not.

  Never invent an id for something that does not exist yet — a person the
  author is proposing has no id, and saying so is the correct answer.

scope_roots — where you think traversal should START, which is a different
  question and is explicitly your inference rather than their meaning:
    { "temporal": ["ch.01-the-cafe"], "location": ["place.cafe"], "surface": ["material"] }
  Wrong guesses here are cheap: they change where a worker begins looking,
  never what the instruction is recorded as meaning. Empty lists are fine.

inferred_scope — local | scene | chapter | arc | story

authority — how far the author has authorised you to go:
  exploratory      they are thinking aloud; nothing may be written
  proposed         they want it recorded as a proposal for their approval
  author-directed  they explicitly asked for the change to be made

  When in doubt, choose the WEAKER authority. Under-reaching costs a
  round-trip; over-reaching puts a machine's guess into the story.

ambiguity — "consequential" when the readings differ in a way that would
  change the story (a new character vs. a new scene vs. a note-to-self);
  "low" when any reasonable reading produces the same work.

requested_outcome — one plain sentence: what the author wants to be true
  when this is done.

open_questions — what the author left open. Preserve their words where you
  can. An empty list is a strong claim; make it only when it is true.

Answer with the JSON object alone. No prose, no code fence.`

function buildIntakePrompt(canon: string, input: string): string {
  return [
    INTAKE_RULES,
    `=== THE STORY RECORD (ids you may anchor to; YAML files are authoritative) ===\n${canon}`,
    `=== WHAT THE AUTHOR SAID ===\n${input}`,
    'Produce the envelope.',
  ].join('\n\n')
}

/** Tolerant parse: the model returns an object, and a missing list is an
 *  empty list rather than a crash. Authority and ambiguity fall back to the
 *  cautious value, never the permissive one. */
export function parseEnvelope(text: string): IntentEnvelope {
  const raw = stripFences(text)
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error(`intake did not return JSON: ${raw.slice(0, 200)}`)
  const o = JSON.parse(raw.slice(start, end + 1)) as Partial<IntentEnvelope>

  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : [])
  const authorities: Authority[] = ['exploratory', 'proposed', 'author-directed']
  const scopes: Scope[] = ['local', 'scene', 'chapter', 'arc', 'story']

  return {
    operations: list(o.operations) as Operation[],
    anchors: list(o.anchors),
    scope_roots: {
      temporal: list((o.scope_roots as Record<string, unknown> | undefined)?.temporal),
      location: list((o.scope_roots as Record<string, unknown> | undefined)?.location),
      surface: list((o.scope_roots as Record<string, unknown> | undefined)?.surface),
    },
    inferred_scope: scopes.includes(o.inferred_scope as Scope) ? (o.inferred_scope as Scope) : 'story',
    authority: authorities.includes(o.authority as Authority) ? (o.authority as Authority) : 'exploratory',
    ambiguity: o.ambiguity === 'low' ? 'low' : 'consequential',
    requested_outcome: typeof o.requested_outcome === 'string' ? o.requested_outcome : '',
    open_questions: list(o.open_questions),
  }
}

/** Read-only by construction: no tools on either engine. */
export async function runIntake(input: string, runId?: string): Promise<IntentEnvelope> {
  const engine = currentEngine()
  if (!engine) throw new HttpError(503, 'No generation engine available.')
  const prompt = buildIntakePrompt(canonJson(), input)

  if (engine === 'claude-cli') return parseEnvelope((await runCliPrompt(prompt, { cwd: STORY, runId })).text)

  const message = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: prompt }],
  })
  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')
  return parseEnvelope(text)
}
