// THE COMMIT LANE (A72-2). One short mutation transaction at a time over the
// story repo, one place that runs `git commit`, and nothing left behind by a
// decision that did not land.
//
// The properties pinned here: every mutation of the story goes through the
// lane and the architecture check can name the ones that do; a foreign
// index.lock is refused in the author's words and never removed, before the
// transaction and during it; a commit the story's own gate refuses leaves no
// verdict, no staged path and no changed prose; unrelated staged work, another
// waiting scene and an earlier uncommitted verdict all survive a decision that
// is not about them; two accepts of different scenes both land; and the lane
// is released whatever happened.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { git, makeStory, writeScene } from './fixture.ts'

const STORY = makeStory()
process.env.ARC_STORY_PATH = STORY
process.env.ARC_DRAFT_ENGINE = 'none'

const { commitRecords, proseAccept, proseAcceptParagraph, proseDraft, proseRejectParagraph, proseWrite } = await import('../src/story.ts')
const { inLane, laneHolder } = await import('../src/lane.ts')
const { readJudgments, EVIDENCE_REL } = await import('../src/evidence.ts')
const { HttpError } = await import('../src/http.ts')
const { baseOf } = await import('../src/base.ts')
/** THE BASE a decision is made about (A72-3), taken the moment before the
 *  decision — which is what a viewer that has just rendered the diff sends. */
const basesOf = (files?: string[]): Record<string, string> =>
  Object.fromEntries((files ?? []).map(f => [f, baseOf(f)]))

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
const A = 'prose/ch-01/scene-01.md'
const B = 'prose/ch-01/scene-02.md'
const HOOK = path.join(STORY, '.git', 'hooks', 'pre-commit')
const INDEX_LOCK = path.join(STORY, '.git', 'index.lock')

/** The story as it was before this file touched it. Every test starts from
 *  here, so one test's committed verdict is never another's starting state. */
const BASE = git(STORY, 'rev-parse', 'HEAD').trim()

const seed = (): void => {
  fs.rmSync(HOOK, { force: true })
  fs.rmSync(INDEX_LOCK, { force: true })
  git(STORY, 'reset', '-q', '--hard', BASE)
  git(STORY, 'clean', '-fdq')
  writeScene(STORY, A, 'sc.01-1', 'The first scene, as the book has it.')
  writeScene(STORY, B, 'sc.01-2', 'The second scene, as the book has it.')
  git(STORY, 'add', '-A')
  if (git(STORY, 'status', '--porcelain').trim()) git(STORY, 'commit', '-qm', 'prose: two scenes')
}

const edit = (file: string, body: string): void => {
  const abs = path.join(STORY, file)
  fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace(/---\n\n[\s\S]*$/, `---\n\n${body}\n`))
}

const evidenceLines = (): string[] => {
  try { return fs.readFileSync(path.join(STORY, EVIDENCE_REL), 'utf8').split('\n').filter(Boolean) } catch { return [] }
}

/** The story's own commit gate, refusing. Stands in for the lock guard, whose
 *  refusal arrives at exactly this moment — after the lane has written the
 *  scene, recorded the verdict and staged the paths. */
const refuseAtCommit = (): void => {
  fs.writeFileSync(HOOK, '#!/bin/sh\necho "the gate said no" >&2\nexit 1\n', { mode: 0o755 })
}

// ---- the architecture check ------------------------------------------------

/** Git's read-only verbs. Everything else moves something — the index, the
 *  working tree or a ref — and belongs inside a lane transaction. The list is
 *  a allow-list on purpose: a verb nobody here has used yet fails the check
 *  rather than slipping through it. */
const READ_ONLY = new Set([
  'rev-parse', 'status', 'show', 'log', 'ls-files', 'ls-tree', 'diff', 'cat-file',
  'for-each-ref', 'symbolic-ref', 'merge-base', 'rev-list', 'describe', 'blame', 'grep',
])

/** Every call to the story's `git(...)` helper in one file, with the verb it
 *  actually runs — found by walking the call's whole argument list, so a verb
 *  hidden behind `-c key=value` or any other flag is still the verb. The
 *  helper takes only strings and already carries `-C <the story>`, which is
 *  what makes reading it this way honest. */
function parseCalls(text: string, file: string): { file: string; verb: string }[] {
  const out: { file: string; verb: string }[] = []
  for (const m of text.matchAll(/(?<![\w$])git\(/g)) {
    // To the matching close paren, with string contents skipped so a paren
    // inside a literal cannot end the call early.
    let depth = 0, end = text.length, quote = ''
    for (let i = m.index! + m[0].length - 1; i < text.length; i++) {
      const ch = text[i]
      if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = '' ; continue }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
      if (ch === '(') depth++
      else if (ch === ')') { depth--; if (!depth) { end = i; break } }
    }
    const literals = [...text.slice(m.index! + m[0].length, end).matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(x => x[1])
    // Walk the flags to the verb: `-c key=value` and `-C dir` each take one.
    let i = 0
    while (i < literals.length && literals[i].startsWith('-')) i += (literals[i] === '-c' || literals[i] === '-C') ? 2 : 1
    if (literals[i]) out.push({ file, verb: literals[i] })
  }
  return out
}

const gitCalls = (): { file: string; verb: string }[] =>
  fs.readdirSync(SRC).filter(n => n.endsWith('.ts')).sort()
    .flatMap(name => parseCalls(fs.readFileSync(path.join(SRC, name), 'utf8'), name))

test('every git call that moves something is in the lane, and the list says which', () => {
  const moves = gitCalls().filter(c => !READ_ONLY.has(c.verb))
  // lane.ts owns staging, the index and the commit. story.ts keeps exactly one
  // mutation outside a transaction object: the checkout a discard IS, which
  // runs inside `inLane` and restores HEAD's own words.
  const expected = [
    { file: 'lane.ts', verb: 'add' },             // Tx.stage
    { file: 'lane.ts', verb: 'add' },             // Tx.stageAppended
    { file: 'lane.ts', verb: 'commit' },          // the one commit
    { file: 'lane.ts', verb: 'update-index' },    // rollback: index entries removed
    { file: 'story.ts', verb: 'checkout' },       // discardChange, inside inLane
  ]
  assert.deepEqual(moves, expected,
    `the story's git mutations moved — every one belongs inside a lane transaction:\n${
      moves.map(s => `  ${s.file} ${s.verb}`).join('\n')}`)
})

test('`git commit` against the story is run in exactly one place', () => {
  assert.deepEqual(gitCalls().filter(c => c.verb === 'commit'), [{ file: 'lane.ts', verb: 'commit' }])
})

test('nothing runs git behind the helper\'s back', () => {
  // The helper is what the check above can read. A second wrapper would make
  // its list a half-truth, so the files that spawn git AT ALL are named here
  // and a new one has to arrive deliberately.
  const spawners = fs.readdirSync(SRC).filter(n => n.endsWith('.ts'))
    .filter(n => /execFileSync\(\s*'git'/.test(fs.readFileSync(path.join(SRC, n), 'utf8'))).sort()
  assert.deepEqual(spawners, [
    'lane.ts',      // the helper itself, and the two index operations it owns
    'records.ts',   // rev-parse, reading the arc and story revisions — no story mutation
    'style.ts',     // the AUTHOR's own style repo in their home, not the story
  ])
})

test('the check sees a verb hidden behind a flag, and one it has never heard of', () => {
  // The evasions that would otherwise walk past it, proven against text
  // rather than trusted: a verb behind `-c key=value` (a form the codebase
  // already uses at story.ts), a paren inside a literal, and a verb the
  // allow-list has never heard of.
  assert.deepEqual(parseCalls(`git('-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'x')`, 'x.ts'),
    [{ file: 'x.ts', verb: 'commit' }])
  assert.deepEqual(parseCalls(`git('commit', '-m', 'a message with a ) in it')`, 'x.ts'),
    [{ file: 'x.ts', verb: 'commit' }])
  assert.deepEqual(parseCalls(`git('-c', 'x=1', 'clean', '-fdq')`, 'x.ts'), [{ file: 'x.ts', verb: 'clean' }])
  for (const verb of ['clean', 'restore', 'read-tree', 'stash', 'apply', 'revert', 'push', 'fetch', 'update-index']) {
    assert.ok(!READ_ONLY.has(verb), `${verb} moves something and must not be read as read-only`)
  }
})

// ---- the foreign lock ------------------------------------------------------

test('a lock held outside arc refuses the decision, in the author\'s words, and is never removed', () => {
  seed()
  edit(A, 'Pending, and about to be refused.')
  const head = git(STORY, 'rev-parse', 'HEAD').trim()
  fs.writeFileSync(INDEX_LOCK, 'held by something else\n')
  try {
    assert.throws(() => proseAccept(undefined, [A], basesOf([A])), (e: unknown) =>
      e instanceof HttpError && e.status === 409
      && /writing to this story right now/.test(e.message)
      && /try again/.test(e.message)
      && !/git|index\.lock|lock file/i.test(e.message))
    assert.ok(fs.existsSync(INDEX_LOCK), 'arc never removes a lock it did not take')
    assert.equal(git(STORY, 'rev-parse', 'HEAD').trim(), head)
    assert.deepEqual(readJudgments(), [], 'and nothing was recorded')
    assert.equal(laneHolder(), null, 'the lane is released')
  } finally {
    fs.rmSync(INDEX_LOCK, { force: true })
  }
})

test('a lock taken AFTER the preflight reaches the author as the same sentence', () => {
  seed()
  assert.throws(() => inLane('a test transaction', tx => {
    fs.writeFileSync(INDEX_LOCK, 'taken mid-transaction\n')
    tx.stage([A])
  }), (e: unknown) => e instanceof HttpError && e.status === 409 && /writing to this story right now/.test(e.message))
  assert.ok(fs.existsSync(INDEX_LOCK))
  fs.rmSync(INDEX_LOCK, { force: true })
  assert.equal(laneHolder(), null)
  // And the next request works.
  edit(A, 'After the lock went away.')
  assert.deepEqual(proseAccept(undefined, [A], basesOf([A])).files, [A])
})

// ---- what a refused commit leaves behind -----------------------------------

test('a commit the gate refuses leaves no verdict, nothing staged and the words as they were', () => {
  seed()
  edit(A, 'An accept that will be refused at the commit.')
  const head = git(STORY, 'rev-parse', 'HEAD').trim()
  const before = fs.readFileSync(path.join(STORY, A), 'utf8')
  refuseAtCommit()
  assert.throws(() => proseAccept(undefined, [A], basesOf([A])))
  fs.rmSync(HOOK, { force: true })

  assert.equal(git(STORY, 'rev-parse', 'HEAD').trim(), head, 'nothing committed')
  assert.deepEqual(readJudgments(), [], 'no verdict survives a commit that did not happen')
  assert.deepEqual(evidenceLines(), [], 'and the log is as it was')
  assert.equal(git(STORY, 'diff', '--cached', '--name-only').trim(), '', 'nothing left staged')
  assert.equal(fs.readFileSync(path.join(STORY, A), 'utf8'), before, 'the pending words are still pending')
  assert.equal(laneHolder(), null)

  // A later request succeeds.
  const out = proseAccept(undefined, [A], basesOf([A]))
  assert.deepEqual(out.files, [A])
  assert.equal(readJudgments().length, 1)
})

test('a refused paragraph accept puts the scene, the log and the index back', () => {
  seed()
  const abs = path.join(STORY, A)
  const fm = fs.readFileSync(abs, 'utf8').slice(0, fs.readFileSync(abs, 'utf8').indexOf('---', 3) + 4)
  fs.writeFileSync(abs, fm + '\nOne.\n\nTwo.\n')
  git(STORY, 'commit', '-qam', 'prose: two paragraphs')
  const head = git(STORY, 'rev-parse', 'HEAD').trim()
  fs.writeFileSync(abs, fm + '\nOne, revised.\n\nTwo.\n')
  const pending = fs.readFileSync(abs, 'utf8')

  refuseAtCommit()
  assert.throws(() => proseAcceptParagraph(A, { file: A, side: 'draft', paragraph: 0 }, baseOf(A)))
  fs.rmSync(HOOK, { force: true })

  assert.equal(git(STORY, 'rev-parse', 'HEAD').trim(), head)
  assert.equal(fs.readFileSync(abs, 'utf8'), pending, "the author's unaccepted words are back")
  assert.deepEqual(evidenceLines(), [], 'and no verdict was kept')
  assert.equal(git(STORY, 'diff', '--cached', '--name-only').trim(), '')
  assert.equal(laneHolder(), null)
})

// ---- what a decision must not touch ----------------------------------------

test('a decision carries its own evidence and leaves every other pending thing alone', () => {
  seed()
  // An earlier verdict that was never committed: refusing a paragraph records
  // one and reaches no commit, so its line is sitting in the log when this
  // accept begins.
  const absB = path.join(STORY, B)
  const fmB = fs.readFileSync(absB, 'utf8').slice(0, fs.readFileSync(absB, 'utf8').indexOf('---', 3) + 4)
  fs.writeFileSync(absB, fmB + '\nOne.\n\nTwo.\n')
  git(STORY, 'commit', '-qam', 'prose: paragraphs in the second scene')
  fs.writeFileSync(absB, fmB + '\nOne, rewritten.\n\nTwo.\n')
  proseRejectParagraph(B, { file: B, side: 'draft', paragraph: 0 }, baseOf(B))
  const earlier = evidenceLines()
  assert.equal(earlier.length, 1, 'the refusal left one uncommitted verdict')

  edit(A, 'The scene the author read.')
  edit(B, 'A scene they have not.')
  // And something unrelated, staged by their own hand.
  fs.appendFileSync(path.join(STORY, 'canon/story.yaml'), '# a line the author staged\n')
  git(STORY, 'add', '--', 'canon/story.yaml')

  proseAccept(undefined, [A], basesOf([A]))

  const committed = git(STORY, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean)
  assert.ok(committed.includes(A))
  assert.ok(!committed.includes(B), 'the scene they have not read stays pending')
  assert.ok(!committed.some(f => f.startsWith('canon/')), 'their staged canon edit is not swept in')
  assert.match(git(STORY, 'status', '--porcelain', '--', 'canon/story.yaml'), /^M /, 'and is still staged')

  // THE EVIDENCE DELTA, not the file: the earlier verdict is not in the book,
  // and it has not been lost either.
  const inHead = git(STORY, 'show', `HEAD:${EVIDENCE_REL}`).split('\n').filter(Boolean)
  assert.ok(!inHead.includes(earlier[0]), "an earlier decision's verdict is not ratified by this one")
  assert.ok(evidenceLines().includes(earlier[0]), 'and it is still waiting in the log')
  assert.equal(inHead.length, 1, 'exactly this decision\'s verdict went into the book')

  git(STORY, 'reset', '-q', 'HEAD', '--', 'canon'); git(STORY, 'checkout', 'HEAD', '--', 'canon')
})

// ---- serialising -----------------------------------------------------------

test('two accepts of different scenes both land, one after the other', () => {
  seed()
  edit(A, 'One decision.')
  edit(B, 'Another decision.')
  const first = proseAccept(undefined, [A], basesOf([A]))
  const second = proseAccept(undefined, [B], basesOf([B]))
  assert.deepEqual(first.files, [A])
  assert.deepEqual(second.files, [B])
  assert.notEqual(first.hash, second.hash, 'two decisions, two commits')
  assert.equal(proseDraft().changes.length, 0)
  assert.match(git(STORY, 'show', `HEAD:${A}`), /One decision\./)
  assert.match(git(STORY, 'show', `HEAD:${B}`), /Another decision\./)
})

test('two decisions about the same change do not both land', () => {
  seed()
  edit(A, 'The change both decisions are about.')
  const first = proseAccept(undefined, [A], basesOf([A]))
  assert.deepEqual(first.files, [A])
  // The second arrives after the first changed its input. Today it is refused
  // because there is nothing pending for that scene any more; A72-3 gives the
  // accept the base the author read, and refuses it for the right reason.
  assert.throws(() => proseAccept(undefined, [A], basesOf([A])), (e: unknown) =>
    e instanceof HttpError && (e.status === 409 || e.status === 400))
  assert.equal(git(STORY, 'rev-parse', 'HEAD').trim(), git(STORY, 'rev-parse', first.hash).trim(),
    'and it committed nothing on top')
  assert.equal(laneHolder(), null)
})

test('a receipt whose commit failed is taken along by the next one, not by a repeated accept', () => {
  seed()
  const records = path.join(STORY, 'history')
  fs.mkdirSync(records, { recursive: true })
  // A receipt that has its hash: its decision landed and only the bookkeeping
  // failed, which is the thing there is to repair.
  fs.writeFileSync(path.join(records, 'run.0001.yaml'), 'id: run.0001\nresult:\n  commit: abc1234\n')
  refuseAtCommit()
  assert.equal(commitRecords('Record: the receipt for run.0001', ['history/run.0001.yaml']), null,
    'bookkeeping never throws — an accept that landed stays landed')
  fs.rmSync(HOOK, { force: true })
  assert.ok(fs.existsSync(path.join(records, 'run.0001.yaml')), 'and the receipt is still on disk')

  // The next decision's receipt carries it along: repair without asking the
  // author to make the same decision twice.
  fs.writeFileSync(path.join(records, 'run.0002.yaml'), 'id: run.0002\nresult:\n  commit: def5678\n')
  const hash = commitRecords('Record: the receipt for run.0002', ['history/run.0002.yaml'])
  assert.ok(hash, 'the second one committed')
  const committed = git(STORY, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean)
  assert.deepEqual(committed.sort(), ['history/run.0001.yaml', 'history/run.0002.yaml'])
  assert.equal(laneHolder(), null)
})

test('a receipt still waiting for its own scene is never swept into another decision', () => {
  seed()
  const records = path.join(STORY, 'history')
  fs.mkdirSync(records, { recursive: true })
  // An adopted route writes its receipt with no hash and waits for ITS OWN
  // scene's accept to fill one. Another scene's records commit must not take
  // it: it would land with `commit: null` under the wrong message, and be
  // committed a second time when that scene is accepted.
  fs.writeFileSync(path.join(records, 'run.0003.yaml'), 'id: run.0003\nresult:\n  commit: null\n')
  fs.writeFileSync(path.join(records, 'run.0004.yaml'), 'id: run.0004\nresult:\n  commit: 9abcdef\n')

  const hash = commitRecords('Record: the receipt for run.0004', ['history/run.0004.yaml'])
  assert.ok(hash)
  const committed = git(STORY, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean)
  assert.deepEqual(committed, ['history/run.0004.yaml'])
  assert.match(git(STORY, 'status', '--porcelain', '-uall', '--', 'history'), /run\.0003\.yaml/,
    'the un-stamped receipt is still waiting for the decision it belongs to')
})

test('a staging failure after preparation rolls the decision back like any other', () => {
  seed()
  edit(A, 'An accept whose staging will fail.')
  const head = git(STORY, 'rev-parse', 'HEAD').trim()
  const pending = fs.readFileSync(path.join(STORY, A), 'utf8')
  // The evidence log becomes unstageable: git refuses to add an ignored path,
  // and the accept reaches that line only after it has written its verdict.
  const exclude = path.join(STORY, '.git', 'info', 'exclude')
  const before = fs.readFileSync(exclude, 'utf8')
  fs.writeFileSync(exclude, `${before}\n${EVIDENCE_REL}\n`)
  try {
    assert.throws(() => proseAccept(undefined, [A], basesOf([A])))
  } finally {
    fs.writeFileSync(exclude, before)
  }

  assert.equal(git(STORY, 'rev-parse', 'HEAD').trim(), head, 'nothing committed')
  assert.deepEqual(evidenceLines(), [], 'and no verdict was kept')
  assert.equal(git(STORY, 'diff', '--cached', '--name-only').trim(), '', 'nothing left staged')
  assert.equal(fs.readFileSync(path.join(STORY, A), 'utf8'), pending)
  assert.equal(laneHolder(), null)
  assert.deepEqual(proseAccept(undefined, [A], basesOf([A])).files, [A], 'and the next request works')
})

test('a commit that names no path is refused rather than taking the whole index', () => {
  seed()
  fs.appendFileSync(path.join(STORY, 'canon/story.yaml'), '# staged, and nobody asked for it to be committed\n')
  git(STORY, 'add', '--', 'canon/story.yaml')
  const head = git(STORY, 'rev-parse', 'HEAD').trim()
  assert.throws(() => inLane('a commit with no paths', tx => tx.commit('this should not happen', [])),
    (e: unknown) => e instanceof Error && /named paths/.test(e.message))
  assert.equal(git(STORY, 'rev-parse', 'HEAD').trim(), head)
  assert.match(git(STORY, 'status', '--porcelain', '--', 'canon/story.yaml'), /^M /)
  git(STORY, 'reset', '-q', 'HEAD', '--', 'canon'); git(STORY, 'checkout', 'HEAD', '--', 'canon')
})

test('a transaction may not be started inside another, and the lane survives trying', () => {
  seed()
  assert.throws(() => inLane('the outer one', () => inLane('the inner one', () => 1)),
    (e: unknown) => e instanceof Error && !(e instanceof HttpError)
      && /the outer one/.test(e.message) && /the inner one/.test(e.message))
  assert.equal(laneHolder(), null)
})

test('a transaction that would yield is refused, not held open', () => {
  seed()
  assert.throws(() => inLane('an async transaction', () => Promise.resolve(1) as unknown as number),
    (e: unknown) => e instanceof Error && /must not yield/.test(e.message))
  assert.equal(laneHolder(), null)
})

// ---- the boundary the lane does not claim ----------------------------------

test('an editor outside arc that changes the scene mid-decision is not written over', () => {
  seed()
  const abs = path.join(STORY, A)
  const fm = fs.readFileSync(abs, 'utf8').slice(0, fs.readFileSync(abs, 'utf8').indexOf('---', 3) + 4)
  fs.writeFileSync(abs, fm + '\nOne.\n\nTwo.\n')
  git(STORY, 'commit', '-qam', 'prose: paragraphs for the external-edit case')
  fs.writeFileSync(abs, fm + '\nOne, revised.\n\nTwo, revised.\n')

  // The hook stands in for the author's editor: it runs while the decision is
  // landing, at the one moment arc holds the committed text on disk.
  fs.writeFileSync(HOOK,
    `#!/bin/sh\nprintf '%s' "${'$'}(cat <<'EOF'\n${fm}\nTyped by hand while that was landing.\nEOF\n)" > ${JSON.stringify(abs)}\nexit 0\n`,
    { mode: 0o755 })
  proseAcceptParagraph(A, { file: A, side: 'draft', paragraph: 0 }, baseOf(A))
  fs.rmSync(HOOK, { force: true })

  assert.match(fs.readFileSync(abs, 'utf8'), /Typed by hand while that was landing\./,
    'the lane excludes arc from itself, never the author from their own editor')
  assert.equal(laneHolder(), null)
})

test('a scene saved by hand goes through the lane like everything else', () => {
  seed()
  const before = proseDraft().changes.length
  proseWrite(A, 'Saved by hand.\n')
  assert.equal(laneHolder(), null)
  assert.equal(proseDraft().changes.length, before + 1)
})
