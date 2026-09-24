// Re-fingerprint every fixture after a deliberate brief change (A67-9):
//
//   npm run fixtures:rekey
//
// Runs each scenario in order, reads the fingerprint the fixture engine was
// actually handed, and writes it into the fixture's frontmatter. Only the
// fingerprint moves — the recorded answer is the author of the fixture's to
// change by hand. Order matters: the rewrite scenarios need explore.scene.one-shot/lands to
// HIT, so its new fingerprint is on disk before they run.
import fs from 'node:fs'
import { SCENARIOS, renderScenario } from './fixture-scenarios.ts'
import { loadFixtures } from '../src/fixtures.ts'

let moved = 0
for (const s of SCENARIOS) {
  // A scenario the leak gate refuses never sends a brief, so it has no
  // recorded answer to rekey (A67-7).
  if (s.expect === 'leak') { console.log(`${s.row}/${s.name}  refused before the send — nothing to record`); continue }
  const fixture = loadFixtures().find(f => f.row === s.row && f.name === s.name)
  if (!fixture) { console.error(`no fixture on disk for ${s.row}/${s.name} — write fixtures/${s.row}/${s.name}.md first`); process.exit(1) }
  const { seen } = await renderScenario(s)
  const rendered = seen[0]?.fingerprint
  if (!rendered) { console.error(`${s.row}/${s.name}: no brief reached the fixture engine`); process.exit(1) }
  if (rendered === fixture.fingerprint) { console.log(`${s.row}/${s.name}  ${rendered}  unchanged`); continue }
  const text = fs.readFileSync(fixture.file, 'utf8')
  fs.writeFileSync(fixture.file, text.replace(/^fingerprint: .*$/m, `fingerprint: ${rendered}`))
  console.log(`${s.row}/${s.name}  ${fixture.fingerprint} → ${rendered}`)
  moved++
}
console.log(moved ? `${moved} fixture${moved === 1 ? '' : 's'} rekeyed — review the diff, then run the tests` : 'every fixture already matches its brief')
