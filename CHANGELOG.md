# Changelog

A release is an annotated git tag (`vX.Y.Z`), cut only by the author, whose
message carries the date it is made available (`git tag -a v0.1.0 -m "v0.1.0 — 2026-MM-DD"`),
and is pushed that same day (`git push origin v0.1.0`). Each tag gets one line
here naming the same date: `## v0.1.0 — 2026-MM-DD`.
The date matters because each version converts from FSL-1.1 to Apache 2.0 on
the second anniversary of the day it was made available (see [LICENSE](LICENSE)).

## Unreleased

Everything since the first commit (2026-07-26); no version has been tagged yet.

- The canon API, with lock checks on every write path.
- The passes — draft, redraft, reroute, revise, inspect, learn-style — on rows
  with their gates, behind one engine seam (the claude CLI or the SDK).
- The draft layer: decisions at scene, paragraph and sentence grain, put back,
  ask again, and a receipt for every run.
