// Connected agents. Three properties carry this story: a session working on
// some other repo is ignored rather than mis-attributed, a session arc
// launched itself does not get a second run, and nothing here is ever slow or
// fatal — the hook path sits inside the author's turn.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { StreamMessage } from '../src/run.ts'
import { makeStory } from './fixture.ts'

const STORY = makeStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

const { hook, listAgents, servesThisStory, _resetAgents } = await import('../src/agents.ts')
const { subscribeRuns } = await import('../src/run.ts')
const { getRun } = await import('../src/runs.ts')

const SESSION = 'sess-abc123'

test('a session in another repo is ignored, never mis-attributed', () => {
  _resetAgents()
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'not-the-story-'))
  const out = hook({ event: 'SessionStart', session: SESSION, cwd: elsewhere })
  assert.deepEqual(out, { ok: true, ignored: true })
  assert.equal(listAgents().length, 0, 'arc serves one story; this is not a fact about it')

  assert.equal(servesThisStory(elsewhere), false)
  assert.equal(servesThisStory(STORY), true)
  assert.equal(servesThisStory(path.join(STORY, 'prose')), true, 'a subdirectory is still the story')
  assert.equal(servesThisStory(''), false)
})

test('SessionStart registers presence and announces it', () => {
  _resetAgents()
  const seen: StreamMessage[] = []
  const stop = subscribeRuns(m => { if (m.event.startsWith('agent.')) seen.push(m) })

  hook({ event: 'SessionStart', session: SESSION, cwd: STORY, source: 'claude-code' })
  stop()

  const agent = listAgents()[0]
  assert.equal(agent.session, SESSION)
  assert.equal(agent.state, 'idle')
  assert.equal(agent.run, null, 'presence is not a run')
  assert.ok(agent.since, 'stamped')
  assert.equal(seen[0]?.event, 'agent.connected', 'and the viewer hears about it at once')
})

test('a prompt opens a run carrying the author\'s raw words, with no model involved', () => {
  _resetAgents()
  hook({ event: 'SessionStart', session: SESSION, cwd: STORY })
  const out = hook({ event: 'UserPromptSubmit', session: SESSION, cwd: STORY, prompt: 'make Manuel seem more suspicious here' })

  assert.ok(out.run, 'a run was opened')
  const detail = getRun(out.run!)
  assert.equal(detail.run.prompt, 'make Manuel seem more suspicious here', 'their words, unread')
  assert.equal(detail.run.source, 'claude-code')
  assert.equal(listAgents()[0].state, 'working')
})

test('a prompt arriving before SessionStart still registers the session', () => {
  _resetAgents()
  const out = hook({ event: 'UserPromptSubmit', session: 'sess-late', cwd: STORY, prompt: 'the backend started mid-session' })
  assert.ok(out.run)
  assert.equal(listAgents().length, 1, 'a missed SessionStart must not drop the prompt')
})

test('a session arc launched itself attaches to the run it was given', () => {
  _resetAgents()
  hook({ event: 'SessionStart', session: SESSION, cwd: STORY })
  const before = getRun(hook({ event: 'UserPromptSubmit', session: SESSION, cwd: STORY, prompt: 'first' }).run!).run.id

  // ARC_RUN_ID threaded into the child: the hook must attach, not open a second.
  const out = hook({ event: 'UserPromptSubmit', session: SESSION, cwd: STORY, prompt: 'second', run: before })
  assert.equal(out.run, before, 'no duplicate run for work arc already has one for')
  assert.equal(listAgents()[0].run, before)
})

test('tool use is recorded as something that happened, never as a plan', () => {
  _resetAgents()
  hook({ event: 'SessionStart', session: SESSION, cwd: STORY })
  const run = hook({ event: 'UserPromptSubmit', session: SESSION, cwd: STORY, prompt: 'do a thing' }).run!
  hook({ event: 'PostToolUse', session: SESSION, cwd: STORY, detail: { tool: 'Edit', input: { file: 'prose/ch-01/scene-01.md' } } })

  const agent = listAgents()[0]
  assert.equal(agent.actions.length, 1)
  assert.match(JSON.stringify(agent.actions[0].detail), /scene-01/)
  assert.match(JSON.stringify(getRun(run).events), /scene-01/, 'and it lands on the run too')

  // The shape carries no notion of what comes next, by construction.
  assert.equal('next' in agent, false)
  assert.equal('plan' in agent, false)
})

test('Stop ends the turn; SessionEnd disconnects', () => {
  _resetAgents()
  hook({ event: 'SessionStart', session: SESSION, cwd: STORY })
  hook({ event: 'UserPromptSubmit', session: SESSION, cwd: STORY, prompt: 'something' })
  hook({ event: 'Stop', session: SESSION, cwd: STORY })
  assert.equal(listAgents()[0].state, 'idle')
  assert.equal(listAgents()[0].run, null, 'the turn is over, so the run is no longer this session\'s current one')

  hook({ event: 'SessionEnd', session: SESSION, cwd: STORY })
  assert.equal(listAgents().length, 0)
})

test('an unknown event, or one for a session arc never saw, is accepted and ignored', () => {
  _resetAgents()
  // A Claude release adding a hook type must not start failing sessions.
  assert.deepEqual(hook({ event: 'SomeFutureHook', session: SESSION, cwd: STORY }), { ok: true, ignored: true })
  assert.deepEqual(hook({ event: 'Stop', session: 'never-seen', cwd: STORY }), { ok: true, ignored: true })
  assert.deepEqual(hook({ event: 'SessionStart', session: '', cwd: STORY }), { ok: true, ignored: true })
})

// ---- the installer -------------------------------------------------------

test('installing hooks merges into the author\'s settings and is idempotent', async () => {
  const { execFileSync } = await import('node:child_process')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-settings-'))
  const settings = path.join(dir, 'settings.json')
  // The author already has their own hook and their own permissions.
  fs.writeFileSync(settings, JSON.stringify({
    permissions: { allow: ['Bash(ls:*)'] },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
  }, null, 2))

  const installer = path.join(process.cwd(), '..', 'arc-core', 'hooks', 'install-hooks.mjs')
  const hookScript = path.join(process.cwd(), '..', 'arc-core', 'hooks', 'arc-hook.mjs')
  const run = () => execFileSync('node', [installer], {
    env: { ...process.env, ARC_HOOK: hookScript, ARC_SETTINGS: settings, ARC_PORT: '8787' },
  })

  run()
  const after = JSON.parse(fs.readFileSync(settings, 'utf8'))
  assert.deepEqual(after.permissions, { allow: ['Bash(ls:*)'] }, 'the author\'s own settings are untouched')
  assert.ok(after.hooks.SessionStart.some((g: { hooks: { command: string }[] }) =>
    g.hooks.some(h => h.command === 'echo mine')), 'and so is their own hook')
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']) {
    assert.ok(JSON.stringify(after.hooks[event]).includes('arc-hook.mjs'), `${event} is installed`)
  }

  run()
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), after, 'running it again changes nothing')
})

test('the installer refuses to clobber settings it cannot parse', async () => {
  const { execFileSync } = await import('node:child_process')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-bad-settings-'))
  const settings = path.join(dir, 'settings.json')
  fs.writeFileSync(settings, '{ this is not json')

  const installer = path.join(process.cwd(), '..', 'arc-core', 'hooks', 'install-hooks.mjs')
  assert.throws(() => execFileSync('node', [installer], {
    stdio: 'pipe',
    env: { ...process.env, ARC_HOOK: '/tmp/arc-hook.mjs', ARC_SETTINGS: settings },
  }), 'a non-zero exit, not a rewrite')
  assert.equal(fs.readFileSync(settings, 'utf8'), '{ this is not json', 'left exactly as found')
})

// ---- the script itself ---------------------------------------------------

test('the hook script reads a PIPED payload — the failure unit tests cannot see', async () => {
  // Every test above calls hook() directly, so all of them passed while the
  // script was silently sending an empty payload: it read stdin by file
  // descriptor, which returns nothing for a pipe, so every hook succeeded at
  // doing nothing. Only running the real script catches that.
  const http = await import('node:http')
  const { execFile } = await import('node:child_process')

  const received: Record<string, unknown>[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      try { received.push(JSON.parse(body)) } catch { /* record nothing */ }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise<void>(r => server.listen(0, r))
  const port = (server.address() as { port: number }).port

  const script = path.join(process.cwd(), '..', 'arc-core', 'hooks', 'arc-hook.mjs')
  const code = await new Promise<number>(resolve => {
    const child = execFile('node', [script, 'UserPromptSubmit'],
      { env: { ...process.env, ARC_PORT: String(port), ARC_RUN_ID: 'run.0042' } },
      () => resolve(0))
    child.stdin!.end(JSON.stringify({ session_id: 'piped', cwd: STORY, prompt: 'typed by the author' }))
  })
  server.close()

  assert.equal(code, 0)
  assert.equal(received.length, 1, 'the script reached the backend')
  assert.equal(received[0].session, 'piped', 'and carried the session it was piped')
  assert.equal(received[0].prompt, 'typed by the author', 'and the words')
  assert.equal(received[0].run, 'run.0042', 'and ARC_RUN_ID, so arc does not open a second run')
})

test('the hook exits 0 and stays silent when nothing is listening', async () => {
  const { execFile } = await import('node:child_process')
  const script = path.join(process.cwd(), '..', 'arc-core', 'hooks', 'arc-hook.mjs')
  const out = await new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    // Port 1 is reliably nothing.
    const child = execFile('node', [script, 'SessionStart'],
      { env: { ...process.env, ARC_PORT: '1' } },
      (err, stdout, stderr) => resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, stdout, stderr }))
    child.stdin!.end(JSON.stringify({ session_id: 'x', cwd: STORY }))
  })
  assert.equal(out.code, 0, 'a stopped backend must never fail the author\'s session')
  assert.equal(out.stdout, '', 'and never write to stdout — on some hooks that is model input')
  assert.equal(out.stderr, '')
})
