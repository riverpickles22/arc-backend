# arc-backend — agent notes

Read `../arc-system-design/AGENTS.md` first; it carries the rules every arc
repo shares. This file is only what is particular to the backend.

- **Every write path goes through the lock check** and answers HTTP 423 on
  locked prose. A new endpoint that writes prose, canon, or annotations calls
  the same guard the existing ones do — no exceptions for "internal" paths.
- **A run is minted before the first token, and ends once** (A67-3). A
  generating request creates its `Run` before the seam is called — labelled
  in the author's words, never the brief, with its subject — registers it
  (`registerRun`) so `/api/runs` lists it and the runtime's hook joins it
  instead of opening a second, holds every launch in flight (`attachLaunch`)
  so `POST /api/runs/:id/stop` reaches the child, and ends it through
  `endRun(id, ending)` with an ending from the closed set: landed · refused ·
  could not run · timed out · budget · unreadable · cancelled · unfinished.
  The state follows the ending (`stateOfEnding`), the record gets one
  `run.ended` event and the first ending wins. A stop keeps what already
  landed — write the proposal as soon as it passes its gates, not at the
  end. Every launch is recorded with the transcript it will write
  (`recordLaunch`), so `DELETE /api/runs/:id/transcript` works even for a run
  this process never held, and a run with no ending on disk is found at
  startup by `unfinishedRuns()` and named by the briefing as one that did not
  finish.
- **The envelope is proven from the runtime's own init event, or recorded,
  never declared** (A67-5). `proveEnvelope(row, init, expect)` asserts a
  sealed row's declared envelope against what the runtime reported loading —
  tools empty (and through that, network and subagents), no MCP server, the
  working directory arc created, the session arc opened — the moment the
  init event arrives, before the run wears its label and before another
  token is spent. A mismatch refuses the launch with `EngineError('envelope')`
  and one author sentence rendered by code, ending in the next keystroke; the
  run ends `could not run` and the receipt carries the refusal with the field,
  what was declared and what was observed — one observation per launch, so a
  later launch cannot erase an earlier refusal. A downgrade is never silent,
  and a declaration this adapter can neither prove nor record refuses too.
  Fields no engine on subscription auth can withhold are RECORDED instead
  (`recordedEnvelope`): the skills, subagents, memory and plugins the init
  event names, each with where it was observed, plus the user-level files
  listed as present on disk, plus any CLAUDE.md or AGENTS.md an ANCESTOR of
  the launch directory carries — the runtime finds those by walking up, and
  arc's scratch parent sits under the author's own `~/.arc/`, so arc records
  them by path rather than claiming a project context it cannot enforce.
  What arc proves is only what arc made: the directory it created is empty.
  None of it is ever written as "none". Under the `sdk`
  engine a withholding row refuses at launch: that adapter reports nothing
  about what it loaded, and slice 6 is where the second runtime is proved.
  The fixture engine starts no runtime, and its receipt says so.
- **The author reads a sentence; the machine's words go on the receipt.**
  A failed launch reaches the route reader as one author sentence per kind
  (`engineSentence`), never a prefixed error — the engine's own message is
  kept as the launch stage's gate record on the receipt, and the failure's
  KIND travels as a field so a transport failure can earn no repair
  (invariant 5) without the author ever seeing the word.
- **Every run leaves a receipt, in two homes** (A67-4). The working receipt
  is `.arc/runs/<id>/receipt.yaml`, written from the launch and closed with
  the ending, beside what the run kept: the rendered brief (`briefs/`), the
  raw answers (`answers/`), the text a gate refused (`refused/`) and the
  event log — all named by fingerprint, all gitignored. It carries the
  request as the author made it and the cell it resolved to, the brief's
  slots as block ids and fingerprints (never text), the slice's three
  headings — withheld by design · dropped for budget · what the runtime
  added — the envelope declared and observed, every gate that ran with its
  typed record, the fingerprints of everything read, the claims returned and
  dropped, the engine and model as THEY reported, tokens estimated and
  actual, the wall clock, the ending, and what produced it: the arc commit
  and the row's job fingerprint. The record receipt is `history/<id>.yaml`,
  written at the author's DECISION (adopt today; cancel and supersede in
  A67-10) and committed: `toRecordReceipt` strips every absolute path from
  every field, and no prose ever reaches it — a test greps for both. A
  refusal that produced nothing reaches no decision, so it leaves the
  working receipt only, which is what `arc doctor` will count. `result.commit`
  is filled by the accept that commits the adopted route
  (`stampReceiptCommit`), and the receipt is then committed by `commitRecords`
  in its OWN commit right behind it — no file can hold the hash of the commit
  that contains it. A run launches more than once (two seeds, a repair), so
  the receipt ACCUMULATES: one set of brief slots per launch, tokens summed,
  evidence summed, and each answer marked landed by its own attempt, never by
  whichever arrived last. Arc writes every field from the slice manifest and
  the envelope; no model writes its own receipt.
- **Generated prose never lands in main.** Passes write to the story's
  working tree (the draft layer) or `.arc/alternatives/`; the accept endpoint
  is the only commit. The ledger records origin at adopt, not at generation.
- **One pass, one `*_RULES` constant, one gate.** Build the prompt from the
  six slots (`src/*.ts` beside `prompt-engineering.md`), parse the answer
  tolerantly, and gate it before anything is written. Countable style rules
  are read from the style contract, never hard-coded.
- **The gate runner owns the child** (A67-6). `runGates(job)` in
  `src/gates.ts` is where a rowed pass hands over: it launches, walks the
  ROW'S GATE IDS in order (`GATES`, keyed by id — locks, lock-order,
  withhold-literals, and-chain, sentence-length, overlap, coverage-tail),
  writes a typed record for every gate that ran, keeps the refused text with
  the run, and offers exactly ONE repair. Where the engine keeps a transcript
  (the CLI) the repair resumes the first attempt's from the same directory
  and sends only the refusal; where it does not (the SDK, the fixture) the
  SAME brief goes again with the refusal on the end — never a fresh slice
  either way (invariant 5), and `engineResumes()` is what decides. A
  transport failure is not a refusal and earns no repair; nothing retries
  further. What ENDED the run is what names it: a stop wins, then a gate
  refusal (a repair that could not run afterwards does not relabel it), then
  the seam's kind. A gate never repairs — it refuses and
  says why, and `could not judge` reaches the author as *not checked*, never
  as passed. A gate that cannot run refuses the write: an answer with no
  coverage tail does not land. A row naming a gate this arc has no
  implementation for is refused, never quietly skipped. Every record names
  the launch it belongs to, so two seeds of one run never blur.
- **A gesture is resolved to a cell by code, at the door** (A67-8).
  `src/request.ts` turns what the author did — the route button on a scene,
  *rewrite from these notes* on a route — into a cell (job · scope · mode ·
  depth) and then the row that admits it, in the route handlers where the
  gesture arrives. A cell the rows do not list is refused at intake in the
  author's words, and a depth word they do not carry is refused too, never
  silently mapped to standard; both before any token. The receipt records
  the gesture as the author made it and the cell it became.
- **Evidence resolves against the destination the pass was given** (A67-8).
  `resolveCoverage()` checks each coverage claim against the destination and
  DROPS what does not resolve, counting it by reason — unresolvable ·
  outside the slice (it names one of arc's own key points, which are context
  and never the destination) · unparseable. A beat stated twice is a
  RESTATEMENT, not a drop — its evidence resolved and its row is already
  there — and `returned` counts the claims the pass MADE that resolved,
  never the destination's length, which is the same for every answer. The
  counts go on the route (`dropped`) and on the receipt
  (`evidence.dropped`), and the viewer says them where the route is. An answer that parsed to nothing ends the run
  `unreadable`, never as an empty route.
- **The leak gate proves the brief before the send** (A67-7). A withholding
  row declares its withheld set (`WithheldSpec` on the row: the scene as it
  stands, less the locked paragraphs the pass is told to reproduce and the
  contract's quoted literals, at a bar of eight consecutive words); the pass
  realises it (`withheldSet()`); the runner proves every brief against it
  before any launch, including the repair's. A run of the withheld set in
  the brief refuses with the passage named, at stage `brief`, and nothing is
  sent — the fix is the author's note, so there is no repair. The set is the
  SCENE and only the scene: a note that quotes the prose and a touchstone
  drawn from it are quotes OF the scene, so a span of the scene is what
  catches them, and the author's own words about the scene stay theirs to
  send. What a pass is shown ON PURPOSE is allowed through: the locked
  paragraphs, the contract's quoted literals, and — for the rewrite — the
  route it is rewriting, whose own text is its subject. This is the gate for
  the leak that existed before it: reroute hands the pass the scene's open
  notes, and a note carries its quote. A row that declares the gate and
  hands over no set is refused, never silently skipped. A pass supplies the
  brief, the repair's line, and what its gates measure against
  (`gateCtx()` in reroute.ts); it owns no launch, no retry and no receipt
  bookkeeping of its own.
- **The engine seam is `src/engine.ts`, and it takes the row first**
  (A67-2). `askRow(row, brief, opts)` answers a brief from whichever
  engine is configured — the fixture, `claude -p` on the author's login,
  or the SDK with a key — and the launch derives from the row: the toolbelt
  from its envelope, the wall clock from its budget, the output ceiling from
  its budget (the SDK's `max_tokens`; the CLI child's
  `CLAUDE_CODE_MAX_OUTPUT_TOKENS`), the session and the scratch directory
  from the run id and the attempt. A launch with no row throws before any
  token; `dry` renders the brief and never spawns, and needs no engine. The
  CLI child is streamed (`--output-format stream-json --verbose`) so its
  `system/init` event comes back beside the text — tools, MCP servers,
  model, working directory, session, version, skills — and it launches from
  a fresh directory under `<ARC_HOME>/scratch/<story>-<hash>/<run>/<attempt>/`,
  never the story tree, removed when the child has exited; the run id
  reaches it as `ARC_RUN_ID`, and each launch of a run — a seed, a repair —
  gets its own `--session-id`, a UUID derived from the run id and the
  attempt, so the transcript is named before the run and no two launches
  share a session. The launch handle's `stop()` sends SIGTERM, then kills,
  and ends the launch as `cancelled`, never `timed out`. A failure is an
  `EngineError` with a kind from the closed set: unreachable · rate-limited
  (the runtime said rejected) · died · timed out · cancelled. The passes not
  yet on a row use the interim `runCliPrompt(prompt, { pass })`: streamed,
  from a scratch directory of its own, `ARC_RUN_ID` when the caller has a
  run, no pre-assigned session and no output ceiling — the row is what adds
  those. Test stubs for `claude` come from `installStubCli()` in
  `test/fixture.ts` and speak the streamed shape; the real shape is in
  `test/captures/`.
- **The fixture engine answers only a brief it has seen** (A67-9).
  `ARC_DRAFT_ENGINE=fixture` selects `src/fixtures.ts`: a recorded answer
  keyed by the fingerprint of the rendered brief, a miss refused with the
  fingerprint named, nothing invented. Fixtures live in `fixtures/<row key>/
  <name>.md` (the key is `job.scope.mode`, e.g. `explore.scene.one-shot`); the scenarios that render their briefs in
  `test/fixture-scenarios.ts`, one per fixture, against arc-core's worked
  example as shipped. A rowed pass ships four — one that lands, one the leak
  gate fires on, one the overlap gate refuses, one with a coverage claim to
  drop — and its test runs with no key and no subscription. Change a word of
  a pass's rules, a slice layer, a threshold or the example scene and the
  fixture test fails naming the fingerprint that moved; when the change was
  meant, `npm run fixtures:rekey` records the new one and the diff is
  reviewed like any other. The brief is fingerprinted over the record alone:
  nothing machine-specific — a path, a directory name, a clock — may reach
  a brief.
- **Every launch carries its row, or names its pass** (A67-1, A55-4).
  `src/registry.ts` is the one typed table that admits a launch on the
  governed path: a union over the pattern (sealed · staged · fan-out ·
  investigation · record agent), each row carrying its cell, slice,
  envelope, gates, answer shape, budgets, rules text and fixtures, with its
  status derived at startup. A pass on a row hands the row to the seam and
  the toolbelt derives from the envelope; the `*_RULES` text lives on the
  row and the pass imports it, so a job has one address. A pass not yet
  migrated names its `PASS_REGISTRY` entry (`src/invocation.ts`), and the
  entry — never the call site — decides whether the child gets tools.
  `test/pass-registry.test.ts` enumerates the launch sites, reads a real
  child's argv, and holds the RATCHET: the count of launches with no row
  (twelve) may only fall, and a migration lowers it in the same change it
  deletes the entry it replaces. `src/registry.types.test.ts` is the
  negative type test — a sealed row cannot carry a toolbelt, a session or a
  subagent pool — proven by `npm run typecheck`.
- Checks before you say done: `npm run check` (typecheck, lint, tests — one
  exit code). Commit with `-s` (DCO).
