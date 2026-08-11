// The gate through the real tools: an out-of-scope write must not reach the
// disk, and minting must be the only way a new permanent ID appears.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { ChatAction } from 'arc-canon-graph'
import { makeStory } from './fixture.ts'

const STORY = makeStory()
process.env.ARC_STORY_PATH = STORY
const { makeStoryTools } = await import('../src/agent.ts')
const { grant, UNRESTRICTED } = await import('../src/capability.ts')

const tool = (tools: any[], name: string) => tools.find(t => t.name === name)!
const CARLOS = 'id: char.carlos\ntype: character\nname: Carlos\nstatus: proposed\n'
const REL = 'canon/entities/characters/carlos.yaml'

test('an out-of-scope canon write leaves no file behind', async () => {
  const actions: ChatAction[] = []
  const tools = makeStoryTools(actions, grant({ reads: ['*'], writes: ['material.*'] }))
  const out = await tool(tools, 'write_canon_file').run({ path: REL, content: CARLOS })

  assert.match(out, /SCOPE_EXCEEDED/)
  assert.equal(fs.existsSync(path.join(STORY, REL)), false, 'nothing touched the disk')
  assert.equal(actions[0].ok, false)
  assert.match(actions[0].detail!, /scope exceeded: char\.carlos/)
})

test('an out-of-scope read returns the refusal instead of the contents', async () => {
  fs.mkdirSync(path.join(STORY, 'research'), { recursive: true })
  fs.writeFileSync(path.join(STORY, 'research/secret.md'), 'the ending\n')

  const tools = makeStoryTools([], grant({ reads: ['canon/*'] }))
  const out = await tool(tools, 'read_story_file').run({ path: 'research/secret.md' })

  assert.match(out, /SCOPE_EXCEEDED/)
  assert.doesNotMatch(out, /the ending/)
})

test('mint_id refuses a type the worker holds no CREATE grant for', async () => {
  const actions: ChatAction[] = []
  const tools = makeStoryTools(actions, grant({ creates: [{ type: 'place' }] }))
  const out = await tool(tools, 'mint_id').run({ type: 'character', hint: 'Rafael' })

  assert.match(out, /SCOPE_EXCEEDED/)
  assert.equal(actions[0].ok, false)
})

test('mint_id widens the capability, and the write that was refused then lands', async () => {
  const actions: ChatAction[] = []
  const cap = grant({ reads: ['*'], writes: [], creates: [{ type: 'character', related_to: 'char.carlos' }] })
  const tools = makeStoryTools(actions, cap)
  const write = tool(tools, 'write_canon_file')

  const before = await write.run({ path: REL, content: CARLOS })
  assert.match(before, /SCOPE_EXCEEDED/)
  assert.match(before, /mint_id type:character/, 'the refusal names the way forward')

  const minted = await tool(tools, 'mint_id').run({ type: 'character', hint: 'Carlos' })
  assert.match(minted, /OK — minted char\.carlos/)
  assert.ok(cap.proposes.includes('char.carlos'), 'the widening is recorded on the capability')

  // The gate now passes it to the validator, which is the next layer down and
  // a separate concern — the temp story has no arc-core venv, so it reverts.
  const after = await write.run({ path: REL, content: CARLOS })
  assert.doesNotMatch(after, /SCOPE_EXCEEDED/)
  assert.ok(actions.some(a => a.tool === 'mint_id' && a.ok), 'the mint is in the action record')
  assert.ok(
    !actions.some(a => a.tool === 'write_canon_file' && a.detail?.startsWith('scope exceeded') && a === actions.at(-1)),
    'the last write was not refused on scope',
  )
})

test('the frozen UNRESTRICTED singleton survives a mint', async () => {
  const tools = makeStoryTools([], UNRESTRICTED)
  const out = await tool(tools, 'mint_id').run({ type: 'place', hint: 'Trinidad' })
  assert.match(out, /OK — minted place\.trinidad/)
})

test('default capability is unrestricted — the author\'s chat is unchanged', async () => {
  const tools = makeStoryTools([])
  const out = await tool(tools, 'write_canon_file').run({
    path: 'canon/entities/places/havana.yaml',
    content: 'id: place.havana\ntype: place\nname: Havana\nstatus: proposed\n',
  })
  assert.doesNotMatch(out, /SCOPE_EXCEEDED/)
})
