// The two countable style rules a contract can state as a number, and the
// readers that find them (conventions §10). Read from the contract, never from
// a constant, so the author owns the number; absent, there is no rule to
// enforce. One definition: the prose gates (reroute.ts re-exports these) and
// U12's gates (rule-gates.ts) both read through here.

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

