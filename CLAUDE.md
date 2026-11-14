# arc-backend — agent notes

Read `../arc-context/AGENTS.md` first; it carries the rules every arc
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
  working receipt only, which is what `arc doctor` will count. EVERY decision
  on a pending draft a run wrote — scene, paragraph or sentence accept, or
  discard, whatever the origin — goes through ONE writer,
  `recordDraftDecision` (A76-1): the step is appended to
  `author_decision.taken` at the grain the decision named, `result.commit`
  takes the decision's hash, and the receipt is then committed by
  `commitRecords` in its OWN commit right behind it — no file can hold the
  hash of the commit that contains it. A paragraph or sentence REJECT is a
  step too, committed receipt-only like the discard. A whole-scene accept, a
  discard, or the last piece taken or refused (nothing left pending at the
  path) settles the draft; a later accept at that path is the author's own hand and
  writes nothing, as does a draft with no run behind it. A run launches more than once (two seeds, a repair), so
  the receipt ACCUMULATES: one set of brief slots per launch, tokens summed,
  evidence summed, and each answer marked landed by its own attempt, never by
  whichever arrived last. Arc writes every field from the slice manifest and
  the envelope; no model writes its own receipt.
- **Generated prose never lands in main.** Passes write to the story's
  working tree (the draft layer) or `.arc/alternatives/`; the accept endpoint
  is the only commit. The ledger records origin at adopt, not at generation.
- **One commit lane, and it is not a lock on the files** (A72-2).
  `inLane(what, fn)` in `src/lane.ts` runs one short mutation transaction at a
  time over the story repo, and `Tx.commit` is the only place arc runs
  `git commit` in it. `test/commit-lane.test.ts` reads every `git(...)` call in
  `src/` and names the verb each one runs — walking past `-c key=value` and any
  other flag — against an allow-list of READ-ONLY verbs, so a verb the list has
  never heard of fails the check rather than slipping through it; a second test
  names the three files allowed to spawn git at all, so a new wrapper cannot
  make that list a half-truth. Every path that touches the story takes the
  lane: the three accepts, the author's own save, the rejects, the discard, the
  route adoption's write-and-ledger, the style ratification (its WRITE
  included, so a refusal does not leave the contract changed and uncommitted)
  and the record commits. `Tx.commit` refuses a transaction that names no
  path — `git commit --` with no pathspec takes the whole index, which is
  every unrelated thing the author happened to have staged. A transaction MAY NOT YIELD —
  `inLane` refuses a thenable, because an `await` inside one reopens the
  window it closes — so no model ever runs while the lane is held. It
  remembers the bytes it is about to change and the index entries it is about
  to stage, and a failure puts both back: a refused commit records no verdict,
  stages nothing and changes no prose. `Tx.stageAppended` commits THIS
  decision's lines of the evidence log and puts the rest of the file back, so
  an earlier uncommitted verdict is not ratified by someone else's decision.
  `commitRecords` repairs its own bookkeeping — a receipt whose commit failed
  rides along with the next one rather than making the author repeat an accept
  that already landed — but ONLY one that already carries its hash: an adopted
  route's receipt waits, unstamped, for its own scene's accept, and sweeping it
  in would commit it twice under the wrong message.
  And the boundary, which is not negotiable: the lane is process-local
  exclusion, never a claim over the files. A foreign `index.lock` is refused
  in the author's words and NEVER removed, and a file that changed under a
  restoration is left alone. Nothing in arc may say or imply that the lane
  holds back the author's own editor.
- **"Minimal" is measured, not declared** (A72-6). `src/blast-radius.ts` is a
  PURE gate: the before side is the scene AS THE PASS WAS HANDED IT (`ctx.
  sceneBody`, pending edits included — never HEAD, never `paragraphContext`),
  the licensed scope is what the AUTHOR'S open notes point at resolved against
  that same text (`licensedScope`: a scene note licenses the scene, a
  multi-paragraph note its whole covered range, an agent note or a key point
  nothing, an orphaned or ambiguous passage nothing), and every difference the
  shared `alignParagraphs` finds is attributed to a source paragraph and
  judged there — an insertion by the passage it sits beside. Ambiguity REFUSES
  rather than widens. A row naming the gate without `ctx.handedNotes` is
  refused at the gate, never passed. The receipt records the licensed scope
  (`measured_against`) and what changed outside it (`measured`); the author
  reads the rendered sentence with the paragraph number. Fixtures: the
  `overreach` pair under `revise.scene.one-shot.quick.*`.
- **A refusal is READ to the author, never quoted at them** (A72-11).
  `src/refusal.ts` translates the story's own validator: the path and the
  `FAIL — n finding(s)` summary go, the fault is said in the author's terms
  (*it names char.nobody, which your record does not hold*), and the check's
  own words stay on the receipt's gate record (`validatorDetail`), which is
  where the author opened them on purpose. The validator gate and the
  material edit both go through it. "Nothing was written" is a claim about
  the disk and only the paths that wrote nothing may make it — a test names
  them, and `landedThenFailed` is the sentence for a decision that landed and
  then failed at arc's own bookkeeping. THE BOUNDARY IS A TEST, NEVER A
  FILTER: `arc-canon-graph/author-language.ts` reads what a diagnostic looks
  like — a validator summary, a stack frame, a shell invocation, an object
  id, a path into the machinery — and `test/refusal.test.ts` sweeps what arc
  actually renders against it. Nothing scans a message on its way out, and
  ordinary English a writer owns (branch, stage, index, head) is not a
  forbidden word. Two sweeps hold it: one over the sentences the renderers
  PRODUCE, and one over every literal refusal in `src/` — the second is what
  caught *this story is not a git repository*, which no run ever reaches.
- **A reading of a pending change is rowed, or it has no surface** (A72-10).
  `src/inspect.ts` is U9: ONE scene, the base of the diff the author is
  reading (a moved one refuses before a token), the record it is judged
  against from the assembler, and the pending diff as the ask. It answers
  with findings, each citing ids the brief actually carried or paragraphs of
  the scene it read; `resolveCitations` places them against the slice's own
  layer record and the `citations` gate runs once per finding — a drop costs
  that finding, never the answer, and when nothing survives the author reads
  *not reported* with the count. An answer arc cannot read ends the run
  `unreadable`, never as a reading that found nothing. It writes nothing:
  no path here opens a file for writing, and the accept stays exactly as
  available during and after. `analyze.ts`, its bare seam call and its
  `PASS_REGISTRY` entry went with it — the ratchet fell from seven to six.
- **Put it back reverses one decision, never a scene** (A72-8).
  `src/put-back.ts`: the accept's commit is found by the decision id in the
  evidence log (`git log -S` on the record line, never a subject), the inverse
  of THAT change is computed against the scene as the book now holds it by the
  shared paragraph alignment (`inverseOf`, pure), later unrelated edits are
  kept, a later edit on a paragraph the accept touched is an overlap and
  refuses, pending prose on the scene refuses, a lock the inverse would change
  answers 423. Preview is read-only and returns a token over the accepted
  bytes, the working tree, the locks and the inverse; confirm recomputes it
  inside the lane, refuses a moved token, and ANSWERS FROM THE RECORD FIRST —
  a decision already put back returns its reversal and appends nothing, where
  a record counts only once its own commit exists (`reversalOf`): a line
  left by a crash before the commit is never read as a reversal. A deleted
  paragraph goes back only if the seam it came from is intact.
  `recordPutBack` throws so a reversal with no record never lands. The
  reversal is its own record kind (`kind: 'put-back'`); `readJudgments`
  excludes every kind that names itself, `standingJudgments` drops reversed
  accepts for readers that ask what stands, and `decisionHistory` serves all
  of it with a state. A put-back never recreates a draft, reopens a note,
  relocks prose or touches canon or style; the preview names those as what
  remains.
- **A note resolves from what the landing said it was owed** (A72-7).
  `src/note-lifecycle.ts`: at the landing `attribute(before, after, notes)`
  records on the ledger entry, per handed note, the paragraphs it was about and
  the spans its change produced (text that must be in the book, text that must
  be gone), from the same alignment the blast-radius gate measured. At every
  accept `closeAnsweredNotes` asks `answeredStates` whether those spans are at
  HEAD (accepted), in the working tree only (waiting) or in neither (GONE —
  rejected, discarded, or the author's own hand) — COUNTED against how many
  times each text read at HEAD when the pass landed, so a repeated line is
  not in until the book says it twice and a deletion of words the book never
  held is never accepted — and resolves — never
  deletes — a passage note when every span is in, a scene note when the scene
  settles with at least one of its changes taken. Gone leaves the note OPEN
  however much else was accepted; a note edited since the landing is a new
  instruction (`noteInstruction`: body and anchor, never status); a note that
  produced no change, an agent note, a key point never resolve on their own.
  Derived from state, never remembered, so a restart changes nothing and
  `settleAnsweredNotes` sweeps every ledger file at startup (a crash between
  an accept's commit and its close); each resolution is one line in
  `.arc/note-resolutions.jsonl` with the decision that completed it.
  `ProseChange.answered` is served whenever provenance exists — EMPTY when
  nothing of it pends, so the viewer's handed-list fallback fires only for an
  entry with no attribution, which closes at scene grain as before.
- **Asking again is the same question, not a similar one** (A72-13). Every
  writing row records its REQUEST at the landing (`LedgerEntry.replay`): the
  row that answered it, its own target — for a new scene, the slot THAT draft
  went into, never the next free one — the scope inside it, the author's words
  and the notes it was handed with the version each was at. Never the rendered
  brief: that is one answer to a question, against a record that has moved.
  A PASSAGE IS REMEMBERED BY ITS WORDS, not its index: one paragraph inserted
  above leaves `[2,3]` in bounds and pointing at somebody else's prose, which
  is the fault conventions §14's anchors exist to prevent.
  `POST /api/prose/ask-again` re-asks it through `src/replay.ts`, dispatching on
  the recorded ROW — U3 rebuilds at its re-resolved scope, U2 goes back through
  the notes that apply now, U1 goes back into its own slot, and an adopted
  route re-issues the route and adopts the answer through the guarded path.
  It refuses before it runs: no review token is a 400, a moved one a 409
  (A72-3); a draft the author has edited OR already partly accepted needs
  `replaceMine` in as many words — a paragraph accept restores the pending
  draft exactly, so only the evidence log can see a partial decision — and the
  refusal carries what would have gone; a passage whose words are gone is
  refused rather than rebuilt from whatever took their place; and `claimReplay`
  holds the destination so two replays cannot race a replacement into it. The
  replacement runs through the ordinary guarded landing, so the words on screen
  stay until the new ones are in and a failure leaves them. The new entry
  `supersedes` the old one; the old one stays exactly where it is, and the
  record moving is never recorded as the author deciding.
- **A pass's answer never lands over words that moved while it ran** (A72-4).
  Every writing row takes `destinationAt(file)` when it LAUNCHES — including
  the absence of a file it is about to create — and lands through
  `landOrKeep`, which compares that snapshot inside the lane immediately
  before the write. A destination that moved does not take the answer: what
  the pass wrote is kept in `.arc/candidates/<run>.md`, readable after a
  restart, and is NEVER made the live draft. A failure puts back only what arc
  can still see it wrote (`restoreIfOurs`) — the old code restored the bytes
  it read at launch, which is how a cancelled pass could cost the author the
  paragraph they typed while it ran.
- **One enumeration records what a proposal read and compares it** (A72-4).
  `src/reads.ts` owns both `readManifest` (recording) and `staleAgainst`
  (comparing), for routes and drafts alike — a manifest built by one rule and
  compared by another agrees with nothing. It covers what the record SAYS
  about each id, not only its words: a note's status, kind, authorship and
  anchor; a scene's frontmatter and contract beside its prose. Every proposal
  records `v` (`READ_MAP`); one minted under an older rule reads *written by
  an older arc* rather than pretending to compare, and the same answer covers
  a moved job fingerprint. BUMP `READ_MAP` whenever a fingerprint's coverage
  changes. The two facts — the record moved, and the pass that wrote it has
  changed — are INDEPENDENT (`Staleness.older`, A72-5): the listing passes the
  current job fingerprint of the row the entry names (`rowByKey`), so both can
  be true at once and the author reads them as two. What a pass could not put
  in is served beside the reading (`ProseDraft.candidates`) and read or let go
  through `/api/prose/candidate`; it is never a pending change. A stale draft
  is a WARNING — it still accepts, because accepting
  destroys nothing the author wrote. The moved BASE is the other bar, and that
  one refuses; never collapse them.
  What it does NOT yet cover: the obligations layer, and the difference
  between what the scene carried at launch and what the assembled slice
  actually gave the pass (a layer dropped for budget is still claimed as
  read). Closing that means `WritingSlice` reporting per-layer versioned ids.
  The selection SUGGESTION path needs none of this: it writes nothing, and the
  author applies it through the ordinary scene save, protected by the base.
- **Every decision names the versions it was made about** (A72-3).
  `src/base.ts` mints a BASE per file — an opaque token over both versions of
  the diff the author is being shown, the accepted scene and the pending one,
  bytes and frontmatter together — served on every `ProseChange` and beside
  every scene (`ProseResponse.bases`), and echoed back with the decision.
  `assertBase` runs INSIDE the lane and BEFORE any index is resolved, anything
  is written, any evidence is recorded or any note is resolved; `assertBases`
  preflights every file of a multi-file request so one that moved leaves the
  others untouched. It FAILS CLOSED: a missing or malformed token is a 400,
  not an accommodation. A moved one is a 409 carrying what was read and what
  is there now, from a small bounded in-memory record of what the server
  showed — for display only, never read back as permission to write. Both
  sides matter: the pending side moving is the case HEAD cannot see, and the
  one that costs the author a paragraph. It is NOT `evidence.ts`'s pinned
  baseline, which is the commit a generation was judged from. The editor's
  autosave keeps its own `baseline` body compare instead — a view-level token
  would refuse every save after the first — and `proseWrite` takes both.
- **A decision leaves a record, in the log that already exists** (A72-3). The
  evidence entries carry a stable `decision` id, the `base` decided about and
  the `after` it makes true. No second history store, and nothing infers a
  decision from a commit subject.
- **An accept names the scenes it ratifies** (A72-1). `files` is required of
  `ProseAcceptRequest`, of `proseAccept` and of the viewer's `acceptDraft`;
  there is no accept-everything, because the only honest accept is one over a
  diff the author read. `acceptScope` in `story.ts` is the single door that
  says which paths an accept may name — a plain `prose/…/*.md` inside the
  story's prose directory, no duplicates, each with a pending change — and it
  checks every name before any of them is accepted, so one bad path in a list
  leaves the book exactly as it was. Staging and committing name those same
  paths, so an accept never sweeps in a scene or a record edit beside it.
- **One pass, one `*_RULES` constant, one gate.** Build the prompt from the
  six slots (`src/*.ts` beside `prompt-engineering.md`), parse the answer
  tolerantly, and gate it before anything is written. Countable style rules
  are read from the style contract, never hard-coded.
- **The gate runner owns the child** (A67-6). `runGates(job)` in
  `src/gates.ts` is where a rowed pass hands over: it launches, walks the
  ROW'S GATE IDS in order (`GATES`, keyed by id — for example locks,
  lock-order, validator, withhold-literals, and-chain, sentence-length,
  overlap, coverage-tail, blast-radius, answer-whole; `gates.ts` is the list),
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
- **A prose answer comes back whole, or says why it cannot be measured**
  (A75-1, A75-2). `GATES['answer-whole']` is the one gate that reads the
  answer as a whole — overlap scores a fragment well and the coverage tail
  only resolves claims — and it proves two things by count, either of which
  refuses: *paragraphs*, every paragraph a coverage claim names exists in the
  body — every claim the tail made (`ParsedAnswer.claims`), dropped ones
  included, because a dropped claim still said where a beat lands; *floor*, the body holds at least the row's `minShareOfSubject` of the
  subject's words. The subject is the scene (`ctx.sceneBody`), on the route
  rewrite too and never the parent route; at selection scope it is the
  passage the pass hands over as `ProseGateCtx.subjectPassage`. A row with no
  floor is not measured and the record says so; a body opening on a
  lowercase letter is recorded in `measured_against` and never refuses
  alone. Both failing keeps the floor's figures structured beside the
  paragraph proof's, and `gateSentence` renders the proof that failed with
  whole percentages rounded DOWN (*too short to be the whole scene (14%
  against 30%)*; *the whole passage it rebuilds* at selection scope). It runs
  LAST on five rows: reroute and route rewrite through `ROUTE_GATES` (both
  proofs), and `CLEAN_PASS_GATES` (revise · scene and revise · selection,
  standard) and `MINIMAL_REVISION_GATES` (revise · scene · quick) with the
  floor alone, since they carry no coverage claims — on a staged row the
  write stage lists it and the launch carries the row's floor. The floor is
  `ROUTE_MIN_SHARE_OF_SUBJECT`, 0.30, the author's bar (2026-11-14): a
  truncated route measured 0.14, a sound short route 0.47. Every row whose
  answer is prose (`WRITES_PROSE`) either lists the gate with a floor or
  carries a one-line `noAnswerWhole` — draft, rephrase and synonyms do — and
  `test/answer-whole-rows.test.ts` holds it: never both, never neither. The
  reason is left out of the job fingerprint, as the fixture list is.
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
  `test/captures/`. **The test run never reaches the author's claude**
  (A70-7): `test/tripwire.ts`, preloaded by `npm test` and imported by the
  fixture, sets `ARC_DRAFT_ENGINE=none` and a temp `ARC_HOME`, and puts a
  refusing `claude` first on PATH — a test that reaches it fails loudly,
  naming the file and the pass (the child's `ARC_PASS`). A test that wants a
  model pins the engine and installs the stub, after the preload.
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
