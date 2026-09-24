// A disposable story repo in tmpdir: minimal canon/, a committed prose
// scene, git identity configured. Each test file makes its own and points
// ARC_STORY_PATH at it BEFORE importing any src module — config resolves
// paths at module load.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
}

export function writeScene(dir: string, rel: string, id: string, body: string, extraFrontmatter = ''): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(
    path.join(dir, rel),
    `---\nscene: ${id}\nchapter: ch.01\nstatus: proposed\nfacts: []\nevents: []\n${extraFrontmatter}---\n\n${body}\n`,
  )
}

/** A disposable copy of arc-core's worked example — a story whose canon
 *  actually exports, which makeStory()'s minimal one does not. Use it when the
 *  test needs a route that reads the graph (/api/canon) rather than just a
 *  scene on disk.
 *
 *  On top of the example's own scene (sc.01-1, since A67-9) this writes a
 *  second one in ch.02, bound to the wreck — the tests that predate the
 *  example's prose were written against it, and a scene anchored on ids that
 *  resolve is what gives a lens a non-empty context to read. */
export function makeExampleStory(): string {
  return copyExampleStory(dir => {
    fs.mkdirSync(path.join(dir, 'prose', 'ch-02'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'prose', 'ch-02', 'scene-01.md'),
      [
        '---',
        'scene: sc.02-1',
        'chapter: ch.02-the-aurelia',
        'status: proposed',
        'pov: char.ines',
        'facts: [char.ines, char.wren, place.whitcombe-light]',
        'events: [event.the-wreck]',
        '---',
        '',
        'The light held. Below it the sea did what the sea does, and Ines counted',
        'the stairs down because counting was the only arithmetic left to her.',
        '',
      ].join('\n'))
  })
}

/** The worked example exactly as arc-core ships it, in one commit — one
 *  scene in ch.01 with its key points, a resolved note and a locked
 *  paragraph (A67-9). The fixture engine's briefs are fingerprinted over
 *  this copy, so a fixture test starts from it and nothing more; a test that
 *  wants more writes it in `augment`, before the one commit. */
export function copyExampleStory(augment?: (dir: string) => void): string {
  const src = path.resolve(process.env.ARC_CORE_PATH ?? '../arc-core', 'examples/example-story')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-test-example-'))
  fs.cpSync(src, dir, { recursive: true })
  augment?.(dir)
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@test')
  git(dir, 'config', 'user.name', 'test')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'the worked example')
  return dir
}

export function makeStory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-test-story-'))
  fs.mkdirSync(path.join(dir, 'canon'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'canon', 'story.yaml'), 'title: Test Story\n')
  writeScene(dir, 'prose/ch-01/scene-01.md', 'sc.01-1', 'Original first paragraph.\n\nSecond paragraph.')
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@test')
  git(dir, 'config', 'user.name', 'test')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'prose: first scene')
  return dir
}

/** A `claude` on PATH that speaks the streamed shape the seam parses
 *  (A67-2): an init event with the toolbelt the argv asked for, then a
 *  result. `answer` is a JavaScript expression evaluated in the stub with
 *  `prompt` (stdin) and `argv` in scope — the test decides what the model
 *  says; `before` is a statement run first (a marker, a log, a refusal).
 *  Every test that spawns sets ARC_HOME to its own directory here, so the
 *  seam's scratch parent never touches the author's home. */
export function installStubCli(opts: { answer?: string; before?: string; delayMs?: number; name?: string } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `arc-stub-${opts.name ?? 'cli'}-`))
  // realpath'd: macOS's tmpdir is a symlink, and a child reports where it
  // really ran.
  process.env.ARC_HOME ??= fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arc-home-')))
  const bin = path.join(dir, 'claude')
  fs.writeFileSync(bin, `#!/usr/bin/env node
// Stands in for \`claude -p --output-format stream-json --verbose\`.
if (process.argv.includes('--version')) { process.stdout.write('stub 1.0\\n'); process.exit(0) }
const argv = process.argv.slice(2)
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1] }
const chunks = []
process.stdin.on('data', c => chunks.push(c))
process.stdin.on('end', () => {
  const prompt = chunks.join('')
  ${opts.before ?? ''}
  ${opts.delayMs ? `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${opts.delayMs})` : ''}
  const tools = process.env.STUB_TOOLS ? process.env.STUB_TOOLS.split(',') : flag('--tools') === '' ? [] : ['Read', 'Edit', 'Bash']
  const session_id = flag('--session-id') ?? flag('--resume') ?? 'stub-session'
  const line = o => process.stdout.write(JSON.stringify(o) + '\\n')
  if (!process.env.STUB_NOINIT) line({ type: 'system', subtype: 'init', cwd: process.env.STUB_CWD || process.cwd(), session_id: process.env.STUB_SESSION || session_id, tools,
    mcp_servers: process.env.STUB_SERVERS ? process.env.STUB_SERVERS.split(',').map(name => ({ name, status: 'connected' })) : [], model: 'stub-model',
    permissionMode: 'default', apiKeySource: 'none', claude_code_version: 'stub 1.0', skills: ['arc-canon'], agents: [], plugins: [],
    memory_paths: { auto: (process.env.STUB_PROJECTS || require('node:path').join(process.env.ARC_HOME, 'stub-projects')) + '/memory/' },
    arc_run_id: process.env.ARC_RUN_ID ?? null })
  const result = ${opts.answer ?? "'ok'"}
  line({ type: 'result', subtype: 'success', is_error: false, session_id, result, duration_ms: 1, num_turns: 1,
    usage: { input_tokens: prompt.length, output_tokens: String(result).length } })
})
`)
  fs.chmodSync(bin, 0o755)
  return dir
}
