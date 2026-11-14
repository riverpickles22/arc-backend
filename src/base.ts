// THE BASE AT THE DECISION (A72-3). What the author read, carried with what
// they decided, so a decision can only ever land on the words it was about.
//
// Invariant 11: an accept that would land on words the author changed since
// they read the diff is refused, not merged. Until now only the author's own
// save compared anything (`proseWrite`'s baseline); every accept took whatever
// was on disk at the moment it arrived. Two tabs, a stale index, a scene
// edited in another window between reading and clicking — all of them landed.
//
// THE TOKEN COVERS BOTH SIDES OF THE DIFF, because a diff is two versions and
// the author read both. The accepted side moving means the book changed under
// the decision; the pending side moving means their own newer words are about
// to be overwritten, and HEAD never moved at all — which is the case a
// HEAD-shaped check cannot see. Both are the same refusal.
//
// AND IT IS SCOPED TO THE FILE, not the repository. A token over HEAD would
// go stale every time an unrelated scene was accepted, and an author whose
// decisions are refused for reasons they cannot see stops reading the reason.
//
// WHAT IT IS NOT: the pinned baseline in `evidence.ts`. That is the commit a
// generation was judged FROM, kept so the learning pass knows which pair it is
// looking at. This is what the author had in front of them. They answer
// different questions and are never interchangeable.
import fs from 'node:fs'
import path from 'node:path'
import { STORY } from './config'
import { HttpError } from './http'
import { git } from './lane'
import { sha16 } from './records'

/** One side of the diff, as it stood. `absent` is a state, not a gap: a scene
 *  the draft adds has no accepted side, and one it deletes has no pending
 *  side, and either of those appearing or disappearing is a change. */
export interface ReviewedSide {
  present: boolean
  /** sha16 of the file's bytes — frontmatter and body together, because a
   *  changed `status:` or `events:` is as much a change as a changed line. */
  sha: string | null
}

export interface ReviewedVersions {
  file: string
  accepted: ReviewedSide
  pending: ReviewedSide
}

const absent: ReviewedSide = { present: false, sha: null }

const acceptedText = (file: string): string | null => {
  try { return git('show', `HEAD:${file}`) } catch { return null }
}

const pendingText = (file: string): string | null => {
  try { return fs.readFileSync(path.join(STORY, file), 'utf8') } catch { return null }
}

const sideOf = (text: string | null): ReviewedSide =>
  text === null ? absent : { present: true, sha: sha16(text) }

/** Both versions of one file as they stand right now. */
export function versionsOf(file: string): ReviewedVersions {
  return { file, accepted: sideOf(acceptedText(file)), pending: sideOf(pendingText(file)) }
}

/** The token over two versions given as text, for a decision that knows what
 *  it is ABOUT TO make true. An accept is deterministic: the bytes it will
 *  commit and the bytes that will stand in the working tree are both known
 *  before the commit, so the record it writes can name the version it is
 *  producing as well as the one it was made about. */
export function tokenFor(file: string, accepted: string | null, pending: string | null): string {
  return sha16(JSON.stringify({ file, accepted: sideOf(accepted), pending: sideOf(pending) }))
}

/** The token for what the author is being shown. Opaque to the client, which
 *  only ever echoes it back — the rules about what counts as a change live
 *  here and nowhere else, so the two sides cannot disagree about them. */
export function baseOf(file: string): string {
  const v = versionsOf(file)
  const token = sha16(JSON.stringify(v))
  remember(token, file)
  return token
}

// ---- a bounded memory of what was shown --------------------------------
//
// A hash cannot reconstruct the text it was taken over, and a refusal that
// cannot say WHAT changed is a refusal the author has to take on faith. So the
// server keeps the two versions behind each token it mints, for long enough to
// explain itself: small, bounded, in memory, and never read as permission to
// write — it answers "what did you see", never "what is true now".

interface Shown { file: string; accepted: string | null; pending: string | null }

// BOUNDED PER FILE, not globally. One load of the manuscript mints a token for
// every scene; a single global ring would then evict the diff the author is
// actually reading as soon as the book outgrew the ring, and every refusal
// after that would lose the words it is supposed to show them. A handful of
// versions per file is all a refusal ever needs, and the file count is capped
// too so a long session cannot grow without limit.
const PER_FILE = 4
const FILES_MAX = 256
const shown = new Map<string, Map<string, Shown>>()

function remember(token: string, file: string): void {
  let forFile = shown.get(file)
  if (!forFile) {
    forFile = new Map()
    shown.set(file, forFile)
    while (shown.size > FILES_MAX) {
      const oldest = shown.keys().next().value as string | undefined
      if (oldest === undefined || oldest === file) break
      shown.delete(oldest)
    }
  }
  if (forFile.has(token)) return
  forFile.set(token, { file, accepted: acceptedText(file), pending: pendingText(file) })
  while (forFile.size > PER_FILE) {
    const oldest = forFile.keys().next().value as string | undefined
    if (oldest === undefined) break
    forFile.delete(oldest)
  }
}

/** What the author was shown under this token, while arc still remembers it.
 *  For display beside a refusal; never for writing. */
export function reviewed(token: string): Shown | null {
  for (const forFile of shown.values()) {
    const hit = forFile.get(token)
    if (hit) return hit
  }
  return null
}

/** For a test that needs the store empty. */
export const forgetReviews = (): void => { shown.clear() }

// ---- the compare -------------------------------------------------------

/** What changed between the version the author read and the one on disk, in
 *  the author's nouns. Null when nothing did. */
function whatMoved(was: Shown | null, now: ReviewedVersions): { moved: string; side: BaseConflict['side'] } | null {
  if (!was) return null
  const wasAccepted = sideOf(was.accepted)
  const wasPending = sideOf(was.pending)
  const acceptedMoved = wasAccepted.present !== now.accepted.present || wasAccepted.sha !== now.accepted.sha
  const pendingMoved = wasPending.present !== now.pending.present || wasPending.sha !== now.pending.sha
  if (acceptedMoved && pendingMoved) return { moved: 'both the book and the pending words have changed', side: 'both' }
  if (acceptedMoved) return { moved: now.accepted.present ? 'the book has changed here' : 'this scene is no longer in the book', side: 'accepted' }
  if (pendingMoved) return { moved: now.pending.present ? 'you have changed these words since' : 'the pending words are gone', side: 'pending' }
  return null
}

/** What a refusal carries beside its sentence: what was read, and what is
 *  there now. Text, so the viewer can show the author the difference rather
 *  than asserting one. */
export interface BaseConflict {
  file: string
  moved: string
  /** WHICH SIDE MOVED, so the page shows the pair that differs and not two
   *  identical blocks under a sentence asserting a difference. */
  side: 'accepted' | 'pending' | 'both'
  /** Bodies only. The frontmatter — `scene:`, `status:`, `events:` — is the
   *  id the author-facing surface must not carry (the epic's decision 3). */
  reviewed: { accepted: string | null; pending: string | null } | null
  current: { accepted: string | null; pending: string | null }
}

const FM_RE = /^---\n[\s\S]*?\n---\n?/
/** The prose without its frontmatter, for display. Null stays null. */
const bodyOf = (text: string | null): string | null => text === null ? null : text.replace(FM_RE, '')

/** Refuse unless the decision names the versions it was made about.
 *
 *  Fails CLOSED. A request with no token is not an old client to be
 *  accommodated — it is a decision arc cannot show the author a reason for,
 *  and the whole point of this is that every decision has one. */
export function assertBase(file: string, base: unknown, doing: string): void {
  if (typeof base !== 'string' || !/^[0-9a-f]{16}$/.test(base)) {
    throw new HttpError(400,
      `${doing} must say which version of ${file} it was decided about — reload the manuscript and try again`)
  }
  const now = versionsOf(file)
  if (sha16(JSON.stringify(now)) === base) return

  const was = reviewed(base)
  const what = whatMoved(was, now)
    ?? { moved: 'this scene has changed since that was read', side: 'both' as const }   // older than arc's memory of it
  const conflict: BaseConflict = {
    file,
    moved: what.moved,
    side: what.side,
    reviewed: was ? { accepted: bodyOf(was.accepted), pending: bodyOf(was.pending) } : null,
    current: { accepted: bodyOf(acceptedText(file)), pending: bodyOf(pendingText(file)) },
  }
  throw new HttpError(409,
    `${what.moved}, so arc did not ${doing}. Read it again, and decide about the words that are there now.`,
    { conflict: conflict as unknown as Record<string, unknown> })
}

/** Preflight several files before any of them is touched (criterion 6): one
 *  bad token in a request must not leave half a decision behind. */
export function assertBases(files: string[], bases: unknown, doing: string): void {
  const map = (bases ?? {}) as Record<string, unknown>
  if (typeof map !== 'object' || Array.isArray(map)) {
    throw new HttpError(400, `${doing} must say which version of each scene it was decided about`)
  }
  for (const f of files) assertBase(f, map[f], doing)
}
