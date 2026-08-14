// Entry point: resolve config (fails at startup rather than mid-request —
// importing config checks both repo paths) and listen.
import { describeConfig, PORT } from './config'
import { describeStyle } from './style'
import { createArcServer } from './server'
import { startWatcher } from './watch'

console.log('arc-backend\n' + describeConfig() + `\n  style  ${describeStyle()}`)
createArcServer().listen(PORT, () => {
  console.log(`  listening on http://localhost:${PORT}`)
  // Only once the server is up: the watcher's whole output is stream events,
  // and there is nobody to hear them before then.
  startWatcher()
})
