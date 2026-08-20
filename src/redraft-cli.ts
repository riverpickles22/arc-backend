// The redraft pass from the terminal. No UI, no server — the same operation
// the viewer runs, because the backend owns redraft semantics and a second
// prompt would be a fork that drifts. This entry point is what lets a Claude
// Code session (arc-canon skill §9) redraft THROUGH arc instead of around
// it, with every proven check — locks, the validator, literal withholds —
// standing exactly where the app puts them.
//
//   npm run redraft -- sc.00-1
//   npm run redraft -- sc.00-1 --paragraphs 3-6
//   npm run redraft -- sc.00-1 --guidance "slower; let the tide do the work"
//
// The result lands in the working tree as an ordinary draft. Review it
// through the gate — the viewer's, or the accept/reject routes; nothing is
// accepted by generating it.
import { describeConfig } from './config'
import { runRedraft } from './redraft'

const HELP = `arc redraft — rebuild a scene or passage to its contract (A42-6).

  npm run redraft -- <scene-id> [--paragraphs N-M] [--guidance "..."]

Writes into the working tree (the draft layer). Locks, the validator, and
quoted must_withhold literals can refuse the write; everything else the pass
says about its own output is argued, for the author to judge.`

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (!argv.length || argv[0] === '--help') {
    console.log(HELP)
    process.exit(argv.length ? 0 : 1)
  }

  let scene = ''
  let paragraphs: [number, number] | undefined
  let guidance: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--paragraphs') {
      const m = /^(\d+)-(\d+)$/.exec(argv[++i] ?? '')
      if (!m) { console.error('--paragraphs takes N-M, 1-based as the manuscript shows them'); process.exit(1) }
      paragraphs = [Number(m[1]) - 1, Number(m[2]) - 1]
    } else if (argv[i] === '--guidance') {
      guidance = argv[++i]
    } else if (!scene) scene = argv[i]
  }
  if (!scene) { console.error('a scene id is required'); process.exit(1) }

  console.log(describeConfig())
  const out = await runRedraft({ scene, paragraphs, guidance })
  console.log(`\nwrote  ${out.file}\n`)
  console.log(out.reply)
}

main().catch(e => {
  // A refusal is an outcome, not a crash: say what refused and why.
  console.error(`\nrefused: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
