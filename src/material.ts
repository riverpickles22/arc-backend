// The material worker (work-graph.md §11, slice 1): the narrow path from an
// ambiguous author sentence to one honest material item.
//
// Material is the first rung of the ladder — material, proposed, canon,
// manuscript (conventions §12). It is never load-bearing, and capturing it
// must cost nothing: the worker files what the author means WITHOUT forcing
// decisions about characters, scenes, or placement that the author has not
// made. Preserving the uncertainty is the job, not a shortfall of it.
//
// The claim it holds is deliberately conservative: read the anchors and their
// neighbourhood, write material only. If it concludes a real canon entity is
// warranted it hits the gate — which is the point, because that refusal is
// the first honest measurement of whether claim derivation works.
import fs from 'node:fs'
import path from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import type { ChatAction } from 'arc-canon-graph'
import { MODEL, STORY } from './config'
import { canonJson, validateStory } from './canon'
import { canonicalYaml, getClient, makeReadStoryTool } from './agent'
import {
  type Capability,
  checkPathWrite,
  checkRecordWrite,
  covered,
  diffRecords,
  mintId,
  recordsIn,
} from './capability'
import { load as yamlLoad } from 'js-yaml'
import { currentEngine, runCliPrompt, stripFences } from './engine'
import { resolveWithin } from './safe-path'
import { takenIds } from './records'
import type { IntentEnvelope } from './intent'
import type { Run } from './run'

const WORKER_RULES = `You are arc's MATERIAL WORKER. The author said something about their story
that is not yet a decision. Your job is to file it as ONE material item so it
is not lost — and to leave it exactly as undecided as they left it.

WHAT MATERIAL IS (conventions §12): the first rung of the ladder — material,
proposed, canon, manuscript. Material is never load-bearing. Nothing in the
story may depend on it. Vagueness is the point: NEVER invent precision to
fill a schema field.

THE FAILURE YOU MUST AVOID. Given "Carlos needs a childhood friend, maybe
someone from the neighbourhood who turns sympathetic to the Revolution, I
don't know where he appears yet", the WRONG output invents "Rafael, born
1945, lives on Calle Empedrado". The RIGHT output records the need, what it
would do for the story, the constraints the author stated, and the fact that
placement is unresolved. You are capturing creative intent, not committing
story truth. If you find yourself naming a person the author did not name,
stop.

THE FILE. Write exactly one file to material/<slug>.yaml with write_material_file:

  id: mat.<slug>          — from mint_id, never invented
  type: character-need | unplaced-scene | motif-idea | relationship | obligation | gap
  status: unplaced
  body: >                 — the material itself, as vague as it honestly is
  purpose: >              — what this would do for the story, if known
  constraints: []         — what the author stated, including what is NOT settled
  related: []             — canon ids this touches; ONLY ids that already exist
  window: { from: ch.*, to: ch.* }   — omit entirely unless the author implied one

Read before you write. The 'related' list must resolve — an id that does not exist
fails validation and the write is reverted.

YOUR SCOPE. You hold authority over material only. If you believe canon
should change, do NOT try: say so in your final message and let the author
decide. A refused write is a correct outcome, not an error to work around.

Finish with two or three sentences: what you filed, and what you deliberately
left open.`

/** Write one material item, under capability. Material is not canon: it has
 *  its own lifecycle (unplaced → placed → absorbed | dropped) and no
 *  ratification gate, so authority over a material id is an ordinary WRITE. */
export function makeMaterialTool(actions: ChatAction[], cap: Capability) {
  return betaTool({
    name: 'write_material_file',
    description:
      'Write one YAML file under material/. The story is validated after the write; on failure the write ' +
      'is REVERTED and you get the errors back. Read an existing item before rewriting it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'relative path under material/, ending .yaml' },
        content: { type: 'string', description: 'complete YAML file content' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    } as const,
    run: async (input: any) => {
      if (!input.path.startsWith('material/') || !input.path.endsWith('.yaml'))
        throw new Error(`path must be under material/ and end with .yaml: ${input.path}`)

      let parsed: unknown
      try {
        parsed = yamlLoad(input.content)
      } catch (e: any) {
        return `YAML SYNTAX ERROR (nothing written): ${e.message}`
      }
      return writeMaterial(input.path, parsed, cap, actions)
    },
  })
}

/** Gate, write, validate, revert — the one path both engines share, so the
 *  capability model holds identically whether or not the worker had tools. */
export function writeMaterial(rel: string, parsed: unknown, cap: Capability, actions: ChatAction[]): string {
  const abs = resolveWithin(STORY, rel)

  // A claim may name material either way — by id (mat.*) or by path
  // (material/*) — so either grant suffices; denial needs both to fail.
  const prev = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null
  const before = prev === null ? [] : recordsIn(yamlLoad(prev), rel)
  const scope = checkRecordWrite(cap, diffRecords(before, recordsIn(parsed, rel)))
  if (!scope.ok && !checkPathWrite(cap, rel).ok) {
    actions.push({ tool: 'write_material_file', path: rel, ok: false, detail: `scope exceeded: ${scope.denied!.join(', ')}` })
    return scope.message!
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, canonicalYaml(parsed))
  const check = validateStory()
  if (!check.ok) {
    if (prev !== null) fs.writeFileSync(abs, prev)
    else fs.unlinkSync(abs)
    actions.push({ tool: 'write_material_file', path: rel, ok: false, detail: 'validation failed, reverted' })
    return `VALIDATION FAILED — write reverted. Fix these and retry:\n${check.output}`
  }
  actions.push({ tool: 'write_material_file', path: rel, ok: true })
  return `OK — written and validated (${check.output})`
}

/** mint_id scoped to this worker. The widening it performs is recorded on the
 *  run, which is what makes claim expansion measurable rather than invisible. */
export function makeMintTool(actions: ChatAction[], cap: Capability, run: Run, node: string) {
  return betaTool({
    name: 'mint_id',
    description:
      'Ask arc for a new permanent ID before creating anything. arc allocates it under the ID conventions, ' +
      'checks the whole story for collisions, and grants you authority over it. Never invent an ID.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'material | character | place | faction | object | event | relationship' },
        hint: { type: 'string', description: 'the name to slugify, e.g. "carlos childhood friend"' },
      },
      required: ['type', 'hint'],
      additionalProperties: false,
    } as const,
    run: async (input: any) => {
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
      // Material has no ratification gate (conventions §12), so a minted
      // material id is an ordinary write; canon ids are only ever PROPOSE.
      const verb: 'writes' | 'proposes' = input.type === 'material' ? 'writes' : 'proposes'
      if (!covered(cap[verb], id)) {
        cap[verb] = [...cap[verb], id]
        run.recordExpansion(node, `${verb === 'writes' ? 'WRITE' : 'PROPOSE'} ${id}`)
      }
      actions.push({ tool: 'mint_id', path: id, ok: true, detail: `granted ${verb} ${id}` })
      return `OK — minted ${id}. You may now write it.`
    },
  })
}

export interface WorkerResult {
  reply: string
  actions: ChatAction[]
}

const CLI_NOTE = `ENGINE NOTE: you have no tools in this mode. Do not attempt tool calls, and
do not write a file. Reply with ONLY one JSON object:

{"slug_hint":"a short kebab-case name for this item, e.g. carlos-childhood-friend",
 "item":{"type":"character-need","status":"unplaced","body":"...","purpose":"...",
         "constraints":["..."],"related":["char.carlos"]},
 "account":"two or three sentences: what you filed and what you deliberately left open"}

Omit any field you do not honestly know — especially "window". Do NOT include
an "id": arc assigns it. No prose outside the JSON, no code fence.`

/** The toolless engine path. arc mints the id and runs the gate here in Node,
 *  so this path cannot invent a permanent id even in principle — the same
 *  invariant the tool path enforces, made structural. */
function runMaterialWorkerCli(
  envelope: IntentEnvelope,
  context: string,
  cap: Capability,
  run: Run,
  node: string,
): WorkerResult {
  const actions: ChatAction[] = []
  const prompt = [
    WORKER_RULES,
    `=== THE AUTHOR'S REQUEST, AS INTAKE READ IT ===\n${JSON.stringify(envelope, null, 2)}`,
    `=== WHAT THE AUTHOR ACTUALLY SAID ===\n${run.root.raw_author_input}`,
    `=== YOUR CONTEXT (every fact here carries the reason it was included) ===\n${context}`,
    CLI_NOTE,
  ].join('\n\n')

  const raw = stripFences(runCliPrompt(prompt, { cwd: STORY }).text)
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error(`material worker did not return JSON: ${raw.slice(0, 200)}`)
  const out = JSON.parse(raw.slice(start, end + 1)) as {
    slug_hint?: string
    item?: Record<string, unknown>
    account?: string
  }
  if (!out.item) throw new Error('material worker returned no item')

  if (!cap.creates.some(g => g.type === '*' || g.type === 'material'))
    return { reply: 'SCOPE_EXCEEDED — this claim grants no CREATE material.', actions }

  const id = mintId('material', out.slug_hint || envelope.requested_outcome || 'untitled', takenIds())
  if (!covered(cap.writes, id)) {
    cap.writes = [...cap.writes, id]
    run.recordExpansion(node, `WRITE ${id}`)
  }
  actions.push({ tool: 'mint_id', path: id, ok: true, detail: `granted writes ${id}` })

  delete out.item.id
  const rel = `material/${id.slice('mat.'.length)}.yaml`
  const result = writeMaterial(rel, { id, ...out.item }, cap, actions)
  return { reply: `${out.account ?? ''}\n\n${result}`.trim(), actions }
}

export async function runMaterialWorker(
  envelope: IntentEnvelope,
  context: string,
  cap: Capability,
  run: Run,
  node: string,
): Promise<WorkerResult> {
  if (currentEngine() === 'claude-cli') return runMaterialWorkerCli(envelope, context, cap, run, node)

  const actions: ChatAction[] = []
  const prompt = [
    `=== THE AUTHOR'S REQUEST, AS INTAKE READ IT ===\n${JSON.stringify(envelope, null, 2)}`,
    `=== WHAT THE AUTHOR ACTUALLY SAID ===\n${run.root.raw_author_input}`,
    `=== YOUR CONTEXT (every fact here carries the reason it was included) ===\n${context}`,
    'File the material item.',
  ].join('\n\n')

  const final = await getClient().beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    system: [{ type: 'text', text: WORKER_RULES, cache_control: { type: 'ephemeral' } }],
    tools: [makeReadStoryTool(cap), makeMaterialTool(actions, cap), makeMintTool(actions, cap, run, node)],
    messages: [{ role: 'user', content: prompt }],
    max_iterations: 10,
  })

  const reply = final.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')
  return { reply, actions }
}

/** The canon export, trimmed to what the worker's claim lets it read. Slice 1
 *  keeps this simple and honest: the anchors plus the story's own record. The
 *  traversal-based context pack is what replaces it. */
export function buildWorkerContext(anchors: string[]): string {
  const doc = JSON.parse(canonJson()) as {
    story?: unknown
    entities?: Record<string, unknown>
    events?: Record<string, unknown>
    chapters?: { id: string }[]
  }
  const picked: Record<string, unknown> = {}
  for (const id of anchors) {
    const e = doc.entities?.[id] ?? doc.events?.[id]
    if (e) picked[id] = e
  }
  return JSON.stringify(
    {
      story: doc.story,
      included_because: 'named as an anchor by the intake pass',
      anchors: picked,
      chapter_ids: (doc.chapters ?? []).map(c => c.id),
      note: 'Only the anchors are expanded. Use read_story_file for anything else your scope allows.',
    },
    null,
    2,
  )
}
