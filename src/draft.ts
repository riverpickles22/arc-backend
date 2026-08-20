// The drafting pass: generation INTO the working tree. The author asks for a
// scene; the model drafts it from the record's own context — the context-pack
// bundle (every fact carrying its inclusion reason, payoffs fenced) plus the
// story's style contract (docs/style.md) — and writes one scene file into
// prose/ as an ordinary draft. No new review machinery: the result arrives
// word-diffed in the existing draft layer, and the author's accept (which
// runs capture) or discard stays the only gate. Iterating is discard +
// regenerate with guidance appended.
import fs from 'node:fs'
import path from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import type { CanonDoc, ChatAction, DraftSceneResponse } from 'arc-canon-graph'
import { buildContextPack } from 'arc-canon-graph/context-pack-lib.ts'
import { MODEL, STORY } from './config'
import { canonJson, validateStory } from './canon'
import { getClient, makeReadStoryTool } from './agent'
import { currentEngine, runCliPrompt, stripFences } from './engine'
import { styleContract } from './style'
import { recordGenerated } from './ledger'
import { proseScenes } from './story'
import { HttpError } from './http'
import { resolveWithin } from './safe-path'

const DRAFT_RULES = `You are arc's DRAFTING PASS. The author asked you to draft ONE scene of
their novel. You write it as a complete scene file — frontmatter binding plus
prose body — via the write_scene_file tool, at exactly the path you are given.

THE SCENE FILE (conventions §10):
- Frontmatter: scene (the id you are given), chapter, status: proposed, pov
  (the chapter's POV where one exists), events (the chapter events this scene
  actually depicts), facts (the entity/relationship ids the prose rests on),
  and a contract block stating the intent you drafted to — purpose,
  must_establish, must_withhold at minimum.
- Every id in the binding must resolve in canon. The context pack below lists
  the ids available to you; do not invent ids. Validation failures come back
  to you — fix the file and retry.

THE PROSE (binding rules, in priority order):
1. The style contract below is law. Run its pre-draft checklist before
   writing; a scene that violates the POV/tense contract, the no-comment law,
   or the sensory rules is a failed draft even if the plot is right.
2. The payoff fence: events listed under "Planted payoffs — do not reveal"
   are known to the record, NOT to this scene. Nothing may foreshadow them
   knowingly.
3. POV knowledge: the scene knows only what its POV could know at T. Events
   marked "happens after T" must not leak. Characters marked not living at T
   appear only as memory.
4. The anachronism boundary: nothing — object, phrase, attitude — that
   postdates the scene's span.
5. Canon is truth: contradict nothing in the context pack. Where canon is
   silent you may invent texture (minor sensory detail, unnamed passers-by),
   but any invention that deserves a record belongs in the briefing's
   "to verify" list, not silently in the prose.
- Length: a full dramatic scene, typically 700–1200 words, unless the
  author's guidance says otherwise.

THE BRIEFING (your final message — keep it tight):
1. What the scene does and the contract you drafted to.
2. Style-contract check — each checklist item, held or knowingly bent.
3. To verify — inventions or borderline claims a human should confirm.

=== THE STYLE CONTRACT (conventions §10) ===
`

/** Scene file slot for a chapter: directory from the chapter id's number
 *  (ch.00-prologue → prose/ch-00), next scene number from existing files.
 *  Pure — existingFiles is the story's current prose file list. */
export function sceneSlot(chapterId: string, order: number | undefined, existingFiles: string[]): { file: string; sceneId: string } {
  const m = chapterId.match(/^ch\.(\d+)/)
  const digits = m ? m[1] : String(order ?? 0).padStart(2, '0')
  const dir = `prose/ch-${digits}`
  let max = 0
  for (const f of existingFiles) {
    const sm = f.match(new RegExp(`^${dir}/scene-(\\d+)\\.md$`))
    if (sm) max = Math.max(max, Number(sm[1]))
  }
  const n = max + 1
  return { file: `${dir}/scene-${String(n).padStart(2, '0')}.md`, sceneId: `sc.${digits}-${n}` }
}

/** The user turn: the assignment. Pure, for tests. */
export function draftUserMessage(chapterId: string, sceneId: string, file: string, guidance: string | undefined, chapterScenes: { scene: string; file: string }[]): string {
  const existing = chapterScenes.length
    ? `This chapter already has ${chapterScenes.length} scene(s): ${chapterScenes.map(s => `${s.scene} (${s.file})`).join(', ')} — included above. Your scene follows them; do not retell them.`
    : 'This is the chapter\'s first scene.'
  return [
    `Draft scene ${sceneId} of chapter ${chapterId}.`,
    `Write it with write_scene_file to exactly this path: ${file}`,
    existing,
    guidance?.trim() ? `AUTHOR'S GUIDANCE (binding): ${guidance.trim()}` : '',
    'Run the drafting pass.',
  ].filter(Boolean).join('\n\n')
}

/** Run the drafting pass for a chapter. Throws HttpError(400) on an unknown
 *  chapter; SDK/credential errors are the route's to map. */
export async function runDraft(chapterId: string, guidance?: string): Promise<DraftSceneResponse> {
  const canon = JSON.parse(canonJson()) as CanonDoc
  const chapter = (canon.chapters ?? []).find(c => c.id === chapterId)
  if (!chapter) throw new HttpError(400, `no chapter ${chapterId}`)

  const pack = buildContextPack(canon, { chapter: chapterId })
  const style = styleContract()

  const scenes = proseScenes()
  const { file, sceneId } = sceneSlot(chapterId, chapter.order, scenes.map(s => s.file))
  const chapterScenes = scenes.filter(s => s.chapter === chapterId)
  const scenesText = chapterScenes.map(s => `=== ${s.file} ===\n${fs.readFileSync(path.join(STORY, s.file), 'utf8')}`).join('\n\n')

  if (currentEngine() === 'claude-cli') {
    return await runDraftCli({ chapterId, guidance, pack, style, file, sceneId, chapterScenes, scenesText })
  }

  const actions: ChatAction[] = []
  let written: string | null = null

  const writeSceneFile = betaTool({
    name: 'write_scene_file',
    description:
      'Write the complete scene file (frontmatter + prose body) at the assigned path under prose/. ' +
      'The story is validated after the write; on failure the write is REVERTED and you get the ' +
      'validator errors — fix the file and retry.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'the exact assigned path, e.g. prose/ch-02/scene-01.md' },
        content: { type: 'string', description: 'complete file content: --- frontmatter --- then the prose body' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    } as const,
    run: async (input: any) => {
      if (!String(input.path).startsWith('prose/') || !String(input.path).endsWith('.md'))
        return `path must be under prose/ and end .md: ${input.path}`
      const abs = resolveWithin(STORY, input.path)
      const existed = fs.existsSync(abs)
      const prev = existed ? fs.readFileSync(abs, 'utf8') : null
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, input.content)
      const check = validateStory()
      if (!check.ok) {
        if (prev !== null) fs.writeFileSync(abs, prev)
        else fs.unlinkSync(abs)
        actions.push({ tool: 'write_scene_file', path: input.path, ok: false, detail: 'validation failed, reverted' })
        return `VALIDATION FAILED — write reverted. Fix these and retry:\n${check.output}`
      }
      recordGenerated(input.path, input.content, { engine: 'sdk', scene: sceneId, origin: 'draft' })
      actions.push({ tool: 'write_scene_file', path: input.path, ok: true })
      written = input.path
      return `OK — written and validated (${check.output})`
    },
  })

  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    // Stable per story: rules + the style contract. Own cache breakpoint.
    { type: 'text', text: DRAFT_RULES + style, cache_control: { type: 'ephemeral' } },
    // Volatile: the scene-scoped context pack and the chapter's existing prose.
    {
      type: 'text',
      text: `=== CONTEXT PACK (traversal-selected; every item carries its inclusion reason) ===\n${pack}` +
        (scenesText ? `\n\n=== THIS CHAPTER'S EXISTING SCENES ===\n${scenesText}` : ''),
      cache_control: { type: 'ephemeral' },
    },
  ]

  const finalMessage = await getClient().beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system,
    tools: [makeReadStoryTool(), writeSceneFile],
    messages: [{ role: 'user', content: draftUserMessage(chapterId, sceneId, file, guidance, chapterScenes) }],
    max_iterations: 8,
  })

  const reply = finalMessage.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')

  return { reply, actions, file: written }
}

/** Write scene content through the gate both engines share: record what
 *  arc wrote to the generation ledger, write, validate the whole story,
 *  revert on failure. The ledger entry is only kept when the write survives
 *  — a reverted generation never happened, and must not be mined later. */
function writeScene(rel: string, content: string, engine: string, scene?: string): { ok: boolean; output: string } {
  const check = writeValidated(rel, content)
  if (check.ok) recordGenerated(rel, content, { engine, scene, origin: 'draft' })
  return check
}

export function writeValidated(rel: string, content: string): { ok: boolean; output: string } {
  const abs = resolveWithin(STORY, rel)
  const existed = fs.existsSync(abs)
  const prev = existed ? fs.readFileSync(abs, 'utf8') : null
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  const check = validateStory()
  if (!check.ok) {
    if (prev !== null) fs.writeFileSync(abs, prev)
    else fs.unlinkSync(abs)
  }
  return check
}

/** The claude-cli engine: one shot of headless `claude -p` on the author's
 *  subscription login, plus one repair retry (--resume) when the validator
 *  rejects the scene. Slower and toolless next to the SDK path — the model
 *  replies with the complete file; the gate runs here in Node. */
async function runDraftCli(a: {
  chapterId: string; guidance?: string
  pack: string; style: string; file: string; sceneId: string
  chapterScenes: { scene: string; file: string }[]; scenesText: string
}): Promise<DraftSceneResponse> {
  const prompt = [
    DRAFT_RULES + a.style,
    `=== CONTEXT PACK (traversal-selected; every item carries its inclusion reason) ===\n${a.pack}`,
    a.scenesText ? `=== THIS CHAPTER'S EXISTING SCENES ===\n${a.scenesText}` : '',
    draftUserMessage(a.chapterId, a.sceneId, a.file, a.guidance, a.chapterScenes),
    'ENGINE NOTE: you have no tools in this mode. Do not attempt tool calls. ' +
    'Reply with ONLY the complete scene file content — the --- frontmatter block, then the prose body. ' +
    'No preamble, no commentary, no code fences.',
  ].filter(Boolean).join('\n\n')

  const actions: ChatAction[] = []
  const first = await runCliPrompt(prompt, { cwd: STORY })
  let content = stripFences(first.text)
  let check = writeScene(a.file, content, 'claude-cli', a.sceneId)
  actions.push({ tool: 'write_scene_file', path: a.file, ok: check.ok, detail: check.ok ? undefined : 'validation failed, reverted' })

  if (!check.ok && first.sessionId) {
    const repair = await runCliPrompt(
      `VALIDATION FAILED — the scene was reverted. Fix these and reply with ONLY the corrected complete file content:\n${check.output}`,
      { cwd: STORY, resume: first.sessionId })
    content = stripFences(repair.text)
    check = writeScene(a.file, content, 'claude-cli', a.sceneId)
    actions.push({ tool: 'write_scene_file', path: a.file, ok: check.ok, detail: check.ok ? 'repaired after validator errors' : 'validation failed again, reverted' })
  }

  return {
    reply: check.ok
      ? `Drafted ${a.sceneId} via the claude CLI on the subscription login (no API key). Written and validated: ${a.file}.`
      : `The claude CLI engine could not produce a valid scene — the write was reverted.\n\nValidator output:\n${check.output}`,
    actions,
    file: check.ok ? a.file : null,
  }
}
