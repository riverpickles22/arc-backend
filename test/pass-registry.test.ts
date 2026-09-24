// A55-4: the registry decides a child's tools, not the call site's silence.
//
// Two halves, because the type system reaches one of them and not the other.
// `pass` is required on InvocationOpts, so tsc already refuses a call that
// names none — but tsconfig covers `src` only, and a type is no help at all
// against the failure this story is really about: a NEW pass arriving with a
// call site and no row, or a row quietly losing the posture the author chose.
// So the first test reads the source and enumerates every launch, and the
// second watches a real child being spawned and reads the argv it was given.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PASS_REGISTRY, type PassName } from '../src/invocation.ts'
import { runCliPrompt } from '../src/engine.ts'
import { installStubCli } from './fixture.ts'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** The text of one call, from the paren after the callee to its match.
 *  Counting brackets rather than matching a regex, because the calls are
 *  not all on one line — draft's repair spans three. */
function callText(source: string, openParen: number): string {
  let depth = 0
  for (let i = openParen; i < source.length; i++) {
    const c = source[i]
    if (c === '(') depth++
    else if (c === ')') { depth--; if (depth === 0) return source.slice(openParen, i + 1) }
  }
  return source.slice(openParen)
}

/** Every place in src/ that launches a child through the seam.
 *
 *  Two doors (A67-2). `askRow(row, brief, opts)` is the governed one: the
 *  row is its first argument by type, so every call through it is `rowed`.
 *  `runCliPrompt(prompt, { pass })` is the interim for the passes not yet
 *  migrated: `pass` is null when the call names none at all — the failure
 *  A55-4 exists to make impossible — and 'variable' when it passes a typed
 *  name through rather than a literal. */
function launchSites(): { file: string; pass: string | 'variable' | null; rowed: boolean }[] {
  const out: { file: string; pass: string | 'variable' | null; rowed: boolean }[] = []
  for (const file of fs.readdirSync(SRC).filter(f => f.endsWith('.ts'))) {
    const source = fs.readFileSync(path.join(SRC, file), 'utf8')
    const re = /\b(runCliPrompt|askRow)\s*\(/g
    for (let m = re.exec(source); m; m = re.exec(source)) {
      // The definition itself is not a launch, and neither is a mention in
      // a comment.
      const head = source.slice(Math.max(0, m.index - 40), m.index)
      const lineStart = source.lastIndexOf('\n', m.index) + 1
      if (/function\s+$/.test(head) || /export\s+$/.test(head) || /^\s*(\/\/|\*)/.test(source.slice(lineStart, m.index))) continue
      const text = callText(source, m.index + m[0].length - 1)
      if (m[1] === 'askRow') { out.push({ file, pass: null, rowed: true }); continue }
      const literal = /\bpass:\s*'([^']+)'/.exec(text)
      // the shorthand property — `{ pass, noTools }`
      const shorthand = /[{,]\s*pass\s*[,}]/.test(text)
      out.push({ file, pass: literal ? literal[1] : shorthand ? 'variable' : null, rowed: false })
    }
  }
  return out
}

/** Rows no launch site names as a literal, each for a stated reason. */
const ACCOUNTED: Record<string, string> = {
  // reaches the model through the SDK's tool runner, not this seam; it is
  // registered ahead of the CLI path it gets in slice 4 (§11)
  capture: 'off-seam, SDK tool runner',
}

test('every launch in src names a pass or carries a row, and every pass it names has a row', () => {
  const sites = launchSites()
  assert.ok(sites.length >= 12, `expected the backend's launch sites, found ${sites.length}`)

  const silent = sites.filter(s => s.pass === null && !s.rowed)
  assert.deepEqual(silent, [],
    `these launch with no pass and no row, so nothing decides their tools: ${silent.map(s => s.file).join(', ')}`)

  const unregistered = sites.filter(s => !s.rowed && s.pass !== 'variable' && !(s.pass! in PASS_REGISTRY))
  assert.deepEqual(unregistered, [],
    `these name a pass with no row: ${unregistered.map(s => `${s.file} (${s.pass})`).join(', ')}`)
})

/** THE RATCHET (A67-1; agent-workflows §11, "drift protection starts with
 *  the first row"). Seam launches that carry no registry row — a pass named
 *  by string, with the interim PASS_REGISTRY deciding its tools. Twelve
 *  today, across eleven passes (draft launches twice); reroute's one site
 *  took its row and was never among them. The count may only fall: a
 *  migration lowers this number in the same change, and a new bare launch
 *  fails here. */
const BARE_SEAM_CALLS = 12

test(`the ratchet: ${BARE_SEAM_CALLS} seam launches carry no row, and the count may only fall`, () => {
  const bare = launchSites().filter(s => !s.rowed)
  const where = bare.map(s => `${s.file} (${s.pass})`).join(', ')
  assert.ok(bare.length <= BARE_SEAM_CALLS,
    `${bare.length} launches carry no row, more than the ${BARE_SEAM_CALLS} recorded — a new launch must take a registry row, never a pass name: ${where}`)
  assert.equal(bare.length, BARE_SEAM_CALLS,
    `${bare.length} launches carry no row, fewer than the ${BARE_SEAM_CALLS} recorded — a pass migrated; lower BARE_SEAM_CALLS in the same change: ${where}`)
  assert.equal(new Set(bare.map(s => s.file)).size, 11, 'across eleven passes')
  const rowed = launchSites().filter(s => s.rowed)
  assert.deepEqual(rowed.map(s => s.file), ['gates.ts'], 'the one rowed launch is the gate runner\'s, and it serves every rowed pass')
})

test('every row in the registry is reached by a launch, or is honestly accounted for', () => {
  const named = new Set(launchSites().map(s => s.pass))
  const orphans = (Object.keys(PASS_REGISTRY) as PassName[])
    .filter(p => !named.has(p) && !(p in ACCOUNTED))
  assert.deepEqual(orphans, [],
    `these rows have no launch site — delete the row or name it at the call: ${orphans.join(', ')}`)
})

const argvFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arc-argv-cli-')), 'argv.json')
process.env.PATH = `${installStubCli({
  name: 'argv',
  before: `require('node:fs').appendFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)) + '\\n')`,
})}${path.delimiter}${process.env.PATH}`

const recorded = (): string[][] =>
  fs.readFileSync(argvFile, 'utf8').trim().split('\n').map(l => JSON.parse(l) as string[])

test('every reading pass really launches with an empty toolbelt, argv recorded from the spawn', async () => {
  // The six the author pinned on 2026-09-11. The point is the whole path —
  // call site to registry to builder to spawn — not the builder alone, which
  // invocation.test.ts covers. Read from the child's own argv, so a change
  // anywhere along that path shows up here.
  for (const pass of ['analyze', 'judge', 'suggest', 'intent', 'lenses', 'bootstrap'] as const) {
    await runCliPrompt('read this', { pass })
    const argv = recorded().at(-1)!
    const i = argv.indexOf('--tools')
    assert.notEqual(i, -1, `${pass} must be spawned with --tools; got ${argv.join(' ')}`)
    assert.equal(argv[i + 1], '', `${pass} must be spawned with an empty toolbelt`)
  }
})

test('a pass the author did not pin keeps its tools, so the pin is a decision and not a blanket', async () => {
  await runCliPrompt('write this', { pass: 'draft' })
  assert.ok(!recorded().at(-1)!.includes('--tools'))
})
