// "Work through my notes on this scene", from the terminal. No UI, no
// server — the same operation the viewer runs (work-notes.ts), because the
// backend owns what the sentence means and a second reading would drift.
// This is what lets a Claude Code session (arc-canon skill §10) work the
// author's notes THROUGH arc: the notes are the brief, the draft lands
// beside the scene, and arc is where it is read.
//
//   npm run notes -- sc.00-2
//   npm run notes -- sc.00-2 --rebuild
//   npm run notes -- sc.00-2 --rebuild --guidance "keep the first half"
//
// The reply is one short paragraph for the author. It never carries the
// prose: nothing is accepted by generating it, and the manuscript is where
// a draft is judged.
import { runWorkNotes } from './work-notes'

const HELP = `arc notes — work the author's open notes on one scene into a draft.

  npm run notes -- <scene-id>
      the minimal revision: your notes are the instructions, and the prose
      changes as little as they require
  npm run notes -- <scene-id> --rebuild [--guidance "..."]
      a clean pass over the scene with your notes answered where the
      rebuild allows; --guidance adds one binding line beside them

The draft lands beside the scene. Open the manuscript in arc to review it —
nothing is accepted by generating it, and your notes stay open until you
close them. A scene with no open notes is refused: leave a note first.`

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (!argv.length || argv[0] === '--help') {
    console.log(HELP)
    process.exit(argv.length ? 0 : 1)
  }

  let scene = ''
  let rebuild = false
  let guidance: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rebuild') rebuild = true
    else if (argv[i] === '--guidance') guidance = argv[++i]
    else if (!scene) scene = argv[i]
  }
  if (!scene) { console.error('a scene id is required — for example: npm run notes -- sc.00-2'); process.exit(1) }
  if (guidance && !rebuild) { console.error('--guidance goes with --rebuild; the minimal revision takes its instructions from your notes alone'); process.exit(1) }

  const out = await runWorkNotes({ scene, mode: rebuild ? 'redraft' : 'revise', guidance, source: 'cli' })
  console.log(out.reply)
  if (out.notes.length) console.log(`\nnotes worked: ${out.notes.join(', ')}`)
  process.exit(out.changed ? 0 : 2)
}

main().catch(e => {
  // A refusal is an outcome, not a crash: say what refused and what to do.
  console.error(`\nrefused: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
