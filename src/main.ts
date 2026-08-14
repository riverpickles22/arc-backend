// Entry point: resolve config (fails at startup rather than mid-request —
// importing config checks both repo paths) and listen.
import { describeConfig, PORT } from './config'
import { describeStyle } from './style'
import { currentEngine } from './engine'
import { createArcServer } from './server'
import { startWatcher } from './watch'

// Probe for the claude CLI here, before anyone is listening. The probe itself
// is synchronous and cached for the process; paying for it at startup keeps
// the one place left that can block the loop out of the request path.
const engine = currentEngine()

console.log('arc-backend\n' + describeConfig() + `\n  style  ${describeStyle()}` + `\n  engine ${engine ?? 'none'}`)
createArcServer().listen(PORT, () => {
  console.log(`  listening on http://localhost:${PORT}`)
  // Only once the server is up: the watcher's whole output is stream events,
  // and there is nobody to hear them before then.
  startWatcher()
})
