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
import type Anthropic from '@anthropic-ai/sdk'
import { MODEL, STORY } from './config'
import { getClient } from './agent'
import { currentEngine, runCliPrompt } from './engine'
import { annotations } from './annotations'
import { buildLearnPrompt, editPairs, materialize, parseProposals, significant } from './learn-style'
import { styleContract } from './style'
import { git, parseScene, proseScenes } from './story'
import { appendToQueue, readQueue, type ProposedRule } from './style-queue'
import { QUEUE_SUPPRESS_AT } from './learn-style'

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

/** The author's own reactions, as context. Bodies only — the model is told
 *  they interpret the diffs and never substitute for them. */
export function annotationContext(): string {
  const notes = annotations()
    .filter(n => n.body.trim())
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

interface BootstrapResult {
  added: ProposedRule[]
  skipped: 'queue-full' | 'no-history' | 'no-engine' | null
  pairsConsidered: number
}

export async function runBootstrapStyle(): Promise<BootstrapResult> {
  if (readQueue().length >= QUEUE_SUPPRESS_AT) return { added: [], skipped: 'queue-full', pairsConsidered: 0 }

  const all = historyPairs()
  if (!all.length) return { added: [], skipped: 'no-history', pairsConsidered: 0 }
  const considered = all.slice(-MAX_PAIRS).map((p, i) => ({ ...p, n: i + 1 }))

  const engine = currentEngine()
  const sdk = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
  if (!engine && !sdk) return { added: [], skipped: 'no-engine', pairsConsidered: considered.length }

  const prompt = [
    buildLearnPrompt({ pairs: considered, style: styleContract(), pending: readQueue().map(r => r.rule) }),
    annotationContext(),
  ].filter(Boolean).join('\n\n')

  let text: string
  if (engine === 'claude-cli') {
    text = (await runCliPrompt(prompt, { cwd: STORY })).text
  } else {
    const message = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    })
    text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map(b => b.text)
      .join('\n')
  }

  // STORY layer regardless of the model's recommendation: one manuscript is
  // one observation, and the author layer is earned at the ratify click.
  const fresh = materialize(parseProposals(text), considered, new Date().toISOString())
    .map(r => ({ ...r, layer: 'story' as const }))
  const { added } = appendToQueue(fresh)
  return { added, skipped: null, pairsConsidered: considered.length }
}
