// The one path guard: traversal, absolutes, and symlink escapes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveWithin } from '../src/safe-path.ts'
import { HttpError } from '../src/http.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-safe-'))
fs.mkdirSync(path.join(root, 'sub'))
fs.writeFileSync(path.join(root, 'sub', 'ok.md'), 'fine')

const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-outside-'))
fs.writeFileSync(path.join(outside, 'secret.md'), 'secret')

const rejects400 = (fn: () => unknown) =>
  assert.throws(fn, (e: unknown) => e instanceof HttpError && e.status === 400)

test('plain paths inside the root resolve', () => {
  assert.equal(resolveWithin(root, 'sub/ok.md'), path.join(fs.realpathSync(root), 'sub', 'ok.md'))
  // the root itself is allowed
  assert.equal(resolveWithin(root, '.'), fs.realpathSync(root))
})

test('missing paths still resolve (writes create them)', () => {
  assert.ok(resolveWithin(root, 'sub/new-file.md').endsWith('new-file.md'))
})

test('dot-dot traversal is rejected', () => {
  rejects400(() => resolveWithin(root, '../evil.md'))
  rejects400(() => resolveWithin(root, 'sub/../../evil.md'))
})

test('absolute paths are rejected', () => {
  rejects400(() => resolveWithin(root, '/etc/hosts'))
})

test('a symlink planted inside the tree cannot escape', () => {
  fs.symlinkSync(outside, path.join(root, 'sneaky'))
  rejects400(() => resolveWithin(root, 'sneaky/secret.md'))
  // a symlinked directory on the path is caught too, even for missing leaves
  rejects400(() => resolveWithin(root, 'sneaky/new.md'))
})
