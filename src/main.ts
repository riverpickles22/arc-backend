// Entry point: resolve config (fails at startup rather than mid-request —
// importing config checks both repo paths) and listen.
import { describeConfig, PORT } from './config'
import { createArcServer } from './server'

console.log('arc-backend\n' + describeConfig())
createArcServer().listen(PORT, () => console.log(`  listening on http://localhost:${PORT}`))
