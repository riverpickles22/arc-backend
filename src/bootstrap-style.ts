// The bootstrap: first proposals for a book whose loop arrived late.
//
// The learning pass mines decisions as they happen; this book made months of
// decisions before there was anything listening. The evidence still exists —
// every accepted state of the prose is a commit, and the author's reactions
// are in annotations/ — so one deliberate pass reads it and files proposals.
//
// THE DISCIPLINE IS TIGHTER THAN THE LIVE PASS, not looser, because a single
// pass over one manuscript is by definition a single observation:
//   - everything files as a STORY-layer proposal, whatever the model
//     recommends — ~/.arc/style.md gains content only when the author
//     deliberately promotes something at the ratify click;
//   - history pairs are labelled as what they are (author-RATIFIED movement,
//     possibly machine-drafted on either side), never as hand edits;
//   - the cap and the two-independent-examples bar hold as everywhere.
//
// The annotations ride along as context — the author's stated reactions help
// the model read the diffs — but rules still cite edit numbers only, so the
// trust property holds: every quote in the queue comes from arc's own table.
import { HttpError } from './http'
import { sha16 } from './records'
import { currentEngine } from './engine'
import { annotations } from './annotations'
import { editPairs, launchLearn, learnAsk, QUEUE_SUPPRESS_AT, significant, type LearnResult } from './learn-style'
import { ROW_LEARN_MANUSCRIPT_FROM_PROSE } from './registry'
import { git, parseScene, proseScenes } from './story'
import { readQueue } from './style-queue'

/** Bound the prompt however long the history runs: the LAST transitions per
 *  file are the author's most recent taste, which is the taste that counts. */
const MAX_TRANSITIONS_PER_FILE = 8
const MAX_PAIRS = 24

type Pair = ReturnType<typeof editPairs>[number]

/** Every significant paragraph movement between successive accepted states of
 *  each prose file. Pure over git — no model, so it can run and be tested
 *  without an engine. */
export function historyPairs(): Omit<Pair, 'n'>[] {
  const prefix = (() => { try { return git('rev-parse', '--show-prefix').trim() } catch { return null } })()
  if (prefix === null) return []

  const out: Omit<Pair, 'n'>[] = []
  for (const sc of proseScenes()) {
    let shas: string[]
    try {
      shas = git('log', '--format=%H', '--reverse', '--', sc.file).split('\n').filter(Boolean)
    } catch { continue }
    if (shas.length < 2) continue

    const bodies: string[] = []
    for (const sha of shas.slice(-(MAX_TRANSITIONS_PER_FILE + 1))) {
      try {
        const body = parseScene(git('show', `${sha}:${prefix}${sc.file}`), sc.file)?.body
        if (body) bodies.push(body)
      } catch { /* the file may not exist at that sha under this name */ }
    }
    for (let i = 0; i + 1 < bodies.length; i++) {
      out.push(...significant(editPairs(bodies[i], bodies[i + 1], sc.scene, 'history')))
    }
  }
  return out
}

/** The author's own reactions, as context — notes the AUTHOR wrote; an agent's
 *  key points are never presented as theirs. Bodies only — the model is told
 *  they interpret the diffs and never substitute for them. */
export function annotationContext(): string {
  const notes = annotations()
    .filter(n => n.by !== 'agent' && n.body.trim())
    .map(n => `- (${n.status ?? 'keypoint'}) ${n.body.trim().replace(/\s+/g, ' ')}`)
  if (!notes.length) return ''
  return [
    '=== THE AUTHOR\'S OWN NOTES (context only) ===',
    'Reactions the author wrote on their manuscript. Use them to interpret the',
    'edits above — a pattern a note complains about is likelier to be real —',
    'but a rule must still cite edit NUMBERS, never a note. A note with no',
    'edits behind it is a thought, not evidence.',
    ...notes,
  ].join('\n')
}

/** The bootstrap's answer: what a learning read answers, with the one reason
 *  of its own for not reading — a book with no history. */
export type BootstrapResult = Omit<LearnResult, 'skipped'> & { skipped: LearnResult['skipped'] | 'no-history' }

/** The gesture, as a gesture: the author's own hand, never an invented sentence. */
const GESTURE = 'learn from the history of your prose, by hand'

export async function runBootstrapStyle(): Promise<BootstrapResult> {
  if (readQueue().length >= QUEUE_SUPPRESS_AT) return { added: [], skipped: 'queue-full', pairsConsidered: 0 }

  const all = historyPairs()
  if (!all.length) return { added: [], skipped: 'no-history', pairsConsidered: 0 }
  const considered = all.slice(-MAX_PAIRS).map((p, i) => ({ ...p, n: i + 1 }))

  const engine = currentEngine()
  if (!engine) return { added: [], skipped: 'no-engine', pairsConsidered: considered.length }
  if (engine === 'sdk') {
    throw new HttpError(400,
      'arc can read the history of your prose only when it runs on your claude login — it cannot show what it was given on the engine it is set up to use. '
      + 'Log in with  claude  and ask again, or remove ANTHROPIC_API_KEY from arc-backend/.env.')
  }

  // The brief is the learner's own (the promoted contract and the declined
  // list, never the pending queue — rule 3), with the author's notes riding
  // beside the pairs as context that can never become evidence.
  const notes = annotationContext()
  // Rule 8: the notes come BEFORE the edits table, so the answer contract is last.
  const ask = [notes, learnAsk(considered)].filter(Boolean).join('\n\n')
  // STORY layer regardless of the model's recommendation: one manuscript is
  // one observation, and the author layer is earned at the ratify click.
  return launchLearn({
    row: ROW_LEARN_MANUSCRIPT_FROM_PROSE, considered, ask,
    said: GESTURE, subject: 'the manuscript', range: null,
    readExtra: [{ id: 'annotations', version: sha16(notes) }],
    opened: { yes: false },
    receiptNote: 'Record: the receipt for a style read of the prose history',
    layer: 'story',
  })
}
