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

/** Rules the author has already declined.
 *
 *  ruleId is a hash of the rule's text, and appendToQueue only ever checked
 *  the CURRENT queue — so a dismissed rule was re-argued by the next pass,
 *  arrived with the identical id, and was filed again. The author said no and
 *  it came back, every run, which is the fastest way to teach someone to stop
 *  reading a queue.
 *
 *  Tracked and committed, because a dismissal is a decision and decisions are
 *  record. It keeps the rule's text, not only its hash: an author looking at
 *  this file should be able to see what they turned down. */
export const DISMISSED_REL = 'docs/style.dismissed.md'
const dismissedPath = (): string => path.join(STORY, DISMISSED_REL)

const DISMISSED_HEADER = `# Rules you have declined

Machine-written. Arc argued for these and you said no, so it will not argue
for them again — a proposal whose text hashes to one of these ids is dropped
before it reaches your queue. Delete an entry to let arc make its case again.
`

const DISMISSED_RECORD = /<!--\s*arc:dismissed\s+(\{[\s\S]*?\})\s*-->/g

interface DismissedRule { id: string; rule: string; at: string }

export function readDismissed(): DismissedRule[] {
  try {
    const text = fs.readFileSync(dismissedPath(), 'utf8')
    const out: DismissedRule[] = []
    for (const m of text.matchAll(DISMISSED_RECORD)) {
      try {
        const r = JSON.parse(m[1]) as Partial<DismissedRule>
        if (typeof r.id === 'string' && typeof r.rule === 'string') {
          out.push({ id: r.id, rule: r.rule, at: typeof r.at === 'string' ? r.at : '' })
        }
      } catch { continue }
    }
    return out
  } catch {
    return []
  }
}

/** Remember a refusal. Never throws: failing to remember costs a repeated
 *  proposal, and failing the dismissal itself would cost the author's click. */
export function rememberDismissal(rule: { id: string; rule: string }, at: string): void {
  try {
    const known = readDismissed()
    if (known.some(d => d.id === rule.id)) return
    const next = [...known, { id: rule.id, rule: rule.rule, at }]
    const body = next.map(d =>
      `<!-- arc:dismissed ${JSON.stringify(d)} -->\n\n- ${d.rule.trim()}\n`).join('\n')
    fs.mkdirSync(path.dirname(dismissedPath()), { recursive: true })
    fs.writeFileSync(dismissedPath(), `${DISMISSED_HEADER}\n${body}`)
  } catch (e) {
    console.error('[warn] could not record the dismissal (the rule still left the queue):', e)
  }
}

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
        // Queues written before the field existed have no source; absent
        // means draft, so old entries parse and file exactly as they did.
        ...(r.source === 'revision' ? { source: 'revision' as const } : {}),
        ...(r.source === 'refusal' ? { source: 'refusal' as const } : {}),
        ...(r.source === 'history' ? { source: 'history' as const } : {}),
        // Same discipline for the layer recommendation: spread only when it
        // is there, so a queue written without one round-trips unchanged.
        ...(r.layer === 'author' ? { layer: 'author' as const } : {}),
        ...(r.layer === 'story' ? { layer: 'story' as const } : {}),
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
  // Revision evidence is the author against themself; saying "arc wrote"
  // over their own sentence would be claiming credit for their voice.
  const [before, after] = r.source === 'revision' ? ['you had', 'you revised to']
    : r.source === 'refusal' ? ['arc wrote', 'you refused it, keeping']
      : r.source === 'history' ? ['the book had', 'it moved to']
        : ['arc wrote', 'you kept']
  for (const e of r.evidence) {
    lines.push(`- **${e.scene}** — ${before}: ${JSON.stringify(e.wrote)}`)
    lines.push(`  ${after}: ${JSON.stringify(e.kept)}`)
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
  // Preserve whatever touchstones the file holds: two kinds share it, and a
  // rule save must not silently discard the other kind's proposals.
  writeQueueFile(rules, readTouchstones())
}

/** Append, collapsing anything already queued under the same id. Returns the
 *  rules that were genuinely new, so a caller can report honestly. */
export function appendToQueue(fresh: ProposedRule[]): { added: ProposedRule[]; queue: ProposedRule[] } {
  const queue = readQueue()
  // Already queued, or already declined. The second half is what stops the
  // author being asked the same question every run.
  const known = new Set([...queue.map(r => r.id), ...readDismissed().map(d => d.id)])
  const added = fresh.filter(r => !known.has(r.id))
  if (added.length) writeQueue([...queue, ...added])
  return { added, queue: [...queue, ...added] }
}

/** How a ratified rule reads once it is in the contract. The proposal's
 *  evidence does NOT come with it: the contract is a set of instructions for
 *  whoever writes next, and the argument that produced a rule stops mattering
 *  the moment the author agrees with it. The history is in git. */
const renderRatified = (r: ProposedRule): string =>
  `\n${r.section ? `## ${r.section}\n\n` : ''}${r.rule.trim()}\n`

/** A heading, reduced to the thing that identifies it.
 *
 *  Contracts number their sections — this book's are "## 3. Rhythm" and
 *  "## 6. Touchstones" — and an exact-title match never found them, so every
 *  ratification opened a SECOND "Rhythm" at the end of the file. The existing
 *  test passed only because its fixture used a bare "## Rhythm", which no
 *  real contract here does. The number is ordering, not identity. */
const headingKey = (title: string): string =>
  title.trim().replace(/^\d+[.)]\s*/, '').toLowerCase()

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
  const at = sectionTail(lines, rule.section)
  if (at === null) return body + renderRatified(rule)
  return [...lines.slice(0, at), '', rule.rule.trim(), ...lines.slice(at)].join('\n')
}

/** Where new content lands inside a named section: just past its last
 *  non-blank line. Null when the heading is not in the file. */
function sectionTail(lines: string[], section: string): number | null {
  const wanted = headingKey(section)
  const head = lines.findIndex(l => {
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(l)
    return !!m && headingKey(m[2]) === wanted
  })
  if (head < 0) return null

  const level = (/^(#{1,6})/.exec(lines[head]) as RegExpExecArray)[1].length
  let end = lines.length
  for (let i = head + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i])
    if (m && m[1].length <= level) { end = i; break }
  }
  // Trim the section's own trailing blank lines, then reopen one.
  let tail = end
  while (tail > head + 1 && lines[tail - 1].trim() === '') tail--
  return tail
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
  if (action === 'dismiss') rememberDismissal(rule, new Date().toISOString())
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

// ---- touchstones: passages proposed, not rules --------------------------
//
// A touchstone is a calibration passage from the manuscript, labelled with
// the quality it demonstrates. It shares this queue file but NOT the rule
// shape: RuleEvidence requires `wrote` and `kept`, and the tolerant parser
// drops anything missing either — a touchstone overloaded onto ProposedRule
// would render once and vanish on the next read. Its own marker, its own
// budget, its own renderer.

export type { ProposedTouchstone } from 'arc-canon-graph'
import type { ProposedTouchstone } from 'arc-canon-graph'

/** Touchstones cannot crowd rules out of a run, nor rules touchstones. */
export const MAX_TOUCHSTONES_PER_RUN = 3

const TOUCHSTONE_RECORD = /<!--\s*arc:touchstone\s+(\{[\s\S]*?\})\s*-->/g

/** Stable id over the passage itself: the same passage proposed again
 *  collapses, and a dismissed passage stays dismissed — but a REVISED passage
 *  hashes fresh, so improving the prose reopens the question. */
export const touchstoneId = (t: { scene: string; paragraph: number; passage: string }): string =>
  't-' + createHash('sha256').update(`${t.scene}:${t.paragraph}:${t.passage.trim()}`).digest('hex').slice(0, 8)

export function parseTouchstones(text: string): ProposedTouchstone[] {
  const out: ProposedTouchstone[] = []
  for (const m of text.matchAll(TOUCHSTONE_RECORD)) {
    try {
      const t = JSON.parse(m[1]) as Partial<ProposedTouchstone>
      if (typeof t.quality !== 'string' || typeof t.scene !== 'string' || typeof t.passage !== 'string') continue
      if (typeof t.paragraph !== 'number') continue
      out.push({
        id: typeof t.id === 'string' && t.id ? t.id : touchstoneId(t as ProposedTouchstone),
        quality: t.quality,
        scene: t.scene,
        file: typeof t.file === 'string' ? t.file : '',
        paragraph: t.paragraph,
        passage: t.passage,
        at: typeof t.at === 'string' ? t.at : '',
      })
    } catch {
      continue
    }
  }
  return out
}

const renderTouchstone = (t: ProposedTouchstone): string => [
  `<!-- arc:touchstone ${JSON.stringify(t)} -->`,
  '',
  `### Touchstone — ${t.quality}`,
  '',
  ...t.passage.trim().split('\n').map(l => `> ${l}`),
  '',
  `- **from** ${t.file || t.scene} ¶${t.paragraph + 1}`,
  '',
].join('\n')

export function readTouchstones(): ProposedTouchstone[] {
  try {
    return parseTouchstones(fs.readFileSync(queuePath(), 'utf8'))
  } catch {
    return []
  }
}

/** Rewrite the queue file carrying BOTH kinds. Every writer goes through
 *  here, so neither kind can erase the other on a save. */
function writeQueueFile(rules: ProposedRule[], touchstones: ProposedTouchstone[]): void {
  const p = queuePath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const body = [renderQueue(rules), ...touchstones.map(renderTouchstone)].join('\n')
  fs.writeFileSync(p, body)
}

export function writeTouchstones(touchstones: ProposedTouchstone[]): void {
  writeQueueFile(readQueue(), touchstones)
}

/** Append touchstones, collapsing known ids and honouring dismissals — the
 *  same two courtesies rules get. Returns what was genuinely new. */
export function appendTouchstones(fresh: ProposedTouchstone[]): { added: ProposedTouchstone[] } {
  const queue = readTouchstones()
  const known = new Set([...queue.map(t => t.id), ...readDismissed().map(d => d.id)])
  const added = fresh.filter(t => !known.has(t.id)).slice(0, MAX_TOUCHSTONES_PER_RUN)
  if (added.length) writeQueueFile(readQueue(), [...queue, ...added])
  return { added }
}

/** The marker a RATIFIED touchstone carries in the contract itself, so its
 *  standing against the manuscript can be computed rather than remembered.
 *  Distinct from the queue marker on purpose: one is a question, the other
 *  is an anchor. */
export const TOUCHSTONE_ANCHOR = /<!--\s*arc:touchstone-anchor\s+(\{[\s\S]*?\})\s*-->/g

const fileish = (t: ProposedTouchstone): string =>
  t.file ? t.file.replace(/^prose\//, '').replace(/\.md$/, '') : t.scene

/** How a ratified touchstone reads in the contract: the label format §6
 *  already uses — touchstonesOf() finds it by the bold lead — plus the
 *  anchor comment that makes staleness computable. */
const renderRatifiedTouchstone = (t: ProposedTouchstone): string => [
  '',
  `**${t.quality} — from ${fileish(t)}:**`,
  `<!-- arc:touchstone-anchor ${JSON.stringify({ quality: t.quality, scene: t.scene, paragraph: t.paragraph, quote: t.passage.trim() })} -->`,
  '',
  ...t.passage.trim().split('\n').map(l => `> ${l}`),
  '',
].join('\n')

/** Place a ratified touchstone at the end of the Touchstones section, or at
 *  the file's end when no such heading exists. */
export function placeTouchstone(existing: string, t: ProposedTouchstone): string {
  const body = existing.replace(/\s*$/, existing.trim() ? '\n' : '')
  const lines = body.split('\n')
  const at = sectionTail(lines, 'Touchstones')
  if (at === null) return body + renderRatifiedTouchstone(t)
  return [...lines.slice(0, at), renderRatifiedTouchstone(t), ...lines.slice(at)].join('\n')
}

/** Ratify a proposed touchstone into the story contract, or dismiss it.
 *  Deterministic, like ratifyRule — no model runs here. Touchstones only
 *  ever land in the story layer: they are passages of THIS manuscript, and
 *  a book's calibration passages are not the author's cross-book voice. */
export function ratifyTouchstone(
  id: string,
  action: 'ratify' | 'dismiss',
  contractPath: string,
): { path: string | null; remaining: ProposedTouchstone[]; touchstone: ProposedTouchstone } {
  const queue = readTouchstones()
  const t = queue.find(x => x.id === id)
  if (!t) throw new HttpError(404, `no proposed touchstone ${id}`)

  let target: string | null = null
  if (action === 'dismiss') rememberDismissal({ id: t.id, rule: `touchstone: ${t.quality} (${t.scene} ¶${t.paragraph + 1})` }, new Date().toISOString())
  if (action === 'ratify') {
    target = contractPath
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''
    fs.writeFileSync(target, placeTouchstone(before, t))
  }

  const remaining = queue.filter(x => x.id !== id)
  writeQueueFile(readQueue(), remaining)
  return { path: target, remaining, touchstone: t }
}
