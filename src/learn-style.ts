// The style LEARNING pass (U12): what did the author change about what arc wrote?
//
// Runs on the review episode (A74-3), beside U7. U7 asks what the prose means
// for canon; this asks what the author's edits mean for the contract. Both are
// non-fatal — a failure here must never un-accept prose. Since A74-6 it has a
// row (learn · manuscript · triggered, registry.ts ROW_LEARN_MANUSCRIPT): the
// launch is the row's, the three bars are typed gates (gates.ts), and every
// run leaves a receipt carrying the key the episode joins on.
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
import { HttpError } from './http'
import { currentEngine, stripFences, SDK_ENGINE_FIX } from './engine'
import { runGates } from './gates'
import { endingOf, gateCtx as gateCtxOf } from './gate-ctx'
import { jobFingerprint, LEARN_RULES, MIN_INDEPENDENT_EXAMPLES, ROW_LEARN_MANUSCRIPT, type SealedRow } from './registry'
import { sha16 } from './records'
import { resolveRequest } from './request'
import { closeReceipt, landedByKey, openRowRun, runKey } from './rowrun'
import { endRun, stateOf } from './runs'
import { outcomeSentence, writeReceipt, writeWorkingReceipt } from './run'
import { commitRecords } from './story'
import { rulesFrom, type RawRule } from './rule-gates'
import { generatedFor, clearGenerated } from './ledger'
import { addMinedNotes, readJudgments, readMinedNotes, readWatermark, setWatermark } from './evidence'
import type { ResolvedAnnotation } from 'arc-canon-graph'
import { alignParagraphs } from 'arc-canon-graph'
import { git, parseScene, proseScenes } from './story'
import { annotations } from './annotations'
import { styleContract } from './style'
import { appendToQueue, readDismissed, readQueue, ruleId, type ProposedRule, type RuleEvidence } from './style-queue'

/** Below this many word-level changes a paragraph edit is a typo fix or a
 *  continuity patch, not a voice signal. Filtering here is what keeps the
 *  model from generalizing a rule out of a corrected character name. */
export const MIN_CHANGED_WORDS = 3

/** Two different places, or it is not a rule — declared on the learn row
 *  (registry.ts), where the gate reads it; re-exported for the callers that
 *  have always imported it from here. */
export { MIN_INDEPENDENT_EXAMPLES }

/** And two different scenes before a rule may claim to be about the writer
 *  rather than about this book. */
export const MIN_AUTHOR_SCENES = 2

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
  /** Where in the scene, so two passes at one paragraph can be recognised as
   *  one example rather than counted as two. */
  paragraph: number
  /** 'draft' — arc's draft vs what the author kept (the ledger diff).
   *  'revision' — the author's last accepted prose vs their hand rewrite of
   *  it. The purest voice signal: nobody described the change, the change is
   *  the description.
   *  'refusal' — arc offered this and the author said no, keeping what stood.
   *  The only one git never records, because refusing commits nothing.
   *  'note' — the author wrote a note ON the passage and later resolved it
   *  with the passage changed (A49-2). The only source where the requirement
   *  is STATED in the author's own words rather than inferred from an edit. */
  source: 'draft' | 'revision' | 'refusal' | 'history' | 'note'
  wrote: string
  kept: string
  changed: number
  /** the note's body — present only on source 'note' */
  said?: string
  /** which annotation argued this pair, so it argues exactly once */
  noteId?: string
  /** the craft plan the passage was drafted under, when the author's decision
   *  on it recorded one (A74-6) — a plan they keep asking for is evidence */
  plan?: { move: string; how: string }[]
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
export function editPairs(wrote: string, kept: string, scene: string, source: EditPair['source'] = 'draft'): EditPair[] {
  const a = paragraphs(wrote)
  const b = paragraphs(kept)
  const pairs: Omit<EditPair, 'n'>[] = []

  for (const al of alignParagraphs(a, b)) {
    if (al.kind === 'changed') {
      const was = a[al.mainIndex!], now = b[al.draftIndex!]
      pairs.push({ scene, source, paragraph: al.mainIndex!, wrote: was, kept: now, changed: changedWords(was, now) })
    } else if (al.kind === 'del') {
      // A cut is a pair with an empty kept side: the author's answer to that
      // paragraph was that the book is better without it.
      const was = a[al.mainIndex!]
      pairs.push({ scene, source, paragraph: al.mainIndex!, wrote: was, kept: '', changed: changedWords(was, '') })
    }
  }
  return pairs.map((p, i) => ({ n: i + 1, ...p }))
}

/** Refusals, as pairs — the evidence only the log holds.
 *
 *  A rejection never reaches git: the point of refusing is that nothing is
 *  committed, and the refused text is overwritten in place. So the log is the
 *  only record that arc offered something and the author declined it, and this
 *  is where that becomes an argument. Only entries newer than the watermark,
 *  so a refusal argues once rather than at every accept for the rest of time.
 *
 *  A refusal with nothing on arc's side is the author declining their own
 *  prose, which is not evidence about how arc should write. */
export function refusalPairs(files: string[], since: string): Omit<EditPair, 'n'>[] {
  return readJudgments()
    .filter(j => j.verdict === 'rejected' && files.includes(j.file) && j.at > since)
    .filter(j => j.arcWrote.trim() && j.arcWrote.trim() !== j.authorKept.trim())
    .map(j => ({
      scene: j.scene ?? j.file,
      paragraph: j.paragraph ?? -1,
      source: 'refusal' as const,
      wrote: j.arcWrote,
      kept: j.authorKept,
      changed: changedWords(j.arcWrote, j.authorKept),
      ...(j.plan?.length ? { plan: j.plan } : {}),
    }))
}

/** The plan the author's latest decision on a passage carried, or none.
 *  A decision on the whole scene (no paragraph) speaks for every passage in
 *  it; one on a paragraph speaks for that paragraph alone. Read from the
 *  evidence log, where the plan was copied at the decision (A69-4) — the
 *  receipt that held it is long gone. */
export function planFor(file: string, paragraph: number): { move: string; how: string }[] | undefined {
  const hits = readJudgments().filter(j => j.file === file && j.plan?.length && (j.paragraph === null || j.paragraph === paragraph))
  return hits.at(-1)?.plan
}

/** Attach the plan beside each pair that has one. */
const withPlans = (pairs: EditPair[]): EditPair[] =>
  pairs.map(p => {
    if (p.plan || (p.source !== 'draft' && p.source !== 'revision')) return p
    const plan = planFor(p.scene, p.paragraph)
    return plan ? { ...p, plan } : p
  })

/** Resolved notes as pairs — the author's stated requirement beside the
 *  prose it was stated about (A49-2).
 *
 *  Only notes whose anchor captured its paragraphs (A49-1) can argue: the
 *  snapshot is the BEFORE, and the paragraphs standing where the anchor
 *  resolves today are the AFTER. Only the author's own notes count — mining
 *  arc's keypoints or agent notes would teach arc from itself. Orphaned
 *  anchors are skipped (what the passage became is unknowable), unchanged
 *  passages are skipped (the note resolved without the prose moving, so it
 *  says nothing about form), and mined ids are skipped (a note teaches
 *  once). Pure over its inputs so the test owns every branch. */
export function notePairs(
  notes: ResolvedAnnotation[],
  mined: Set<string>,
  bodyOf: (scene: string) => string | null,
): Omit<EditPair, 'n'>[] {
  const squash = (t: string) => t.replace(/\s+/g, ' ').trim()
  const out: Omit<EditPair, 'n'>[] = []
  for (const n of notes) {
    if (n.kind === 'keypoint' || n.by === 'agent') continue
    if (n.status !== 'resolved' || mined.has(n.id)) continue
    const snapshot = n.anchor.paragraphs
    if (!snapshot?.length || !n.body.trim()) continue
    if (n.resolution.state !== 'resolved' && n.resolution.state !== 'drifted') continue
    const body = bodyOf(n.anchor.scene)
    if (body === null || n.resolution.paragraph === null) continue
    const paras = paragraphs(body)
    const kept = paras.slice(n.resolution.paragraph, n.resolution.paragraph + snapshot.length).join('\n\n')
    const wrote = snapshot.join('\n\n')
    if (!kept || squash(kept) === squash(wrote)) continue
    out.push({
      scene: n.anchor.scene,
      paragraph: n.anchor.paragraph ?? -1,
      source: 'note',
      wrote,
      kept,
      changed: changedWords(wrote, kept),
      said: n.body.trim(),
      noteId: n.id,
    })
  }
  return out
}

/** The bar, applied in one place so the test can pin it. */
export const significant = (pairs: EditPair[]): EditPair[] =>
  pairs.filter(p => p.changed >= MIN_CHANGED_WORDS)


/** The plan, as one line beside its pair. */
const planLine = (p: EditPair): string[] =>
  p.plan?.length ? [`THE PLAN IT WAS DRAFTED UNDER: ${p.plan.map(m => `${m.move} — ${m.how}`).join('; ')}`] : []

/** The numbered pairs, as the subject of the brief. Pure. */
export function editsTable(pairs: EditPair[]): string {
  return pairs.map(p => [
    `--- EDIT ${p.n} (${p.scene}) ---`,
    ...(p.source === 'note' ? [`AUTHOR NOTED: ${p.said ?? ''}`] : []),
    p.source === 'revision' ? `AUTHOR HAD: ${p.wrote}`
      : p.source === 'history' ? `THE BOOK HAD: ${p.wrote}`
        : p.source === 'note' ? `AS NOTED: ${p.wrote}`
          : `ARC WROTE: ${p.wrote}`,
    p.source === 'revision' ? `REVISED TO: ${p.kept || '(cut entirely)'}`
      : p.source === 'refusal' ? `AUTHOR REFUSED, KEEPING: ${p.kept || '(nothing — the passage went)'}`
        : p.source === 'history' ? `IT MOVED TO: ${p.kept || '(cut entirely)'}`
          : p.source === 'note' ? `IT BECAME: ${p.kept || '(cut entirely)'}`
            : `AUTHOR KEPT: ${p.kept || '(cut entirely)'}`,
    ...planLine(p),
  ].join('\n')).join('\n\n')
}

/** THE SLICE: the promoted contract and the rules the author declined. Built
 *  by code from the record, never by the model. The pending queue is not here:
 *  docs/style.proposed.md is read by no prompt (rule 3), and the gates check
 *  a new rule against it in code. */
export function learnSlice(input: { style: string; declined?: string[] }): string {
  return [
    `=== THE CONTRACT AS IT STANDS (do not re-propose any of this) ===\n${input.style}`,
    input.declined?.length
      ? `=== RULES THE AUTHOR DECLINED (do not propose these again, in any wording) ===\n${input.declined.map(r => `- ${r}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n\n')
}

/** THE ASK: the numbered pairs, the subject. */
export const learnAsk = (pairs: EditPair[]): string => `=== THE EDITS ===\n${editsTable(pairs)}\n\nAnswer with the JSON array.`

/** The whole brief as one string. The rowed passes send the same three parts
 *  as blocks; this is the one-string reading of them, for tests. */
export function buildLearnPrompt(input: {
  pairs: EditPair[]
  style: string
  declined?: string[]
}): string {
  return [LEARN_RULES, learnSlice(input), learnAsk(input.pairs)].join('\n\n')
}

type RawProposal = RawRule

/** Tolerant parse, matching the other passes: fences stripped, junk dropped. */
export function parseProposals(text: string): RawProposal[] {
  const raw = stripFences(text)
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end < start) throw new Error(`learning pass did not return a JSON array: ${raw.slice(0, 160)}`)
  const parsed: unknown = JSON.parse(raw.slice(start, end + 1))
  if (!Array.isArray(parsed)) throw new Error('learning pass returned JSON that is not an array')
  return rulesFrom(parsed)
}

const clip = (s: string): string =>
  s.length <= EVIDENCE_CHARS ? s : s.slice(0, EVIDENCE_CHARS - 1).trimEnd() + '…'

/** Attach evidence from OUR table, not the model's text, and drop any
 *  proposal that cites nothing real. A rule with no evidence is an opinion,
 *  and the author has no way to judge it. */
/** How many DIFFERENT places in the manuscript a set of edits comes from.
 *
 *  The unit is the paragraph, not the edit. An author who works one paragraph
 *  over three times has shown one preference three ways, and counting that as
 *  three examples is how a passing mood becomes a binding rule. */
export const independentExamples = (cited: EditPair[]): number =>
  new Set(cited.map(placeKey)).size

/** The scene a pair is about, as an id. Pairs name their scene three ways — a
 *  prose FILE (a draft or a hand revision), a scene id (a refusal, a note) —
 *  so the same paragraph reached by two routes must be recognised as one
 *  place before it is counted. Resolved from the book's own scenes; a name it
 *  cannot place stands as it is. */
export function sceneIdOf(name: string): string {
  return proseScenes().find(s => s.file === name || s.scene === name)?.scene ?? name
}

/** ONE KEY FOR EVERY PAIR: the scene and the paragraph. A refusal and a hand
 *  edit of the same paragraph are one example, not two. */
export const placeKey = (p: { scene: string; paragraph: number }): string => `${sceneIdOf(p.scene)}:${p.paragraph}`

/** Attach evidence from OUR table, not the model's text, and hold every
 *  proposal to the bar in code rather than only in the prompt.
 *
 *  The prompt asks for two independent examples. A rule that lives only in a
 *  prompt is of a weaker kind than the evidence-materializing beside it — the
 *  whole property this module rests on is that the machine supplies the proof,
 *  so the machine counts the proof too. */
export function materialize(proposals: RawProposal[], pairs: EditPair[], at: string): ProposedRule[] {
  return materializeCounted(proposals, pairs, at).rules
}

/** `materialize`, and what it left out by name — so the receipt can say that
 *  every rule the answer made is either kept or dropped for a reason. */
export function materializeCounted(proposals: RawProposal[], pairs: EditPair[], at: string): { rules: ProposedRule[]; dropped: { reason: string; count: number }[] } {
  const byN = new Map(pairs.map(p => [p.n, p]))
  const out: ProposedRule[] = []
  const dropped = new Map<string, number>()
  const drop = (reason: string, n = 1): void => { dropped.set(reason, (dropped.get(reason) ?? 0) + n) }
  for (const [i, p] of proposals.entries()) {
    // Cited BEFORE evidence is trimmed for display. Gating on the trimmed
    // list would fail a well-evidenced rule for being too well evidenced.
    const cited = p.edits.map(n => byN.get(n)).filter((x): x is EditPair => !!x)
    if (independentExamples(cited) < MIN_INDEPENDENT_EXAMPLES) { drop('no-evidence'); continue }

    const evidence: RuleEvidence[] = cited
      .slice(0, 3)
      .map(x => ({ scene: x.scene, wrote: clip(x.wrote), kept: clip(x.kept) }))
    if (!evidence.length) { drop('no-evidence'); continue }

    // Attribution is conservative: a rule is 'revision' only when every edit
    // it cites is one. One draft correction in the argument makes it a rule
    // about how arc should write, and it files as such.
    const source = cited.every(x => x.source === 'revision') ? 'revision' as const
      : cited.every(x => x.source === 'refusal') ? 'refusal' as const
        : cited.every(x => x.source === 'history') ? 'history' as const
          : 'draft' as const

    // The author layer is what stays true across books, so one book's evidence
    // cannot argue for it. Spanning two scenes is a low bar and still a bar;
    // anything under it is refiled as a rule about this story, which is what
    // it actually is. The author can still ratify it anywhere they like.
    const scenes = new Set(cited.map(x => x.scene)).size
    const layer = p.layer === 'author' && scenes >= MIN_AUTHOR_SCENES ? 'author' as const : 'story' as const

    out.push({ id: ruleId(p.rule), rule: p.rule, section: p.section, at, evidence, source, layer })
    if (out.length >= MAX_PROPOSALS_PER_RUN) { if (proposals.length - i - 1 > 0) drop('cap', proposals.length - i - 1); break }
  }
  return { rules: out, dropped: [...dropped].map(([reason, count]) => ({ reason, count })) }
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
function baselineBody(file: string, at?: string): string | null {
  // A caller that knows where its reading starts — the review episode — names
  // it, so two accepts read as one change and not as the last of them alone.
  if (at) {
    try {
      const prefix = git('rev-parse', '--show-prefix').trim()
      return parseScene(git('show', `${at}:${prefix}${file}`), file)?.body ?? null
    } catch { return null }
  }
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

export interface LearnResult {
  added: ProposedRule[]
  /** Why nothing was proposed, when nothing was — including the cases that
   *  never reached the model at all. `already-read` is a keyed episode this
   *  record already holds a landed read of; `not-read` a run that ended
   *  without an answer (its sentence is `reply`). */
  skipped: 'queue-full' | 'no-edits' | 'no-engine' | 'already-read' | 'not-read' | null
  pairsConsidered: number
  /** the run that read, when a model was asked */
  run?: string
  /** one sentence for the author, when a run ended without an answer */
  reply?: string
}

/** The episode a keyed read belongs to (A74-3): the scene, the commits it
 *  covers and the combined diff the key fingerprints. Absent for the Style
 *  page's "learn now", which reads whatever the author has judged and is
 *  attended, by hand, and carries no key. */
export interface LearnEpisode { scene: string; range: { from: string; to: string }; diff: string }

/** The key of a learner read: job · scene · range, by the same rule as U7's. */
export const learnKey = (e: LearnEpisode): string => runKey('learn', e.scene, e.range, e.diff)

/** The gesture, as a gesture — never a sentence the author did not say. The
 *  Style page's "learn now" is the author's hand; a read after their accepts
 *  is arc's own trigger, named for the scene it follows. */
const gestureOf = (episode?: LearnEpisode): string =>
  episode ? `after your accepts to ${episode.scene}` : 'learn now, by hand'

export async function runLearnStyle(
  files: string[],
  baselines: Record<string, string> = {},
  opts: { episode?: LearnEpisode } = {},
): Promise<LearnResult> {
  const opened = { yes: false }
  try {
    return await learnRead(files, baselines, opts, opened)
  } catch (e) {
    // A KEYED READ THAT THROWS BEFORE ITS RUN OPENED (the table of pairs reads
    // git and the evidence log) still leaves its receipt, ending could not
    // run, so the failure is LISTED and not simply lost. A refusal in the
    // author's words (HttpError) is an answer, not a failure.
    if (!opened.yes && opts.episode && !(e instanceof HttpError)) {
      try {
        const request = resolveRequest({ said: gestureOf(opts.episode), job: 'learn', scope: 'manuscript', mode: 'triggered', subject: opts.episode.scene })
        const ctx = openRowRun(request, ROW_LEARN_MANUSCRIPT, { included: [], withheld: [], dropped: [], read: [] })
        ctx.receipt.key = learnKey(opts.episode)
        ctx.receipt.result = { records: [], commit: null, range: opts.episode.range }
        closeReceipt(ctx, 'could not run'); endRun(ctx.run.id, 'could not run', { failed: opts.episode.scene })
      } catch (inner) { console.error('[error] could not record the failed style read:', inner) }
    }
    throw e
  }
}

async function learnRead(
  files: string[],
  baselines: Record<string, string>,
  opts: { episode?: LearnEpisode },
  opened: { yes: boolean },
): Promise<LearnResult> {
  // A KEYED READ THAT LANDED IS DONE (invariant 3): the same accepts, the same
  // words — nothing to spend. Checked before anything is read.
  const key = opts.episode ? learnKey(opts.episode) : undefined
  if (key && landedByKey(key, undefined, 'learn')) {
    return { added: [], skipped: 'already-read', pairsConsidered: 0, reply: 'arc has already read everything you changed in this scene, so there is nothing new to learn from.' }
  }

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
      const had = baselineBody(file, baselines[file])
      if (had === null || had === kept) continue
      pairs.push(...significant(editPairs(had, kept, file, 'revision')))
    }
  }
  // the plan each decision carried, beside the pair it is about (A74-6)
  const planned = withPlans(pairs)
  pairs.length = 0
  pairs.push(...planned)

  // What the author refused, which git never recorded and only the evidence
  // log holds. Added after the ledger diffs so the numbering stays stable.
  const mark = readWatermark()
  const refusals = significant(refusalPairs(files, mark).map((p, i) => ({ n: pairs.length + i + 1, ...p })))
  pairs.push(...refusals)

  // What the author asked for in words: resolved notes whose passage moved
  // (A49-2). Deduplicated by note id in the watermark, so a note argues once.
  const noted = significant(
    notePairs(annotations(), readMinedNotes(), f => {
      const sc = proseScenes().find(x => x.scene === f)
      return sc ? sc.body : null
    }).map((p, i) => ({ n: pairs.length + i + 1, ...p })))
  pairs.push(...noted)

  // Accepted unedited, or nothing arc wrote: no model, no tokens.
  if (!pairs.length) {
    if (mined.length) clearGenerated(mined)
    return { added: [], skipped: 'no-edits', pairsConsidered: 0 }
  }

  const engine = currentEngine()
  if (!engine) return { added: [], skipped: 'no-engine', pairsConsidered: pairs.length }
  if (engine === 'sdk') {
    throw new HttpError(400,
      'arc can learn from your edits only when it runs on your claude login — it cannot show what it was given on the engine it is set up to use. '
      + SDK_ENGINE_FIX)
  }

  // Renumber after truncation so the numbers the model sees are the numbers
  // materialize() looks up.
  const considered = pairs.slice(0, MAX_PAIRS).map((p, i) => ({ ...p, n: i + 1 }))
  const subject = opts.episode?.scene ?? 'the manuscript'
  const read = await launchLearn({
    row: ROW_LEARN_MANUSCRIPT, considered, ask: learnAsk(considered),
    said: gestureOf(opts.episode), subject, key,
    range: opts.episode?.range ?? null,
    readExtra: opts.episode ? [{ id: `range:${opts.episode.scene}`, version: `${opts.episode.range.from}..${opts.episode.range.to}` }] : [],
    opened,
    receiptNote: key ? `Record: the receipt for a style read of ${opts.episode!.range.to.slice(0, 7)}` : 'Record: the receipt for a style read by hand',
  })
  if (read.skipped !== null) return read

  // Consumed: the same edit must never be mined twice into the same queue.
  clearGenerated(mined)
  // The refusals have argued; move the watermark past them so they do not
  // argue again at every accept from here on.
  const newest = considered.filter(p => p.source === 'refusal').length
    ? readJudgments().filter(j => files.includes(j.file)).at(-1)?.at
    : null
  if (newest) setWatermark(newest)
  // The notes have argued too — each exactly once.
  addMinedNotes(considered.filter(p => p.noteId).map(p => p.noteId!))
  return read
}

/** THE LAUNCH OF A LEARNING READ, shared by the two rows that learn (the
 *  review episode's, A74-6, and the bootstrap's, A74-7): resolve the gesture,
 *  open the run, send the three blocks, run the three gates, file what
 *  survives with the run id on it, and close the receipt. The slice carries
 *  the promoted contract and the declined list and NEVER the pending queue
 *  (rule 3): the queue is checked in code by the gates. What differs between
 *  the rows is only what the caller hands in. */
export async function launchLearn(input: {
  row: SealedRow
  considered: EditPair[]
  /** the ask block: the numbered pairs, and any context the caller adds */
  ask: string
  said: string
  subject: string
  key?: string
  range: { from: string; to: string } | null
  readExtra?: { id: string; version: string }[]
  opened: { yes: boolean }
  receiptNote: string
  /** a layer to force on every proposal, whatever the model recommends */
  layer?: 'story'
}): Promise<LearnResult> {
  const { row, considered, ask, subject, key, range, opened } = input
  const style = styleContract()
  const pending = readQueue().map(r => r.rule)
  const declined = readDismissed()

  const request = resolveRequest({
    said: input.said,
    job: row.job, scope: row.scope, mode: row.mode,
    subject,
  })
  // the queue is held in code, never shown to the model (rule 3)
  const sliceText = learnSlice({ style, declined: declined.map(d => d.rule) })
  const ctx = openRowRun(request, row, {
    included: [...row.slice.layers], withheld: [], dropped: [],
    read: [
      { id: 'style-contract', version: sha16(style) },
      { id: 'declined', version: sha16(declined.map(d => d.id).join(',')) },
      { id: 'edits', version: sha16(ask) },
      ...(input.readExtra ?? []),
      { id: 'job', version: jobFingerprint(row) },
    ],
  })
  opened.yes = true
  const { run, receipt } = ctx
  // The key and the commits it read are on the receipt from the start, so a
  // run that fails is still the answer to "what did this try to read".
  if (key) receipt.key = key
  receipt.result = { records: [], commit: null, range }
  writeWorkingReceipt(receipt)

  const brief = {
    blocks: [
      { id: 'rules', text: row.rules, cached: true },
      { id: 'slice', text: sliceText, cached: true },
      { id: 'ask', text: ask, cached: false },
    ],
  }
  const gateCtx = {
    ...gateCtxOf({
      sceneName: subject, sceneBody: '', sceneLocks: [], lockedTexts: [],
      literals: [], andCap: null, wordCap: null, destination: [], known: [],
    }),
    rules: {
      // one key per pair: the scene id and the paragraph, however the pair named its scene
      table: considered.map(p => ({ n: p.n, scene: sceneIdOf(p.scene), paragraph: p.paragraph })),
      minExamples: row.minIndependentExamples ?? MIN_INDEPENDENT_EXAMPLES,
      contract: style,
      pending,
      declined,
    },
  }

  try {
    const out = await runGates({
      row: { ...row },
      run, receipt, brief,
      repair: (refusal: string, resumed: boolean) => ({
        blocks: resumed ? [{ id: 'repair', text: refusal, cached: false }]
          : [...brief.blocks, { id: 'repair', text: refusal, cached: false }],
      }),
      attempt: (n: 1 | 2) => `read-${n}`,
      gateCtx,
      render: b => b.blocks.map(x => x.text).join('\n\n'),
    })

    const unread = (reply: string): LearnResult =>
      ({ added: [], skipped: 'not-read', pairsConsidered: considered.length, run: run.id, reply })

    if (stateOf(run.id) === 'cancelled') {
      closeReceipt(ctx, 'cancelled'); endRun(run.id, 'cancelled', { stopped: subject })
      return unread(outcomeSentence({ ending: 'cancelled', gates: receipt.gates }) ?? 'you stopped it before it had anything to say.')
    }
    if (!out.ok) {
      const ending = endingOf([{ kind: out.kind, gateRefused: out.gateRefused, unreadable: out.unreadable }], false)
      closeReceipt(ctx, ending); endRun(run.id, ending, { refused: out.reason })
      return unread(outcomeSentence({ ending, gates: receipt.gates }) ?? out.reason)
    }

    const read = JSON.parse(out.checked.body) as {
      rules: RawProposal[]
      dropped: { gate: string; claim: string; why: string }[]
      resembles: Record<string, { id: string; at: string }>
    }
    // The quotes come from OUR table; the run id and the resemblance ride on
    // the rule so the Style page can say where it came from.
    const made = materializeCounted(read.rules, considered, new Date().toISOString())
    const fresh = made.rules.map(r => ({
      ...r, run: run.id,
      ...(input.layer ? { layer: input.layer } : {}),
      ...(read.resembles[r.rule] ? { resembles: read.resembles[r.rule] } : {}),
    }))

    // THE KEY IS CHECKED AGAIN before anything is filed: two reads with one
    // key never both file, however they overlapped while the model answered.
    // Ended as U7 ends it — cancelled, saying it was already read.
    if (key && landedByKey(key, run.id, 'learn')) {
      closeReceipt(ctx, 'cancelled'); endRun(run.id, 'cancelled', { read: subject, already: true })
      return { added: [], skipped: 'already-read', pairsConsidered: considered.length, run: run.id,
        reply: 'arc has already read everything you changed in this scene, so there is nothing new to learn from.' }
    }
    const { added } = appendToQueue(fresh)

    // EVERY RULE THE ANSWER MADE IS KEPT OR DROPPED FOR A NAMED REASON:
    // returned = kept + dropped. The gates' drops, materialize's own (no
    // evidence, the cap) and the queue's (already queued or declined by id).
    const byGate = new Map<string, number>()
    const count = (reason: string, n: number): void => { if (n > 0) byGate.set(reason, (byGate.get(reason) ?? 0) + n) }
    for (const d of read.dropped) count(d.gate, 1)
    for (const d of made.dropped) count(d.reason, d.count)
    count('already-queued-or-declined', fresh.length - added.length)
    receipt.evidence = {
      returned: read.rules.length + read.dropped.length,
      dropped: [...byGate].map(([reason, count]) => ({ reason, count })),
    }
    receipt.result = { records: added.map(r => r.id), commit: null, range }
    writeWorkingReceipt(receipt)
    closeReceipt(ctx, 'landed')
    // A LANDED KEYED READ JOINS THE RECORD when it lands (epic D10): no
    // author's decision gates it, and the episode reads what has been read
    // from history/, not from the disposable .arc/.
    // A read the author asked for by hand joins the record too when it proposes
    // something, so every proposal's `run` resolves in history/.
    if (key || added.length) {
      try {
        const file = writeReceipt(receipt)
        commitRecords(input.receiptNote, [file])
      } catch (e) { console.error('[error] could not write the receipt of a landed style read to history/:', e) }
    }
    endRun(run.id, 'landed', { read: subject, proposed: added.length, dropped: read.dropped.length })
    return { added, skipped: null, pairsConsidered: considered.length, run: run.id }
  } catch (e) {
    // A RUN THAT THROWS AFTER ITS RECEIPT IS KEYED must still end: left open
    // it would read as unfinished. The first ending wins.
    closeReceipt(ctx, 'could not run'); endRun(run.id, 'could not run', { failed: subject })
    throw e
  }
}
