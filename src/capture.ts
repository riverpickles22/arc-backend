// The capture pass: extraction at the accept gate. When the author accepts
// scenes into the manuscript, a scene-scoped model read extracts what
// changed and files genuinely new facts as status: proposed canon — through
// the same validated write gate as every other contributor. The author
// approves at the proposal queue; nothing becomes true because a machine
// decided it should.
//
// The spike's design finding, encoded below: the noise risk concentrates
// exactly where the author's deliberate withholds live, so the extractor
// consumes must_withhold and narrative_notes as suppression context.
import fs from 'node:fs'
import path from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import type { ChatAction, ChatResponse } from 'arc-canon-graph'
import { CORE, MODEL, STORY } from './config'
import { canonJson } from './canon'
import { getClient, makeStoryTools } from './agent'

const CAPTURE_RULES = `You are arc's CAPTURE PASS. The author just accepted scenes into the
manuscript. Extract what the accepted prose changed and keep the record
consistent — without the author doing bookkeeping.

WHAT TO EXTRACT: genuinely new facts the prose establishes — new entities,
new events, state changes (a NEW snapshot appended to the entity's states,
never editing old ones), relationship shifts. File them with
write_canon_file as status: proposed. Read a file before extending it.
State snapshots use the structured fields (conventions §4): beliefs, wants,
fears as lists — a want or fear the prose establishes goes in its field,
never buried in psychology prose where no diff can see it.

SUPPRESSION (the binding rule): before filing anything, read each scene's
frontmatter contract (must_withhold) and the narrative_notes of the events
the scene is bound to. NEVER mint an entity, place, or name that canon
deliberately keeps unnamed or the contract withholds. When unsure whether
something deserves a record, mention it in the briefing instead of filing.

EPISTEMIC CLASS: every proposed record's note field begins
"capture: stated" (explicit on the page) or "capture: implied" (strongly
implied but unstated). The briefing marks each item the same way.

THE BRIEFING (your final message — keep it tight):
1. What this scene changed — each change, marked stated/implied.
2. Contract check — each must_establish met or not yet; each must_withhold
   honored or leaked.
3. To verify — claims a human or research pass should confirm.
File little, mention much: a wrong proposal costs trust; a mentioned
observation costs nothing.

=== conventions.md ===
`

/** Run the capture pass over just-accepted scene files. Errors are the
 *  caller's to swallow — capture failing must never un-accept prose. */
export async function runCapture(files: string[]): Promise<ChatResponse> {
  const actions: ChatAction[] = []
  const conventions = fs.readFileSync(path.join(CORE, 'conventions.md'), 'utf8')

  const scenes = files.map(f => {
    const abs = path.join(STORY, f)
    return `=== ${f} ===\n${fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '(deleted in this accept)'}`
  }).join('\n\n')

  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: 'text', text: CAPTURE_RULES + conventions, cache_control: { type: 'ephemeral' } },
    {
      type: 'text',
      text: `=== CURRENT CANON (generated JSON export; YAML files are authoritative) ===\n${canonJson()}`,
      cache_control: { type: 'ephemeral' },
    },
  ]

  const finalMessage = await getClient().beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system,
    tools: makeStoryTools(actions),
    messages: [{
      role: 'user',
      content: `The author accepted these scenes into the manuscript:\n\n${scenes}\n\nRun the capture pass.`,
    }],
    max_iterations: 10,
  })

  const reply = finalMessage.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')

  return { reply, actions, canonChanged: actions.some(a => a.ok && a.tool === 'write_canon_file') }
}
