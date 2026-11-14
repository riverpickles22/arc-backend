// U7 · UPDATE RECORD · SCENE · TRIGGERED (A74-1).
//
// "What did what I accepted change?" Until this card the answer was asked of
// a pass that ran only through the SDK's tool runner, with a canon write
// tool, behind a credential check in the accept handler — so on a machine
// with no key, which is the author's, every accept taught the record
// nothing. This gives U7 the row every other writing job has.
//
// The model WRITES NOTHING. It reads the accepted change (the paragraphs the
// accept added, changed or removed, each with an id) against the record and
// answers with proposals as data. Arc's gates then prove what can be proven
// about each one, and arc's code does the filing: it mints the id, writes the
// origin to the ledger FIRST (§4's landing order), then the canon file with
// `status: proposed` through validate-or-revert. Nothing is committed here:
// a proposal is a working-tree file until the author decides on it.
//
// THE REGISTERS. That a paragraph id is in the accepted change, that a
// record validates, that a name is already in the book — proven. That the
// page implies a fact — argued, and marked so in the ledger's class.
import fs from 'node:fs'
import path from 'node:path'
import { alignParagraphs } from 'arc-canon-graph'
import type { CanonDoc, UpdateRecordResponse } from 'arc-canon-graph'
import { dump as yamlDump } from 'js-yaml'
import { STORY } from './config'
import { HttpError } from './http'
import { currentEngine, noEngineSentence, SDK_ENGINE_FIX } from './engine'
import { CONFLICT_BY_CHECKS, CONFLICT_BY_NAMES, leaks, runGates, type ProposalGateCtx } from './gates'
import { git } from './lane'
import { canonJson, invalidateCanon, validateAt, validateStory } from './canon'
import { neverKeys } from './evidence'
import { proposalOrigins, recordProposalOrigin, retractionOrigins } from './ledger'
import { inLane } from './lane'
import { buildCandidate, entityKeys, evidenceId, EXISTING_RECORD_WHY, proposalKey, provenConflict, recordKeys, UNSAFE_APPEND_WHY, withEdge, type BuildContext, type Proposal } from './proposals'
import { continuityConflict } from './continuity'
import { endingOf, gateCtx as gateCtxOf, literalWithholds } from './gate-ctx'
import { fingerprintsAtWrite } from './style-projection'
import { jobFingerprint, ROUTE_WITHHELD, type SealedRow } from './registry'
import { READ_MAP, readsFrom } from './reads'
import { idsInFile, listFiles, sha16, takenIds } from './records'
import { resolveRequest } from './request'
import { closeReceipt, landedByKey, openRowRun, runKey } from './rowrun'
import { endRun, stateOf } from './runs'
import { assembleWritingSlice } from './slice'
import { outcomeSentence, writeReceipt, writeWorkingReceipt } from './run'
import { paragraphsOf } from './blast-radius'
import { commitRecords, parseScene, proseScenes } from './story'

/** git's empty tree: what a scene's first accept is read against. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf9be2c46d6d09fe7'

// ---- the accepted change ------------------------------------------------------

/** The accepted change a request names: by default the commit that last
 *  touched the scene's file, against its parent. A scene whose first accept
 *  that was reads against nothing — every paragraph is new. */
export function acceptedRange(file: string, from?: string, to?: string): { from: string; to: string } {
  const prefix = git('rev-parse', '--show-prefix').trim()
  const resolve = (rev: string): string => {
    if (rev === EMPTY_TREE) return rev   // a first accept reads against nothing
    try { return git('rev-parse', '--verify', `${rev}^{commit}`).trim() } catch {
      throw new HttpError(400, `arc does not know the change called ${rev}.`)
    }
  }
  const end = resolve(to ?? 'HEAD')
  if (from) return { from: resolve(from), to: end }
  const last = git('log', '-1', '--format=%H', end, '--', `${prefix}${file}`).trim()
  if (!last) throw new HttpError(409, 'that scene has never been accepted into the book, so there is nothing yet to learn from.')
  let parent: string
  try { parent = git('rev-parse', '--verify', `${last}^`).trim() } catch { parent = EMPTY_TREE }
  return { from: parent, to: end }
}

// ---- the run's key (A74-3, invariant 3) -----------------------------------------

/** The scene's body as the book held it at a commit, or null if it was not
 *  there. */
export function bodyAt(rev: string, file: string): string | null {
  if (rev === EMPTY_TREE) return null   // nothing was there before a first accept
  try {
    const prefix = git('rev-parse', '--show-prefix').trim()
    return parseScene(git('show', `${rev}:${prefix}${file}`), file)?.body ?? null
  } catch { return null }
}

/** THE ACCEPTED DIFF WITH ITS PARAGRAPH IDS (the subject slot). Each
 *  paragraph is numbered as the book now holds it; only the ones the accept
 *  added, changed or removed can be cited, and the unchanged ones are
 *  context, labelled so. `citable` is the set the evidence gate resolves
 *  against — read off the same walk that rendered the text. */
export function acceptedDiff(before: string | null, after: string): { text: string; citable: Set<string> } {
  const b = before === null ? [] : paragraphsOf(before)
  const a = paragraphsOf(after)
  const citable = new Set<string>()
  const lines: string[] = []
  for (const x of alignParagraphs(b, a)) {
    if (x.kind === 'same') { lines.push(`[¶${x.draftIndex! + 1} · unchanged — context, not citable]\n${a[x.draftIndex!]}`); continue }
    if (x.kind === 'del') {
      const id = `-¶${x.mainIndex! + 1}`
      citable.add(id)
      lines.push(`[${id} · removed by this change]\n${b[x.mainIndex!]}`)
      continue
    }
    const id = `¶${x.draftIndex! + 1}`
    citable.add(id)
    lines.push(x.kind === 'ins'
      ? `[${id} · new]\n${a[x.draftIndex!]}`
      : `[${id} · changed]\n${a[x.draftIndex!]}\n(it read, before: ${b[x.mainIndex!]})`)
  }
  return { text: lines.join('\n\n'), citable }
}

// ---- the record, as the pass is told it ---------------------------------------

interface CanonEntity { id: string; type?: string; name?: string; aliases?: string[]; status?: string }
const entitiesOf = (canon: { entities?: Record<string, CanonEntity> }): CanonEntity[] =>
  Object.values(canon.entities ?? {})

/** EVERY ENTITY'S ID AND NAMES, built by code so a known person is never
 *  minted twice. Compact: one line each. */
export function nameIndex(entities: CanonEntity[]): string {
  if (!entities.length) return '(the record holds no people, places, factions or objects yet)'
  return entities.map(e =>
    `${e.id} — ${[e.name, ...(e.aliases ?? [])].filter(Boolean).join(' / ')} (${e.type ?? 'record'}, ${e.status ?? 'proposed'})`).join('\n')
}

/** THE NARRATIVE NOTES of what the scene binds — its facts and its events —
 *  as the suppression slot of the brief. The author keeps some things unsaid
 *  on purpose, and the notes are where they say so; a pass that is told to
 *  suppress what they protect has to be shown them. */
export function narrativeNotes(
  canon: { entities?: Record<string, { narrative_notes?: string }>; events?: Record<string, { narrative_notes?: string }> },
  scene: { facts: string[]; events: string[] },
): string {
  const lines: string[] = []
  for (const id of scene.facts) {
    const n = canon.entities?.[id]?.narrative_notes
    if (typeof n === 'string' && n.trim()) lines.push(`${id}: ${n.trim().replace(/\s+/g, ' ')}`)
  }
  for (const id of scene.events) {
    const n = canon.events?.[id]?.narrative_notes
    if (typeof n === 'string' && n.trim()) lines.push(`${id}: ${n.trim().replace(/\s+/g, ' ')}`)
  }
  return lines.length ? lines.join('\n') : '(the scene binds nothing that carries narrative notes)'
}

/** THE KEYS A PROPOSAL IS REFUSED AGAINST: what the book holds (every
 *  entity's names, canon or pending) and what an earlier run already filed
 *  and is still waiting on. This is the one place the set is built.
 *  Plus every key the author said never to (`neverKeys`, A74-2), so a person
 *  they declined is not proposed again under a fresh id. */
export function refusedKeys(entities: CanonEntity[], canon?: Parameters<typeof recordKeys>[0]): Set<string> {
  const keys = new Set<string>(entities.flatMap(e => entityKeys(e)))
  // what the book already says about its relationships and events (A74-12):
  // a proposal that only restates an edge or an event is a duplicate
  for (const k of canon ? recordKeys(canon) : []) keys.add(k)
  for (const o of [...proposalOrigins(), ...retractionOrigins()]) if (o.key) keys.add(o.key)
  for (const k of neverKeys()) keys.add(k)
  return keys
}

// ---- judging a candidate without touching the working tree ----------------------

/** A story directory laid out like the real one, for the validator. Kept
 *  under .arc/ (never committed) and removed when the run ends. */
class Sandbox {
  readonly dir: string
  private baseline: { ok: boolean; output: string } | null = null
  constructor(run: string) {
    this.dir = path.join(STORY, '.arc', 'validate', run)
    fs.mkdirSync(this.dir, { recursive: true })
    for (const d of ['canon', 'docs', 'research']) {
      if (fs.existsSync(path.join(STORY, d))) fs.cpSync(path.join(STORY, d), path.join(this.dir, d), { recursive: true })
    }
  }
  /** Does adding this file make the story worse? A story that already has
   *  findings of its own is not a reason to refuse a record that adds none. */
  check(files: { rel: string; text?: string; edge?: Record<string, unknown> }[]): { ok: boolean; output: string } {
    this.baseline ??= validateAt(this.dir)
    const abs = files.map(f => path.join(this.dir, f.rel))
    // an edge joins a file that is already there: put its bytes back after
    const before = abs.map(a => { try { return fs.readFileSync(a) } catch { return null } })
    files.forEach((f, i) => {
      fs.mkdirSync(path.dirname(abs[i]), { recursive: true })
      fs.writeFileSync(abs[i], f.edge ? withEdge(before[i]?.toString('utf8') ?? '', f.edge) ?? '' : f.text ?? '')
    })
    try { return addsNothing(this.baseline, validateAt(this.dir)) } finally {
      abs.forEach((a, i) => { if (before[i]) fs.writeFileSync(a, before[i]!); else fs.rmSync(a, { force: true }) })
    }
  }
  close(): void { fs.rmSync(this.dir, { recursive: true, force: true }) }
}

/** Compare a validation to the one before it: ok when it is clean, or when
 *  every finding it reports was already there. */
export function addsNothing(base: { ok: boolean; output: string }, now: { ok: boolean; output: string }): { ok: boolean; output: string } {
  if (now.ok) return now
  if (base.ok) return now
  const had = new Set(base.output.split('\n').map(l => l.trim()).filter(l => l && !/^FAIL\b/.test(l)))
  const added = now.output.split('\n').map(l => l.trim()).filter(l => l && !/^FAIL\b/.test(l) && !had.has(l))
  return added.length ? now : { ok: true, output: base.output }
}

const canonYaml = (record: unknown): string => yamlDump(record, { indent: 2, lineWidth: 100, noRefs: true, sortKeys: false })

/** The existing edge a new one sits BESIDE: one between the same two ends, in
 *  either direction, of a different kind. Kinds coexist (conventions §4);
 *  nothing is replaced. */
function besideEdge(edges: { id: string; from: string; to: string; kind: string }[], record: Record<string, unknown>): string | null {
  const { from, to, kind } = record as { from: string; to: string; kind: string }
  return edges.find(e => e.kind !== kind && ((e.from === from && e.to === to) || (e.from === to && e.to === from)))?.id ?? null
}

/** WHERE A RECORD LIVES, by id — a retraction names one, so the origin can
 *  point at its file. */
function fileOfRecord(id: string): string | null {
  for (const rel of listFiles('canon')) {
    if (rel.endsWith('.yaml') && idsInFile(path.join(STORY, rel), rel).includes(id)) return rel
  }
  return null
}

// ---- the sentence the author reads ------------------------------------------------

const many = (n: number, one: string, more: string): string => `${n === 1 ? 'one' : n} ${n === 1 ? one : more}`

export function updateRecordReply(proposed: number, dropped: number, refused: number): string {
  const tail = [
    dropped ? `${(dropped === 1 ? 'one thing was' : `${dropped} things were`)} left out for resting on nothing arc could check` : '',
    refused ? `${(refused === 1 ? 'one thing was' : `${refused} things were`)} left out because your record already has it or would not fit it` : '',
  ].filter(Boolean)
  const rest = tail.length ? ` ${tail.join(', and ').replace(/^./, c => c.toUpperCase())}.` : ''
  if (!proposed) return `arc read what you accepted and has nothing to add to your record.${rest}`
  return `arc read what you accepted and has ${many(proposed, 'thing', 'things')} for you to look at — proposed, none of it in your record until you say so.${rest}`
}

// ---- the pass -------------------------------------------------------------------

/** READ ONE ACCEPTED CHANGE AND FILE WHAT THE RECORD SHOULD LEARN. Rowed,
 *  receipted, gated. Filed proposals are working-tree canon files with
 *  `status: proposed`, and nothing is committed. */
export async function runUpdateRecord(
  scene: string, from?: string, to?: string,
  /** `rerun` asks for a reading the key would skip. For a test that asks the
   *  same question twice on purpose; no route and no trigger sets it. */
  opts: { rerun?: boolean } = {},
): Promise<UpdateRecordResponse> {
  const live = proseScenes().find(s => s.scene === scene)
  if (!live) throw new HttpError(404, `arc has no scene called ${scene}.`)
  const range = acceptedRange(live.file, from, to)
  const before = bodyAt(range.from, live.file)
  const after = bodyAt(range.to, live.file)
  if (after === null) throw new HttpError(409, `${scene} is not in the book at that point, so there is nothing to read.`)
  const diff = acceptedDiff(before, after)
  if (!diff.citable.size) throw new HttpError(409, `that accept left the words of ${scene} as they were, so there is nothing to learn from.`)

  // THE KEY, before anything is spent: the same accepts, the same words, read
  // and landed already — nothing to do, and the reply says so.
  const key = runKey('update-record', scene, range, diff.text)
  const done = opts.rerun ? null : landedByKey(key)
  if (done) {
    return { scene, run: done, proposed: 0, dropped: 0, refused: 0, filed: [], nothingNew: true,
      reply: 'arc has already read everything you accepted to this scene, so there is nothing new to add to your record.' }
  }

  const request = resolveRequest({
    said: `what should the record learn from ${scene}?`,
    job: 'update-record', scope: 'scene', mode: 'triggered',
    subject: scene,
  })
  const row = request.row as SealedRow

  if (currentEngine() === 'sdk') {
    throw new HttpError(400,
      'arc cannot show what that reading was given on the engine it is set up to use — it can only do this when it runs the claude CLI on your login. '
      + SDK_ENGINE_FIX)
  }
  if (!currentEngine()) {
    throw new HttpError(400, noEngineSentence())
  }

  const canon = JSON.parse(canonJson()) as {
    entities?: Record<string, CanonEntity & { narrative_notes?: string }>
    events?: Record<string, { narrative_notes?: string; title?: string; participants?: { entity: string }[] }>
    relationships?: { id: string; from: string; to: string; kind: string; directed?: boolean }[]
    chapters?: { id: string; era?: string }[]
  }
  const entities = entitiesOf(canon)
  const era = canon.chapters?.find(c => c.id === live.chapter)?.era ?? null

  const slice = assembleWritingSlice(row, { chapter: live.chapter, scene: live }, { stage: 'write' })
  const used = slice.forReceipt()
  const sliceText = `${slice.render()}\n\n=== NARRATIVE NOTES — deliberate silences; never propose what they protect ===\n${narrativeNotes(canon, live)}`
    + `\n\n=== WHAT THE RECORD ALREADY HOLDS (id — names) ===\n${nameIndex(entities)}`
  const ctx = openRowRun(request, row, {
    ...used,
    withheld: [],
    dropped: used.dropped_for_budget,
    read: [
      { id: `slice:${scene}`, version: sha16(sliceText) },
      ...readsFrom(fingerprintsAtWrite(scene)),
      { id: `range:${scene}`, version: `${range.from}..${range.to}` },
      { id: 'read-map', version: String(READ_MAP) },
      { id: 'job', version: jobFingerprint(row) },
    ],
  })
  const { run, receipt } = ctx
  // The key and the commits it read are on the receipt from the start, so a
  // run that fails is still the answer to "what did this try to read".
  receipt.key = key
  receipt.result = { records: [], commit: null, range }
  writeWorkingReceipt(receipt)

  const ask = [
    `=== THE ACCEPTED CHANGE TO ${scene} ===`,
    diff.text,
    'Read what this accepted change establishes that the record should learn. Answer with the proposals array alone.',
  ].join('\n\n')
  const brief = {
    blocks: [
      { id: 'rules', text: row.rules, cached: true },
      { id: 'slice', text: sliceText, cached: true },
      { id: 'ask', text: ask, cached: false },
    ],
  }

  const sandbox = new Sandbox(run.id)
  const taken = takenIds()
  const relFile = path.join(STORY, 'canon', 'relationships.yaml')
  const bctx: BuildContext = {
    scene, era, taken, entities: entities.map(e => ({ id: e.id, type: e.type })),
    sceneSpan: live.span,
    // the brief's own rule: no run of eight of the scene's words enters the record
    copiesScene: text => leaks(text, { text: [after], allowed: [], spanWords: ROUTE_WITHHELD.spanWords }).length > 0,
    ...(fs.existsSync(relFile) ? { relationshipsText: fs.readFileSync(relFile, 'utf8') } : {}),
  }
  const proposals: ProposalGateCtx = {
    evidence: diff.citable,
    refused: refusedKeys(entities, canon),
    keyOf: proposalKey,
    // Two halves, both proven: a name that is already some other kind of
    // thing, and — for a record about what the book already holds — whatever
    // arc-core's continuity checks say anew with that record in the book.
    conflict: p => {
      const named = provenConflict(p, entities)
      if (named) return { message: named, by: CONFLICT_BY_NAMES }
      if (p.subject === 'new' || p.class === 'retracted') return null
      const cand = buildCandidate(p, bctx)
      const found = cand.ok ? continuityConflict(canon as unknown as CanonDoc, cand, p) : null
      return found ? { message: found, by: CONFLICT_BY_CHECKS } : null
    },
    validate: p => {
      if (p.class === 'retracted') {
        return p.subject !== 'new' && entities.some(e => e.id === p.subject)
          ? { ok: true, output: 'nothing is written for a retraction' }
          : { ok: false, output: 'a retraction names a record that is not there', sentence: 'it names a record your book does not hold' }
      }
      const cand = buildCandidate(p, bctx)
      if (!cand.ok) return { ok: false, output: cand.why, sentence: cand.why }
      const r = sandbox.check(cand.collection
        ? [{ rel: cand.file, edge: cand.record }]
        : [{ rel: cand.file, text: canonYaml(cand.record) }, ...(cand.article ? [{ rel: cand.article.file, text: cand.article.text }] : [])])
      return r.ok ? r : { ...r, sentence: 'the record it would become does not fit the rest of your story' }
    },
  }
  const gateCtx = {
    ...gateCtxOf({
      sceneName: scene, sceneBody: after, sceneLocks: [], lockedTexts: [],
      literals: literalWithholds(live.contract?.must_withhold), andCap: null, wordCap: null, destination: [], known: [],
    }),
    proposals,
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

    const answer = (r: Partial<UpdateRecordResponse>, reply: string): UpdateRecordResponse =>
      ({ scene, run: run.id, proposed: 0, dropped: 0, refused: 0, filed: [], reply, ...r })

    if (stateOf(run.id) === 'cancelled') {
      closeReceipt(ctx, 'cancelled'); endRun(run.id, 'cancelled', { stopped: scene })
      return answer({}, outcomeSentence({ ending: 'cancelled', gates: receipt.gates }) ?? 'you stopped it before it had anything to say.')
    }
    if (!out.ok) {
      const ending = endingOf([{ kind: out.kind, gateRefused: out.gateRefused, unreadable: out.unreadable }], false)
      closeReceipt(ctx, ending); endRun(run.id, ending, { refused: out.reason })
      return answer({}, outcomeSentence({ ending, gates: receipt.gates }) ?? out.reason)
    }

    const read = JSON.parse(out.checked.body) as { proposals: Proposal[]; dropped: { gate: string; claim: string; why: string }[] }
    const refusedCount = read.dropped.filter(d => d.gate === 'duplicate').length
    const droppedCount = read.dropped.length - refusedCount

    // FILING, in §4's landing order, one proposal at a time: the origin in
    // the ledger first, the canon file last. A file that does not validate is
    // taken back out and counted; the origin that names it then reads as
    // nothing (`proposalOrigins` omits an entry whose file is gone).
    const filed: UpdateRecordResponse['filed'] = []
    let reverted = 0
    const trimmedCounts = new Map<string, number>()
    const baseline = validateStory()
    let superseded = false
    // IN THE LANE (A72-2): canon, articles and ledger lines are mutations of
    // the story, and the author's own save or accept must not interleave with
    // them. The loop is synchronous — the model has already answered.
    inLane('file proposals', tx => {
      // THE KEY IS CHECKED HERE, inside the lane and before anything is filed:
      // two runs with one key never both file, however they overlapped while
      // the model was answering (A74-3).
      if (!opts.rerun && landedByKey(key, run.id)) { superseded = true; return }
      for (const p of read.proposals) {
        const conflicts = {
          ...(p.proven_conflict ? { proven_conflict: p.proven_conflict } : {}),
          ...(p.conflicts_with ? { argued_conflict: p.conflicts_with } : {}),
        }
        const origin = {
          origin: 'update-record' as const, scene, run: run.id, type: p.type, class: p.class,
          key: proposalKey(p), range, evidence: p.evidence.map(e => evidenceId(e)!).filter(Boolean), ...conflicts,
        }
        if (p.class === 'retracted') {
          const file = fileOfRecord(p.subject)
          if (!file) { reverted++; continue }
          recordProposalOrigin({ ...origin, file, canon: p.subject })
          filed.push({ id: p.subject, type: p.type, class: p.class, name: p.value, retracts: true, ...(p.conflicts_with ? { argued_conflict: p.conflicts_with } : {}) })
          continue
        }
        const cand = buildCandidate(p, bctx)
        if (!cand.ok) { reverted++; continue }
        taken.add(cand.id)
        const abs = path.join(STORY, cand.file)
        const articleAbs = cand.article ? path.join(STORY, cand.article.file) : null
        // AN EXISTING RECORD IS ONLY EVER ADDED TO (A74-12). What this is
        // about is named in the origin; the edge it sits beside, when there is one,
        // too. A relationship joins the end of canon/relationships.yaml and
        // nothing already in the file is touched.
        const about = p.subject !== 'new' ? { about: p.subject } : {}
        const beside = cand.collection ? besideEdge(canon.relationships ?? [], cand.record) : null
        const detail = { ...about, ...(beside ? { beside } : {}) }
        const grown = cand.collection ? withEdge(fs.readFileSync(abs, 'utf8'), cand.record) : null
        if (cand.collection && grown === null) { reverted++; continue }
        // BOTH PATHS FREE, BEFORE ANY ORIGIN: an origin written for a write
        // that never happens would come back to life if the author later
        // made a file at that path.
        if (!cand.collection && (fs.existsSync(abs) || (articleAbs && fs.existsSync(articleAbs)))) { reverted++; continue }
        recordProposalOrigin({ ...origin, ...detail, type: cand.collection ? 'relationship' : p.type, file: cand.file, canon: cand.id })
        tx.keep(...(articleAbs ? [abs, articleAbs] : [abs]))
        const original = cand.collection ? fs.readFileSync(abs) : null
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        if (cand.collection) fs.writeFileSync(abs, grown!)
        else fs.writeFileSync(abs, canonYaml(cand.record))
        if (cand.article && articleAbs) {
          fs.mkdirSync(path.dirname(articleAbs), { recursive: true })
          fs.writeFileSync(articleAbs, cand.article.text)
        }
        const check = addsNothing(baseline, validateStory())
        if (!check.ok) {
          if (original) fs.writeFileSync(abs, original); else fs.rmSync(abs, { force: true })
          if (articleAbs) fs.rmSync(articleAbs, { force: true })
          // A TOMBSTONE, so the origin stays dead whatever the path does later
          recordProposalOrigin({ origin: 'update-record', scene, run: run.id, canon: cand.id, file: cand.file, reverted: true })
          reverted++
          continue
        }
        invalidateCanon()
        for (const t of cand.trimmed ?? []) trimmedCounts.set(t, (trimmedCounts.get(t) ?? 0) + 1)
        filed.push({ id: cand.id, type: p.type, class: p.class, name: p.value, ...detail, ...conflicts })
      }
    })

    if (superseded) {
      closeReceipt(ctx, 'cancelled'); endRun(run.id, 'cancelled', { read: scene, already: true })
      return answer({ nothingNew: true }, 'arc has already read everything you accepted to this scene, so there is nothing new to add to your record.')
    }

    // THE RECEIPT COUNTS what was proposed, dropped and refused, and lists
    // what was filed; the gates' own records are already on it.
    const byGate = new Map<string, number>()
    for (const d of read.dropped) {
      // A proposal that would alter a record that already exists (it has no
      // record of its own) is its own reason, counted apart.
      const reason = d.gate === 'validator' && d.why.startsWith(EXISTING_RECORD_WHY) ? 'existing-record'
        : d.gate === 'validator' && d.why === UNSAFE_APPEND_WHY ? 'relationships-file'
          : d.gate
      byGate.set(reason, (byGate.get(reason) ?? 0) + 1)
    }
    if (reverted) byGate.set('filing', reverted)
    // what building left out of a record that WAS filed: a date the scene does not bear out, a note that copied the scene
    for (const [t, n] of trimmedCounts) byGate.set(t, n)
    receipt.evidence = {
      returned: read.proposals.length,
      dropped: [...byGate].map(([reason, count]) => ({ reason, count })),
    }
    receipt.result = { records: filed.map(f => f.id), commit: null, range }
    writeWorkingReceipt(receipt)
    closeReceipt(ctx, 'landed')
    // A LANDED TRIGGERED RUN JOINS THE RECORD when it lands (epic D10): no
    // author's decision gates it, and the review episode reads what has been
    // read from history/, not from the disposable .arc/.
    // and is COMMITTED, in its own records commit through the lane: nothing
    // tracked is left dirty, and the receipt is the record the next episode
    // reads (commitRecords never fails the read).
    try {
      const file = writeReceipt(receipt)
      commitRecords(`Record: the receipt for a read of ${range.to.slice(0, 7)}`, [file])
    } catch (e) { console.error('[error] could not write the receipt of a landed read to history/:', e) }
    endRun(run.id, 'landed', { read: scene, proposed: filed.length, dropped: droppedCount, refused: refusedCount + reverted })
    return answer({ proposed: filed.length, dropped: droppedCount, refused: refusedCount + reverted, filed },
      updateRecordReply(filed.length, droppedCount, refusedCount + reverted))
  } catch (e) {
    // A RUN THAT THROWS AFTER ITS RECEIPT IS KEYED must still end: left open
    // it would read as unfinished and be started again by every trigger.
    // The first ending wins, so a run that already ended keeps its own.
    closeReceipt(ctx, 'could not run'); endRun(run.id, 'could not run', { failed: scene })
    throw e
  } finally {
    sandbox.close()
  }
}
