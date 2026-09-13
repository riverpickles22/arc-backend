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
 *  `pass` is null when the call names none at all — the failure this story
 *  exists to make impossible. It is 'variable' when the call passes a typed
 *  one through rather than a literal: reroute's single launch serves both
 *  route passes and takes the name as an argument, which is still the
 *  registry deciding, with tsc proving the name is one of its rows. */
function launchSites(): { file: string; pass: string | 'variable' | null }[] {
  const out: { file: string; pass: string | 'variable' | null }[] = []
  for (const file of fs.readdirSync(SRC).filter(f => f.endsWith('.ts'))) {
    const source = fs.readFileSync(path.join(SRC, file), 'utf8')
    const re = /runCliPrompt\s*\(/g
    for (let m = re.exec(source); m; m = re.exec(source)) {
      // The definition itself is not a launch.
      const head = source.slice(Math.max(0, m.index - 40), m.index)
      if (/function\s+$/.test(head) || /export\s+$/.test(head)) continue
      const text = callText(source, m.index + m[0].length - 1)
      const literal = /\bpass:\s*'([^']+)'/.exec(text)
      // the shorthand property — `{ cwd, pass, noTools }`
      const shorthand = /[{,]\s*pass\s*[,}]/.test(text)
      out.push({ file, pass: literal ? literal[1] : shorthand ? 'variable' : null })
    }
  }
  return out
}

/** Rows no launch site names as a literal, each for a stated reason. */
const ACCOUNTED: Record<string, string> = {
  // reaches the model through the SDK's tool runner, not this seam; it is
  // registered ahead of the CLI path it gets in slice 4 (§11)
  capture: 'off-seam, SDK tool runner',
  // one launch site serves both, taking the name as a typed argument
  reroute: 'named through a variable at reroute.ts',
  'reroute-revise': 'named through a variable at reroute.ts',
}

test('every launch in src names a pass, and every pass it names has a row', () => {
  const sites = launchSites()
  assert.ok(sites.length >= 12, `expected the backend's launch sites, found ${sites.length}`)

  const silent = sites.filter(s => s.pass === null)
  assert.deepEqual(silent, [],
    `these launch with no pass, so the registry cannot decide their tools: ${silent.map(s => s.file).join(', ')}`)

  const unregistered = sites.filter(s => s.pass !== 'variable' && !(s.pass! in PASS_REGISTRY))
  assert.deepEqual(unregistered, [],
    `these name a pass with no row: ${unregistered.map(s => `${s.file} (${s.pass})`).join(', ')}`)
})

test('every row in the registry is reached by a launch, or is honestly accounted for', () => {
  const named = new Set(launchSites().map(s => s.pass))
  const orphans = (Object.keys(PASS_REGISTRY) as PassName[])
    .filter(p => !named.has(p) && !(p in ACCOUNTED))
  assert.deepEqual(orphans, [],
    `these rows have no launch site — delete the row or name it at the call: ${orphans.join(', ')}`)
})

/** A `claude` that answers nothing and records the argv it was handed. */
function installRecordingCli(): { dir: string; argvFile: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-argv-cli-'))
  const argvFile = path.join(dir, 'argv.json')
  const bin = path.join(dir, 'claude')
  fs.writeFileSync(bin, `#!/usr/bin/env node
// Records what the seam asked for, answers in the shape the seam parses.
const fs = require('fs')
if (process.argv.includes('--version')) { process.stdout.write('stub 1.0\\n'); process.exit(0) }
const chunks = []
process.stdin.on('data', c => chunks.push(c))
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)) + '\\n')
  process.stdout.write(JSON.stringify({
    subtype: 'success', is_error: false, session_id: 'stub-session', result: 'ok',
  }))
})
`)
  fs.chmodSync(bin, 0o755)
  return { dir, argvFile }
}

const recorder = installRecordingCli()
process.env.PATH = `${recorder.dir}${path.delimiter}${process.env.PATH}`

const recorded = (): string[][] =>
  fs.readFileSync(recorder.argvFile, 'utf8').trim().split('\n').map(l => JSON.parse(l) as string[])

test('every reading pass really launches with an empty toolbelt, argv recorded from the spawn', async () => {
  // The six the author pinned on 2026-09-11. The point is the whole path —
  // call site to registry to builder to spawn — not the builder alone, which
  // invocation.test.ts covers. Read from the child's own argv, so a change
  // anywhere along that path shows up here.
  for (const pass of ['analyze', 'judge', 'suggest', 'intent', 'lenses', 'bootstrap'] as const) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-argv-cwd-'))
    await runCliPrompt('read this', { pass, cwd })
    const argv = recorded().at(-1)!
    const i = argv.indexOf('--tools')
    assert.notEqual(i, -1, `${pass} must be spawned with --tools; got ${argv.join(' ')}`)
    assert.equal(argv[i + 1], '', `${pass} must be spawned with an empty toolbelt`)
  }
})

test('a pass the author did not pin keeps its tools, so the pin is a decision and not a blanket', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-argv-cwd-'))
  await runCliPrompt('write this', { pass: 'draft', cwd })
  assert.ok(!recorded().at(-1)!.includes('--tools'))
})
