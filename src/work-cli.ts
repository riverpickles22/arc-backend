// Slice 1 from the terminal. No UI, no server, no scheduler — one run.
//
//   npm run work -- "Carlos needs a childhood friend..."
//   npm run work -- --decide reject "Carlos needs a childhood friend..."
//
// The default stops at the author's decision and writes no receipt, which is
// the honest state: nothing is decided. --decide accept|reject|abandon makes
// the decision in the same breath, which is what a test run wants.
import { decide, runIntent } from './orchestrate'
import { describeConfig } from './config'

const HELP = `arc work — run one author intent through the work graph (slice 1).

  npm run work -- "<what you want to say to the story>"
  npm run work -- --decide accept|reject|abandon "<...>"
  npm run work -- --source claude-code "<...>"

Writes telemetry to .arc/runs/<run>/events.jsonl always, and a receipt to
history/<run>.yaml only once a decision is made.`

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (!argv.length || argv[0] === '--help') {
    console.log(HELP)
    process.exit(argv.length ? 0 : 1)
  }

  let decision: 'accepted' | 'rejected' | 'abandoned' | null = null
  let source: 'ui' | 'claude-code' | 'cli' | 'external' = 'cli'
  const words: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--decide') {
      const v = argv[++i]
      decision = v === 'accept' ? 'accepted' : v === 'reject' ? 'rejected' : 'abandoned'
    } else if (argv[i] === '--source') {
      source = argv[++i] as typeof source
    } else words.push(argv[i])
  }
  const input = words.join(' ')

  console.log(describeConfig())
  console.log(`\n> ${input}\n`)

  const outcome = await runIntent(input, source)
  const { run, envelope, judgment, produced } = outcome

  console.log(`run        ${run.id}  (revision ${run.root.story_revision?.slice(0, 8) ?? 'not a repo'})`)
  console.log(`intent     ${envelope.operations.join(', ')} · ${envelope.authority} · ambiguity ${envelope.ambiguity}`)
  console.log(`anchors    ${envelope.anchors.join(', ') || '(none)'}`)
  if (envelope.open_questions.length) console.log(`open       ${envelope.open_questions.join('\n           ')}`)
  console.log(`expansions ${run.expansions.length ? run.expansions.map(e => e.granted).join(', ') : '(none)'}`)
  console.log(`wrote      ${produced.map(p => p.path).join(', ') || '(nothing)'}`)
  console.log(`checks     ${outcome.checks.ok ? 'PASS' : 'FAIL'}`)
  console.log(`verdict    ${judgment.verdict}`)

  for (const a of judgment.argued) console.log(`  argued   ${a.about}: ${a.claim}`)
  for (const q of judgment.asked) console.log(`  asked    ${q.about}: ${q.question}`)

  console.log(`\n${outcome.workerReply}\n`)
  for (const p of produced) console.log(`--- ${p.path} ---\n${p.content}`)

  if (decision) {
    const { receipt, dropped } = await decide(outcome, decision, 'decided from the CLI')
    console.log(`\ndecision   ${decision}`)
    if (dropped.length) console.log(`dropped    ${dropped.join(', ')}`)
    console.log(`receipt    ${receipt}`)
  } else {
    console.log('\nno decision made — status needs_author, no receipt written.')
    console.log('re-run with --decide accept|reject to close it.')
  }
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
