// The four numbers, from the terminal (A76-3):
//
//   npm --prefix arc-backend run measure -- <story path>
//   npm --prefix arc-backend run measure -- <story path> --since 2026-11-01
//   npm --prefix arc-backend run measure -- <story path> --json
//
// Read-only and model-free: see measure.ts. The story path is set before any
// module that reads it is loaded, because config resolves it at import.
import fs from 'node:fs'
import path from 'node:path'

const HELP = `arc measure — the four numbers, dated, from the story's own record.

  npm run measure -- <story path> [--since YYYY-MM-DD] [--json]

Prints capture precision, style-gate usefulness, review precision and the
record-maintenance burden, each with its definition, its sources and the
window of history it read. It changes nothing in the story.`

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (!argv.length || argv.includes('--help')) {
    console.log(HELP)
    process.exit(argv.length ? 0 : 1)
  }
  let story = ''
  let since: string | null = null
  let json = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') json = true
    else if (argv[i] === '--since') since = argv[++i] ?? null
    else if (argv[i].startsWith('--since=')) since = argv[i].slice('--since='.length)
    else if (!story) story = argv[i]
  }
  if (!story) { console.error('a story path is required — for example: npm run measure -- ../feral-dogs-of-cuba'); process.exit(1) }
  if (since !== null && Number.isNaN(Date.parse(since))) { console.error(`--since takes a date, like 2026-11-01; "${since}" is not one`); process.exit(1) }
  // npm runs the script from the package; a relative path means the caller's
  const abs = path.resolve(process.env.INIT_CWD ?? process.cwd(), story)
  if (!fs.existsSync(path.join(abs, 'canon'))) { console.error(`no story at ${abs} (it has no canon/)`); process.exit(1) }
  process.env.ARC_STORY_PATH = abs
  const { measure, renderText } = await import('./measure')
  const m = measure({ since })
  console.log(json ? JSON.stringify(m, null, 2) : renderText(m))
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
