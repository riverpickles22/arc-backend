// Canonical serialization (multi-author early lock 3): agent writes land
// deterministically formatted, so diffs are semantic.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeStory } from './fixture.ts'

process.env.ARC_STORY_PATH = makeStory()
const { canonicalYaml } = await import('../src/agent.ts')
const { load } = await import('js-yaml')

test('canonicalYaml is a fixed point (dump ∘ load ∘ dump is stable)', () => {
  const messy = 'id: "char.x"\nname:   Ana\nstates:\n    - at: {era: era.a, date: "1951"}\n      beliefs: [ one , two ]\n'
  const once = canonicalYaml(load(messy))
  const twice = canonicalYaml(load(once))
  assert.equal(once, twice)
})

test('semantically equal inputs with different formatting land identical', () => {
  const a = canonicalYaml(load('id: char.x\nname: Ana\ntags: [a, b]\n'))
  const b = canonicalYaml(load('id:    "char.x"\nname: "Ana"\ntags:\n  - a\n  - b\n'))
  assert.equal(a, b)
})

test('insertion order is preserved, not sorted', () => {
  const out = canonicalYaml(load('zeta: 1\nalpha: 2\n'))
  assert.ok(out.indexOf('zeta') < out.indexOf('alpha'))
})
