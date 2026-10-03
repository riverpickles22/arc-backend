// The test run never spends the author's quota (A70-7).
//
// Loaded before every test file — `--import ./test/tripwire.ts` in the npm
// test script (node's test runner hands its execArgv to each child), and
// again by fixture.ts for a file run by hand; ESM runs it once per process
// either way. Three guarantees, each a default a test may override on
// purpose and none it can fall into by accident:
//
//   1. ARC_DRAFT_ENGINE is 'none'. With no engine named, chooseEngine picks
//      claude-cli whenever a `claude` is on PATH — on the author's machine,
//      theirs. Tests that accept prose reached the style-learning pass that
//      way and made a real model call per run (216 test-story transcripts
//      under ~/.claude/projects by 2026-10-03). A test that wants a model
//      sets the engine itself, after this runs, as the stub tests do.
//   2. ARC_HOME is a fresh temp directory, so the seam's scratch parent never
//      lands under ~/.arc.
//   3. A tripwire `claude` goes FIRST on PATH. It answers `--version` (the
//      engine probes availability with it, even when the engine is pinned)
//      and refuses everything else: it writes a marker, says so on stderr,
//      exits 1. A test that installs the stub (fixture.ts installStubCli)
//      prepends its own directory afterwards and wins; nothing else can reach
//      the real binary. At exit, a marker fails the whole test process loudly
//      — the accept route swallows a learning-pass failure by design, so the
//      refusal alone would have been silent.
//
// Both defaults are set unconditionally: the author's shell may export
// either, and a test run must not inherit a spending engine or the real
// ~/.arc from it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.ARC_DRAFT_ENGINE = 'none'
process.env.ARC_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arc-home-')))

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-tripwire-'))
const marker = path.join(dir, 'reached')
process.env.ARC_TRIPWIRE_MARKER = marker
// The engine names the pass it is running in the child's environment
// (ARC_PASS), so the refusal can say which pass reached the binary.
fs.writeFileSync(path.join(dir, 'claude'), `#!/bin/sh
# arc's test tripwire: stands where the real claude would be found.
case "$1" in
  --version) echo "tripwire 0.0"; exit 0 ;;
esac
printf 'pass=%s run=%s · claude %s\\n' "\${ARC_PASS:-?}" "\${ARC_RUN_ID:-none}" "$*" >> "\${ARC_TRIPWIRE_MARKER:?}"
echo "arc tests must never reach the real claude — install the stub (test/fixture.ts installStubCli) or leave ARC_DRAFT_ENGINE at 'none'. Refused: pass=\${ARC_PASS:-?} claude $*" >&2
exit 1
`)
fs.chmodSync(path.join(dir, 'claude'), 0o755)
process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ''}`

process.on('exit', code => {
  if (!fs.existsSync(marker)) {
    // Nothing reached it: leave no trace of the run.
    for (const d of [dir, process.env.ARC_HOME]) {
      if (d) try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* a child may still hold it */ }
    }
    return
  }
  const file = process.argv[1] ? path.relative(process.cwd(), process.argv[1]) : '(unknown test)'
  process.stderr.write(
    `\n✗ ${file} reached the real claude. arc's tests spend no quota: pin ARC_DRAFT_ENGINE or install the stub.\n` +
    fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean).map(l => `    ${l}`).join('\n') + '\n\n',
  )
  if (code === 0) process.exitCode = 1
})
