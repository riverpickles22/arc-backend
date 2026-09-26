// Re-fingerprint every fixture after a deliberate brief change (A67-9):
//
//   npm run fixtures:rekey -- --because "the pack carries the POV's wants and fears (A69-1)"
//
// The reason is REQUIRED when anything moves (A69-1). A fingerprint is the
// promise that the brief is the one that was recorded; changing it silently
// turns the fixture store into something that agrees with whatever the brief
// became. The reason is written onto every fixture the rekey moves, and the
// ones it does not move are left alone.
//
// Runs each scenario in order, reads the fingerprint the fixture engine was
// actually handed, and writes it into the fixture's frontmatter. Only the
// fingerprint moves — the recorded answer is the author of the fixture's to
// change by hand. Order matters: the rewrite scenarios need explore.scene.one-shot/lands to
// HIT, so its new fingerprint is on disk before they run.
import fs from 'node:fs'
import { SCENARIOS, renderScenario } from './fixture-scenarios.ts'
import { loadFixtures } from '../src/fixtures.ts'

const flag = process.argv.indexOf('--because')
const BECAUSE = flag >= 0 ? (process.argv[flag + 1] ?? '').trim() : ''

// Checked BEFORE the scenarios run, not when the first one moves: every
// scenario is a full pass over the story, and being told at the end that the
// flag was missing costs the whole suite.
if (!BECAUSE) {
  console.error(
    'a rekey has to say why the brief moved, and the reason is recorded on every fixture it touches:\n' +
    '  npm run fixtures:rekey -- --because "what changed, and the card that changed it"')
  process.exit(1)
}

/** Rewrite one frontmatter field, in the frontmatter ONLY. The recorded
 *  answer below it is model prose and may hold a line starting `because:` or
 *  `fingerprint:` of its own; a whole-file replace would edit the answer and
 *  leave the header untouched. The replacement is a function so a reason
 *  containing `$&` or `$1` is written as the author typed it. */
function setField(text: string, field: string, value: string): string {
  const head = text.match(/^---\n([\s\S]*?)\n---\n/)
  if (!head) throw new Error('fixture has no frontmatter')
  const line = new RegExp(`^${field}: .*$`, 'm')
  const block = line.test(head[1])
    ? head[1].replace(line, () => `${field}: ${value}`)
    : `${head[1]}\n${field}: ${value}`
  return `---\n${block}\n---\n` + text.slice(head[0].length)
}

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
  fs.writeFileSync(fixture.file,
    setField(setField(text, 'fingerprint', rendered), 'because', JSON.stringify(BECAUSE)))
  console.log(`${s.row}/${s.name}  ${fixture.fingerprint} → ${rendered}`)
  moved++
}
console.log(moved ? `${moved} fixture${moved === 1 ? '' : 's'} rekeyed — review the diff, then run the tests` : 'every fixture already matches its brief')
