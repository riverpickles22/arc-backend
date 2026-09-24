# Captures

Real runtime output, recorded once and committed, so the adapters are
parsed against what the runtime actually says rather than what its
documentation promises (A67-2, step zero).

- `claude-cli-2.1.270-stream.jsonl` — one `claude -p --output-format
  stream-json --verbose --tools ''` run on the author's machine on
  2026-09-13, from an empty scratch directory, with a pre-assigned
  `--session-id`. Four lines: the `system/init` event (the envelope the
  runtime reports it loaded — tools, MCP servers, model, working directory,
  session id, version, skills, agents, memory paths), a `rate_limit_event`,
  the assistant message, and the `result`. The author's username is
  replaced with `author` throughout; nothing else is edited.

Re-capture when the runtime's stream shape changes: run the same command
from an empty directory, scrub the home path, and replace the file — then
`test/engine.test.ts` says what the parser no longer understands.
