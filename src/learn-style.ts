// The style LEARNING pass: what did the author change about what arc wrote?
//
// Runs at the accept gate, beside capture. Capture asks what the prose means
// for canon; this asks what the author's edits mean for the contract. Both are
// non-fatal — a failure here must never un-accept prose.
//
// THE TRUST PROPERTY. The model never supplies a quote. It receives NUMBERED
// edit pairs and answers with rule text plus the edit numbers it relies on;
// the backend then materializes each proposal's evidence verbatim out of its
// own diff table. So a proposal in the queue cannot carry a fabricated or
// paraphrased quote, which is what makes the queue safe to ratify from at a
// glance. The model chooses the rule; the machine supplies the proof.
//
// Everything produced here is ARGUED (conventions §11) and binds nothing: the
// queue lives in docs/style.proposed.md, which no drafting pass ever reads.
import type Anthropic from '@anthropic-ai/sdk'
import fs from 'node:fs'
import path from 'node:path'
import { MODEL, STORY } from './config'
import { getClient } from './agent'
import { currentEngine, runCliPrompt, stripFences } from './engine'
import { generatedFor, clearGenerated } from './ledger'
import { parseScene } from './story'
import { styleContract } from './style'
import { appendToQueue, readQueue, ruleId, type ProposedRule, type RuleEvidence } from './style-queue'

/** Below this many word-level changes a paragraph edit is a typo fix or a
 *  continuity patch, not a voice signal. Filtering here is what keeps the
 *  model from generalizing a rule out of a corrected character name. */
export const MIN_CHANGED_WORDS = 3

/** Homework limits. Three proposals is a glance; a queue of thirty is a chore
 *  the author will abandon, which costs more than the loop is worth. */
export const MAX_PROPOSALS_PER_RUN = 3
export const QUEUE_SUPPRESS_AT = 12

/** Bound the prompt regardless of how much was rewritten in one accept. */
const MAX_PAIRS = 24

/** Evidence quotes are truncated once, here, so the record and the rendered
 *  file always show the identical string. */
const EVIDENCE_CHARS = 320

export interface EditPair {
  n: number
  scene: string
  wrote: string
  kept: string
  changed: number
}

const paragraphs = (body: string): string[] =>
  body.split(/\n{2,}/).map(s => s.trim()).filter(Boolean)

const words = (s: string): string[] => s.split(/\s+/).filter(Boolean)

/** Word-level edit distance. Paragraphs are short, so the plain O(n·m) table
 *  is the right amount of machinery. */
export function changedWords(a: string, b: string): number {
  const x = words(a)
  const y = words(b)
  if (!x.length || !y.length) return Math.max(x.length, y.length)
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j)
  for (let i = 1; i <= x.length; i++) {
    const row = [i]
    for (let j = 1; j <= y.length; j++) {
      row[j] = x[i - 1] === y[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], row[j - 1])
    }
    prev = row
  }
  return prev[y.length]
}

/** Longest common subsequence of paragraphs, as index pairs. The identical
 *  paragraphs are the anchors; everything between them is the edit. */
function anchors(a: string[], b: string[]): [number, number][] {
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push([i, j]); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return out
}

/** Pair what arc wrote against what the author kept, paragraph by paragraph.
 *
 *  Rewrites and deletions become pairs; a paragraph the author ADDED outright
 *  does not. An addition has nothing on arc's side to compare against, so it
 *  cannot support a rule about how arc should write — it is the author adding
 *  their own material, not correcting arc's. Pure, so the arithmetic that
 *  silently goes wrong is the part under test. */
export function editPairs(wrote: string, kept: string, scene: string): EditPair[] {
  const a = paragraphs(wrote)
  const b = paragraphs(kept)
  const pairs: Omit<EditPair, 'n'>[] = []

  const marks = [...anchors(a, b), [a.length, b.length] as [number, number]]
  let ai = 0
  let bi = 0
  for (const [am, bm] of marks) {
    const removed = a.slice(ai, am)
    const added = b.slice(bi, bm)
    // Positional pairing inside a changed block: removed[k] is what arc wrote
    // where added[k] is what the author put instead. Surplus removals are
    // cuts (kept: ''); surplus additions are the author's own new prose.
    for (let k = 0; k < removed.length; k++) {
      const to = added[k] ?? ''
      pairs.push({ scene, wrote: removed[k], kept: to, changed: changedWords(removed[k], to) })
    }
    ai = am + 1
    bi = bm + 1
  }
  return pairs.map((p, i) => ({ n: i + 1, ...p }))
}

/** The bar, applied in one place so the test can pin it. */
export const significant = (pairs: EditPair[]): EditPair[] =>
  pairs.filter(p => p.changed >= MIN_CHANGED_WORDS)

const LEARN_RULES = `You are arc's STYLE LEARNING pass. The author accepted scenes that arc
drafted, and edited them on the way in. Below are numbered EDIT pairs: what
arc WROTE, and what the author KEPT in its place. An empty KEPT means the
author cut the paragraph entirely.

Your job is to name the FORM rules those edits imply — how this author's
sentences behave. Diction, rhythm, sentence length, punctuation, register,
what they refuse to spell out. NEVER a rule about fact, plot, character, or
canon: those belong to the story record, not the style contract.

DISCIPLINE:
- Propose a rule only when the same pattern shows in TWO OR MORE edits, or
  when one edit shows it unmistakably. One coincidence is not a rule.
- Never propose a rule the contract below already states, in any wording.
- Never propose a rule already in the pending queue below.
- Write each rule the way the contract is written: imperative, one or two
  sentences, addressed to whoever drafts next.
- Do NOT quote the prose. Cite edit NUMBERS only — arc attaches the quotes
  itself, from its own diff.
- If nothing generalizes, answer with an empty array. That is a good answer
  and the common one.

Answer with a JSON array and nothing else:
[{"rule": "...", "section": "Sentences" | null, "edits": [1, 4]}]`

/** Pure prompt builder — testable without an engine. */
export function buildLearnPrompt(input: {
  pairs: EditPair[]
  style: string
  pending: string[]
}): string {
  const table = input.pairs.map(p => [
    `--- EDIT ${p.n} (${p.scene}) ---`,
    `ARC WROTE: ${p.wrote}`,
    `AUTHOR KEPT: ${p.kept || '(cut entirely)'}`,
  ].join('\n')).join('\n\n')

  return [
    LEARN_RULES,
    `=== THE CONTRACT AS IT STANDS (do not re-propose any of this) ===\n${input.style}`,
    input.pending.length
      ? `=== ALREADY PENDING RATIFICATION (do not re-propose) ===\n${input.pending.map(r => `- ${r}`).join('\n')}`
      : '',
    `=== THE EDITS ===\n${table}`,
    'Answer with the JSON array.',
  ].filter(Boolean).join('\n\n')
}

export interface RawProposal { rule: string; section: string | null; edits: number[] }

/** Tolerant parse, matching the other passes: fences stripped, junk dropped. */
export function parseProposals(text: string): RawProposal[] {
  const raw = stripFences(text)
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end < start) throw new Error(`learning pass did not return a JSON array: ${raw.slice(0, 160)}`)
  const parsed: unknown = JSON.parse(raw.slice(start, end + 1))
  if (!Array.isArray(parsed)) throw new Error('learning pass returned JSON that is not an array')
  return parsed.flatMap((x): RawProposal[] => {
    const r = x as Partial<RawProposal>
    if (typeof r.rule !== 'string' || !r.rule.trim()) return []
    const edits = Array.isArray(r.edits) ? r.edits.filter((n): n is number => Number.isInteger(n)) : []
    return [{ rule: r.rule.trim(), section: typeof r.section === 'string' && r.section.trim() ? r.section.trim() : null, edits }]
  })
}

const clip = (s: string): string =>
  s.length <= EVIDENCE_CHARS ? s : s.slice(0, EVIDENCE_CHARS - 1).trimEnd() + '…'

/** Attach evidence from OUR table, not the model's text, and drop any
 *  proposal that cites nothing real. A rule with no evidence is an opinion,
 *  and the author has no way to judge it. */
export function materialize(proposals: RawProposal[], pairs: EditPair[], at: string): ProposedRule[] {
  const byN = new Map(pairs.map(p => [p.n, p]))
  const out: ProposedRule[] = []
  for (const p of proposals) {
    const evidence: RuleEvidence[] = p.edits
      .map(n => byN.get(n))
      .filter((x): x is EditPair => !!x)
      .slice(0, 3)
      .map(x => ({ scene: x.scene, wrote: clip(x.wrote), kept: clip(x.kept) }))
    if (!evidence.length) continue
    out.push({ id: ruleId(p.rule), rule: p.rule, section: p.section, at, evidence })
    if (out.length >= MAX_PROPOSALS_PER_RUN) break
  }
  return out
}

/** The body of an accepted scene as it stands on disk, frontmatter stripped —
 *  the contract is about prose, and frontmatter edits are not voice. */
function acceptedBody(file: string): string | null {
  try {
    const abs = path.join(STORY, file)
    if (!fs.existsSync(abs)) return null
    return parseScene(fs.readFileSync(abs, 'utf8'), file)?.body ?? null
  } catch {
    return null
  }
}

export interface LearnResult {
  added: ProposedRule[]
  /** Why nothing was proposed, when nothing was — including the cases that
   *  never reached the model at all. */
  skipped: 'queue-full' | 'no-edits' | 'no-engine' | null
  pairsConsidered: number
}

export async function runLearnStyle(files: string[]): Promise<LearnResult> {
  // A full queue suppresses the pass before anything is read or spent. More
  // proposals do not help an author who has not looked at the last twelve.
  if (readQueue().length >= QUEUE_SUPPRESS_AT) return { added: [], skipped: 'queue-full', pairsConsidered: 0 }

  const pairs: EditPair[] = []
  const mined: string[] = []
  for (const file of files) {
    const gen = generatedFor(file)
    if (!gen) continue // hand-written, or already mined: nothing of arc's to compare
    mined.push(file)
    const kept = acceptedBody(file)
    if (kept === null) continue
    const wrote = parseScene(gen.content, file)?.body ?? gen.content
    pairs.push(...significant(editPairs(wrote, kept, file)))
  }

  // Accepted unedited, or nothing arc wrote: no model, no tokens.
  if (!pairs.length) {
    if (mined.length) clearGenerated(mined)
    return { added: [], skipped: 'no-edits', pairsConsidered: 0 }
  }

  const engine = currentEngine()
  if (!engine) return { added: [], skipped: 'no-engine', pairsConsidered: pairs.length }

  // Renumber after truncation so the numbers the model sees are the numbers
  // materialize() looks up.
  const considered = pairs.slice(0, MAX_PAIRS).map((p, i) => ({ ...p, n: i + 1 }))
  const prompt = buildLearnPrompt({
    pairs: considered,
    style: styleContract(),
    pending: readQueue().map(r => r.rule),
  })

  let text: string
  if (engine === 'claude-cli') {
    text = (await runCliPrompt(prompt, { cwd: STORY })).text
  } else {
    const message = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    })
    text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map(b => b.text)
      .join('\n')
  }

  const fresh = materialize(parseProposals(text), considered, new Date().toISOString())
  const { added } = appendToQueue(fresh)

  // Consumed: the same edit must never be mined twice into the same queue.
  clearGenerated(mined)
  return { added, skipped: null, pairsConsidered: considered.length }
}
