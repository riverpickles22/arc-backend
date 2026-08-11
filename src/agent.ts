// arc's world-shaping agent. Reads the full canon, converses with the author,
// and writes canon/docs files through the same validation discipline as any
// other contributor — failed validation bounces back to the model to fix.
import fs from 'node:fs'
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { dump as yamlDump, load as yamlLoad } from 'js-yaml'
import type { ChatAction, ChatRequest, ChatResponse } from 'arc-canon-graph'
import { CORE, MODEL, STORY } from './config'
import { canonJson, invalidateCanon, validateStory } from './canon'
import { styleContract } from './style'
import { resolveWithin } from './safe-path'
import { idsInFile, listFiles, takenIds } from './records'
import {
  type Capability,
  UNRESTRICTED,
  checkRecordWrite,
  checkPathWrite,
  checkRead,
  covered,
  diffRecords,
  mintId,
  recordsIn,
} from './capability'

// The chat wire contract lives in arc-canon-graph (graph/api-types.ts),
// shared with the frontend. Alias kept for existing importers.
export type { ChatAction as Action }

// Constructed lazily: the SDK throws without credentials, and the route
// already answers 503 before calling handleChat when none are set.
let client: Anthropic | undefined
export const getClient = () => (client ??= new Anthropic())

/** Canonical YAML for agent writes (multi-author early lock 3): whatever
 *  shape the model emits, the file lands deterministically formatted —
 *  insertion-order keys, 2-space indent, consistent quoting, no refs — so
 *  every diff is semantic, never cosmetic. Human-authored files are never
 *  reformatted; only the agent write path passes through here. */
export function canonicalYaml(parsed: unknown): string {
  return yamlDump(parsed, { indent: 2, lineWidth: 100, noRefs: true, sortKeys: false })
}

function safeStoryPath(rel: string, allowedRoots: string[], exts: string[]): string {
  const abs = resolveWithin(STORY, rel)   // realpath-aware; throws on any escape
  const realStory = fs.realpathSync(STORY)
  if (!allowedRoots.some(r => abs.startsWith(path.join(realStory, r) + path.sep) || path.dirname(abs) === path.join(realStory, r)))
    throw new Error(`path must be under ${allowedRoots.join(' or ')}: ${rel}`)
  if (!exts.some(e => abs.endsWith(e))) throw new Error(`file must end with ${exts.join(' or ')}: ${rel}`)
  return abs
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
- Never invent a permanent ID. Call mint_id and use what it returns — arc
  allocates under the ID conventions and checks the whole story for
  collisions. When you create an entity, also create its docs article
  (write_docs_file).
- You hold a scope. A write outside it returns SCOPE_EXCEEDED and touches
  nothing; the refusal names how to widen the scope. Follow it rather than
  working around it.
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
      // Volatile — the canon changes as the agent writes. Its own cache
      // breakpoint: multi-turn conversations without writes reuse this
      // (large, growing) block too; a write invalidates only this one,
      // never the stable prefix above.
      type: 'text',
      text: `=== CURRENT CANON (generated JSON export; YAML files are authoritative) ===
${canonJson()}

${styleContract()}

=== STORY FILES ===
${files}`,
      cache_control: { type: 'ephemeral' },
    },
  ]
}

/** The read tool alone — shared with passes (drafting) that need story
 *  reads but their own restricted write surface. */
export function makeReadStoryTool(cap: Capability = UNRESTRICTED) {
  return betaTool({
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
      const scope = checkRead(cap, input.path, idsInFile(abs, input.path))
      if (!scope.ok) return scope.message!
      return fs.readFileSync(abs, 'utf8')
    },
  })
}

/** The story tools, closed over an actions collector and a capability —
 *  shared by the chat agent and the capture pass so both write through the
 *  same validated gate. The capability is checked BEFORE validation, so an
 *  out-of-scope write never touches the disk at all; it defaults to
 *  UNRESTRICTED, which is what the author's own chat holds.
 *
 *  `cap` is mutated in place by mint_id — that is the audited widening of
 *  work-graph.md §4, and the caller keeps the object to record it. */
export function makeStoryTools(actions: ChatAction[], cap: Capability = UNRESTRICTED) {
  const readStoryFile = makeReadStoryTool(cap)

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
      let parsed: unknown
      try {
        parsed = yamlLoad(input.content)
      } catch (e: any) {
        return `YAML SYNTAX ERROR (nothing written): ${e.message}`
      }
      const existed = fs.existsSync(abs)
      const prev = existed ? fs.readFileSync(abs, 'utf8') : null

      // Scope before validation: an out-of-scope write never reaches disk.
      const before = prev === null ? [] : recordsIn(yamlLoad(prev), input.path)
      const scope = checkRecordWrite(cap, diffRecords(before, recordsIn(parsed, input.path)))
      if (!scope.ok) {
        actions.push({
          tool: 'write_canon_file',
          path: input.path,
          ok: false,
          detail: `scope exceeded: ${scope.denied!.join(', ')}`,
        })
        return scope.message!
      }

      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, canonicalYaml(parsed))
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
      const scope = checkPathWrite(cap, input.path)
      if (!scope.ok) {
        actions.push({ tool: 'write_docs_file', path: input.path, ok: false, detail: 'scope exceeded' })
        return scope.message!
      }
      // Same discipline as canon writes, guarded: revert only when the write
      // itself broke a previously-clean story — pre-existing findings must
      // not wedge every docs write.
      const cleanBefore = validateStory().ok
      const existed = fs.existsSync(abs)
      const prev = existed ? fs.readFileSync(abs, 'utf8') : null
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, input.content)
      const check = validateStory() // catches broken wikilinks / missing-article drift
      if (!check.ok && cleanBefore) {
        if (prev !== null) fs.writeFileSync(abs, prev)
        else fs.unlinkSync(abs)
        actions.push({ tool: 'write_docs_file', path: input.path, ok: false, detail: 'validation failed, reverted' })
        return `VALIDATION FAILED — write reverted. Fix these and retry:\n${check.output}`
      }
      actions.push({ tool: 'write_docs_file', path: input.path, ok: check.ok, detail: check.ok ? undefined : 'validator warnings' })
      return check.ok ? 'OK — written' : `Written, but the validator now reports:\n${check.output}\nFix canon or the doc so these clear.`
    },
  })

  const mintIdTool = betaTool({
    name: 'mint_id',
    description:
      'Ask arc for a new permanent canon ID before creating an entity. arc allocates it under the ID ' +
      'conventions, checks it against every ID the story already holds, and grants you permission to ' +
      'propose it. Never invent a permanent ID yourself — IDs are forever, and collisions are silent.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'character | place | faction | object | event | era | timepoint | relationship | chapter | theme',
        },
        hint: { type: 'string', description: 'the name to slugify, e.g. "Rafael" or "Carlos and Rafael"' },
      },
      required: ['type', 'hint'],
      additionalProperties: false,
    } as const,
    run: async (input: any) => {
      // Authority first: it is free, and a worker with no grant should not
      // cause a scan of the story.
      if (!cap.creates.some(g => g.type === '*' || g.type === input.type)) {
        actions.push({ tool: 'mint_id', path: input.type, ok: false, detail: `no create grant for ${input.type}` })
        return `SCOPE_EXCEEDED — no CREATE grant for ${input.type}. Ask the planner to widen the claim.`
      }
      let id: string
      try {
        id = mintId(input.type, input.hint, takenIds())
      } catch (e: any) {
        return `MINT FAILED: ${e.message}`
      }
      // The audited widening. Skipped when already covered, which is also
      // what keeps the frozen UNRESTRICTED singleton safe to pass in.
      if (!covered(cap.proposes, id)) cap.proposes = [...cap.proposes, id]
      actions.push({ tool: 'mint_id', path: id, ok: true, detail: `granted propose ${id}` })
      return `OK — minted ${id}. You may now propose it (status: proposed).`
    },
  })

  return [readStoryFile, writeCanonFile, writeDocsFile, mintIdTool]
}

export async function handleChat(body: ChatRequest): Promise<ChatResponse> {
  const actions: ChatAction[] = []

  const finalMessage = await getClient().beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: buildSystem(),
    tools: makeStoryTools(actions),
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
