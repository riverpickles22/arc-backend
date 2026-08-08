// arc's world-shaping agent. Reads the full canon, converses with the author,
// and writes canon/docs files through the same validation discipline as any
// other contributor — failed validation bounces back to the model to fix.
import fs from 'node:fs'
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { load as yamlLoad } from 'js-yaml'
import type { ChatAction, ChatRequest, ChatResponse } from 'arc-canon-graph'
import { CORE, MODEL, STORY } from './config'
import { canonJson, invalidateCanon, validateStory } from './canon'

// The chat wire contract lives in arc-canon-graph (graph/api-types.ts),
// shared with the frontend. Alias kept for existing importers.
export type { ChatAction as Action }

function safeStoryPath(rel: string, allowedRoots: string[], exts: string[]): string {
  const abs = path.resolve(STORY, rel)
  if (!abs.startsWith(STORY + path.sep)) throw new Error(`path escapes story dir: ${rel}`)
  if (!allowedRoots.some(r => abs.startsWith(path.join(STORY, r) + path.sep) || path.dirname(abs) === path.join(STORY, r)))
    throw new Error(`path must be under ${allowedRoots.join(' or ')}: ${rel}`)
  if (!exts.some(e => abs.endsWith(e))) throw new Error(`file must end with ${exts.join(' or ')}: ${rel}`)
  return abs
}

function listFiles(dir: string, base = ''): string[] {
  const out: string[] = []
  const root = path.join(STORY, dir, base)
  if (!fs.existsSync(root)) return out
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const rel = path.join(dir, base, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(dir, path.join(base, entry.name)))
    else out.push(rel)
  }
  return out
}

function buildSystem(): Anthropic.Beta.BetaTextBlockParam[] {
  const conventions = fs.readFileSync(path.join(CORE, 'conventions.md'), 'utf8')
  const files = [...listFiles('canon'), ...listFiles('docs')].join('\n')
  const storyName = path.basename(STORY)
  return [
    {
      // Stable prefix — cached. Everything volatile goes in the block below it.
      type: 'text',
      text: `You are the arc world-shaping agent, embedded in the arc viewer — a living
map/graph tool for developing the story in "${storyName}". You converse
with the AUTHOR. Your job is to help shape the story's material — characters,
places, factions, events, chapters, versioned character states — and to keep
the canon consistent while doing it.

You have tools to read and write the story's files. Writes to canon/ are
validated (JSON Schema + referential integrity); if validation fails you get
the errors back — fix the file and retry. Every successful canon write
immediately re-renders the author's map, graph, and timeline.

RULES (binding, from arc-core's conventions.md below):
- Canon YAML is the source of truth. Docs elaborate; canon states facts.
- New facts you introduce default to "status: proposed" unless the author
  explicitly ratifies them in this conversation — then use "status: canon".
- Character development = a NEW state snapshot at a timepoint, never editing
  an old snapshot (except to fix errors).
- Wire causality: events get causes/leads_to; states get caused_by.
- Mint IDs as type.slug kebab-case (char. place. faction. obj. event. ch.).
  When you create an entity, also create its docs article (write_docs_file).
- Keep edits minimal and targeted. Don't rewrite files wholesale to change
  one field — read the file first, then write it back with only the intended
  change applied.
- If the story keeps a research corpus (research/), it is evidence the story
  is grounded in: respect it, and flag plausibility concerns rather than
  silently inventing facts. A story may diverge from its sources, but only
  knowingly.

STYLE: You are a sharp, well-read story editor. Be concise and
concrete. Reference entities by their canon IDs (e.g. char.<slug>) so the author can
click them. When you change files, end with a one-line summary per file
changed. When the author is exploring ideas rather than requesting changes,
discuss — don't write files until the direction is settled.

=== conventions.md ===
${conventions}`,
      cache_control: { type: 'ephemeral' },
    },
    {
      // Volatile — the canon changes as the agent writes. Kept after the
      // cache breakpoint so a canon write doesn't invalidate the prefix.
      type: 'text',
      text: `=== CURRENT CANON (generated JSON export; YAML files are authoritative) ===
${canonJson()}

=== STORY FILES ===
${files}`,
    },
  ]
}

export async function handleChat(body: ChatRequest): Promise<ChatResponse> {
  const client = new Anthropic()
  const actions: ChatAction[] = []

  const readStoryFile = betaTool({
    name: 'read_story_file',
    description:
      'Read a file from the story directory. Use before editing any file. ' +
      'Path is relative to the story root, e.g. "canon/entities/characters/<slug>.yaml" or "docs/vision.md".',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'relative path under canon/, docs/, or research/' } },
      required: ['path'],
      additionalProperties: false,
    } as const,
    run: async (input: any) => {
      const abs = safeStoryPath(input.path, ['canon', 'docs', 'research'], ['.yaml', '.md'])
      return fs.readFileSync(abs, 'utf8')
    },
  })

  const writeCanonFile = betaTool({
    name: 'write_canon_file',
    description:
      'Write (create or replace) a YAML file under canon/. The full story canon is validated after the ' +
      'write; on failure the write is REVERTED and you get the validator errors — fix and retry. ' +
      'On success the viewer refreshes automatically. Always read an existing file before rewriting it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'relative path under canon/, ending .yaml' },
        content: { type: 'string', description: 'complete YAML file content' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    } as const,
    run: async (input: any) => {
      const abs = safeStoryPath(input.path, ['canon'], ['.yaml'])
      try {
        yamlLoad(input.content)
      } catch (e: any) {
        return `YAML SYNTAX ERROR (nothing written): ${e.message}`
      }
      const existed = fs.existsSync(abs)
      const prev = existed ? fs.readFileSync(abs, 'utf8') : null
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, input.content)
      const check = validateStory()
      if (!check.ok) {
        if (prev !== null) fs.writeFileSync(abs, prev)
        else fs.unlinkSync(abs)
        actions.push({ tool: 'write_canon_file', path: input.path, ok: false, detail: 'validation failed, reverted' })
        return `VALIDATION FAILED — write reverted. Fix these and retry:\n${check.output}`
      }
      invalidateCanon()
      actions.push({ tool: 'write_canon_file', path: input.path, ok: true })
      return `OK — written and validated (${check.output})`
    },
  })

  const writeDocsFile = betaTool({
    name: 'write_docs_file',
    description:
      'Write (create or replace) a markdown file under docs/ — vision.md, world.md, or a per-entity ' +
      'article under docs/entities/. Wikilink canon IDs like [[char.<slug>]].',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'relative path under docs/, ending .md' },
        content: { type: 'string', description: 'complete markdown file content' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    } as const,
    run: async (input: any) => {
      const abs = safeStoryPath(input.path, ['docs'], ['.md'])
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, input.content)
      const check = validateStory() // catches broken wikilinks / missing-article drift
      actions.push({ tool: 'write_docs_file', path: input.path, ok: check.ok, detail: check.ok ? undefined : 'validator warnings' })
      return check.ok ? 'OK — written' : `Written, but the validator now reports:\n${check.output}\nFix canon or the doc so these clear.`
    },
  })

  const finalMessage = await client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: buildSystem(),
    tools: [readStoryFile, writeCanonFile, writeDocsFile],
    messages: body.messages,
    max_iterations: 12,
  })

  const reply = finalMessage.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')

  return {
    reply,
    actions,
    canonChanged: actions.some(a => a.ok && a.tool === 'write_canon_file'),
  }
}
