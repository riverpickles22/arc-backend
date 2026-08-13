// Selection suggestions: the writer's-menu pass. Rephrase a selected passage
// against the author's OWN style contract — that is the whole point, and the
// difference from every generic "improve this" button — or offer synonyms
// with nuance notes that respect the scene's period.
//
// Read-only by construction, like the analysis pass: no tools on either
// engine, nothing written, nothing proposed. Everything returned is in the
// ARGUED register (conventions §11) — a list the author picks from or
// ignores. The machine never applies its own suggestion.
import type Anthropic from '@anthropic-ai/sdk'
import type { SuggestRequest, SuggestResponse } from 'arc-canon-graph'
import { MODEL, STORY } from './config'
import { getClient } from './agent'
import { currentEngine, runCliPrompt, stripFences } from './engine'
import { styleContract } from './style'
import { parseScene } from './story'
import { HttpError } from './http'
import fs from 'node:fs'
import path from 'node:path'

const REPHRASE_RULES = `You are arc's REPHRASE pass. The author selected a passage of their novel
and wants alternatives — in THEIR voice, not yours.

THE CONTRACT BELOW IS BINDING. Every alternative must obey the author's own
style rules; an alternative that "improves" the line by breaking a rule is
worthless. Match the passage's tense and point of view. Keep roughly its
length unless the rules demand tighter.

Offer 3 to 5 alternatives, each a complete drop-in replacement for the
selection alone — never the surrounding text. No commentary, no ranking,
no explanation.

Answer with a JSON array of strings and nothing else.`

const SYNONYM_RULES = `You are arc's SYNONYM pass. The author selected a word or short phrase and
wants alternatives, the way a thesaurus offers them — but one that knows
their book.

Offer 3 to 6 alternatives. Each entry is the replacement, then " — ", then
ONE clause of nuance: what shade this choice carries. If a word would break
the story's period or register (the scene context below tells you when and
where the book lives), either omit it or say so in the nuance clause.

The replacement before the " — " must be a drop-in for the selection: same
part of speech, same case.

Answer with a JSON array of strings and nothing else.`

/** Pure prompt builder, testable without an engine. */
export function buildSuggestPrompt(req: {
  kind: 'rephrase' | 'synonyms'
  selection: string
  paragraph?: string
  sceneContext?: string
  style: string
}): string {
  const rules = req.kind === 'rephrase' ? REPHRASE_RULES : SYNONYM_RULES
  return [
    rules,
    // The style contract is the rephrase pass's authority; the synonym pass
    // reads it too — register is a voice question as much as a word one.
    `=== THE AUTHOR'S STYLE CONTRACT (binding) ===\n${req.style}`,
    req.sceneContext ? `=== SCENE CONTEXT ===\n${req.sceneContext}` : '',
    req.paragraph ? `=== THE PARAGRAPH IT SITS IN ===\n${req.paragraph}` : '',
    `=== THE SELECTION ===\n${req.selection}`,
    'Answer with the JSON array.',
  ].filter(Boolean).join('\n\n')
}

/** Tolerant parse: an array of strings, fences stripped, junk dropped. */
export function parseSuggestions(text: string): string[] {
  const raw = stripFences(text)
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end < start) throw new Error(`suggest pass did not return a JSON array: ${raw.slice(0, 160)}`)
  const parsed: unknown = JSON.parse(raw.slice(start, end + 1))
  if (!Array.isArray(parsed)) throw new Error('suggest pass returned JSON that is not an array')
  return parsed.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 6)
}

/** What the prompt gets to know about the scene: POV and chapter, read fresh
 *  from the file's own frontmatter. Absent file, absent context — the pass
 *  still works on the selection alone. */
function sceneContextFor(file?: string): string | undefined {
  if (!file || !file.startsWith('prose/') || file.includes('..')) return undefined
  try {
    const scene = parseScene(fs.readFileSync(path.join(STORY, file), 'utf8'), file)
    if (!scene) return undefined
    return `Scene ${scene.scene}, chapter ${scene.chapter}${scene.pov ? `, narrated from the point of view of ${scene.pov}` : ''}.`
  } catch {
    return undefined
  }
}

export async function runSuggest(req: SuggestRequest): Promise<SuggestResponse> {
  const engine = currentEngine()
  if (!engine) throw new HttpError(503, 'No generation engine available.')
  if (!req.selection?.trim()) throw new HttpError(400, 'nothing selected')

  const prompt = buildSuggestPrompt({
    kind: req.kind,
    selection: req.selection,
    paragraph: req.paragraph,
    sceneContext: sceneContextFor(req.file),
    style: styleContract(),
  })

  if (engine === 'claude-cli') {
    return { suggestions: parseSuggestions(runCliPrompt(prompt, { cwd: STORY }).text), register: 'argued', engine }
  }

  const message = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  })
  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')
  return { suggestions: parseSuggestions(text), register: 'argued', engine }
}
