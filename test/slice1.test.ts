// Slice 1 (work-graph.md §11): the properties the vertical path has to hold,
// tested without a model — everything here is the deterministic half.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { load as yamlLoad } from 'js-yaml'
import { makeStory } from './fixture.ts'

const STORY = makeStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

const { deriveClaim, planGraph, decide } = await import('../src/orchestrate.ts')
const { parseEnvelope } = await import('../src/intent.ts')
const { parseJudgment } = await import('../src/judge.ts')
const { Run, nextRunId, snapshotReads, staleReads, buildReceipt, writeReceipt } = await import('../src/run.ts')
const { checkRecordWrite, diffRecords, recordsIn } = await import('../src/capability.ts')
const { fingerprints } = await import('../src/records.ts')

const AMBIGUOUS = {
  operations: ['capture', 'explore'],
  anchors: ['char.carlos'],
  inferred_scope: 'story',
  authority: 'proposed',
  ambiguity: 'consequential',
  requested_outcome: 'Carlos should have a childhood friend, placement undecided.',
  open_questions: ['Where does he first appear?', 'Does he actually turn sympathetic to the Revolution?'],
}

// ---- the envelope keeps the author's uncertainty ------------------------

test('parseEnvelope preserves open questions rather than resolving them', () => {
  const e = parseEnvelope(JSON.stringify(AMBIGUOUS))
  assert.equal(e.open_questions.length, 2)
  assert.equal(e.ambiguity, 'consequential')
  assert.deepEqual(e.anchors, ['char.carlos'])
})

test('a malformed envelope falls back to the cautious reading, never the permissive one', () => {
  const e = parseEnvelope('{"requested_outcome":"do a thing"}')
  assert.equal(e.authority, 'exploratory', 'unknown authority must not grant writes')
  assert.equal(e.ambiguity, 'consequential', 'unknown ambiguity must not claim confidence')
  assert.deepEqual(e.operations, [])
})

test('parseEnvelope tolerates a fenced or chatty response', () => {
  const e = parseEnvelope('```json\n{"authority":"proposed","anchors":["char.carlos"]}\n```')
  assert.equal(e.authority, 'proposed')
})

// ---- the claim is conservative -----------------------------------------

test('the derived claim permits material and nothing else', () => {
  const cap = deriveClaim(parseEnvelope(JSON.stringify(AMBIGUOUS)))
  assert.deepEqual(cap.writes, [], 'no standing write authority at all')
  assert.deepEqual(cap.proposes, [], 'no standing propose authority at all')
  assert.deepEqual(cap.creates.map(c => c.type), ['material'])
})

test('a worker under the derived claim cannot create a character', () => {
  const cap = deriveClaim(parseEnvelope(JSON.stringify(AMBIGUOUS)))
  const rafael = 'id: char.rafael\ntype: character\nname: Rafael\nstatus: proposed\n'
  const check = checkRecordWrite(cap, diffRecords([], recordsIn(yamlLoad(rafael), 'canon/entities/characters/rafael.yaml')))
  assert.equal(check.ok, false)
  assert.match(check.message!, /CREATE character/, 'and the refusal escalates to the planner')
})

test('exploratory authority still permits capture — material asserts no story truth', () => {
  // The blunt rule ("exploratory grants nothing") made capture unperformable
  // for exactly the input it exists to serve. Authority gates canon; §12 says
  // capturing material must cost nothing.
  const cap = deriveClaim(parseEnvelope(JSON.stringify({ ...AMBIGUOUS, authority: 'exploratory' })))
  assert.deepEqual(cap.creates.map(c => c.type), ['material'])
  assert.deepEqual(cap.writes, [], 'but still no standing write authority')
  assert.deepEqual(cap.proposes, [], 'and never canon')
})

test('an intent with no capture operation is read-only', () => {
  const cap = deriveClaim(parseEnvelope(JSON.stringify({ ...AMBIGUOUS, operations: ['query'] })))
  assert.deepEqual(cap.creates, [])
  assert.deepEqual(cap.writes, [])
})

// ---- the work graph ----------------------------------------------------

test('the planned node records the version of everything it will read', () => {
  const g = planGraph('run.0001', parseEnvelope(JSON.stringify({ ...AMBIGUOUS, anchors: ['story'] })))
  assert.equal(g.nodes.length, 1)
  assert.equal(g.nodes[0].status, 'queued')
  assert.equal(g.nodes[0].read_versions['story'], fingerprints().get('story'))
})

test('staleness is decided by comparing fingerprints, with no model involved', () => {
  const node = {
    id: 'n', kind: 'material', claim: deriveClaim(parseEnvelope('{}')),
    reads: ['story'], read_versions: snapshotReads(['story']),
    writes: [], creates: [], depends_on: [], status: 'running' as const,
  }
  assert.deepEqual(staleReads(node), [], 'nothing has moved yet')

  fs.writeFileSync(path.join(STORY, 'canon', 'story.yaml'), 'title: Test Story\nlogline: changed underneath\n')
  assert.deepEqual(staleReads(node), ['story'], 'the read moved, so the node is stale')
})

// ---- the run root ------------------------------------------------------

test('a run stamps its root the moment it starts', () => {
  const run = new Run('claude-code', 'Carlos needs a childhood friend.')
  assert.match(run.id, /^run\.\d{4}$/)
  assert.equal(run.root.source, 'claude-code')
  assert.equal(run.root.raw_author_input, 'Carlos needs a childhood friend.')
  assert.match(run.root.story_revision!, /^[0-9a-f]{40}$/, 'the git SHA the run began against')
  assert.equal(run.events[0].event, 'run.started')

  const rootFile = path.join(STORY, '.arc', 'runs', run.id, 'root.json')
  assert.deepEqual(JSON.parse(fs.readFileSync(rootFile, 'utf8')), run.root)
})

test('telemetry is appended as it happens, one JSON object per line', () => {
  const run = new Run('cli', 'x')
  run.emit('task.started', 'capture', { kind: 'material' })
  run.recordExpansion('capture', 'WRITE mat.friend')
  run.emit('task.completed', 'capture')

  const lines = fs
    .readFileSync(path.join(STORY, '.arc', 'runs', run.id, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l))
  assert.deepEqual(lines.map(l => l.event), ['run.started', 'task.started', 'claim.expanded', 'task.completed'])
  assert.equal(run.expansions[0].granted, 'WRITE mat.friend')
})

test('run ids do not collide with ids a receipt already claimed', () => {
  fs.mkdirSync(path.join(STORY, 'history'), { recursive: true })
  fs.writeFileSync(path.join(STORY, 'history', 'run.0900.yaml'), 'run_id: run.0900\n')
  assert.equal(nextRunId(), 'run.0901')
})

// ---- the judgment ------------------------------------------------------

test('an unreadable verdict is not an approval', () => {
  assert.equal(parseJudgment('{"verdict":"looks good to me"}').verdict, 'revise')
  assert.equal(parseJudgment('{"verdict":"accept"}').verdict, 'accept')
})

test('a judgment is always in the argued register', () => {
  const j = parseJudgment('{"verdict":"reject","argued":[{"about":"mat.x","claim":"invents a name","evidence":"body"}]}')
  assert.equal(j.register, 'argued')
  assert.equal(j.argued.length, 1)
})

// ---- the author's decision ---------------------------------------------

function fakeOutcome(materialPath: string) {
  const run = new Run('cli', 'Carlos needs a childhood friend.')
  const envelope = parseEnvelope(JSON.stringify(AMBIGUOUS))
  const graph = planGraph(run.id, envelope)
  return {
    run,
    graph,
    envelope,
    actions: [],
    workerReply: 'Filed the need; left placement open.',
    produced: [{ path: materialPath, content: fs.readFileSync(path.join(STORY, materialPath), 'utf8') }],
    checks: { proven: 'ok', ok: true },
    judgment: parseJudgment('{"verdict":"reject","argued":[{"about":"mat.friend","claim":"names a person","evidence":"body"}]}'),
  }
}

function seedMaterial(slug: string): string {
  const rel = `material/${slug}.yaml`
  fs.mkdirSync(path.join(STORY, 'material'), { recursive: true })
  fs.writeFileSync(
    path.join(STORY, rel),
    `id: mat.${slug}\ntype: character-need\nstatus: unplaced\nbody: Carlos needs a childhood friend.\n`,
  )
  return rel
}

test('rejection marks the item dropped rather than deleting it', async () => {
  const rel = seedMaterial('friend-reject')
  const { dropped } = await decide(fakeOutcome(rel), 'rejected', 'invents a name')

  assert.deepEqual(dropped, [rel])
  assert.equal(fs.existsSync(path.join(STORY, rel)), true, 'intent history is story history')
  const item = yamlLoad(fs.readFileSync(path.join(STORY, rel), 'utf8')) as any
  assert.equal(item.status, 'dropped')
  assert.equal(item.body, 'Carlos needs a childhood friend.', 'the idea itself survives')
})

test('a rejected run still writes a meaningful receipt', async () => {
  const rel = seedMaterial('friend-receipt')
  const outcome = fakeOutcome(rel)
  const { receipt } = await decide(outcome, 'rejected', 'invents a name')

  const r = yamlLoad(fs.readFileSync(path.join(STORY, receipt), 'utf8')) as any
  assert.equal(r.run_id, outcome.run.id)
  assert.equal(r.author_decision.decision, 'rejected')
  assert.equal(r.author_decision.note, 'invents a name')
  assert.equal(r.raw_author_input, 'Carlos needs a childhood friend.')
  assert.equal(r.judgment.verdict, 'reject')
  assert.ok(r.intent.open_questions.length, 'what the author left open is in the record')
  assert.match(r.story_revision, /^[0-9a-f]{40}$/)
  assert.deepEqual(r.result.records, [rel])
})

test('the receipt holds the link, never the diff', async () => {
  const rel = seedMaterial('friend-nodiff')
  const { receipt } = await decide(fakeOutcome(rel), 'accepted')
  const text = fs.readFileSync(path.join(STORY, receipt), 'utf8')

  assert.match(text, /friend-nodiff\.yaml/, 'it names what changed')
  assert.doesNotMatch(text, /Carlos needs a childhood friend\.\n.*character-need/s, 'but does not copy the file body')
  assert.ok(!text.includes('type: character-need'), 'no record contents are duplicated into history')
})

test('accepting leaves the item exactly as the worker filed it', async () => {
  const rel = seedMaterial('friend-accept')
  await decide(fakeOutcome(rel), 'accepted')
  const item = yamlLoad(fs.readFileSync(path.join(STORY, rel), 'utf8')) as any
  assert.equal(item.status, 'unplaced', 'acceptance is not promotion — material stays material')
})

test('every terminal decision writes a receipt, abandonment included', async () => {
  const rel = seedMaterial('friend-abandon')
  const { receipt } = await decide(fakeOutcome(rel), 'abandoned')
  assert.ok(fs.existsSync(path.join(STORY, receipt)))
  const r = yamlLoad(fs.readFileSync(path.join(STORY, receipt), 'utf8')) as any
  assert.equal(r.author_decision.decision, 'abandoned')
})

test('the context manifest records what was read and at which version', async () => {
  const rel = seedMaterial('friend-manifest')
  const outcome = fakeOutcome(rel)
  outcome.graph.nodes[0].read_versions = snapshotReads(['story'])
  const { receipt } = await decide(outcome, 'accepted')

  const r = yamlLoad(fs.readFileSync(path.join(STORY, receipt), 'utf8')) as any
  assert.deepEqual(r.context_manifest, [{ id: 'story', version: fingerprints().get('story') }])
})

test('writeReceipt round-trips through the history directory', () => {
  const run = new Run('ui', 'x')
  const rel = writeReceipt(
    buildReceipt(run, planGraph(run.id, parseEnvelope('{}')), {
      checks: { ok: true },
      judgment: { verdict: 'accept' },
      decision: 'accepted',
      records: [],
    }),
  )
  assert.equal(rel, path.join('history', `${run.id}.yaml`))
})
