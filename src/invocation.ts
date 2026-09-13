// The pass→rung registry and the one place claude argv is assembled.
//
// design/harness.md §4 (the registry rule) and §8 (launch properties):
// "sealed", "read-only" and "governed" are properties of the LAUNCH, not
// promises about behaviour — so the flags are built here, from the pass's
// registered posture, never assembled by hand at a call site. A convention
// ("remember to pass noTools") will eventually be broken by a convenient
// refactor; a registry row cannot be forgotten, because building args for an
// unregistered pass throws.

/** Engagement rungs (harness.md §4). Only rung 1 exists in code today; the
 *  registry carries the rung so later rungs (sessions, roams, governed hands)
 *  attach to the same rows instead of a second table. */
export type Rung = 0 | 1 | 2 | 3 | 4

export interface PassSpec {
  rung: Rung
  /** The pass is DEFINED by not seeing something — reroute withholds the
   *  current prose; capture must not read beyond the accepted scenes it is
   *  handed. The builder forces `--tools ''` for these no matter what the
   *  caller says: withholding is mechanical, never a caller's memory. */
  withholding: boolean
  /** May a stored session ever be reused across calls for this pass?
   *  (idea-scene-session: iterative verbs only. The in-call repair retry is
   *  not a session — it resumes the same transcript once, within one job.) */
  sessionAllowed: boolean
}

/** Every generating pass that reaches the CLI engine. Adding a pass means
 *  adding a row and choosing a posture in review — not remembering a flag.
 *
 *  THE DISCREPANCY A55-2 REPORTED IS CLOSED (2026-09-11, A55-4, the author's
 *  decision). The reading passes are pinned withholding, so `--tools ''` is
 *  what the registry hands them and "read-only by construction" is true on
 *  the engine that actually runs, not only on the SDK path and not only by
 *  asking the prompt nicely:
 *
 *    - the five lenses and the style bootstrap, because their worth is
 *      reading the record COLD — a child that can open the working tree can
 *      answer from the book instead of from the slice arc handed it;
 *    - analyze, judge, suggest and intent, which read and return a judgement
 *      and have nothing to write.
 *
 *  The prose-writing passes (draft, redraft, revise) and the record workers
 *  (material, learn-style) are deliberately NOT pinned here: their envelope
 *  is slice 2's and slice 4's business, and draft and revise are the
 *  iterative verbs a scene session would serve (`idea-scene-session`) — a
 *  session and a withheld set cannot coexist, by the rule below. */
export const PASS_REGISTRY = {
  draft: { rung: 1, withholding: false, sessionAllowed: true },
  redraft: { rung: 1, withholding: false, sessionAllowed: true },
  revise: { rung: 1, withholding: false, sessionAllowed: true },
  // Pinned 2026-09-11: rephrase reads a selection and offers wordings. It
  // loses its session with the pin, because a withholding pass may never
  // reuse one; an iterative rephrase gets one back when slice 2 rows it.
  suggest: { rung: 1, withholding: true, sessionAllowed: false },
  analyze: { rung: 1, withholding: true, sessionAllowed: false },
  judge: { rung: 1, withholding: true, sessionAllowed: false },
  intent: { rung: 1, withholding: true, sessionAllowed: false },
  material: { rung: 1, withholding: false, sessionAllowed: false },
  'learn-style': { rung: 1, withholding: false, sessionAllowed: false },
  lenses: { rung: 1, withholding: true, sessionAllowed: false },
  bootstrap: { rung: 1, withholding: true, sessionAllowed: false },
  reroute: { rung: 1, withholding: true, sessionAllowed: false },
  'reroute-revise': { rung: 1, withholding: true, sessionAllowed: false },
  capture: { rung: 1, withholding: true, sessionAllowed: false },
} as const satisfies Record<string, PassSpec>

export type PassName = keyof typeof PASS_REGISTRY

/** Options the builder understands. `pass` keys the registry and is
 *  REQUIRED (A55-4): the call site's silence used to decide a child's
 *  tools, which meant the posture of a pass lived in whichever caller
 *  happened to remember a flag. A new pass now fails to compile until it
 *  has a row, and the row is the only place a posture is written. */
export interface InvocationOpts {
  pass: PassName
  noTools?: boolean
  resume?: string | null
  /** Pre-assign the session UUID so a receipt can name the session before it
   *  runs (harness.md §3 fact 2). */
  sessionId?: string
  /** JSON Schema for CLI-level output validation (`--json-schema`). */
  jsonSchema?: object
  /** Extra settings for the child. Print mode silently ignores an invalid
   *  settings file (harness.md §3 fact 8) — so the builder validates and
   *  throws instead of letting a governed run go naked. Accepts an object
   *  (serialized here) or a pre-serialized JSON string (parsed to check). */
  settings?: object | string
}

/** May this pass ever reuse a stored session across calls? Throws for
 *  withholding passes and any pass whose row says no — the scene-session
 *  card's rule ("a session that ever read it cannot unsee it") enforced in
 *  code, ahead of any session store existing. */
export function assertSessionAllowed(pass: PassName): void {
  const spec: PassSpec = PASS_REGISTRY[pass]
  if (spec.withholding || !spec.sessionAllowed) {
    throw new Error(`pass "${pass}" may not reuse a session: ${spec.withholding ? 'it is a withholding pass — a session that ever read the withheld material cannot unsee it' : 'its registry row does not allow one'}`)
  }
}

/** Assemble the `claude` argv for one headless call. The only place flags
 *  are put together; engine.ts consumes this verbatim. */
export function buildCliArgs(opts: InvocationOpts): string[] {
  // `pass` is required by the type, so this catches the one case the type
  // cannot: a caller reaching in from JavaScript, or a name whose row was
  // deleted without its call site.
  const spec: PassSpec | undefined = PASS_REGISTRY[opts.pass]
  if (!spec) throw new Error(`unregistered pass "${String(opts.pass)}" — add a PASS_REGISTRY row and choose its posture in review`)

  // Withholding is decided by the registry, not the caller. A caller may add
  // noTools to a non-withholding pass; it may never remove it from one.
  const toolsOff = spec.withholding || opts.noTools === true

  let settingsJson: string | undefined
  if (opts.settings !== undefined) {
    if (typeof opts.settings === 'string') {
      try { JSON.parse(opts.settings) } catch {
        throw new Error('invalid settings JSON — print mode would silently ignore it and the run would launch without its hooks and permissions')
      }
      settingsJson = opts.settings
    } else {
      try { settingsJson = JSON.stringify(opts.settings) } catch {
        throw new Error('settings object could not be serialized — print mode would silently ignore a bad settings file, so the builder refuses instead')
      }
      if (settingsJson === undefined) throw new Error('settings serialized to nothing — the run would launch without its hooks and permissions')
    }
  }

  return [
    '-p', '--output-format', 'json',
    ...(toolsOff ? ['--tools', ''] : []),
    ...(opts.resume ? ['--resume', opts.resume] : []),
    ...(opts.sessionId ? ['--session-id', opts.sessionId] : []),
    ...(opts.jsonSchema ? ['--json-schema', JSON.stringify(opts.jsonSchema)] : []),
    ...(settingsJson !== undefined ? ['--settings', settingsJson] : []),
  ]
}
