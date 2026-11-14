// U12's three gates, as pure measurements (A74-6).
//
// A rule the learner proposes is held to three bars before it reaches the
// author's queue. Two of them can be DECIDED by code — a count of independent
// examples, an id or a countable predicate already stated — and are proven.
// The third kind of fact is wording: a rule that says nearly what the
// contract (or a declined rule) says in other words. Code can measure how
// close two wordings are, but whether they mean the same is the author's
// reading, so a wording-only match is KEPT and marked argued, never dropped.
//
// This module reads nothing from disk and launches nothing; gates.ts wraps it
// in typed records and the pass supplies the record it measures against.
import { andCapFromContract, wordCapFromContract } from './countable'
import { ruleId } from './style-queue'

/** A countable predicate: the two style rules the contract can state as a
 *  number, the same two arc's prose gates read (reroute.ts). Two statements
 *  of the same predicate with the same number are the same rule however they
 *  are worded. */
export type Predicate = `and-chain:${number}` | `sentence-length:${number}`

/** The countable predicates a text states, read by the SAME readers the prose
 *  gates read the contract with (countable.ts) — one definition of what
 *  "a chain stops at three" means. Called on one rule or one contract line at
 *  a time, as those readers find the first statement in what they are given
 *  — and on a whole composed contract they give the book's number, not every
 *  number stated, so this function is meant for one rule or one line. */
export function predicatesOf(text: string): Predicate[] {
  const out: Predicate[] = []
  const chain = andCapFromContract(text)
  if (chain !== null) out.push(`and-chain:${chain}`)
  const sentence = wordCapFromContract(text)
  if (sentence !== null) out.push(`sentence-length:${sentence}`)
  return out
}

/** The lines a contract states rules in: each paragraph and each list item,
 *  headings and the machine's own labels left out. A ratified rule is written
 *  into the contract as a paragraph (style-queue.ts `renderRatified`), so its
 *  id is the id of one of these. */
export function contractLines(contract: string): string[] {
  const out: string[] = []
  for (const block of contract.split(/\n{2,}/)) {
    const lines = block.split('\n').map(l => l.trim().replace(/^(?:[-*]|\d+[.)])\s+/, '')).filter(Boolean)
    const text = lines.join(' ').trim()
    if (text && !/^#{1,6}\s/.test(text) && !/^(?:===|PRECEDENCE:)/.test(text)) out.push(text)
    for (const l of lines) if (l !== text && !/^#{1,6}\s/.test(l) && !/^===/.test(l)) out.push(l)
  }
  return out
}

const STOP = new Set(['the', 'and', 'that', 'this', 'with', 'from', 'into', 'when', 'where', 'they', 'their', 'them', 'will', 'must', 'have', 'been', 'does', 'only', 'than', 'then', 'such', 'each'])
const tokens = (s: string): Set<string> =>
  new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3 && !STOP.has(w)))

/** How much of two wordings is shared: Dice over their content words. 0..1. */
export function wordingShare(a: string, b: string): number {
  const x = tokens(a), y = tokens(b)
  if (!x.size || !y.size) return 0
  let both = 0
  for (const w of x) if (y.has(w)) both++
  return (2 * both) / (x.size + y.size)
}

/** The bar for "says nearly the same thing". A measurement of wording and
 *  nothing more — it earns a mark, never a drop. */
export const WORDING_BAR = 0.6

export type Match =
  | { by: 'id'; line: string }
  | { by: 'predicate'; line: string; predicate: Predicate }
  | { by: 'wording'; line: string; share: number }
  | null

/** Does `rule` repeat any of `lines`? Proven by id or by countable predicate;
 *  argued by wording. The strongest match wins. */
export function matchRule(rule: string, lines: string[]): Match {
  const id = ruleId(rule)
  const hit = lines.find(l => ruleId(l) === id)
  if (hit) return { by: 'id', line: hit }
  const mine = predicatesOf(rule)
  if (mine.length) {
    for (const l of lines) {
      const p = predicatesOf(l).find(x => mine.includes(x))
      if (p) return { by: 'predicate', line: l, predicate: p }
    }
  }
  let best: { line: string; share: number } | null = null
  for (const l of lines) {
    const share = wordingShare(rule, l)
    if (share >= WORDING_BAR && (!best || share > best.share)) best = { line: l, share }
  }
  return best ? { by: 'wording', ...best } : null
}

/** How many DIFFERENT places in the manuscript a rule's cited edits come from
 *  — the paragraph, not the edit, is the unit — read off arc's own table. An
 *  edit number the table does not hold counts for nothing. */
export function examplesCited(edits: number[], table: { n: number; scene: string; paragraph: number }[]): number {
  const byN = new Map(table.map(p => [p.n, p]))
  return new Set(edits.map(n => byN.get(n)).filter((p): p is NonNullable<typeof p> => !!p).map(p => `${p.scene}:${p.paragraph}`)).size
}

/** What the rule-gates are measured against — supplied by the pass from the
 *  record it briefed the model with. */
export interface RuleGateCtx {
  /** arc's own numbered table */
  table: { n: number; scene: string; paragraph: number }[]
  minExamples: number
  /** the promoted contract, both layers */
  contract: string
  /** the rules already waiting in the author's queue. Held in code and never
   *  put in a brief: docs/style.proposed.md is read by no prompt (rule 3) */
  pending: string[]
  /** the rules the author declined */
  declined: { id: string; rule: string; at: string; also?: string[] }[]
}

/** A rule as the model answered it: text, a section, a layer it recommends
 *  and the NUMBERS of the edits it relies on — never a quote. */
export interface RawRule { rule: string; section: string | null; layer: 'story' | 'author' | null; edits: number[] }

/** Tolerant: entries with no rule text are junk and dropped, non-integer edit
 *  numbers are dropped from the entry. */
export function rulesFrom(parsed: unknown[]): RawRule[] {
  return parsed.flatMap((x): RawRule[] => {
    const r = x as Partial<RawRule>
    if (typeof r.rule !== 'string' || !r.rule.trim()) return []
    const edits = Array.isArray(r.edits) ? r.edits.filter((n): n is number => Number.isInteger(n)) : []
    const layer = r.layer === 'author' ? 'author' as const : r.layer === 'story' ? 'story' as const : null
    return [{ rule: r.rule.trim(), section: typeof r.section === 'string' && r.section.trim() ? r.section.trim() : null, layer, edits }]
  })
}
