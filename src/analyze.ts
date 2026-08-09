// The analysis pass: the loop's DETECT step, run before the author commits.
//
// Capture runs at the accept gate — which means today the only way to learn
// what a scene changed is to accept it first. This pass answers the same
// question ahead of the decision: what canon this prose would propose, whether
// it met its own contract, what it contradicts, what needs verifying, how it
// holds against the style contract.
//
// It writes NOTHING. No tools, no proposals, no files — capture remains the
// only path from prose to canon, and it still runs only on the author's
// accept. Everything this pass says lives in the ARGUED register
// (conventions §11): claims with citations, to review, never verdicts.
import fs from 'node:fs'
import path from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import type { AnalyzeResponse, ProseChange, ProseScene } from 'arc-canon-graph'
import { MODEL, STORY } from './config'
import { canonJson } from './canon'
import { getClient } from './agent'
import { currentEngine, runCliPrompt } from './engine'
import { proseDraft, proseScenes } from './story'
import { HttpError } from './http'

const ANALYZE_RULES = `You are arc's ANALYSIS PASS. The author has drafted prose that is not yet
accepted into the manuscript, and wants to know what it would do to the story
BEFORE deciding. You are read-only: you file nothing, write nothing, and
change nothing. You produce one briefing.

THE REGISTER RULE (binding, conventions §11): everything you say is an
ARGUED claim — a reading of prose, offered with its evidence, for a human to
judge. Never state a claim with the confidence of a proven fact. Quote or
cite the passage behind every point. Where you are unsure, say so plainly
rather than hedging into vagueness. If the prose is clean on a dimension,
say that in one line — do not manufacture findings.

THE BRIEFING — exactly these sections, in this order, markdown headings:

## What this scene changed
The canon this prose would propose if accepted: new facts established,
state changes (who is where, what they now believe or carry), relationship
shifts, events depicted. Say what is STATED on the page versus what is
merely IMPLIED. This is the answer to "what did writing this scene change?"

## Contract check
For each must_establish in the scene's contract: met, partly met, or not
met — with the line that does it. For each must_withhold: honored, or
leaked (quote the leak). If the scene has no contract, say so.

## Conflicts with canon
Anything in the prose that contradicts the story record supplied below —
dates, locations, who was present, what a character could know at that
moment, established physical facts. Cite both sides: the line and the
canon id.

## Claims to verify
Historical or period assertions the prose commits to that a human should
check, and inventions the prose introduces that canon does not know about
(a named passer-by, a piece of business, a price). Flag anything that
risks an anachronism against the scene's own date.

## Style contract
How the prose holds against the story's style guide below, checklist item
by checklist item — held, or bent (quote it). This is the author's own
voice contract, not generic craft advice.

Be concrete and short. A briefing the author can read in two minutes and
act on beats an essay.

=== STYLE CONTRACT (docs/style.md) ===
`

/** The prompt for a set of draft changes. Pure — the caller supplies the
 *  working-tree scenes, the HEAD versions, canon, and the style contract. */
export function buildAnalysisPrompt(a: {
  style: string
  canon: string
  changes: ProseChange[]
  scenes: ProseScene[]
  readFile: (rel: string) => string
}): string {
  const byFile = new Map(a.scenes.map(s => [s.file, s]))
  const parts: string[] = []
  for (const c of a.changes) {
    if (c.status === 'deleted') {
      parts.push(`=== ${c.file} — DELETED in this draft ===\n(the accepted version is being removed)`)
      continue
    }
    const scene = byFile.get(c.file)
    const text = scene ? a.readFile(c.file) : '(unreadable)'
    const previous = c.status === 'modified' && c.main
      ? `\n\n--- the accepted version this replaces (for diffing intent) ---\n${c.main.body}`
      : ''
    parts.push(`=== ${c.file} (${c.status}) ===\n${text}${previous}`)
  }
  return [
    ANALYZE_RULES + a.style,
    `=== THE STORY RECORD (generated JSON export; YAML files are authoritative) ===\n${a.canon}`,
    `=== THE PENDING DRAFT (${a.changes.length} scene${a.changes.length === 1 ? '' : 's'}, not yet accepted) ===\n\n${parts.join('\n\n')}`,
    'Analyze the pending draft and produce the briefing. Write nothing; propose nothing; report.',
  ].join('\n\n')
}

/** Analyze the pending draft. Read-only by construction: no tools are given
 *  to the model on either engine, and this module never opens a file for
 *  writing. Throws HttpError(409) when there is no draft to analyze. */
export async function runAnalysis(): Promise<AnalyzeResponse> {
  const engine = currentEngine()
  if (!engine) throw new HttpError(503, 'No generation engine available.')

  const draft = proseDraft()
  if (!draft.git) throw new HttpError(400, 'this story is not a git repository — there is no draft layer to analyze')
  if (!draft.changes.length) throw new HttpError(409, 'no draft changes to analyze')

  const stylePath = path.join(STORY, 'docs', 'style.md')
  const prompt = buildAnalysisPrompt({
    style: fs.existsSync(stylePath) ? fs.readFileSync(stylePath, 'utf8') : '(this story has no docs/style.md — judge only against canon and the contract)',
    canon: canonJson(),
    changes: draft.changes,
    scenes: proseScenes(),
    readFile: rel => fs.readFileSync(path.join(STORY, rel), 'utf8'),
  })

  if (engine === 'claude-cli') {
    const { text } = runCliPrompt(prompt, { cwd: STORY })
    return { briefing: text, register: 'argued', engine, files: draft.changes.map(c => c.file) }
  }

  const message = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: prompt }],
  })
  const briefing = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')
  return { briefing, register: 'argued', engine, files: draft.changes.map(c => c.file) }
}
