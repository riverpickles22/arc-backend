// Touchstones: the contract's calibration passages, kept honest by machinery.
//
// §6 of a style contract quotes passages from the manuscript so new prose has
// something to sound like. A touchstone binds HARDER than a rule — models
// imitate cadence from examples more reliably than they follow imperatives —
// which means a stale one teaches a superseded voice with the contract's own
// authority. This book's §6 proved the failure mode by hand: both passages
// went stale and a human had to notice and write "Pending recalibration" over
// them.
//
// Two jobs here. STANDING: every touchstone's quote is resolved against the
// prose as it is now, with the same anchor machinery locks and annotations
// use, so staleness is a computed state instead of a note someone remembers
// to write. REFRESH: an orphaned touchstone — its passage rewritten out of
// the scene — gets a replacement PROPOSED from the passage's nearest living
// descendant, materialized from the scene file, never from a model. The
// author ratifies or dismisses; nothing touches the contract on its own.
import fs from 'node:fs'
import path from 'node:path'
import type { ProposedTouchstone, TouchstoneState } from 'arc-canon-graph'
import { resolveAnchor } from 'arc-canon-graph/annotations.ts'
import { STORY } from './config'
import { changedWords } from './learn-style'
import { proseScenes } from './story'
import { TOUCHSTONE_ANCHOR, appendTouchstones, touchstoneId } from './style-queue'

const CONTRACT = (): string => path.join(STORY, 'docs', 'style.md')

const paragraphsOf = (body: string): string[] =>
  body.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)

/** One touchstone as the contract file holds it, however it got there. */
export interface ContractTouchstone {
  quality: string
  /** The label's "from" part, e.g. ch-00/scene-01. Empty when the label has
   *  none — the annotated wrong-version example, which is not a touchstone of
   *  the manuscript and is never resolved or refreshed. */
  fileish: string
  passage: string
  /** Present when the touchstone was ratified through the queue; absent on
   *  the hand-written ones. Either way the passage itself is the quote. */
  anchor: { scene: string; paragraph: number; quote: string } | null
}

/** Parse the Touchstones section: bold labels, each followed by an optional
 *  anchor comment and a blockquote. Pure, so the parsing is testable against
 *  the real contract's exact shape. */
export function parseContractTouchstones(contract: string): ContractTouchstone[] {
  const lines = contract.split('\n')
  const start = lines.findIndex(l => /^##\s+(?:\d+[.)]\s*)?touchstones\s*$/i.test(l))
  if (start < 0) return []
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break }
  }

  const out: ContractTouchstone[] = []
  for (let i = start + 1; i < end; i++) {
    const label = /^\*\*(.+?)\*\*/.exec(lines[i])
    if (!label) continue
    const m = /^(.*?)\s+—\s+from\s+([\w./-]+):?$/.exec(label[1])
    const quality = (m ? m[1] : label[1]).replace(/:$/, '').trim()
    const fileish = m ? m[2] : ''

    let anchor: ContractTouchstone['anchor'] = null
    const quote: string[] = []
    for (let j = i + 1; j < end; j++) {
      const line = lines[j]
      if (/^\*\*(.+?)\*\*/.test(line)) break
      const a = new RegExp(TOUCHSTONE_ANCHOR.source).exec(line)
      if (a) {
        try {
          const parsed = JSON.parse(a[1]) as { scene?: string; paragraph?: number; quote?: string }
          if (typeof parsed.scene === 'string' && typeof parsed.paragraph === 'number' && typeof parsed.quote === 'string') {
            anchor = { scene: parsed.scene, paragraph: parsed.paragraph, quote: parsed.quote }
          }
        } catch { /* a mangled anchor is an absent anchor */ }
        continue
      }
      if (/^>\s?/.test(line)) quote.push(line.replace(/^>\s?/, ''))
      else if (quote.length && line.trim() === '') break
    }
    if (quote.length) out.push({ quality, fileish, passage: quote.join(' ').replace(/\s+/g, ' ').trim(), anchor })
  }
  return out
}

const sceneFor = (fileish: string): { scene: string; file: string } | null => {
  const file = `prose/${fileish}.md`
  const hit = proseScenes().find(s => s.file === file)
  return hit ? { scene: hit.scene, file } : null
}

/** Every manuscript touchstone's standing against the prose as it is NOW. */
export function touchstoneStates(): TouchstoneState[] {
  let contract: string
  try { contract = fs.readFileSync(CONTRACT(), 'utf8') } catch { return [] }
  const byScene = new Map(proseScenes().map(s => [s.scene, s.body]))

  const out: TouchstoneState[] = []
  for (const t of parseContractTouchstones(contract)) {
    const located = t.anchor ? { scene: t.anchor.scene } : sceneFor(t.fileish)
    if (!located) continue   // the wrong-version example, or a label naming nothing
    const anchor = t.anchor ?? { scene: located.scene, paragraph: 0, quote: t.passage }
    const r = resolveAnchor(anchor, byScene.get(anchor.scene) ?? null)
    out.push({ quality: t.quality, scene: anchor.scene, state: r.state, ...(r.note ? { note: r.note } : {}) })
  }
  return out
}

/** The nearest living descendant of a passage — the paragraph where most of
 *  the passage's own words survive.
 *
 *  Deliberately NOT raw edit distance over the pair: a paragraph that GREW
 *  around the surviving passage would be punished for every word it added,
 *  and growth is exactly what revision does to an opening. The real §6 proved
 *  it — the smell-first opening survives in today's ¶1, which has doubled in
 *  length around it, and symmetric distance called that a stranger. What
 *  makes a descendant is how much of the PASSAGE lives on, so the fraction
 *  is taken over the passage's words alone. Below the bar, no guess. */
export function nearestParagraph(passage: string, paragraphs: string[]): { index: number; text: string } | null {
  const la = passage.split(/\s+/).filter(Boolean).length
  if (!la) return null
  let best = -1
  let bestSurvival = 0
  paragraphs.forEach((p, i) => {
    const lb = p.split(/\s+/).filter(Boolean).length
    // For word-level edit distance d, (la + lb − d) / 2 bounds the words the
    // two sides share in order — the passage's surviving core.
    const surviving = (la + lb - changedWords(passage, p)) / 2
    const survival = surviving / la
    if (survival > bestSurvival) { bestSurvival = survival; best = i }
  })
  // Under 60% survival, "descendant" would be a guess wearing a number.
  if (best < 0 || bestSurvival < 0.6) return null
  return { index: best, text: paragraphs[best] }
}

/** Propose replacements for every touchstone the manuscript has left behind.
 *
 *  Deterministic end to end — resolution decides WHICH are stale, word
 *  distance decides WHAT replaces them, and the passage is copied from the
 *  scene file. No model, no tokens, and nothing lands in the contract until
 *  the author ratifies. Returns what was filed and what was skipped, so the
 *  caller can say both honestly. */
export function proposeTouchstoneRefresh(): { added: ProposedTouchstone[]; current: number; skipped: string[] } {
  let contract: string
  try { contract = fs.readFileSync(CONTRACT(), 'utf8') } catch { return { added: [], current: 0, skipped: [] } }
  const scenes = new Map(proseScenes().map(s => [s.scene, s.body]))

  const fresh: ProposedTouchstone[] = []
  const skipped: string[] = []
  let current = 0
  for (const t of parseContractTouchstones(contract)) {
    const located = t.anchor ? { scene: t.anchor.scene, file: sceneFileOf(t.anchor.scene) ?? t.fileish } : sceneFor(t.fileish)
    if (!located) continue
    const body = scenes.get(located.scene) ?? null
    const anchor = t.anchor ?? { scene: located.scene, paragraph: 0, quote: t.passage }
    const r = resolveAnchor(anchor, body)
    if (r.state === 'resolved' || r.state === 'drifted') { current++; continue }   // still the book's voice
    if (body === null) { skipped.push(`${t.quality}: scene ${located.scene} no longer exists`); continue }

    const near = nearestParagraph(t.passage, paragraphsOf(body))
    if (!near) { skipped.push(`${t.quality}: nothing in ${located.scene} is close enough to call a descendant`); continue }
    const file = 'file' in located && located.file ? (located.file.startsWith('prose/') ? located.file : `prose/${located.file}.md`) : ''
    fresh.push({
      id: touchstoneId({ scene: located.scene, paragraph: near.index, passage: near.text }),
      quality: t.quality,
      scene: located.scene,
      file,
      paragraph: near.index,
      passage: near.text,
      at: new Date().toISOString(),
    })
  }
  const { added } = appendTouchstones(fresh)
  return { added, current, skipped }
}

const sceneFileOf = (scene: string): string | null =>
  proseScenes().find(s => s.scene === scene)?.file ?? null
