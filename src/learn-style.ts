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
import { MODEL, STORY } from './config'
import { getClient } from './agent'
import { currentEngine, runCliPrompt, stripFences } from './engine'
import { generatedFor, clearGenerated } from './ledger'
import { readJudgments } from './evidence'
import { alignParagraphs } from 'arc-canon-graph'
import { git, parseScene } from './story'
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

interface EditPair {
  n: number
  scene: string
  /** 'draft' — arc's draft vs what the author kept (the ledger diff).
   *  'revision' — the author's last accepted prose vs their hand rewrite of
   *  it, read from git at the accept gate. The purest voice signal: nobody
   *  described the change, the change is the description. */
  source: 'draft' | 'revision'
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

/** Pair what arc wrote against what the author kept, paragraph by paragraph.
 *
 *  Rewrites and deletions become pairs; a paragraph the author ADDED outright
 *  does not. An addition has nothing on arc's side to compare against, so it
 *  cannot support a rule about how arc should write — it is the author adding
 *  their own material, not correcting arc's.
 *
 *  The alignment is arc-canon-graph's, the same one the accept gate merges
 *  against and the viewer renders. This module used to carry its own copy;
 *  two implementations of one alignment is the arrangement diff-seq.ts was
 *  extracted to end, and here it would have meant learning a rule from a pair
 *  the author never saw as a pair. Pure, so the arithmetic that silently goes
 *  wrong is the part under test. */
export function editPairs(wrote: string, kept: string, scene: string, source: 'draft' | 'revision' = 'draft'): EditPair[] {
  const a = paragraphs(wrote)
  const b = paragraphs(kept)
  const pairs: Omit<EditPair, 'n'>[] = []

  for (const al of alignParagraphs(a, b)) {
    if (al.kind === 'changed') {
      const was = a[al.mainIndex!], now = b[al.draftIndex!]
      pairs.push({ scene, source, wrote: was, kept: now, changed: changedWords(was, now) })
    } else if (al.kind === 'del') {
      // A cut is a pair with an empty kept side: the author's answer to that
      // paragraph was that the book is better without it.
      const was = a[al.mainIndex!]
      pairs.push({ scene, source, wrote: was, kept: '', changed: changedWords(was, '') })
    }
  }
  return pairs.map((p, i) => ({ n: i + 1, ...p }))
}

/** The bar, applied in one place so the test can pin it. */
export const significant = (pairs: EditPair[]): EditPair[] =>
  pairs.filter(p => p.changed >= MIN_CHANGED_WORDS)

const LEARN_RULES = `You are arc's STYLE LEARNING pass. The author accepted prose, editing on
the way in. Below are numbered EDIT pairs of two kinds, labelled:

- ARC WROTE / AUTHOR KEPT — arc drafted the paragraph; the author reworked
  it. The edit says how arc should have written it.
- AUTHOR HAD / REVISED TO — the author's own accepted prose, rewritten by
  their own hand. Nobody corrected anybody: this is the author's preference
  showing directly, the strongest voice signal in this table.

An empty right-hand side means the paragraph was cut entirely.

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
    p.source === 'revision'
      ? `AUTHOR HAD: ${p.wrote}`
      : `ARC WROTE: ${p.wrote}`,
    p.source === 'revision'
      ? `REVISED TO: ${p.kept || '(cut entirely)'}`
      : `AUTHOR KEPT: ${p.kept || '(cut entirely)'}`,
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

interface RawProposal { rule: string; section: string | null; edits: number[] }

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
    // Attribution is conservative: a rule is 'revision' only when every edit
    // it cites is one. One draft correction in the argument makes it a rule
    // about how arc should write, and it files as such.
    const cited = p.edits.map(n => byN.get(n)).filter((x): x is EditPair => !!x)
    const source = cited.length && cited.every(x => x.source === 'revision') ? 'revision' as const : 'draft' as const
    out.push({ id: ruleId(p.rule), rule: p.rule, section: p.section, at, evidence, source })
    if (out.length >= MAX_PROPOSALS_PER_RUN) break
  }
  return out
}

/** The scene's body at the commit this file's pending work started from.
 *
 *  This read HEAD^, on the stated assumption that an accept makes exactly one
 *  commit. Judging by paragraph and by sentence makes that false — a scene
 *  taken a sentence at a time produces a commit per sentence, so HEAD^ is one
 *  sentence ago and the "before" text is arc's own draft with one change
 *  removed. Rules were being argued from a difference the author never made.
 *
 *  The boundary is pinned when the file's pending work is first judged
 *  (evidence.ts) and read back here. Null when nothing was pinned, which is
 *  the honest answer rather than a guess at one. */
function baselineBody(file: string): string | null {
  // From the RECORD, not the pin. The pin under .arc/ only lives while a
  // file's work is pending — proseAccept clears it on the way out — but every
  // judgment writes the sha it started from into the evidence log, which is
  // tracked and permanent. The most recent one is this file's boundary.
  const sha = readJudgments().filter(j => j.file === file).at(-1)?.baseline ?? null
  if (!sha) return null
  try {
    const prefix = git('rev-parse', '--show-prefix').trim()
    return parseScene(git('show', `${sha}:${prefix}${file}`), file)?.body ?? null
  } catch {
    return null
  }
}

/** The scene's body as the BOOK now holds it — HEAD, not disk.
 *
 *  Disk is the draft. It was read here on the assumption that after an accept
 *  the two agree, which is true of the whole-draft accept and never true of
 *  the others: proseAcceptParagraph commits one paragraph and then restores
 *  the author's full working tree in its finally, so on return disk holds
 *  every change they have NOT accepted. Reading it would have handed the
 *  learning pass arc's own unaccepted prose as "what the author kept" — and
 *  the queue renders that side as "you revised to", over the author's name.
 *
 *  Frontmatter is stripped either way: the contract is about prose, and a
 *  binding edit is not voice. */
function headBody(file: string): string | null {
  try {
    const prefix = git('rev-parse', '--show-prefix').trim()
    return parseScene(git('show', `HEAD:${prefix}${file}`), file)?.body ?? null
  } catch {
    return null
  }
}

interface LearnResult {
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
    const kept = headBody(file)
    if (kept === null) continue
    const gen = generatedFor(file)
    if (gen) {
      // Arc drafted this one: the ledger diff is the more precise signal —
      // it separates arc's exact output from every keystroke of the author's.
      mined.push(file)
      const wrote = parseScene(gen.content, file)?.body ?? gen.content
      pairs.push(...significant(editPairs(wrote, kept, file)))
    } else {
      // No ledger entry: the author edited their own accepted prose by hand.
      // The before is what git accepted last time. A scene that is new at
      // HEAD^ yields nothing — added prose argues no rule (same reasoning as
      // added paragraphs inside editPairs).
      const had = baselineBody(file)
      if (had === null || had === kept) continue
      pairs.push(...significant(editPairs(had, kept, file, 'revision')))
    }
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
