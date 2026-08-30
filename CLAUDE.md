# arc-backend — agent notes

Read `../arc-system-design/AGENTS.md` first; it carries the rules every arc
repo shares. This file is only what is particular to the backend.

- **Every write path goes through the lock check** and answers HTTP 423 on
  locked prose. A new endpoint that writes prose, canon, or annotations calls
  the same guard the existing ones do — no exceptions for "internal" paths.
- **Generated prose never lands in main.** Passes write to the story's
  working tree (the draft layer) or `.arc/alternatives/`; the accept endpoint
  is the only commit. The ledger records origin at adopt, not at generation.
- **One pass, one `*_RULES` constant, one gate.** Build the prompt from the
  six slots (`src/*.ts` beside `prompt-engineering.md`), parse the answer
  tolerantly, and gate it before anything is written. Countable style rules
  are read from the style contract, never hard-coded.
- **The engine seam is `src/engine.ts`.** SDK with a key, or `claude -p` on
  the author's login; a CLI child gets `--tools ""` and its own timeout.
- Checks before you say done: `npm test` · `npm run typecheck` · `npm run lint`.
  Commit with `-s` (DCO).
