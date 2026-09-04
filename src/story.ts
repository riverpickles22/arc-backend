// The story's presentation layer: view.yaml and the assets/ directory.
//
// These are deliberately not canon — they say how the story is *drawn*, not
// what is true about it — so they live outside canon/ and are served straight
// through rather than going near the validator. They live in the story repo
// rather than the viewer so arc-frontend stays story-agnostic.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { load as yamlLoad } from 'js-yaml'
import type { AlignedParagraph, AlignedSentence, DocArticle, MaterialItem, ProseChange, ProseDraft, ProseScene, SceneContract } from 'arc-canon-graph'
// The sentence rule and the alignment under it, shared with the viewer so the
// side that names a sentence and the side that acts on it cannot disagree.
import { alignParagraphs, alignSentences, mainInsertionPoint, splitSentences } from 'arc-canon-graph'
import { clearGenerated, generatedFor } from './ledger'
import { EVIDENCE_REL, clearBaseline, counterpartOf, pinBaseline, recordJudgment, type Granularity, type Verdict } from './evidence'
import { STORY } from './config'
import { HttpError } from './http'
import { assertUnlocked, locksOn } from './locks'
import { resolveWithin } from './safe-path'
import { canonicalYaml } from './agent'
import { validateStory } from './canon'

// The wire types live in arc-canon-graph (graph/api-types.ts) — one source
// of truth shared with the frontend. Re-exported so importers of this
// module keep working.
export type { DocArticle, ProseChange, ProseDraft, ProseScene, SceneContract }

const ASSETS = path.join(STORY, 'assets')

const CONTENT_TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.geojson': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

/** view.yaml as a plain object, or {} when the story doesn't have one. */
export function viewConfig(): unknown {
  const p = path.join(STORY, 'view.yaml')
  if (!fs.existsSync(p)) return {}
  return yamlLoad(fs.readFileSync(p, 'utf8')) ?? {}
}

const FM_RE = /^---\n([\s\S]*?)\n---\n?/

function mdFiles(root: string): string[] {
  if (!fs.existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name)
      if (fs.statSync(abs).isDirectory()) walk(abs)
      else if (name.endsWith('.md')) out.push(abs)
    }
  }
  walk(root)
  return out
}

/** Every docs/ article, with its canon binding when the frontmatter has one.
 *  The corpus is small (dozens of files) — read fresh, no cache to invalidate. */
export function docsArticles(): DocArticle[] {
  const root = path.join(STORY, 'docs')
  return mdFiles(root).map(abs => {
    const text = fs.readFileSync(abs, 'utf8')
    const fm = text.match(FM_RE)
    const meta = fm ? ((yamlLoad(fm[1]) ?? {}) as Record<string, unknown>) : {}
    return {
      path: path.relative(STORY, abs),
      canon: typeof meta.canon === 'string' ? meta.canon : null,
      body: fm ? text.slice(fm[0].length) : text,
    }
  })
}

/** Parse one scene file (conventions §10). Files without scene frontmatter
 *  (READMEs, loose drafts) are not part of the manuscript. */
export function parseScene(text: string, file: string): ProseScene | null {
  const fm = text.match(FM_RE)
  if (!fm) return null
  const meta = (yamlLoad(fm[1]) ?? {}) as Record<string, unknown>
  if (typeof meta.scene !== 'string') return null
  return {
    scene: meta.scene,
    chapter: String(meta.chapter ?? ''),
    status: String(meta.status ?? 'proposed'),
    pov: typeof meta.pov === 'string' ? meta.pov : null,
    events: Array.isArray(meta.events) ? meta.events.map(String) : [],
    facts: Array.isArray(meta.facts) ? meta.facts.map(String) : [],
    contract: meta.contract && typeof meta.contract === 'object' ? (meta.contract as SceneContract) : null,
    file,
    body: text.slice(fm[0].length),
  }
}

/** Every bound scene in prose/ — the working tree, i.e. the draft layer. */
export function proseScenes(): ProseScene[] {
  const out: ProseScene[] = []
  for (const abs of mdFiles(path.join(STORY, 'prose'))) {
    const scene = parseScene(fs.readFileSync(abs, 'utf8'), path.relative(STORY, abs))
    if (scene) out.push(scene)
  }
  return out
}

/** Story material (conventions §12): the unplaced layer, read fresh like
 *  docs and prose — the corpus is small by nature. */
export function materialItems(): MaterialItem[] {
  const root = path.join(STORY, 'material')
  if (!fs.existsSync(root)) return []
  const out: MaterialItem[] = []
  for (const name of fs.readdirSync(root).sort()) {
    if (!name.endsWith('.yaml')) continue
    const item = yamlLoad(fs.readFileSync(path.join(root, name), 'utf8')) as MaterialItem | null
    if (item && typeof item.id === 'string') out.push(item)
  }
  return out
}

/** The statuses a material item may hold (conventions §12). */
const MATERIAL_STATUS = ['unplaced', 'placed', 'absorbed', 'dropped'] as const
type MaterialStatus = (typeof MATERIAL_STATUS)[number]

/** Correct a filed thought, or change where it sits in its lifecycle.
 *
 *  Arc files a thought in its OWN words, and sometimes reads it slightly
 *  wrong; without this the author's only recourse is opening the YAML in an
 *  editor, which is exactly the errand the capture box exists to remove.
 *
 *  Only `body`, `purpose` and `status` are writable. Type, id and related are
 *  structural: changing them is a canon-shaped act and this path holds no such
 *  authority — the same discipline the material worker's claim enforces.
 *
 *  DROP, NEVER DELETE. A dropped item keeps its file and its id and stops
 *  counting as unplaced: "dropped beats deletion — intent history is story
 *  history" (§12). Restoring it is setting the status back.
 */
export function updateMaterial(
  id: string,
  patch: { body?: string; purpose?: string; status?: string },
): MaterialItem {
  const root = path.join(STORY, 'material')
  if (!fs.existsSync(root)) throw new HttpError(404, 'this story has no material layer yet')

  // Match by the id INSIDE the file rather than trusting the filename to
  // encode it — hand-written material need not follow the minting convention.
  let hit: { abs: string; item: Record<string, unknown> } | null = null
  for (const name of fs.readdirSync(root).sort()) {
    if (!name.endsWith('.yaml')) continue
    const abs = path.join(root, name)
    try {
      const item = yamlLoad(fs.readFileSync(abs, 'utf8')) as Record<string, unknown> | null
      if (item && item.id === id) { hit = { abs, item }; break }
    } catch { /* an unreadable file is not the one we are looking for */ }
  }
  if (!hit) throw new HttpError(404, `no material item ${id}`)

  if (patch.status !== undefined && !MATERIAL_STATUS.includes(patch.status as MaterialStatus)) {
    throw new HttpError(400, `status must be one of ${MATERIAL_STATUS.join(', ')}`)
  }
  if (patch.body !== undefined && !patch.body.trim()) {
    throw new HttpError(400, 'a thought with no body is a deletion — drop it instead')
  }

  const next = { ...hit.item }
  if (patch.body !== undefined) next.body = patch.body.trim()
  if (patch.purpose !== undefined) {
    if (patch.purpose.trim()) next.purpose = patch.purpose.trim()
    else delete next.purpose
  }
  if (patch.status !== undefined) next.status = patch.status

  const prev = fs.readFileSync(hit.abs, 'utf8')
  fs.writeFileSync(hit.abs, canonicalYaml(next))
  if (!validateStory().ok) {
    // The change MIGHT have broken the story — or the story might have been
    // broken already, in which case blaming this edit would lock the author
    // out of their own notes over a fault somewhere else entirely. So put the
    // file back and ask: was it failing before?
    fs.writeFileSync(hit.abs, prev)
    const wasBroken = validateStory()
    if (wasBroken.ok) {
      throw new HttpError(422, `that change does not validate — nothing was written:\n${wasBroken.output}`)
    }
    // Already failing. Not this edit's doing, and not this route's business.
    fs.writeFileSync(hit.abs, canonicalYaml(next))
  }
  return next as unknown as MaterialItem
}

// ---- the draft layer -----------------------------------------------------
//
// Prose has two layers and no new version store: main is the story repo's
// HEAD, the draft is the working tree. Accepting ratifies the draft into
// main as a git commit scoped to prose/ (commit = ratify, the same gate
// canon uses); discarding a file is a surfaced git checkout. A story that
// isn't a git repository simply has no draft layer.

export function git(...args: string[]): string {
  return execFileSync('git', ['-C', STORY, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
}

/** The draft state: every prose file that differs from HEAD, with the main
 *  version of each, plus the ratification history of prose/. */
export function proseDraft(): ProseDraft {
  let prefix: string
  try { prefix = git('rev-parse', '--show-prefix').trim() } catch {
    return { git: false, changes: [], history: [] }
  }

  const changes: ProseChange[] = []
  // -uall: list untracked FILES, not their directory — a scene in a brand-new
  // chapter dir otherwise reports as `?? prose/ch-01/` and vanishes here.
  for (const line of git('status', '--porcelain', '-uall', '--', 'prose').split('\n')) {
    if (!line.trim()) continue
    const xy = line.slice(0, 2)
    let repoRel = line.slice(3).trim()
    if (repoRel.includes(' -> ')) repoRel = repoRel.split(' -> ')[1]   // rename: the new path
    if (!repoRel.endsWith('.md')) continue
    const file = prefix && repoRel.startsWith(prefix) ? repoRel.slice(prefix.length) : repoRel
    const status = xy.includes('?') || xy.includes('A') ? 'added' : xy.includes('D') ? 'deleted' : 'modified'
    let main: ProseScene | null = null
    if (status !== 'added') {
      try { main = parseScene(git('show', `HEAD:${repoRel}`), file) } catch { /* not at HEAD */ }
    }
    // A GHOST is not a change. Accepting normalizes paragraphs into the
    // commit while the finally restores the author's original bytes, so a
    // trailing space could keep a scene "modified" forever with nothing
    // visible to accept — every paragraph 'same', no verdicts, an
    // unacceptable pill. If the working tree and HEAD are identical under
    // the paragraph model (and in frontmatter), there is no change to
    // review, and the draft layer says so by staying silent.
    if (status === 'modified' && main && modelEqual(main, file)) continue
    const change: ProseChange = { file, status, main }
    // Provenance, from the ledger: which pass wrote the pending text and
    // which notes it was handed. A ledger entry whose text is already what
    // HEAD holds was accepted earlier — the pending change is the author's
    // own, and carries nothing. Proven by comparing bodies, never guessed.
    if (status !== 'deleted') {
      const gen = generatedFor(file)
      if (gen?.entry.origin) {
        const wrote = parseScene(gen.content, file)?.body
        const accepted = main !== null && wrote !== undefined && wrote.trim() === main.body.trim()
        if (!accepted) {
          change.origin = gen.entry.origin
          if (gen.entry.notes?.length) change.answers = [...gen.entry.notes]
        }
      }
    }
    changes.push(change)
  }

  let history: ProseDraft['history'] = []
  try {
    history = git('log', '-n', '20', '--pretty=format:%h\t%ad\t%s', '--date=short', '--', 'prose')
      .split('\n').filter(Boolean)
      .map(l => { const [hash, date, ...rest] = l.split('\t'); return { hash, date, subject: rest.join('\t') } })
  } catch { /* no commits yet */ }

  return { git: true, changes, history }
}

/** Ratify the draft into main: stage and commit prose/ only. Anything else
 *  sitting in the story's working tree (canon edits, notes) is untouched. */
export function proseAccept(message?: string): { hash: string; files: string[] } {
  const draft = proseDraft()
  if (!draft.git) throw new HttpError(400, 'this story is not a git repository — there is no draft layer to accept')
  if (!draft.changes.length) throw new HttpError(409, 'no draft changes to accept')
  // THE LOCKS, before anything else — including the evidence log. Settled
  // prose is settled against every write path, and the accept gate was the
  // last one that never asked (A40-3): an author could lock a paragraph and
  // then overwrite it by accepting a stale draft. The check runs before any
  // judgment is recorded, because a decision that never landed must not
  // become style evidence.
  for (const c of draft.changes) {
    if (c.status !== 'modified' || !c.main) continue   // an added scene has no settled text to protect
    let workingBody: string
    try { workingBody = parseScene(fs.readFileSync(path.join(STORY, c.file), 'utf8'), c.file)?.body ?? '' } catch { continue }
    assertUnlocked(c.main.scene, c.main.body, workingBody, 'this accept')
  }

  // One entry per scene, before the commit carries them. Whole-scene
  // granularity is the honest grain here: the author took the file entire, so
  // the pair is arc's draft against what the file now says, and the learning
  // pass does the paragraph arithmetic from there.
  for (const c of draft.changes) {
    const gen = generatedFor(c.file)
    const wrote = gen ? parseScene(gen.content, c.file)?.body ?? gen.content : ''
    let kept = ''
    try { kept = parseScene(fs.readFileSync(path.join(STORY, c.file), 'utf8'), c.file)?.body ?? '' } catch { kept = '' }
    judged(c.file, c.main?.scene ?? null, 'scene', null,
      wrote && wrote.trim() !== kept.trim() ? 'accepted' : 'approved', wrote, kept)
  }

  git('add', '-A', '--', 'prose')
  git('add', '--', EVIDENCE_REL)
  const n = draft.changes.length
  const msg = message?.trim() || `prose: accept draft (${n} scene${n === 1 ? '' : 's'})`
  git('commit', '-m', msg, '--', 'prose', EVIDENCE_REL)
  // The draft is fully judged; the next one starts from wherever the book now
  // stands rather than from a boundary that has moved out from under it.
  for (const c of draft.changes) clearBaseline(c.file)
  return { hash: git('rev-parse', '--short', 'HEAD').trim(), files: draft.changes.map(c => c.file) }
}

/** Write a scene's body back, leaving its frontmatter byte-identical.
 *
 *  The edit lands in the working tree, which IS the draft layer — so it needs
 *  no new gate, no new store, and shows up as an ordinary pending change the
 *  author accepts or discards like any other.
 *
 *  `baseline` is the body the edit started from. arc has no file watcher, so
 *  the viewer cannot know the author also has this scene open in their own
 *  editor; comparing against what they started from is what turns a silent
 *  clobber into a refusal. Whitespace-insensitive, because a trailing newline
 *  is not a conflict.
 */
export function proseWrite(file: string, body: string, baseline?: string): ProseScene {
  if (!file.startsWith('prose/')) throw new HttpError(400, `not a prose file: ${file}`)
  const abs = resolveWithin(path.join(STORY, 'prose'), file.slice('prose/'.length))
  if (!abs.endsWith('.md')) throw new HttpError(400, `not a scene file: ${file}`)
  if (!fs.existsSync(abs)) throw new HttpError(404, `no such scene: ${file}`)

  const before = fs.readFileSync(abs, 'utf8')
  const fm = before.match(FM_RE)
  if (!fm) throw new HttpError(400, `${file} has no scene frontmatter`)

  const current = before.slice(fm[0].length)
  const settle = (t: string) => t.replace(/\r\n/g, '\n').trimEnd()
  if (baseline !== undefined && settle(baseline) !== settle(current)) {
    throw new HttpError(409, `${file} changed underneath this edit — reload the manuscript and reapply it`)
  }

  // Locked prose is settled prose (A29): the choke point is here, not the
  // editor's chrome — a lock only means something if the write path itself
  // refuses, whoever is writing.
  const sceneId = parseScene(before, file)?.scene
  if (sceneId) assertUnlocked(sceneId, current, body, 'this edit')

  const next = fm[0] + (body.endsWith('\n') ? body : body + '\n')
  fs.writeFileSync(abs, next)
  const scene = parseScene(next, file)
  if (!scene) {
    fs.writeFileSync(abs, before)   // the author's words are never the casualty
    throw new HttpError(400, `${file} no longer parses as a scene — reverted`)
  }
  return scene
}

/** A paragraph named the way a sentence already is: which version it belongs
 *  to, and its index into THAT version's own list.
 *
 *  Position alone was never a name. A paragraph index derived from the draft
 *  and applied to main selects a different paragraph the moment the draft
 *  inserts or removes one, and the mistake is silent — the author accepts the
 *  paragraph they are looking at and a different one leaves the book. */
interface ParagraphTarget { side: 'main' | 'draft'; paragraph: number }

/** The two versions of a scene, their paragraphs, and the alignment between
 *  them. Every paragraph verb starts here so they cannot disagree about which
 *  paragraph of main a draft paragraph answers to. */
function paragraphContext(file: string) {
  const draft = proseDraft()
  if (!draft.git) throw new HttpError(400, 'this story is not a git repository — there is no draft layer')
  const change = draft.changes.find(c => c.file === file)
  if (!change) throw new HttpError(404, `no draft change for ${file}`)
  if (change.status !== 'modified' || !change.main) {
    throw new HttpError(400, 'a paragraph can only be judged on a modified scene — take an added or deleted scene whole')
  }
  const abs = resolveWithin(path.join(STORY, 'prose'), file.slice('prose/'.length))
  const working = fs.readFileSync(abs, 'utf8')
  const fm = working.match(FM_RE)
  if (!fm) throw new HttpError(400, `${file} has no scene frontmatter`)

  const split = (body: string) => body.split(/\n{2,}/).map(x => x.trim()).filter(Boolean)
  const draftParas = split(working.slice(fm[0].length))
  const mainParas = split(change.main.body)
  return {
    abs, working, fm: fm[0], draftParas, mainParas,
    scene: change.main.scene,
    aligned: alignParagraphs(mainParas, draftParas),
  }
}

/** Identical under the paragraph model: same frontmatter, same paragraphs
 *  once trimmed and split the way every diff, verdict and lock resolves
 *  them. Whitespace the model cannot see is not a difference the author can
 *  act on. */
function modelEqual(main: ProseScene, file: string): boolean {
  try {
    const raw = fs.readFileSync(resolveWithin(path.join(STORY, 'prose'), file.slice('prose/'.length)), 'utf8')
    const working = parseScene(raw, file)
    if (!working) return false
    const norm = (body: string) => body.split(/\n{2,}/).map(x => x.trim()).filter(Boolean).join('\n\n')
    const fmOf = (text: string, body: string) => text.slice(0, text.length - body.length)
    const headRaw = git('show', `HEAD:${git('rev-parse', '--show-prefix').trim()}${file}`)
    return norm(working.body) === norm(main.body) && fmOf(raw, working.body) === fmOf(headRaw, main.body)
  } catch {
    return false
  }
}

// ---- what the author decided, written down ------------------------------
//
// The generation ledger says what arc wrote. This says what the author did
// about it, and the two together are the only honest argument for a rule
// about their voice. Every verb below files one entry; none of them may fail
// because of it (evidence.ts).

const headSha = (): string | null => {
  try { return git('rev-parse', 'HEAD').trim() } catch { return null }
}

/** Arc's own text for a draft paragraph, or '' when arc wrote nothing there.
 *
 *  The working tree is arc's draft plus whatever the author typed over it, so
 *  the two are aligned rather than assumed equal — an author who rewrote arc's
 *  paragraph before accepting it has produced the most useful pair there is,
 *  and one who accepted it untouched has produced no pair at all. */
function arcSideOf(file: string, draftParas: string[], draftIndex: number): string {
  const gen = generatedFor(file)
  if (!gen) return ''
  const body = parseScene(gen.content, file)?.body ?? gen.content
  const genParas = body.split(/\n{2,}/).map(x => x.trim()).filter(Boolean)
  const hit = alignParagraphs(genParas, draftParas).find(a => a.draftIndex === draftIndex)
  if (!hit) return ''
  if (hit.kind === 'same') return draftParas[draftIndex]
  return hit.mainIndex === null ? '' : genParas[hit.mainIndex]
}

function judged(file: string, scene: string | null, granularity: Granularity,
                paragraph: number | null, verdict: Verdict, arcWrote: string, authorKept: string): void {
  recordJudgment({
    file, scene, granularity, paragraph, verdict, arcWrote, authorKept,
    origin: generatedFor(file)?.entry.origin ?? 'hand',
    baseline: pinBaseline(file, headSha()),
  })
}

/** The paths an accept commits: the scene, and the evidence log when it has
 *  something new to say. A judgment is record, so it rides in the commit the
 *  decision already makes rather than waiting to be noticed. */
function withEvidence(file: string): string[] {
  try {
    git('add', '--', EVIDENCE_REL)
    return git('status', '--porcelain', '--', EVIDENCE_REL).trim() ? [file, EVIDENCE_REL] : [file]
  } catch {
    return [file]
  }
}

/** Find the aligned entry a target names, refusing anything that no longer
 *  resolves — a stale client index must be an error, never a guess. */
function locate(aligned: AlignedParagraph[], t: ParagraphTarget): AlignedParagraph {
  const hit = aligned.find(a => (t.side === 'main' ? a.mainIndex : a.draftIndex) === t.paragraph)
  if (!hit) throw new HttpError(400, `no ${t.side}-side paragraph ${t.paragraph} in this draft — it may have moved on`)
  if (hit.kind === 'same') throw new HttpError(400, `paragraph ${t.paragraph} is unchanged — there is nothing to judge`)
  return hit
}

/** Accept ONE paragraph of a scene, leaving every other change pending.
 *
 *  Accept has been all-or-nothing: `git add -A -- prose` takes every edit in
 *  every scene as a single judgment, which is the opposite of what a review
 *  gate is for. A chapter with four changes is four decisions.
 *
 *  The mechanism is partial staging with the paragraph as the unit, because a
 *  paragraph is what an author actually judges. Build a version of the scene
 *  carrying the accepted paragraph's new text and main's text everywhere else,
 *  commit that, then put the author's full working tree back. HEAD gains the
 *  one change; the working tree keeps the rest, so the remaining diff is
 *  exactly what has not been decided yet.
 *
 *  The three kinds are three different edits to main, and conflating them is
 *  what the positional scheme did:
 *    changed — main's paragraph carries the draft's text
 *    ins     — the draft's paragraph is SPLICED IN at its insertion point,
 *              displacing nothing
 *    del     — main's paragraph goes away, which is what accepting a
 *              deletion means and what could not be expressed before
 *
 *  The working tree is restored in a finally: a failure here must never cost
 *  the author words they have not accepted.
 */
export function proseAcceptParagraph(file: string, t: ParagraphTarget, message?: string): { hash: string; file: string } {
  const { abs, working, fm, draftParas, mainParas, aligned, scene } = paragraphContext(file)
  const hit = locate(aligned, t)

  const merged = [...mainParas]
  if (hit.kind === 'changed') merged[hit.mainIndex!] = draftParas[hit.draftIndex!]
  else if (hit.kind === 'ins') merged.splice(mainInsertionPoint(aligned, hit.draftIndex!), 0, draftParas[hit.draftIndex!])
  else merged.splice(hit.mainIndex!, 1)

  // Locks first, evidence second, commit third: a refused accept costs no
  // words (nothing has been written yet) and records no judgment (A40-3).
  if (scene) assertUnlocked(scene, mainParas.join('\n\n'), merged.join('\n\n'), 'this accept')

  const committed = fm + merged.join('\n\n') + '\n'
  try {
    fs.writeFileSync(abs, committed)

    // Before the commit, so the judgment rides in it. A deletion has no
    // draft-side text at all; for the other two, arc's own words come from
    // the ledger and are compared rather than assumed — taking arc's
    // paragraph untouched is an approval, and editing it first is the pair.
    if (hit.kind === 'del') {
      judged(file, scene, 'paragraph', hit.mainIndex, 'accepted', '', '')
    } else {
      const kept = draftParas[hit.draftIndex!]
      const wrote = arcSideOf(file, draftParas, hit.draftIndex!)
      judged(file, scene, 'paragraph', hit.mainIndex ?? hit.draftIndex, wrote && wrote !== kept ? 'accepted' : 'approved', wrote, kept)
    }

    const paths = withEvidence(file)
    git('add', '--', file)
    git('commit', '-m', message?.trim() || `prose: accept one change in ${path.basename(file)}`, '--', ...paths)
    return { hash: git('rev-parse', '--short', 'HEAD').trim(), file }
  } finally {
    restoreWorking(abs, working, committed)   // the author's unaccepted words, always
  }
}

/** The finally that does not manufacture ghosts. The commit normalizes
 *  paragraphs; the author's original bytes may differ only in whitespace the
 *  model cannot see. Restoring those bytes over the freshly committed text
 *  would leave the scene "modified" forever with nothing visible to accept —
 *  so when the two are paragraph-identical, the committed bytes stand.
 *  Anything the model CAN see is the author's, and is restored exactly. */
function restoreWorking(abs: string, working: string, committed: string): void {
  const paras = (text: string) => {
    const fm = text.match(FM_RE)
    const body = fm ? text.slice(fm[0].length) : text
    return (fm?.[0] ?? '') + body.split(/\n{2,}/).map(x => x.trim()).filter(Boolean).join('\n\n')
  }
  fs.writeFileSync(abs, paras(working) === paras(committed) ? committed : working)
}

/** Reject ONE paragraph of a scene, leaving every other change pending.
 *
 *  The other half of the gate. Accept was per paragraph while the only way to
 *  say no was Discard, which throws away every change in the scene — so an
 *  author who liked three paragraphs of four had to accept those three and
 *  hand the fourth back themselves. A gate that makes agreeing cheap and
 *  disagreeing expensive is not doing the job.
 *
 *  This is the easier direction, and deliberately never reaches git: refusing
 *  a change means the draft stops carrying it, so main's words go back into
 *  the working tree and nothing is committed. Everything pending elsewhere
 *  stays pending. The three kinds mirror accept — a refused rewrite reverts,
 *  a refused insertion goes away, and a refused deletion comes back.
 */
/** THE REJECT VERBS AND LOCKS — decided deliberately, not left to fall
 *  through (A40-3). Rejecting is allowed on locked prose, because refusing a
 *  change RESTORES main's words into the working tree — and main's words are
 *  the very text the lock protects. A reject can only ever move a locked
 *  paragraph toward its settled state, never away from it; refusing the
 *  author that restoration would make the lock protect the draft against
 *  the book. (proseWrite's assertUnlocked guards arbitrary edits; a reject
 *  is not arbitrary — its output is main's text by construction.) */
export function proseRejectParagraph(file: string, t: ParagraphTarget): { file: string } {
  const { abs, working, fm, draftParas, mainParas, aligned, scene } = paragraphContext(file)
  const hit = locate(aligned, t)

  const next = [...draftParas]
  if (hit.kind === 'changed') next[hit.draftIndex!] = mainParas[hit.mainIndex!]
  else if (hit.kind === 'ins') next.splice(hit.draftIndex!, 1)
  else next.splice(draftInsertionPoint(aligned, hit.mainIndex!), 0, mainParas[hit.mainIndex!])

  // The scene has to still BE a scene afterwards. Accept gets this for free —
  // it commits and then restores the author's tree in a finally, so a bad
  // write cannot survive the call. Reject's write IS the outcome, so it
  // verifies its own result the way proseWrite does: write, parse, and put the
  // author's words back if what came out is not a scene. Refusing a change
  // must never be the thing that costs them the rest of their draft.
  fs.writeFileSync(abs, fm + next.join('\n\n') + '\n')
  if (!parseScene(fs.readFileSync(abs, 'utf8'), file)) {
    fs.writeFileSync(abs, working)
    throw new HttpError(500, `refusing that paragraph would have left ${file} unparseable — nothing was changed`)
  }

  // Only after the write survives its own check. A refusal is the strongest
  // signal in the log — arc put this in front of the author and they said no —
  // and it is the only one git never records, because refusing commits
  // nothing. Without this the evidence is overwritten and gone.
  judged(file, scene, 'paragraph', hit.mainIndex ?? hit.draftIndex, 'rejected',
    hit.kind === 'del' ? '' : draftParas[hit.draftIndex!],
    hit.mainIndex === null ? '' : mainParas[hit.mainIndex])
  return { file }
}

/** Where a main-side paragraph belongs in the DRAFT's array — the mirror of
 *  mainInsertionPoint, for putting a refused deletion back where it was. */
function draftInsertionPoint(aligned: AlignedParagraph[], at: number): number {
  let after = 0
  for (const a of aligned) {
    if (a.mainIndex === at) return a.draftIndex ?? after
    if (a.draftIndex !== null) after = a.draftIndex + 1
  }
  return after
}

// ---- judging one sentence (A37-3) ---------------------------------------
//
// The paragraph verbs force an all-or-nothing decision about text the author
// would happily split: a revision rewrites a paragraph to answer one note, and
// usually the new second sentence is better while the new fourth loses
// something. These take the decision down to the sentence, in the before text
// and the after text alike.
//
// The sentence is named by identity and re-derived here by the SHARED rule
// (arc-canon-graph's splitSentences, held to graph/sentence-vectors.json in
// both languages). The client never sends prose.

interface SentenceTarget { paragraph: number; side: 'main' | 'draft'; sentence: number }

/** The two paragraph versions a sentence decision needs, plus the scene's
 *  frontmatter and full working text.
 *
 *  `paragraph` is a DRAFT-side index, and main's counterpart is resolved
 *  through the shared paragraph alignment rather than assumed to sit at the
 *  same number. Before that, a scene whose draft inserted a paragraph anywhere
 *  above handed every later sentence decision the wrong before-text — the
 *  sentence verbs were careful about identity within a paragraph while
 *  addressing the paragraph itself by position. */
function sentenceContext(file: string, paragraph: number) {
  const { abs, working, fm, draftParas, mainParas, aligned, scene } = paragraphContext(file)
  if (paragraph < 0 || paragraph >= draftParas.length) throw new HttpError(400, `no paragraph ${paragraph} in ${file}`)

  const hit = aligned.find(a => a.draftIndex === paragraph)
  if (!hit || hit.mainIndex === null) {
    // The draft invented this paragraph whole: there is no before text to
    // align against, so it has no sentence granularity to offer. Say so
    // rather than pretend.
    throw new HttpError(400, 'this paragraph is new in the draft — accept or reject it whole')
  }
  return { abs, working, fm, draftParas, mainParas, main: hit.mainIndex, scene }
}

/** Rebuild one paragraph, applying a decision to exactly one sentence.
 *
 *  `keep` answers, for each aligned sentence, whether the rebuilt paragraph
 *  carries it. Everything the decision does not name keeps its current state,
 *  which is what leaves the rest of the paragraph pending. */
/** The aligned sentences of a judged paragraph, and the target within them.
 *
 *  Computed once and handed to both the merge and the evidence entry, so the
 *  pair the author sees, the merge that lands, and the rule argued later all
 *  rest on one alignment. */
function sentenceAlignment(mainPara: string, draftPara: string, t: SentenceTarget) {
  const aligned = alignSentences(
    splitSentences(mainPara).map(x => x.text),
    splitSentences(draftPara).map(x => x.text),
  )
  const hit = aligned.find(x => x.side === t.side && x.index === t.sentence && x.kind !== 'same')
  if (!hit) {
    throw new HttpError(400, `no pending ${t.side === 'main' ? 'deleted' : 'added'} sentence ${t.sentence} in paragraph ${t.paragraph} — the draft may have moved on`)
  }
  // A rewrite is a del and an ins that the author judges through two separate
  // calls; the other half is recovered from the alignment rather than lost.
  const other = counterpartOf(aligned, t.side, t.sentence)
  const arcWrote = hit.kind === 'ins' ? hit.text : (other?.text ?? '')
  const mainHad = hit.kind === 'del' ? hit.text : (other?.text ?? '')
  return { aligned, hit, arcWrote, mainHad }
}

function mergeSentence(
  aligned: AlignedSentence[],
  hit: AlignedSentence,
  keep: (s: AlignedSentence, isTarget: boolean) => boolean,
): string {
  const kept = aligned.filter(s => keep(s, s === hit)).map(s => s.text)
  // Sentences tile their paragraph, so a dropped sentence takes its own
  // trailing space with it and the survivors keep theirs. One seam is not
  // covered by that: the LAST sentence of a version has no trailing space, so
  // keeping it and then keeping something after it runs the two together —
  // `…down their backs.They sent her…`, which real prose produced on the first
  // try and no synthetic fixture had. Re-separate only where the seam is bare;
  // spacing the author chose is left alone.
  const out = kept
    .map((t, i) => (i === kept.length - 1 || /\s$/.test(t) ? t : t + ' '))
    .join('')
  return out.trim()
}

/** Accept ONE sentence into the book, leaving the rest of the paragraph — and
 *  every other change — pending.
 *
 *  Same mechanism as proseAcceptParagraph and the same safety: build a version
 *  of the scene that is main's text everywhere except this one sentence,
 *  commit it, restore the author's working tree in a finally. Accepting a
 *  deleted sentence commits the deletion; accepting an added one commits its
 *  arrival. */
export function proseAcceptSentence(file: string, t: SentenceTarget, message?: string): { hash: string; file: string } {
  const { abs, working, fm, draftParas, mainParas, main, scene } = sentenceContext(file, t.paragraph)
  const { aligned, hit, arcWrote } = sentenceAlignment(mainParas[main], draftParas[t.paragraph], t)

  const merged = mergeSentence(aligned, hit, (s, isTarget) => {
    if (s.kind === 'same') return true
    if (s.kind === 'ins') return isTarget          // an added sentence lands only if accepted
    return !isTarget                                // a deleted one stays unless its deletion is accepted
  })

  const next = [...mainParas]
  if (merged) next[main] = merged
  else next.splice(main, 1)

  // Same order as the paragraph verb: locks, then evidence, then the commit.
  if (scene) assertUnlocked(scene, mainParas.join('\n\n'), next.join('\n\n'), 'this accept')

  const committed = fm + next.join('\n\n') + '\n'
  try {
    fs.writeFileSync(abs, committed)
    // Taking arc's sentence, or agreeing with its cut: an approval either way.
    judged(file, scene, 'sentence', main, 'approved', arcWrote, arcWrote)
    const paths = withEvidence(file)
    git('add', '--', file)
    git('commit', '-m', message?.trim() || `prose: accept one sentence in ${path.basename(file)}`, '--', ...paths)
    return { hash: git('rev-parse', '--short', 'HEAD').trim(), file }
  } finally {
    restoreWorking(abs, working, committed)   // the author's unaccepted words, always
  }
}

/** Refuse ONE sentence, leaving the rest of the paragraph pending.
 *
 *  Never reaches git, for the reason proseRejectParagraph does not: refusing a
 *  change means the draft stops carrying it. Refusing an added sentence drops
 *  it; refusing a deleted one puts it back. */
export function proseRejectSentence(file: string, t: SentenceTarget): { file: string } {
  const { abs, fm, draftParas, mainParas, main, scene } = sentenceContext(file, t.paragraph)
  const { aligned, hit, arcWrote, mainHad } = sentenceAlignment(mainParas[main], draftParas[t.paragraph], t)

  const merged = mergeSentence(aligned, hit, (s, isTarget) => {
    if (s.kind === 'same') return true
    if (s.kind === 'ins') return !isTarget         // a refused insertion goes away
    return isTarget                                 // a refused deletion comes back
  })

  const next = [...draftParas]
  if (merged) next[t.paragraph] = merged
  else next.splice(t.paragraph, 1)

  fs.writeFileSync(abs, fm + next.join('\n\n') + '\n')
  // The sentence arc offered, and the sentence that stands instead.
  judged(file, scene, 'sentence', main, 'rejected', arcWrote, mainHad)
  return { file }
}

/** Roll one file back to main. The path arrives from the browser — reject
 *  anything that escapes prose/, including symlink escapes. */
export function proseDiscard(file: string): void {
  if (!file.startsWith('prose/')) throw new HttpError(400, `not a prose file: ${file}`)
  const abs = resolveWithin(path.join(STORY, 'prose'), file.slice('prose/'.length))
  const change = proseDraft().changes.find(c => c.file === file)
  if (!change) throw new HttpError(404, `no draft change for ${file}`)

  // Discard and locks, decided rather than fallen through (A40-3). Rolling
  // back to HEAD usually RESTORES settled prose, which honours every lock —
  // so discard stays allowed. The one case it must refuse: a lock whose
  // protected text lives only in the DRAFT (the author locked a passage and
  // has not accepted it yet). Discarding would destroy the very words the
  // lock exists to keep, silently.
  const working = (() => { try { return parseScene(fs.readFileSync(abs, 'utf8'), file) } catch { return null } })()
  if (working) {
    const inDraft = locksOn(working.scene, working.body)
      .filter(l => l.resolution.state === 'resolved' || l.resolution.state === 'drifted')
    if (inDraft.length) {
      const headBody = change.main?.body ?? ''
      const inHead = new Set(locksOn(working.scene, headBody)
        .filter(l => l.resolution.state === 'resolved' || l.resolution.state === 'drifted')
        .map(l => l.id))
      const casualty = inDraft.find(l => !inHead.has(l.id))
      if (casualty) {
        throw new HttpError(423,
          `${working.scene}: the passage lock ${casualty.id} protects exists only in this draft — ` +
          `discarding would destroy locked prose. Accept the locked paragraph first, or unlock it.`)
      }
    }
  }
  // BEFORE the ledger is cleared, because clearing it unlinks the blob and
  // takes the evidence with it. Discarding is the loudest refusal in the
  // product — a whole scene arc wrote, thrown away entire — and it was the
  // one decision that destroyed its own record on the way out.
  const gen = generatedFor(file)
  if (gen) {
    judged(file, change.main?.scene ?? null, 'scene', null, 'discarded',
      parseScene(gen.content, file)?.body ?? gen.content, '')
  }

  if (change.status === 'added') fs.rmSync(abs)
  else git('checkout', 'HEAD', '--', file)
  // A generation the author threw away must never be diffed against a later
  // hand-written scene at the same path.
  clearGenerated([file])
  clearBaseline(file)
}

interface Asset { body: Buffer; contentType: string }

/**
 * Read a file from the story's assets/ directory.
 * Returns null when it doesn't exist or isn't a servable type.
 * Rejects any name that escapes assets/ (incl. symlink escapes) — the name
 * arrives from the browser; null keeps the existing 404 behavior.
 */
export function readAsset(name: string): Asset | null {
  let abs: string
  try {
    abs = resolveWithin(ASSETS, name)
  } catch {
    return null
  }
  const contentType = CONTENT_TYPES[path.extname(abs).toLowerCase()]
  if (!contentType) return null
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null
  return { body: fs.readFileSync(abs), contentType }
}
