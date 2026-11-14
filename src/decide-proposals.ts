// THE AUTHOR'S WORD ON A PROPOSED RECORD (A74-4): approve it, or never.
//
// A proposal is a canon record with `status: proposed` (conventions §5), so
// deciding it is one of two edits to the record and nothing else:
//
//  · APPROVE changes the one status field, as text. An item in a shared list
//    (canon/relationships.yaml, canon/chapters.yaml) is edited on its own
//    `- id:` line and block — never a YAML round-trip, which would reformat
//    the author's ratified items and their comments.
//  · NEVER takes the record out: the file, or exactly its block in a shared
//    list, and — only when arc wrote it and the author has not touched it —
//    the docs article that came with a new entity. The key it was proposed
//    under is written to the evidence log, which is where the duplicate gate
//    reads what the author has declined.
//
// Both run in the commit lane as ONE transaction that validates the whole
// batch, writes the decisions, stamps the proposing run's receipt and makes
// ONE commit of exactly those files. `later` is not here: it is the viewer's
// hide-for-the-session, and a record of not-now would be a second queue.
//
// LOCKS. A lock anchors prose (arc-core/schema/lock.schema.json); no canon
// record can be locked, so the lock check is not applicable to a decision on
// one, and says so on the receipt rather than staying silent.
import fs from 'node:fs'
import path from 'node:path'
import { load as yamlLoad } from 'js-yaml'
import { STORY } from './config'
import { HttpError } from './http'
import { git, inLane } from './lane'
import { addsNothing } from './update-record'
import { invalidateCanon, validateStory } from './canon'
import { appendProposalDecision, EVIDENCE_REL, readProposalDecisions } from './evidence'
import { proposalOrigins, retractionOrigins, type LedgerEntry } from './ledger'
import { proposalKey } from './proposals'
import { editRefusal, landedThenFailed } from './refusal'
import { readRecordReceipt, readWorkingReceipt, setReceiptCommit, writeReceipt, type GateRecord, type Receipt } from './run'
import { listFiles, storyRevision } from './records'
import { commitRecords, proseScenes } from './story'
import type { DecideProposalsResponse } from 'arc-canon-graph'

export type ProposalAction = 'approve' | 'never'

// ---- text edits (pure) -----------------------------------------------------------

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const STATUS = /^([ \t]*(?:-[ \t]+)?status:[ \t]*)(["']?)proposed\2([ \t]*(?:#.*)?)$/

/** Where the item `- id: <id>` sits in a list file: its lines [start, end)
 *  (trailing blank lines are not part of it), the column its keys start at,
 *  and the list's top-level key. Null when the id is not an item there. */
export function itemRange(lines: string[], id: string): { start: number; end: number; keyCol: number; listKey: number } | null {
  const head = new RegExp(`^([ \\t]*)(-[ \\t]+)id:[ \\t]*(["']?)${esc(id)}\\3[ \\t]*(#.*)?$`)
  const start = lines.findIndex(l => head.test(l))
  if (start < 0) return null
  const m = head.exec(lines[start])!
  const dash = m[1].length
  let end = start + 1
  while (end < lines.length && (lines[end].trim() === '' || lines[end].search(/\S/) > dash)) end++
  while (end > start + 1 && lines[end - 1].trim() === '') end--
  let listKey = start - 1
  while (listKey >= 0 && !/^[A-Za-z_][\w-]*:[ \t]*(#.*)?$/.test(lines[listKey])) listKey--
  return { start, end, keyCol: dash + m[2].length, listKey }
}

/** `status: proposed` → `status: canon` on one item's own status line, and on
 *  nothing else. Null when the item has no such line at its own level. */
export function approveItem(text: string, id: string): string | null {
  const lines = text.split('\n')
  const r = itemRange(lines, id)
  if (!r) return null
  for (let i = r.start; i < r.end; i++) {
    const m = STATUS.exec(lines[i])
    if (m && lines[i].search(/\S/) === r.keyCol) {
      lines[i] = `${m[1]}canon${m[3]}`
      return lines.join('\n')
    }
  }
  return null
}

/** The item's block taken out, with the one blank line that separates it from
 *  what came before. Every other byte stays. A list left with no item is
 *  written back as `key: []`. Null when the id is not an item here. */
export function removeItem(text: string, id: string): string | null {
  const lines = text.split('\n')
  const r = itemRange(lines, id)
  if (!r) return null
  const from = r.start > 0 && lines[r.start - 1].trim() === '' && r.start - 1 > r.listKey ? r.start - 1 : r.start
  lines.splice(from, r.end - from)
  if (r.listKey >= 0) {
    let next = r.listKey + 1
    while (next < lines.length && !/^[A-Za-z_][\w-]*:/.test(lines[next])) next++
    if (!lines.slice(r.listKey + 1, next).some(l => /^[ \t]*-[ \t]/.test(l))) {
      const k = /^([A-Za-z_][\w-]*):([ \t]*)(#.*)?$/.exec(lines[r.listKey])!
      lines[r.listKey] = `${k[1]}: []${k[3] ? ` ${k[3]}` : ''}`
    }
  }
  return lines.join('\n')
}

/** `status: proposed` at the top level of a file that is one record. */
export function approveFile(text: string): string | null {
  const re = /^status:([ \t]*)(["']?)proposed\2([ \t]*(?:#.*)?)$/m
  return re.test(text) ? text.replace(re, (_m, sp: string, _q: string, tail: string) => `status:${sp}canon${tail}`) : null
}

/** The item's block (its lines) as the file holds it, or null. */
export function itemBlock(text: string, id: string): string[] | null {
  const lines = text.split('\n')
  const r = itemRange(lines, id)
  return r ? lines.slice(r.start, r.end) : null
}

/** Is `- id: <id>` an item of this text? ONE definition (`itemRange`), so a
 *  trailing comment on the line cannot make an item invisible to one reader
 *  and visible to another. */
export const holdsItem = (text: string, id: string): boolean => itemRange(text.split('\n'), id) !== null

/** An item added to the end of a list the book already holds: the blank line
 *  and the block, the way arc appends an edge. A list written `key: []` is
 *  opened. Null when the list is not there to add to. */
export function addItem(text: string, listKey: string, block: string[]): string | null {
  const key = new RegExp(`^${esc(listKey)}:[ \\t]*(\\[\\s*\\])?[ \\t]*(#.*)?$`, 'm').exec(text)
  if (!key) return null
  if (key[1]) return text.replace(key[0], () => `${listKey}:${key[2] ? ` ${key[2]}` : ''}\n${block.join('\n')}`)
  return `${text}${text.endsWith('\n') ? '' : '\n'}\n${block.join('\n')}\n`
}

/** The list key an item sits under. */
export function listKeyOf(text: string, id: string): string | null {
  const lines = text.split('\n')
  const r = itemRange(lines, id)
  return r && r.listKey >= 0 ? lines[r.listKey].split(':')[0] : null
}

/** The line arc put in a new entity's article, taken out — and the blank line
 *  after it — when the author approves the entity. Nothing else changes. */
export function dropProposedLine(text: string): string | null {
  const lines = text.split('\n')
  const at = lines.findIndex(l => l.startsWith(PROPOSED_LINE))
  if (at < 0) return null
  lines.splice(at, lines[at + 1]?.trim() === '' ? 2 : 1)
  return lines.join('\n')
}
const PROPOSED_LINE = '> **Proposed, not canon.**'

// ---- reading the record --------------------------------------------------------

interface Found {
  id: string
  /** story-relative */
  file: string
  /** an item in a shared list, rather than a file of its own */
  listed: boolean
  obj: Record<string, unknown>
}

/** Every record under canon/, by id, read from the files (not the export,
 *  which may be mid-edit). */
function canonRecords(): Map<string, Found> {
  const out = new Map<string, Found>()
  for (const rel of listFiles('canon')) {
    if (!rel.endsWith('.yaml')) continue
    let doc: unknown
    try { doc = yamlLoad(fs.readFileSync(path.join(STORY, rel), 'utf8')) } catch { continue }
    if (!doc || typeof doc !== 'object') continue
    const top = doc as Record<string, unknown>
    if (typeof top.id === 'string') { out.set(top.id, { id: top.id, file: rel, listed: false, obj: top }); continue }
    for (const v of Object.values(top)) {
      if (!Array.isArray(v)) continue
      for (const m of v) {
        const o = m as Record<string, unknown> | null
        if (o && typeof o === 'object' && typeof o.id === 'string') out.set(o.id, { id: o.id, file: rel, listed: true, obj: o })
      }
    }
  }
  return out
}

const nameOf = (f: Found): string => {
  const o = f.obj
  return typeof o.name === 'string' && o.name ? o.name : typeof o.title === 'string' && o.title ? o.title : f.id
}

/** The keys a record answers to, built by the same function the duplicate
 *  gate uses. An event is keyed once per participant, as the gate keys the
 *  events the book holds (`recordKeys`). The origin's own key, when there is
 *  one, always comes first. */
function keysOfRecord(f: Found, origin: LedgerEntry | undefined): string[] {
  const o = f.obj
  const type = typeof o.type === 'string' ? o.type : 'record'
  const own: string[] = []
  if (type === 'relationship') own.push(proposalKey({ subject: String(o.from ?? f.id), type, field: String(o.kind ?? ''), value: String(o.to ?? '') }))
  else if (type === 'event') {
    const who = ((o.participants as { entity?: string }[] | undefined) ?? []).map(q => q.entity).filter((x): x is string => !!x)
    for (const e of who.length ? who : [f.id]) own.push(proposalKey({ subject: e, type, field: 'event', value: nameOf(f) }))
  } else own.push(proposalKey({ subject: 'new', type, field: 'name', value: nameOf(f) }))
  return [...new Set([...(origin?.key ? [origin.key] : []), ...own])]
}

/** The docs article that goes with an entity, and whether it is still only
 *  the stub arc wrote (front matter naming the record and the proposed line)
 *  or a page the book has made its own. */
function articleOf(f: Found): { rel: string; stub: boolean } | null {
  const m = /^canon\/entities\/([^/]+)\/([^/]+)\.yaml$/.exec(f.file)
  if (f.listed || !m) return null
  const rel = `docs/entities/${m[1]}/${m[2]}.md`
  try {
    const text = fs.readFileSync(path.join(STORY, rel), 'utf8')
    return { rel, stub: text.includes(`canon: ${f.id}\n`) && text.includes(PROPOSED_LINE) }
  } catch { return null }
}

// ---- the sentences the author reads ------------------------------------------------

const WORD = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
const count = (n: number): string => WORD[n] ?? String(n)
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
const facts = (n: number): string => `${count(n)} ${n === 1 ? 'fact' : 'facts'}`

/** A scene as the author knows it: its place in its chapter, and the chapter's
 *  title. Null when the chapter has no title to name it by — never the scene's
 *  id, which is arc's. */
function sceneName(scene: string, records: Map<string, Found>): string | null {
  const all = proseScenes()
  const s = all.find(x => x.scene === scene)
  const title = s ? records.get(s.chapter)?.obj.title : undefined
  if (!s || typeof title !== 'string' || !title) return null
  const n = all.filter(x => x.chapter === s.chapter).findIndex(x => x.scene === scene) + 1
  return `scene ${n} of ${title}`
}

/** A scene as the author names it, for any sentence about it (A74-3): its
 *  place in its chapter and the chapter's title — "scene 2 of The Light" —
 *  and, when the chapter has no title, only its place. Never an id. */
export function sceneLabel(scene: string): string {
  const named = sceneName(scene, canonRecords())
  if (named) return named
  const all = proseScenes()
  const s = all.find(x => x.scene === scene)
  const n = s ? all.filter(x => x.chapter === s.chapter).findIndex(x => x.scene === scene) + 1 : 0
  return n ? `scene ${n} of its chapter` : 'a scene of your book'
}

/** One sentence naming how many facts and, when they share one, the scene
 *  they were read from. */
function sentenceFor(action: ProposalAction, n: number, from: string): { message: string; reply: string } {
  return action === 'approve'
    ? { message: `${cap(facts(n))}${from} ${n === 1 ? 'is' : 'are'} canon`, reply: `${cap(facts(n))}${from} ${n === 1 ? 'is' : 'are'} in your record now.` }
    : { message: `${cap(facts(n))}${from} ${n === 1 ? 'is' : 'are'} declined and will not be proposed again`, reply: `${cap(facts(n))}${from} ${n === 1 ? 'is' : 'are'} out of your record, and arc will not propose ${n === 1 ? 'it' : 'them'} again.` }
}

const refuse = (status: number, sentence: string): never => { throw new HttpError(status, sentence) }

export const LOCKS_NOT_CHECKED = 'not checked: locks anchor prose, and no canon record can be locked'

// ---- the decision ------------------------------------------------------------------

type Op =
  | { kind: 'approve-item'; id: string }
  | { kind: 'remove-item'; id: string }
  | { kind: 'approve-file' }
  | { kind: 'unstub' }

/** DECIDE A BATCH OF PROPOSED RECORDS. The whole request is refused, with one
 *  sentence and nothing changed, when any id cannot be decided. */
export function decideProposals(rawIds: unknown, rawAction: unknown): DecideProposalsResponse {
  if (rawAction === 'later') refuse(400, 'Later is yours to keep in the viewer — arc only records approve or never.')
  if (rawAction !== 'approve' && rawAction !== 'never') refuse(400, 'arc can approve a proposal or mark it never, and that is neither.')
  const action = rawAction as ProposalAction
  if (!Array.isArray(rawIds) || !rawIds.length || rawIds.some(i => typeof i !== 'string' || !i.trim())) {
    refuse(400, 'Say which proposals you mean, and arc will decide them.')
  }
  const ids = [...new Set((rawIds as string[]).map(i => i.trim()))]

  const records = canonRecords()
  const decided = new Set(readProposalDecisions().map(d => d.id))
  const retracted = new Set(retractionOrigins().map(o => o.canon))
  const origins = new Map<string, LedgerEntry>()
  for (const o of proposalOrigins()) if (o.canon) origins.set(o.canon, o)

  const picked: { f: Found; origin: LedgerEntry | undefined }[] = []
  for (const id of ids) {
    const f = records.get(id)
    if (!f) refuse(404, `One of those facts is no longer waiting in your record — it may already be decided. arc changed nothing; open the list again to see what is left.`)
    const found = f as Found
    if (decided.has(id)) refuse(409, `You have already decided on ${nameOf(found)}, so arc changed nothing.`)
    if (found.obj.status !== 'proposed') {
      refuse(409, retracted.has(id)
        ? `arc suggested that ${nameOf(found)} no longer holds, but it has removed nothing — the fact stays until you edit it yourself.`
        : `${cap(nameOf(found))} is not waiting for your decision, so arc changed nothing.`)
    }
    // a page the book has made its own is not arc's to delete with the record
    if (action === 'never' && articleOf(found) && !articleOf(found)!.stub) {
      refuse(409, `${cap(nameOf(found))} still has its own page in the book — remove it first, then decline it.`)
    }
    picked.push({ f: found, origin: origins.get(id) })
  }
  // A CONFLICT IS DECIDED ON ITS OWN (D13): enforced here, not only by the
  // viewer's button — a batch holding a record whose origin carries a conflict
  // arc found or the reading argued is refused; the one record alone is not.
  if (action === 'approve' && picked.length > 1) {
    const held = picked.find(p => p.origin?.proven_conflict || p.origin?.argued_conflict)
    if (held) refuse(409, `${cap(nameOf(held.f))} has a conflict arc found — decide it on its own.`)
  }

  // A FACT IS NOT CANON BEFORE WHAT IT IS ABOUT: an approved edge or event
  // that names a record the book does not hold yet, and that is not approved
  // in this same request, would commit a book that fails its own check.
  if (action === 'approve') {
    const pre = git('rev-parse', '--show-prefix').trim()
    const inBook = (f: Found): boolean => {
      let text: string
      try { text = git('show', `HEAD:${pre}${f.file}`) } catch { return false }
      return f.listed ? holdsItem(text, f.id) : true
    }
    const batch = new Set(picked.map(p => p.f.id))
    for (const { f } of picked) {
      const o = f.obj
      const about = f.obj.type === 'relationship' ? [o.from, o.to]
        : f.obj.type === 'event' ? [...((o.participants as { entity?: string }[] | undefined) ?? []).map(q => q.entity), o.where]
          : []
      for (const ref of about) {
        const r = typeof ref === 'string' && !batch.has(ref) ? records.get(ref) : undefined
        if (r && !inBook(r)) refuse(409, `Approve ${nameOf(r)} first, or together with this — it is what this fact is about.`)
      }
    }
  }

  const message = (() => {
    const scenes = [...new Set(picked.map(p => p.origin?.scene).filter((s): s is string => !!s))]
    const named = scenes.length === 1 ? sceneName(scenes[0], records) : null
    return sentenceFor(action, picked.length, scenes.length > 1 ? ` from ${count(scenes.length)} scenes` : named ? ` from ${named}` : '')
  })()

  const baseline = validateStory()
  const { done, receipts, runs, failed } = inLane('deciding on proposed records', tx => {
    const prefix = git('rev-parse', '--show-prefix').trim()
    const held = (rel: string): string | null => { try { return git('show', `HEAD:${prefix}${rel}`) } catch { return null } }

    // WHAT EACH FILE NEEDS DONE TO IT, then done twice: to the working file
    // (which keeps the author's uncommitted words) and to HEAD's text (which
    // is all that lands), so one decision commits its own delta and no more.
    const ops = new Map<string, Op[]>()
    const add = (rel: string, op: Op): void => { ops.set(rel, [...(ops.get(rel) ?? []), op]) }
    const deleted: string[] = []
    for (const { f } of picked) {
      if (action === 'approve') {
        add(f.file, f.listed ? { kind: 'approve-item', id: f.id } : { kind: 'approve-file' })
        const art = articleOf(f)
        if (art?.stub) add(art.rel, { kind: 'unstub' })
      } else if (f.listed) add(f.file, { kind: 'remove-item', id: f.id })
      else {
        deleted.push(f.file)
        const art = articleOf(f)
        if (art) deleted.push(art.rel)
      }
    }

    const apply = (text: string, op: Op): string | null =>
      op.kind === 'approve-item' ? approveItem(text, op.id)
        : op.kind === 'remove-item' ? removeItem(text, op.id)
          : op.kind === 'approve-file' ? approveFile(text)
            : dropProposedLine(text)

    const full = new Map<string, string>()       // rel → the working file after the edits
    const lands = new Map<string, string>()      // rel → what HEAD becomes
    for (const [rel, list] of ops) {
      const abs = path.join(STORY, rel)
      tx.keep(abs)
      let text = fs.readFileSync(abs, 'utf8')
      let book = held(rel)
      for (const op of list) {
        const before = text
        const next = apply(text, op)
        if (next === null) refuse(409, `arc could not change ${rel.includes('/') ? 'that record' : 'your file'} without rewriting more of it than the one line, so it left everything as it was. Change it by hand.`)
        text = next as string
        if (book === null) continue
        // the same edit to what the book holds; an item the book does not
        // hold yet joins it whole, as the block the working file has
        let landed = apply(book, op)
        if (landed === null && op.kind === 'approve-item') {
          const block = itemBlock(text, op.id), key = listKeyOf(before, op.id)
          landed = block && key ? addItem(book, key, block) : null
        }
        if (landed === null && op.kind === 'approve-item') refuse(409, `arc could not add that record to your file without rewriting more of it than the one item, so it left everything as it was. Change it by hand.`)
        book = landed ?? book
      }
      full.set(rel, text)
      fs.writeFileSync(abs, text); tx.wrote(abs, text)
      if (book !== null && book !== held(rel)) lands.set(rel, book)
      else if (book === null) lands.set(rel, text)
    }
    for (const rel of deleted) { const abs = path.join(STORY, rel); tx.keep(abs); fs.rmSync(abs, { force: true }) }

    // VALIDATE-OR-REVERT, whole batch: a record the book now does not fit
    // refuses all of it, and the lane puts every file back.
    invalidateCanon()
    const check = addsNothing(baseline, validateStory())
    if (!check.ok) refuse(409, cap(editRefusal(check.output)))

    // the author's word, on the record — one line per key a record answers to
    tx.keep(path.join(STORY, EVIDENCE_REL))
    for (const { f, origin } of picked) {
      for (const key of keysOfRecord(f, origin)) {
        appendProposalDecision({
          id: f.id, class: origin?.class ?? null, key, scene: origin?.scene ?? null, run: origin?.run ?? null,
          verdict: action === 'approve' ? 'approved' : 'never', locks: LOCKS_NOT_CHECKED,
        })
      }
    }

    // the proposing run's receipt: the decision on it and the lock check that
    // did not apply. Its commit is stamped AFTER this commit, as the accept's is.
    const runs = [...new Set(picked.map(p => p.origin?.run).filter((r): r is string => !!r))]
    const receipts: string[] = []
    for (const run of runs) {
      const base: Receipt | null = readRecordReceipt(run) ?? readWorkingReceipt(run)
      if (!base) continue
      const rel = path.join('history', `${run}.yaml`)
      tx.keep(path.join(STORY, rel))
      const mine = picked.filter(p => p.origin?.run === run).map(p => p.f.id)
      const earlier = base.author_decision?.note
      const note = `${action === 'approve' ? 'approved' : 'never'} ${mine.join(', ')}`
      const lockGate: GateRecord = {
        gate: 'locks', verdict: 'not applicable', bar_from: LOCKS_NOT_CHECKED,
        attempt: 1, launch: 'decision', stage: 'write',
      }
      writeReceipt({
        ...base,
        decided_at: new Date().toISOString(),
        story_revision_at_decision: storyRevision(),
        author_decision: { decision: action === 'approve' ? 'accepted' : 'rejected', note: earlier ? `${earlier}; ${note}` : note },
        gates: [...(base.gates ?? []).filter(g => !(g.gate === 'locks' && g.launch === 'decision')), lockGate],
        result: { ...base.result, commit: null },
      })
      receipts.push(rel)
    }

    // WHAT LANDS: HEAD's text with this decision's edit, where the book holds
    // the file; the working file goes back afterwards.
    const putBack: [string, string][] = []
    const land: string[] = []
    for (const [rel, text] of lands) {
      const abs = path.join(STORY, rel)
      if (text !== full.get(rel)) { fs.writeFileSync(abs, text); tx.wrote(abs, text); putBack.push([abs, full.get(rel)!]) }
      land.push(rel)
    }
    for (const rel of deleted) if (held(rel) !== null) land.push(rel)
    if (tx.stageAppended(EVIDENCE_REL)) land.push(EVIDENCE_REL)
    land.push(...receipts)
    const files = [...new Set(land)]
    tx.stage(files.filter(r => r !== EVIDENCE_REL), { all: true })
    tx.commit(message.message, files)
    // the author's other words, and the other proposals still waiting, go back
    const failed: string[] = []
    for (const [abs, text] of putBack) { try { fs.writeFileSync(abs, text) } catch (e) { failed.push(abs); console.error(`[proposals] could not put ${abs} back:`, e) } }
    return { done: git('rev-parse', '--short', 'HEAD').trim(), receipts, runs, failed }
  })
  invalidateCanon()

  // THE RECEIPTS JOIN THE RECORD behind the commit whose hash they now name
  // (the accept's own order: the decision, then the hash, then the records).
  for (const run of runs) setReceiptCommit(run, done)
  if (receipts.length) commitRecords(`Record: ${receipts.length === 1 ? 'the receipt' : `${receipts.length} receipts`} for ${done}`, receipts)
  if (failed.length) throw new HttpError(500, landedThenFailed('the other proposals waiting in your files could not be put back as they were — look at them before you go on'))

  return {
    action,
    decided: picked.map(({ f, origin }) => ({
      id: f.id, type: typeof f.obj.type === 'string' ? f.obj.type : 'record', name: nameOf(f),
      class: origin?.class ?? null, scene: origin?.scene ?? null,
    })),
    commit: done,
    reply: message.reply,
  }
}
