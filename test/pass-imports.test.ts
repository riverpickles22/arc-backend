// NO PASS IS ANOTHER PASS'S LIBRARY (A80-1).
//
// reroute.ts had become the place every pass reached into for the shared
// code it happened to be born with — the gate context, the endings, the
// style projection, the fingerprints at write — and redraft and draft had
// become the same for the literals, the craft plan and the validated write.
// That code lives in shared modules now (gate-ctx.ts, style-projection.ts,
// craft-plan.ts, landing.ts, rowrun.ts), and this test reads every import in
// src/ so it stays there: a pass reaches no other pass, and the assembler
// reaches no pass — directly, or through any chain of shared modules —
// except for the edges named below, each with its reason. The due list
// (due.ts) left briefing.ts for the same reason: the slice read it there,
// and briefing.ts reaches the routes and the episodes.
//
// The lists are explicit on purpose. A new pass goes into PASSES in the same
// change that adds it; a file listed here that no longer exists fails.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** The modules that implement a row's pass — the job a model is launched
 *  for. Not here, and why: orchestrate.ts is the pipeline that RUNS intake,
 *  the judgment and the material worker in turn (a caller of passes, as
 *  server.ts is); revise.ts is the shape of a notes revision the gate runner
 *  reads, with no launch of its own; craft-plan.ts is a stage every writing
 *  row shares. */
const PASSES = [
  'reroute', 'redraft', 'draft', 'work-notes', 'inspect', 'update-record',
  'learn-style', 'bootstrap-style', 'lenses', 'judge', 'intent', 'material', 'suggest',
]

/** The brief assembler: the writing slice every rowed pass reads its record
 *  through. */
const ASSEMBLER = ['slice']

/** Pass → pass edges that are a deliberate composition, not shared code. */
const ALLOWED: { from: string; to: string; reason: string; typeOnly?: true }[] = [
  { from: 'work-notes', to: 'redraft', reason: 'a notes revision whose notes a clean pass can answer hands them to the redraft (notesAnswerable, runRedraft) — it runs that pass, it does not borrow from it' },
  { from: 'bootstrap-style', to: 'learn-style', reason: 'bootstrap is the learning pass on a cold start: it launches learn-style\'s own read over the edit pairs it builds' },
  { from: 'judge', to: 'intent', reason: 'the intake\'s envelope type is what the judgment reads; a type, erased at compile time', typeOnly: true },
  { from: 'material', to: 'intent', reason: 'the intake\'s envelope type is what the material worker reads; a type, erased at compile time', typeOnly: true },
]

interface Edge { from: string; to: string; typeOnly: boolean }

/** Every relative import and re-export of one module, static and dynamic. */
function importsOf(mod: string, src: string = fs.readFileSync(path.join(SRC, `${mod}.ts`), 'utf8')): Edge[] {
  const out: Edge[] = []
  const q = `['"]`
  const spec = `${q}\\.\\/([\\w-]+)(?:\\.ts)?${q}`
  const stmt = new RegExp(`^(?:import|export)\\s+(type\\s+)?(?:\\{[^}]*\\}|\\*(?:\\s+as\\s+\\w+)?|\\w+(?:\\s*,\\s*\\{[^}]*\\})?)\\s+from\\s+${spec}`, 'gm')
  for (const m of src.matchAll(stmt)) out.push({ from: mod, to: m[2], typeOnly: !!m[1] })
  // A side-effect import runs the module and binds nothing.
  for (const m of src.matchAll(new RegExp(`^import\\s+${spec}`, 'gm'))) out.push({ from: mod, to: m[1], typeOnly: false })
  for (const m of src.matchAll(new RegExp(`import\\(${spec}\\)`, 'g'))) {
    // `import('./x').T` in a type position is a type; `await import('./x')` is code.
    const typePosition = src.slice(m.index! + m[0].length).startsWith('.')
    out.push({ from: mod, to: m[1], typeOnly: typePosition })
  }
  return out
}

test('every module the lists name exists', () => {
  for (const m of [...PASSES, ...ASSEMBLER]) assert.ok(fs.existsSync(path.join(SRC, `${m}.ts`)), `src/${m}.ts`)
})

test('the import reader sees multi-line, type-only and re-export statements', () => {
  // A reader that missed a shape would make the next test a half-truth.
  const reroute = importsOf('reroute').map(e => e.to)
  for (const m of ['gate-ctx', 'style-projection', 'registry', 'run']) assert.ok(reroute.includes(m), `reroute imports ${m}`)
  assert.ok(importsOf('judge').some(e => e.to === 'intent' && e.typeOnly))
  assert.ok(importsOf('server').some(e => e.to === 'accept'))
  const shapes = importsOf('x', [
    `import './side-effect'`, `import { a } from "./double-quoted"`, `import type { T } from './typed.ts'`,
    `export * from './star'`, `const m = await import('./dynamic')`,
  ].join('\n'))
  assert.deepEqual(shapes.map(e => `${e.to}${e.typeOnly ? ':type' : ''}`).sort(),
    ['double-quoted', 'dynamic', 'side-effect', 'star', 'typed:type'])
})

/** Every module of src/ with its imports, read once. */
const MODULES = fs.readdirSync(SRC).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts')).map(f => f.slice(0, -3))
const GRAPH = new Map(MODULES.map(m => [m, importsOf(m)]))

/** The passes a module reaches: directly by any import, or through any chain
 *  of modules that are not passes. A chain stops at the first pass it meets
 *  — what that pass imports is its own row of this test. Past the first hop
 *  only value imports are followed: a type is erased at compile time and
 *  carries no code, so `runs → orchestrate` for a type does not make every
 *  pass that records a run reach the judgment. Each hit carries its path. */
function passesReached(start: string, graph: Map<string, Edge[]> = GRAPH): { to: string; via: string[]; typeOnly: boolean }[] {
  const hits: { to: string; via: string[]; typeOnly: boolean }[] = []
  for (const e of graph.get(start) ?? []) {
    if (PASSES.includes(e.to) && e.to !== start) hits.push({ to: e.to, via: [start, e.to], typeOnly: e.typeOnly })
  }
  const seen = new Set<string>([start])
  const queue: { at: string; via: string[] }[] = (graph.get(start) ?? [])
    .filter(e => !e.typeOnly && !PASSES.includes(e.to) && e.to !== start)
    .map(e => ({ at: e.to, via: [start, e.to] }))
  for (const q of queue) seen.add(q.at)
  while (queue.length) {
    const { at, via } = queue.shift()!
    for (const e of graph.get(at) ?? []) {
      if (e.typeOnly || e.to === start || seen.has(e.to)) continue
      seen.add(e.to)
      const path = [...via, e.to]
      if (PASSES.includes(e.to)) hits.push({ to: e.to, via: path, typeOnly: false })
      else queue.push({ at: e.to, via: path })
    }
  }
  return hits
}

function forbidden(graph: Map<string, Edge[]> = GRAPH): string[] {
  const found: string[] = []
  for (const from of [...PASSES, ...ASSEMBLER]) {
    for (const hit of passesReached(from, graph)) {
      const allowed = ALLOWED.find(a => a.from === from && a.to === hit.to && hit.via.length === 2)
      if (allowed && (!allowed.typeOnly || hit.typeOnly)) continue
      found.push(`${hit.via.join(' → ')}${hit.typeOnly ? ' (type)' : ''}`)
    }
  }
  return [...new Set(found)]
}

test('no pass is reached by another pass or by the assembler, directly or through shared modules, except the named compositions', () => {
  assert.deepEqual(forbidden(), [], 'move the shared code into a shared module, or name the composition in ALLOWED with its reason')
})

test('an indirect edge through a shared module is caught', () => {
  // Planted: the assembler imports a shared module that imports a pass.
  const planted = new Map(GRAPH)
  planted.set('slice', [...GRAPH.get('slice')!, { from: 'slice', to: 'planted-shared', typeOnly: false }])
  planted.set('planted-shared', [{ from: 'planted-shared', to: 'reroute', typeOnly: false }])
  const found = forbidden(planted)
  assert.ok(found.includes('slice → planted-shared → reroute'), found.join('\n'))
  // and the pass that reads the assembler is caught through it too
  assert.ok(found.includes('draft → slice → planted-shared → reroute'), found.join('\n'))
})

test('the chain A80-1 broke would be caught: the assembler reading the due list from the briefing', () => {
  // dueRows lived in briefing.ts, which reaches the routes and the episodes.
  const planted = new Map(GRAPH)
  planted.set('slice', [...GRAPH.get('slice')!, { from: 'slice', to: 'briefing', typeOnly: false }])
  const found = forbidden(planted)
  for (const chain of ['slice → briefing → reroute', 'slice → briefing → episodes → learn-style', 'slice → briefing → episodes → update-record']) {
    assert.ok(found.includes(chain), `${chain} in:\n${found.join('\n')}`)
  }
})

test('every allowed edge is still an edge', () => {
  // An allowance with nothing behind it is an open door for the next one.
  for (const a of ALLOWED) assert.ok(importsOf(a.from).some(e => e.to === a.to), `${a.from} → ${a.to}`)
})
