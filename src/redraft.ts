// The redraft pass: a rebuild, not a nudge.
//
// arc has had exactly one way to rewrite existing prose, and it is
// deliberately timid — REVISE_RULES instructs "change as little as the notes
// require", which is the right law for answering an annotation and the wrong
// one for the author who says this scene needs a clean pass. Asking revise
// for a rebuild gets a couple of altered sentences, because that is what it
// is told to produce.
//
// Redraft is the third verb, told apart from its siblings:
//   rephrase — a selection, alternatives offered, writes nothing
//   revise   — a scene, minimal, annotation-driven          (unchanged)
//   redraft  — a scene or passage, REBUILT to its contract
//
// It receives everything revise never had: the canon context pack scoped by
// the scene's own events and POV, the scene's contract frontmatter, the
// chapter's other scenes, the author's open notes, and both style layers —
// including every ratified touchstone, which is how the learning loop's
// output reaches the next generation of prose.
//
// TWO KINDS OF CHECK, NEVER BLURRED (conventions §11). Only deterministic
// structural conditions may refuse the write: locks, the validator, and
// must_withhold items that are exact quoted literals. Everything a model
// merely reads — tense, POV adherence, whether must_establish landed, motif
// execution, non-literal leakage — is ARGUED: reported to the author as
// claims, never enforced. A model's reading in the position of a validator
// would be overclaiming, and §11 forbids it in exactly those words.
//
// One field is withheld on purpose: the contract's reader_before and
// reader_after never reach this prompt. Telling a drafting pass the effect
// to produce invites writing toward the stated effect, which is the
// no-comment law's own failure mode; conventions §10 assigns those fields
// to review passes.
import fs from 'node:fs'
import path from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import type { DraftSceneResponse, ProseScene, ResolvedAnnotation, SceneContract } from 'arc-canon-graph'
import type { CanonDoc } from 'arc-canon-graph'
import { dateOf } from 'arc-canon-graph'
import { buildContextPack } from 'arc-canon-graph/context-pack-lib.ts'
import { lockViolations } from 'arc-canon-graph/annotations.ts'
import { MODEL, STORY } from './config'
import { getClient } from './agent'
import { annotations } from './annotations'
import { canonJson, validateStory } from './canon'
import { currentEngine, runCliPrompt, stripFences } from './engine'
import { HttpError } from './http'
import { recordGenerated } from './ledger'
import { locksOn } from './locks'
import { parseScene, proseScenes } from './story'
import { styleContract } from './style'

const REDRAFT_RULES = `You are arc's REDRAFT pass. The author asked for a clean pass over prose of
their own novel. The text below is ONE ATTEMPT, NOT A FLOOR: order, images,
paragraph boundaries and sentence architecture are all yours to rebuild.
Keep what already earns its place; a redraft that preserves a weak structure
out of politeness has failed, and so has one that discards a strong line to
prove it was here.

WHAT MUST SURVIVE, exactly:
1. The scene's meaning. Every event and fact the frontmatter binds still
   happens here; character state at this moment in the story is unchanged.
2. The scene contract below — purpose, must_establish, must_withhold,
   motifs, constraints. Withholding is deliberate: do not "fix" it.
3. The style contract. It is the author's voice and it is law; run its
   pre-draft checklist before answering.
4. POV, tense, and the anachronism boundary.
5. Locked paragraphs, VERBATIM, word for word, wherever noted below.
6. Canon is truth. Never invent a fact the record would have to carry — a
   new person, date, or place is a proposal for the author, not yours to
   make. Name it in the briefing instead.

ANSWER IN TWO PARTS, separated by a line that is exactly:
=== BRIEFING ===
Part one: the redrafted prose alone — no frontmatter, no commentary, no
fences. Part two, the briefing, in the ARGUED register (these are claims for
the author to judge, not verdicts): the style checklist item by item, held
or knowingly bent; whether each must_establish lands and where; motifs
carried; POV and tense held; anything withheld that risks leaking by
implication; and any fact you needed that canon does not hold.`

/** The contract block as the prompt shows it. reader_before / reader_after
 *  are deliberately absent — review-pass fields, not drafting fuel. */
export function contractBlock(c: SceneContract | null): string {
  if (!c) return '(this scene declares no contract)'
  const lines: string[] = []
  if (c.purpose) lines.push(`purpose: ${String(c.purpose).trim()}`)
  if (Array.isArray(c.must_establish) && c.must_establish.length) lines.push(`must_establish:\n${c.must_establish.map(x => `  - ${x}`).join('\n')}`)
  if (Array.isArray(c.must_withhold) && c.must_withhold.length) lines.push(`must_withhold:\n${c.must_withhold.map(x => `  - ${x}`).join('\n')}`)
  if (Array.isArray(c.motifs) && c.motifs.length) lines.push(`motifs: ${c.motifs.join(', ')}`)
  if (c.constraints) lines.push(`constraints: ${String(c.constraints).trim()}`)
  return lines.length ? lines.join('\n') : '(this scene declares no contract)'
}

/** must_withhold items that are decidable: exact quoted literals.
 *
 *  "The settler's identity" names an idea and only a reading can judge a
 *  leak — that is argued. '"Havana"' names a string, and a string either
 *  appears or it does not — that is proven. The quoting convention is the
 *  author's way of opting a withhold into the hard gate. */
export function literalWithholds(items: unknown): string[] {
  if (!Array.isArray(items)) return []
  return items
    .map(String)
    .map(x => x.trim())
    .filter(x => /^["'“].*["'”]$/.test(x))
    .map(x => x.replace(/^["'“]|["'”]$/g, ''))
    .filter(Boolean)
}

/** The proven half of the withhold check: literals that appear verbatim. */
export const withholdViolations = (literals: string[], body: string): string[] =>
  literals.filter(w => body.includes(w))

/** Replace paragraphs [from..to] with the redrafted passage, everything else
 *  byte-identical by construction — the passage redraft's whole safety story
 *  is that the model never gets to touch what it was not asked about. */
export function spliceRange(paragraphs: string[], from: number, to: number, replacement: string): string[] {
  const out = [...paragraphs]
  out.splice(from, to - from + 1, ...replacement.split(/\n{2,}/).map(x => x.trim()).filter(Boolean))
  return out
}

/** Split the model's two-part answer. A missing marker is an honest
 *  degenerate case: all prose, no briefing — never the other way round. */
export function splitBriefing(text: string): { body: string; briefing: string } {
  const m = text.split(/^\s*=== BRIEFING ===\s*$/m)
  return { body: m[0].trim(), briefing: (m[1] ?? '').trim() }
}

export interface RedraftTarget {
  scene: string
  /** Inclusive paragraph range, draft order. Absent: the whole scene. */
  paragraphs?: [number, number]
  guidance?: string
}

/** Pure prompt assembly, testable without an engine or a story on disk. */
export function buildRedraftPrompt(a: {
  scene: ProseScene
  pack: string
  style: string
  siblings: string
  notes: ResolvedAnnotation[]
  range?: { from: number; to: number; passage: string; above: string | null; below: string | null }
  lockNotice: string
  guidance?: string
}): string {
  const notes = a.notes.length
    ? `=== THE AUTHOR'S OPEN NOTES ON THIS SCENE (answer what they ask where the rebuild allows) ===\n${a.notes.map(n => `- ${n.body.trim()}`).join('\n')}`
    : ''
  const subject = a.range
    ? [
      `=== THE PASSAGE TO REDRAFT (¶${a.range.from + 1}–¶${a.range.to + 1} of ${a.scene.scene}) ===`,
      a.range.passage,
      '',
      'SEAMS: your passage must join what surrounds it, which you may not change.',
      a.range.above !== null ? `The paragraph ABOVE ends the ground your passage rises from:\n${a.range.above}` : 'Your passage OPENS the scene.',
      a.range.below !== null ? `The paragraph BELOW is where your passage must land:\n${a.range.below}` : 'Your passage CLOSES the scene.',
      'Answer with the redrafted passage alone — never the seams.',
    ].join('\n')
    : `=== THE SCENE AS IT STANDS (one attempt, not a floor) ===\n${a.scene.body.trim()}`

  return [
    REDRAFT_RULES + a.lockNotice,
    `=== THE STYLE CONTRACT (binding) ===\n${a.style}`,
    `=== THE SCENE CONTRACT (${a.scene.scene}) ===\n${contractBlock(a.scene.contract)}`,
    `=== CONTEXT PACK (canon truth; every item carries its inclusion reason) ===\n${a.pack}`,
    a.siblings ? `=== THE CHAPTER'S OTHER SCENES (yours follows or precedes them; do not retell them) ===\n${a.siblings}` : '',
    notes,
    subject,
    a.guidance?.trim() ? `AUTHOR'S GUIDANCE (binding): ${a.guidance.trim()}` : '',
    'Run the redraft pass. Answer in the two parts.',
  ].filter(Boolean).join('\n\n')
}

async function ask(prompt: string): Promise<string> {
  if (currentEngine() === 'claude-cli') return (await runCliPrompt(prompt, { cwd: STORY })).text
  const message = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    messages: [{ role: 'user', content: prompt }],
  })
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')
}

const paragraphsOf = (body: string): string[] =>
  body.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)

export async function runRedraft(t: RedraftTarget): Promise<DraftSceneResponse> {
  const scene = proseScenes().find(s => s.scene === t.scene)
  if (!scene) throw new HttpError(400, `no scene ${t.scene}`)
  const paras = paragraphsOf(scene.body)

  let range: { from: number; to: number } | null = null
  if (t.paragraphs) {
    const [from, to] = t.paragraphs
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to >= paras.length) {
      throw new HttpError(400, `paragraphs must name an existing range — this scene has ${paras.length}`)
    }
    range = { from, to }
  }

  // Locks, BEFORE anything is generated. A whole-scene redraft reproduces
  // them verbatim; a passage redraft over one is refused outright — settled
  // prose inside the very range the author wants rebuilt is a contradiction
  // only they can resolve, from the viewer's unlock.
  const sceneLocks = locksOn(t.scene, scene.body)
    .filter(l => l.resolution.paragraph !== null &&
      (l.resolution.state === 'resolved' || l.resolution.state === 'drifted'))
  const fenced = sceneLocks.map(l => l.resolution.paragraph!)
  if (range) {
    const hit = sceneLocks.find(l => l.resolution.paragraph! >= range!.from && l.resolution.paragraph! <= range!.to)
    if (hit) throw new HttpError(423, `¶${hit.resolution.paragraph! + 1} is locked (${hit.id}) — unlock it, or redraft around it`)
  }
  const lockNotice = !range && fenced.length
    ? `\n\nLOCKED PARAGRAPHS — the author has settled paragraph${fenced.length === 1 ? '' : 's'} ` +
      `${fenced.map(i => i + 1).join(', ')}. Reproduce ${fenced.length === 1 ? 'it' : 'them'} verbatim and rebuild around ${fenced.length === 1 ? 'it' : 'them'}.`
    : ''

  // The canon pack, scoped by the SCENE's own bindings — its events and POV —
  // at the chapter's moment. draft.ts anchors by chapter because a new scene
  // has no bindings yet; a redraft knows exactly what it rests on.
  const canon = JSON.parse(canonJson()) as CanonDoc
  const chapter = (canon.chapters ?? []).find(c => c.id === scene.chapter)
  const at = dateOf(chapter?.span?.end) ?? dateOf(chapter?.span?.start)
  const pack = at
    ? buildContextPack(canon, { at, events: scene.events, pov: scene.pov ?? chapter?.pov })
    : buildContextPack(canon, { chapter: scene.chapter })

  const siblings = proseScenes().filter(s => s.chapter === scene.chapter && s.scene !== t.scene)
  const siblingsText = siblings.map(s => `=== ${s.file} ===\n${s.body.trim()}`).join('\n\n')
  const openNotes = annotations().filter(n =>
    n.anchor.scene === t.scene && (!n.status || n.status === 'open') && n.kind !== 'keypoint')

  const prompt = buildRedraftPrompt({
    scene, pack, style: styleContract(), siblings: siblingsText, notes: openNotes,
    range: range ? {
      from: range.from, to: range.to,
      passage: paras.slice(range.from, range.to + 1).join('\n\n'),
      above: range.from > 0 ? paras[range.from - 1] : null,
      below: range.to + 1 < paras.length ? paras[range.to + 1] : null,
    } : undefined,
    lockNotice,
    guidance: t.guidance,
  })

  // The engine is asked for last, after every free refusal has had its say —
  // and guarded here rather than only at the route, because the CLI is a
  // first-class caller: the skill's protocol is that a session reaches the
  // SAME operation, refusals included.
  if (!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) && !currentEngine()) {
    throw new HttpError(400, 'no engine configured — set ANTHROPIC_API_KEY in arc-backend/.env, or log in to the claude CLI')
  }
  const { body: answered, briefing } = splitBriefing(stripFences(await ask(prompt)))
  if (!answered) throw new HttpError(502, 'the redraft pass returned nothing — nothing was written')

  const rebuilt = range
    ? spliceRange(paras, range.from, range.to, answered).join('\n\n')
    : answered

  // ---- PROVEN: the checks that refuse the write --------------------------
  const violated = lockViolations(scene.body, rebuilt, sceneLocks)
  if (violated.length) {
    throw new HttpError(423,
      `the redraft touched locked prose — paragraph ${violated[0].paragraph + 1} ` +
      `(${violated.map(v => v.lock.id).join(', ')}) is settled; nothing was written`)
  }
  const leaked = withholdViolations(literalWithholds(scene.contract?.must_withhold), rebuilt)
  if (leaked.length) {
    throw new HttpError(409,
      `the redraft names what the contract withholds verbatim (${leaked.map(x => `"${x}"`).join(', ')}) — nothing was written`)
  }

  const abs = path.join(STORY, scene.file)
  const raw = fs.readFileSync(abs, 'utf8')
  const head = raw.slice(0, raw.length - (parseScene(raw, scene.file)?.body.length ?? 0))
  const next = head + rebuilt + (rebuilt.endsWith('\n') ? '' : '\n')
  fs.writeFileSync(abs, next)
  const check = validateStory()
  if (!check.ok) {
    fs.writeFileSync(abs, raw)
    throw new HttpError(409, `the validator refused the redraft — nothing was written:\n${check.output}`)
  }

  recordGenerated(scene.file, next, { engine: currentEngine() ?? 'sdk', scene: t.scene, origin: 'redraft' })

  // ---- ARGUED: reported, never enforced ----------------------------------
  const reply = [
    range
      ? `Redrafted ¶${range.from + 1}–¶${range.to + 1} of ${t.scene} into the draft layer. Review it through the gate; nothing is accepted.`
      : `Redrafted ${t.scene} into the draft layer. Review it through the gate; nothing is accepted.`,
    briefing ? `\n=== THE PASS ARGUES (claims to judge, not verdicts) ===\n${briefing}` : '',
  ].join('')
  return { reply, actions: [{ tool: 'redraft', path: scene.file, ok: true }], file: scene.file }
}
