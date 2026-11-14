// THE RECORD AS A WITHHOLDING PASS MAY SEE IT, AND THE FINGERPRINTS OF WHAT
// IT SAW (A80-1).
//
// The style contract stripped of the subject scene's touchstones and of any
// run of its prose; the canon pack and the sibling scenes, stripped the same
// way; and the fingerprints of exactly those strings, so the brief and the
// staleness check can never be built from two different renderings. Born in
// the reroute pass; every writing row and the slice assembler read it, so it
// lives here and no pass imports another for it.
import type { CanonDoc, ProseScene } from 'arc-canon-graph'
import { dateOf } from 'arc-canon-graph'
import { buildContextPack } from 'arc-canon-graph/context-pack-lib.ts'
import { paragraphsOf } from 'arc-canon-graph/annotations.ts'
import { canonJson } from './canon'
import { stripQuotedSpans } from './gates'
import { literalWithholds } from './gate-ctx'
import { siblingLadder } from './ladder'
import { locksOn } from './locks'
import { fingerprintsNow as readsNow, type Fingerprints } from './reads'
import { sha16 } from './records'
import { ROUTE_WITHHELD } from './registry'
import { proseScenes } from './story'
import { styleContract } from './style'

export type { Fingerprints }

/** The cheap map, for listing routes: the scene, the style contract, every
 *  annotation and every lock the scene carries. No canon read. The
 *  enumeration itself is `reads.ts`'s. */
export function fingerprintsNow(scene: string): Fingerprints {
  return readsNow(scene, styleForPass)
}

/** The whole map, for the write path (invariant 1: a changed fingerprint
 *  makes a route stale AT THE WRITE PATH). Adds the two ids the listing map
 *  leaves out, each of which costs a canon read. */
export function fingerprintsAtWrite(scene: string): Fingerprints {
  const { at } = fingerprintsNow(scene)
  const s = proseScenes().find(x => x.scene === scene)
  if (s) {
    const { pack, siblings } = packAndSiblings(s)
    at.set(`pack:${scene}`, sha16(pack))
    at.set(`siblings:${scene}`, sha16(siblings))
  }
  return { at, full: true }
}

/** The canon pack and the sibling scenes for one scene, built exactly once
 *  here so the reroute's brief and the staleness check can never drift into
 *  fingerprinting two different things. */
export function packAndSiblings(s: ProseScene): { pack: string; siblings: string } {
  const canon = JSON.parse(canonJson()) as CanonDoc
  const chapter = (canon.chapters ?? []).find(c => c.id === s.chapter)
  const at = dateOf(chapter?.span?.end) ?? dateOf(chapter?.span?.start)
  const pack = at
    ? buildContextPack(canon, { at, events: s.events, pov: s.pov ?? chapter?.pov })
    : buildContextPack(canon, { chapter: s.chapter })
  // The siblings go in stripped of THIS scene's prose for the same reason the
  // contract does: two scenes of one chapter that share a sentence — a refrain,
  // a line that comes back — would otherwise hand the pass the very scene it is
  // meant to work without, through the neighbour rather than through itself.
  // On the ladder the writing rows read (A69-7): the scene either side in
  // full, the next at its contract, the rest as a line — one definition of
  // "the chapter's other scenes" for every row that hands them over.
  const siblings = withoutSubjectProse(
    siblingLadder({ chapter: s.chapter, sceneId: s.scene }, proseScenes()).text(),
    { scene: s.scene, body: s.body },
  )
  return { pack, siblings }
}

/** The one way the current prose reaches a reroute prompt is the style
 *  contract's own touchstones: §6 quotes passages of the manuscript, and a
 *  passage of the scene being rerouted is the current route in the model's
 *  hands — the first live run treated it as exactly that. Strip every
 *  touchstone drawn from the target scene (by its label's file, or its
 *  anchor's scene) and say so in place, so the section stays honest. */
/** THE STYLE CONTRACT AS A WITHHOLDING PASS MAY SEE IT (A67-14).
 *
 *  Two strips, in order, and one place that does both — because the brief and
 *  the fingerprint of what the brief read must be the same string, and two
 *  call sites composing them separately is how they stop being.
 *
 *  First the touchstone blocks drawn from this scene, which go whole: a
 *  touchstone is an example and an example of the current route teaches the
 *  pass the thing it is meant to find another way to. Then any remaining run
 *  of this scene's own prose, wherever it sits — a Rhythm rule quoting the
 *  paragraph it is about is the same leak in a different shape, and the leak
 *  gate counts it the same way. */
export function styleForPass(target: { scene: string; file: string; body: string }): string {
  return styleForPassRead(target).text
}

/** THE CONTRACT AS RENDERED FOR ONE PASS, and what the rendering did.
 *
 *  `abbreviated` is the number of passages the projection left out — the
 *  author's ratified contract is never touched (it is a file, and this reads
 *  it), and a brief that carries less than all of it says so on the receipt
 *  rather than pretending it carried the whole (A69-2, the author's
 *  decision of 2026-09-24: constrain the representation, never the record). */
export function styleForPassRead(target: { scene: string; file: string; body: string }): { text: string; abbreviated: number } {
  const contract = styleContract()
  const key = `${target.scene}\n${sha16(contract)}\n${sha16(target.body)}`
  const had = STYLE_FOR_PASS.get(key)
  if (had !== undefined) return had
  const touchstones = stripSceneTouchstonesRead(contract, target)
  const quoted = withoutSubjectProseRead(touchstones.text, target)
  const out = { text: quoted.text, abbreviated: touchstones.stripped + quoted.stripped }
  // One manuscript render asks this once per scene through `routeCounts`, and
  // the answer only changes when the contract or the scene body does — which
  // is exactly what the key is.
  if (STYLE_FOR_PASS.size > 256) STYLE_FOR_PASS.clear()
  STYLE_FOR_PASS.set(key, out)
  return out
}
const STYLE_FOR_PASS = new Map<string, { text: string; abbreviated: number }>()

/** Cut any run of the subject scene's own prose out of a layer of the brief,
 *  by the leak gate's rule and minus what the row allows through.
 *
 *  It is not only the style contract. ANY layer can carry the scene: a rule
 *  that quotes the paragraph it is about, and a sibling scene that shares a
 *  sentence with this one — two scenes of a chapter that repeat a line are a
 *  thing authors do on purpose, and the pass is handed the scene either side
 *  in full (the ladder, A69-7). Whatever the layer, the fix is the same and
 *  it is applied in one place. */
export function withoutSubjectProse(layer: string, target: { scene: string; body: string }, spanWords?: number): string {
  return withoutSubjectProseRead(layer, target, spanWords).text
}

/** The same cut, saying how many runs it took out — so a brief can record
 *  that a layer it carried was abbreviated (A69-2). One definition, because
 *  a second copy of the marker or the allowance is how the brief and the
 *  fingerprint of what the brief read become two different strings. */
export function withoutSubjectProseRead(
  layer: string, target: { scene: string; body: string }, spanWords: number = ROUTE_WITHHELD.spanWords,
): { text: string; stripped: number } {
  return stripQuotedSpans(
    layer,
    target.body,
    spanWords,
    `**(a quotation from ${target.scene} is withheld from this pass — it is the current route)**`,
    allowedThrough(target),
  )
}

/** What the row lets through even though it is the scene: the locked
 *  paragraphs, which the brief hands over verbatim by design, and the
 *  contract's own quoted withholds. Computed here rather than passed in, so
 *  the brief and the fingerprint of what the brief read can never be built
 *  from two different allowances. */
function allowedThrough(target: { scene: string; body: string }): string[] {
  const s = proseScenes().find(x => x.scene === target.scene)
  if (!s) return []
  const paras = paragraphsOf(target.body)
  const locked = locksOn(target.scene, target.body)
    .filter(l => l.scope === 'paragraph' && l.resolution.paragraph !== null)
    .map(l => paras[l.resolution.paragraph as number] ?? '')
  return [...locked, ...literalWithholds(s.contract?.must_withhold)].filter(Boolean)
}

export function stripSceneTouchstones(style: string, target: { scene: string; file: string }): string {
  return stripSceneTouchstonesRead(style, target).text
}

/** The same strip, saying how many touchstones it took out — so a brief can
 *  record that the contract it carried was ABBREVIATED, and by how much
 *  (A69-2). The ratified contract is never edited; this is what the renderer
 *  did on the way into one pass, and the receipt says so. */
export function stripSceneTouchstonesRead(style: string, target: { scene: string; file: string }): { text: string; stripped: number } {
  const lines = style.split('\n')
  const start = lines.findIndex(l => /^##\s+(?:\d+[.)]\s*)?touchstones\s*$/i.test(l))
  if (start < 0) return { text: style, stripped: 0 }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) if (/^##\s+/.test(lines[i])) { end = i; break }
  const fileish = target.file.replace(/^prose\//, '').replace(/\.md$/, '')
  // A label opens with ** and may wrap onto following lines before it closes.
  const labelEnd = (i: number): number => {
    if (!/^\*\*/.test(lines[i])) return -1
    for (let k = i; k < end; k++) if (/\*\*\s*$/.test(lines[k]) && (k > i || lines[k].length > 2)) return k
    return -1
  }
  const out: string[] = lines.slice(0, start + 1)
  let stripped = 0
  let i = start + 1
  while (i < end) {
    const le = labelEnd(i)
    if (le < 0) { out.push(lines[i]); i++; continue }
    const label = lines.slice(i, le + 1).join(' ')
    let j = le + 1
    let sawQuote = false
    let anchorScene: string | null = null
    while (j < end) {
      const line = lines[j]
      if (labelEnd(j) >= 0) break
      const a = /arc:touchstone-anchor\s+(\{.*\})/.exec(line)
      if (a) { try { anchorScene = (JSON.parse(a[1]) as { scene?: string }).scene ?? null } catch { /* absent */ } }
      if (/^>\s?/.test(line)) sawQuote = true
      else if (sawQuote && line.trim() === '') { j++; break }
      j++
    }
    const m = /\bfrom\s+([\w./-]+)/.exec(label)
    const mine = (m !== null && m[1].replace(/[,:]+$/, '') === fileish) || anchorScene === target.scene
    if (mine) { stripped++; out.push(`**(a touchstone drawn from ${target.scene} is withheld from this pass — it is the current route)**`, '') }
    else out.push(...lines.slice(i, j))
    i = j
  }
  out.push(...lines.slice(end))
  return { text: stripped ? out.join('\n') : style, stripped }
}
