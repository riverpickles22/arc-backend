// docs/style.proposed.md — the queue of rules arc has ARGUED for and the
// author has not ratified (conventions §11).
//
// This file is machine-written, and it is deliberately NOT the style contract.
// Nothing here reaches a drafting prompt: `styleContract()` in style.ts reads
// docs/style.md and the author layer, and never this. That separation is the
// whole safety property of the learning loop — arc can be wrong about the
// author's voice all it likes in here, and the prose is unaffected until a
// human clicks ratify.
//
// FORMAT. Each entry is an HTML comment holding the record as JSON, followed
// by the same content rendered as prose. The comment is the source of truth;
// the prose beneath it is a courtesy so the file reads sensibly in a plain
// editor. They cannot drift, because nothing but this module writes the file.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { ProposedRule, RuleEvidence } from 'arc-canon-graph'
import { STORY } from './config'
import { HttpError } from './http'

export type { ProposedRule, RuleEvidence }

export const QUEUE_REL = 'docs/style.proposed.md'
export const queuePath = (): string => path.join(STORY, QUEUE_REL)

const HEADER = `# Proposed style rules

Machine-written. Arc watched what it drafted and what you kept, and argues
these rules follow. **Nothing here binds anything** — no drafting pass reads
this file. Ratify a rule on the Style page to move it into your contract, or
dismiss it. Editing this file by hand is fine; arc rewrites it wholesale on
its next pass, so ratify from the app if you want a rule to survive.
`

const RECORD = /<!--\s*arc:proposed\s+(\{[\s\S]*?\})\s*-->/g

/** A stable id for a rule: same text, same id, so a pass that re-argues a
 *  rule already queued collapses into it rather than stacking duplicates. */
export const ruleId = (rule: string): string =>
  'p-' + createHash('sha256').update(rule.trim().toLowerCase()).digest('hex').slice(0, 8)

const isEvidence = (v: unknown): v is RuleEvidence => {
  const e = v as Partial<RuleEvidence>
  return !!e && typeof e.scene === 'string' && typeof e.wrote === 'string' && typeof e.kept === 'string'
}

/** Tolerant parse: a malformed or hand-mangled entry is skipped, never fatal.
 *  A queue that fails to load would take the Style page down with it. */
export function parseQueue(text: string): ProposedRule[] {
  const out: ProposedRule[] = []
  for (const m of text.matchAll(RECORD)) {
    try {
      const r = JSON.parse(m[1]) as Partial<ProposedRule>
      if (typeof r.rule !== 'string' || !r.rule.trim()) continue
      out.push({
        id: typeof r.id === 'string' && r.id ? r.id : ruleId(r.rule),
        rule: r.rule,
        section: typeof r.section === 'string' ? r.section : null,
        at: typeof r.at === 'string' ? r.at : '',
        evidence: Array.isArray(r.evidence) ? r.evidence.filter(isEvidence) : [],
      })
    } catch {
      continue
    }
  }
  return out
}

const renderOne = (r: ProposedRule): string => {
  const lines = [
    `<!-- arc:proposed ${JSON.stringify(r)} -->`,
    '',
    `### ${r.section ?? 'Proposed rule'}`,
    '',
    r.rule.trim(),
    '',
  ]
  for (const e of r.evidence) {
    lines.push(`- **${e.scene}** — arc wrote: ${JSON.stringify(e.wrote)}`)
    lines.push(`  you kept: ${JSON.stringify(e.kept)}`)
  }
  if (r.evidence.length) lines.push('')
  return lines.join('\n')
}

export function renderQueue(rules: ProposedRule[]): string {
  if (!rules.length) return `${HEADER}\n_Nothing proposed. Arc proposes a rule only when your edits show a pattern._\n`
  return [HEADER, ...rules.map(renderOne)].join('\n')
}

export function readQueue(): ProposedRule[] {
  try {
    return parseQueue(fs.readFileSync(queuePath(), 'utf8'))
  } catch {
    return []
  }
}

export function writeQueue(rules: ProposedRule[]): void {
  const p = queuePath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, renderQueue(rules))
}

/** Append, collapsing anything already queued under the same id. Returns the
 *  rules that were genuinely new, so a caller can report honestly. */
export function appendToQueue(fresh: ProposedRule[]): { added: ProposedRule[]; queue: ProposedRule[] } {
  const queue = readQueue()
  const known = new Set(queue.map(r => r.id))
  const added = fresh.filter(r => !known.has(r.id))
  if (added.length) writeQueue([...queue, ...added])
  return { added, queue: [...queue, ...added] }
}

/** How a ratified rule reads once it is in the contract. The proposal's
 *  evidence does NOT come with it: the contract is a set of instructions for
 *  whoever writes next, and the argument that produced a rule stops mattering
 *  the moment the author agrees with it. The history is in git. */
export const renderRatified = (r: ProposedRule): string =>
  `\n${r.section ? `## ${r.section}\n\n` : ''}${r.rule.trim()}\n`

/** Place a ratified rule in the contract text.
 *
 *  If the file already has a heading for the rule's section, the rule joins
 *  that section at its end rather than opening a second heading with the same
 *  name — three rules ratified into "Sentences" should read as one section of
 *  three rules, which is what the author would have written by hand. Only
 *  same-or-higher-level headings close a section, so a rule lands after any
 *  sub-headings the section contains. Pure, so the placement arithmetic is
 *  testable without a disk. */
export function placeRule(existing: string, rule: ProposedRule): string {
  const body = existing.replace(/\s*$/, existing.trim() ? '\n' : '')
  if (!rule.section) return body + renderRatified(rule)

  const lines = body.split('\n')
  const wanted = rule.section.trim().toLowerCase()
  const head = lines.findIndex(l => {
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(l)
    return !!m && m[2].toLowerCase() === wanted
  })
  if (head < 0) return body + renderRatified(rule)

  const level = (/^(#{1,6})/.exec(lines[head]) as RegExpExecArray)[1].length
  let end = lines.length
  for (let i = head + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i])
    if (m && m[1].length <= level) { end = i; break }
  }
  // Trim the section's own trailing blank lines, then reopen one.
  let tail = end
  while (tail > head + 1 && lines[tail - 1].trim() === '') tail--

  return [...lines.slice(0, tail), '', rule.rule.trim(), ...lines.slice(tail)].join('\n')
}

/** Ratify a proposed rule into a layer, or dismiss it. Wholly deterministic —
 *  no model runs in this path, so the author's click means exactly what it
 *  says. The rule leaves the queue either way; ratify also appends it to the
 *  chosen contract file. */
export function ratifyRule(
  id: string,
  action: 'ratify' | 'dismiss',
  layer: 'author' | 'story',
  layerPathFor: (l: 'author' | 'story') => string,
): { path: string | null; remaining: ProposedRule[]; rule: ProposedRule } {
  const queue = readQueue()
  const rule = queue.find(r => r.id === id)
  if (!rule) throw new HttpError(404, `no proposed rule ${id}`)

  let target: string | null = null
  if (action === 'ratify') {
    target = layerPathFor(layer)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''
    fs.writeFileSync(target, placeRule(before, rule))
  }

  const remaining = queue.filter(r => r.id !== id)
  writeQueue(remaining)
  return { path: target, remaining, rule }
}
