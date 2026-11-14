// The two countable style rules a contract can state as a number, and the
// readers that find them (conventions §10). Read from the contract, never from
// a constant, so the author owns the number; absent, there is no rule to
// enforce. One definition: the prose gates (reroute.ts re-exports these) and
// U12's gates (rule-gates.ts) both read through here.

import { splitSentences } from 'arc-canon-graph'
import { paragraphsOf } from 'arc-canon-graph/annotations.ts'

/** The one countable style rule the contract states as a number: "A chain
 *  stops at three." Read from the ratified contract, never from a constant,
 *  so the author owns the number; absent from the contract, there is no gate.
 *  Words up to twelve are accepted alongside digits. */
export function andCapFromContract(style: string): number | null {
  const m = /\bchain stops at (\w+)\b/i.exec(style)
  if (!m) return null
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 }
  const n = words[m[1].toLowerCase()] ?? Number(m[1])
  return Number.isInteger(n) && n > 0 ? n : null
}

/** The second countable rule: "A sentence stops at N words." A run-on is a
 *  run-on however it is joined — the first live route carried a 64-word
 *  sentence on two "and"s and six commas, longer than anything in the
 *  author's own manuscript (max 63, 95th percentile 44). Read from the
 *  contract like the and-cap; absent, no gate. */
export function wordCapFromContract(style: string): number | null {
  const m = /\bsentence stops at (\d+) words?\b/i.exec(style)
  if (!m) return null
  const n = Number(m[1])
  return Number.isInteger(n) && n > 0 ? n : null
}

// ---- the counter: one for the gates, one for the manuscript checks (A77-1) --
//
// The gates ask of an answer "which sentences go over the contract's number";
// /api/prose/checks asks the same of the manuscript. One counter answers both,
// so the number the author reads beside a sentence is the number a gate would
// refuse it at. What is skipped is the caller's to say — the gates know their
// locked paragraphs by text, the checks by paragraph index — and the counter
// never decides it.

/** The two countable rules, by the name a finding and a gate both carry. */
export type CountableRule = 'and-chain' | 'sentence-length'

/** What each rule counts in one sentence. */
export const countIn: Record<CountableRule, (sentence: string) => number> = {
  'and-chain': s => (s.match(/\band\b/gi) ?? []).length,
  'sentence-length': s => s.split(/\s+/).filter(Boolean).length,
}

export interface OverTheBar {
  /** 0-based paragraph index, the manuscript's own addressing */
  paragraph: number
  sentence: string
  count: number
}

/** PROVEN: every sentence whose count under `rule` is over `bar`. The count
 *  is the decidable half of the rule; what the number means is the author's
 *  ratified contract. `skip` names paragraphs never counted against — the
 *  locked ones, the author's settled text. */
export function sentencesOver(
  body: string,
  rule: CountableRule,
  bar: number,
  skip: (paragraph: string, index: number) => boolean = () => false,
): OverTheBar[] {
  const out: OverTheBar[] = []
  paragraphsOf(body).forEach((para, paragraph) => {
    if (skip(para, paragraph)) return
    for (const sentence of splitSentences(para)) {
      const count = countIn[rule](sentence.text)
      if (count > bar) out.push({ paragraph, sentence: sentence.text.trim(), count })
    }
  })
  return out
}

export interface CountableFinding {
  check: CountableRule
  paragraph: number
  /** the start of the sentence, verbatim — only the author's words; the
   *  count and the bar travel as fields and the viewer says them */
  excerpt: string
  register: 'proven'
  measured: number
  bar: number
}

const START_CHARS = 48

/** The start of a sentence, cut at a word so the excerpt reads. */
export function sentenceStart(sentence: string): string {
  if (sentence.length <= START_CHARS) return sentence
  const cut = sentence.slice(0, START_CHARS)
  const at = cut.lastIndexOf(' ')
  return `${(at > 0 ? cut.slice(0, at) : cut).replace(/[\s,;:—-]+$/, '')}…`
}

/** The manuscript side: every sentence over a number the contract states,
 *  read through the same readers and the same counter the gates use. A rule
 *  the contract does not state lists nothing. Nothing here offers a repair. */
export function countableChecks(
  body: string,
  style: string,
  skip: (paragraph: string, index: number) => boolean = () => false,
): CountableFinding[] {
  const bars: [CountableRule, number | null][] = [
    ['and-chain', andCapFromContract(style)],
    ['sentence-length', wordCapFromContract(style)],
  ]
  const out: CountableFinding[] = []
  for (const [rule, bar] of bars) {
    if (bar === null) continue
    for (const o of sentencesOver(body, rule, bar, skip)) {
      out.push({
        check: rule, paragraph: o.paragraph, register: 'proven', measured: o.count, bar,
        excerpt: sentenceStart(o.sentence),
      })
    }
  }
  return out.sort((a, b) => a.paragraph - b.paragraph)
}
