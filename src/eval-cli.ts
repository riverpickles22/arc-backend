// The private evaluation of the drafting brief, from the terminal (A82-3).
//
//   npm run eval:record -- ch.03-the-crossing --label before
//   npm run eval:record -- ch.03-the-crossing --label after
//   npm run eval:compare -- before after
//
// Recording asks the engine for real — on the author's login, so it is the
// author's to run — and keeps the answer under the story's .arc/eval/. It
// never offers a draft: nothing reaches the book, the draft layer or the
// receipts. Comparing reads what is recorded and spends nothing.
import { describeConfig } from './config'
import { assertCanRecord, compare, EvalError, recordCase } from './eval'
import { EngineError } from './engine'
import { HttpError } from './http'

const HELP = `arc eval — keep real answers to the drafting brief, and judge two versions of it side by side (A82-3).

  npm run eval:record -- <chapter-id> --label <name> [--again]
      Asks the engine once for the chapter's next scene, exactly as a draft
      would, and keeps the brief and the answer under the story's
      .arc/eval/<name>/. Nothing lands in the book or beside it. A case
      already recorded under that name is kept unless you add --again.

  npm run eval:compare -- <name> <other-name>
      Writes one page with the two answers to each shared case under blind
      names, and a judgments file with three numbers to fill in per answer.
      Asked again once you have filled it, prints the tally.

To compare two versions of the rules: record your cases under one label,
change the rules, record the same cases under another, compare.
ARC_STORY_PATH names the story.`

async function main(): Promise<void> {
  const [verb, ...argv] = process.argv.slice(2)
  if (!verb || verb === '--help' || argv.includes('--help') || (verb !== 'record' && verb !== 'compare')) {
    console.log(HELP)
    process.exit(verb === '--help' || argv.includes('--help') ? 0 : 1)
  }

  if (verb === 'compare') {
    const names = argv.filter(a => !a.startsWith('--'))
    if (names.length !== 2) { console.error('eval:compare takes two labels — npm run eval:compare -- before after'); process.exit(1) }
    const out = compare(names[0], names[1])
    console.log(out.lines.join('\n'))
    return
  }

  let chapter = '', label = '', again = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--label') label = argv[++i] ?? ''
    else if (argv[i] === '--again') again = true
    else if (!chapter) chapter = argv[i]
  }
  if (!chapter || !label) { console.error('eval:record takes a chapter and a label — npm run eval:record -- <chapter-id> --label before'); process.exit(1) }

  // Anything that refuses is one sentence, before a word of anything else.
  assertCanRecord(chapter, label, { again })
  console.log(describeConfig())
  console.log(`\nrecording ${chapter} under "${label}" — one real answer, kept in .arc/eval/, offered to nobody\n`)
  const { file, saved } = await recordCase(chapter, label, { again })
  console.log(`recorded   ${saved.case} · ${saved.scene}`)
  console.log(`rules      ${saved.rules_fingerprint}`)
  console.log(`brief      ${saved.brief_fingerprint} · ${saved.tokens.input} tokens in`)
  console.log(`answer     ${saved.answer.trim().split(/\s+/).length} words · ${saved.tokens.output} tokens out · ${saved.model ?? 'model not reported'} · ${(saved.wall_clock_ms / 1000).toFixed(1)}s`)
  console.log(`envelope   ${saved.envelope ? (saved.envelope.ok ? 'proven' : 'refused') : 'not reported'}`)
  console.log(`kept in    ${file}`)
  if (saved.transcript) console.log(`transcript ${saved.transcript}  (Claude Code's own copy of this exchange, outside the story — yours to delete)`)
}

main().catch((e: unknown) => {
  if (e instanceof EvalError || e instanceof EngineError || e instanceof HttpError) console.error(e.message)
  else console.error(e)
  process.exit(1)
})
