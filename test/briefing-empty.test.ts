// The briefing on a story with no history yet: honest and empty, not an error.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { git } from './fixture.ts'

const STORY = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-test-empty-'))
fs.mkdirSync(path.join(STORY, 'canon'))
fs.writeFileSync(path.join(STORY, 'canon', 'story.yaml'), 'title: Nothing Yet\n')
git(STORY, 'init', '-q')   // a repository with no commits: the draft layer exists, the history does not
process.env.ARC_STORY_PATH = STORY
const { createArcServer } = await import('../src/server.ts')

const server = createArcServer()
await new Promise<void>(resolve => server.listen(0, resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
test.after(() => server.close())

test('no commits, no prose: an empty briefing with a 200', async () => {
  const res = await fetch(base + '/api/briefing')
  assert.equal(res.status, 200)
  const b = await res.json()
  assert.deepEqual(b, { git: true, lastAccepted: null, draft: [], notes: [], routes: {}, unplaced: 0, due: [], lastSession: [] })
})
