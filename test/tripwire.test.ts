// The tripwire itself (A70-7): the defaults it sets, and that a `claude`
// found on PATH by a test that pinned nothing refuses and leaves a marker.
// The spawn below points ARC_TRIPWIRE_MARKER at its own directory so this
// test does not trip the process it runs in.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
// Arms the tripwire when this file is run by hand; a no-op under the npm
// script, which preloaded the same module.
import './tripwire.ts'

test('the test run defaults to no engine and a scratch home outside ~/.arc', () => {
  assert.equal(process.env.ARC_DRAFT_ENGINE, 'none')
  assert.ok(process.env.ARC_HOME, 'ARC_HOME is set')
  assert.ok(!process.env.ARC_HOME!.startsWith(path.join(os.homedir(), '.arc')), 'never under ~/.arc')
  assert.ok(process.env.ARC_TRIPWIRE_MARKER, 'the marker path is in the environment for children')
})

test('the claude first on PATH answers --version and refuses a prompt, naming the pass', () => {
  const first = (process.env.PATH ?? '').split(path.delimiter)[0]
  const bin = path.join(first, 'claude')
  assert.ok(fs.existsSync(bin), `a claude sits first on PATH (${first})`)
  assert.ok(fs.readFileSync(bin, 'utf8').includes('tripwire'), 'and it is the tripwire')

  const version = spawnSync(bin, ['--version'], { encoding: 'utf8' })
  assert.equal(version.status, 0)
  assert.match(version.stdout, /tripwire/)

  const mine = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-tripwire-test-'))
  const marker = path.join(mine, 'reached')
  const r = spawnSync(bin, ['-p', '--output-format', 'stream-json'], {
    encoding: 'utf8', input: 'hello',
    env: { ...process.env, ARC_TRIPWIRE_MARKER: marker, ARC_PASS: 'learn-style', ARC_RUN_ID: 'run-1' },
  })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /never reach the real claude/)
  assert.match(r.stderr, /pass=learn-style/)
  assert.ok(fs.existsSync(marker), 'the marker is written where the environment says')
  assert.match(fs.readFileSync(marker, 'utf8'), /pass=learn-style run=run-1 · claude -p --output-format stream-json/)
  assert.ok(!fs.existsSync(process.env.ARC_TRIPWIRE_MARKER!), 'this process did not trip')
  fs.rmSync(mine, { recursive: true, force: true })
})
