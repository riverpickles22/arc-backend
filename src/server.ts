// arc-backend: the canon API, the writing passes, and the draft layer.
//
// Routing is a plain table — path → method → handler — dispatched by one
// function that also owns the error mapping: HttpError becomes its status
// with a clean {error} body; anything else is logged in full to stderr and
// answered with a generic 500, so tool output and stack traces never reach
// the browser. Every JSON payload is checked against the shared wire types
// (arc-canon-graph/api-types.ts) with `satisfies`.
import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import type { DecisionHistoryResponse, PutBackPreview, PutBackResult, ProseDraft,
  AgentsResponse,
  InspectDraftResponse,
  UpdateRecordResponse,
  DecideProposalsResponse,
  AnnotationsResponse,
  AskAgainDraftPlanResponse,
  CandidateResponse,
  ApiErrorResponse,
  AttentionResponse,
  BriefingResponse,
  CraftPlanned,
  DeleteTranscriptResponse,
  DocsResponse,
  DraftSceneResponse,
  HealthResponse,
  HookResponse,
  LensesResponse,
  LocksResponse,
  MaterialResponse,
  NoteResponse,
  NotesResponse,
  OkResponse,
  ProseAcceptResponse,
  ProseDiscardResponse,
  ProsePartAcceptResponse,
  ProsePartRejectResponse,
  ProseCheckHit,
  ProseChecksResponse,
  ProseParagraphRequest,
  ProseResponse,
  ProseSentenceRequest,
  RatifyRuleResponse,
  RunDecisionResponse,
  RunDetailResponse,
  RunResponse,
  RunReceiptResponse,
  RunsResponse,
  StopRunResponse,
  StyleResponse,
  UpdateMaterialResponse,
  WorkDecisionResponse,
  WorkResponse,
} from 'arc-canon-graph'
import { STORY } from './config'
import { git, inLane, laneCommits } from './lane'
import { readSceneByHand, startDueEpisodes } from './episodes'
import { baseOf } from './base'
import { admitReplay, claimReplay, planReplay, releaseReplay } from './replay'
import { ROUTE_REPLAY_ROW } from './reroute'
import { candidateText, dropCandidate } from './landing'
import { HttpError, corsOrigin, json, readBody } from './http'
import { canonJson, validateStory } from './canon'
import { docsArticles, materialItems, updateMaterial, proseDraft, proseWrite, proseScenes, readAsset, viewConfig } from './story'
import { annotations, answeredNow, createAnnotation, deleteAnnotation, updateAnnotation } from './annotations'
import { acceptParagraph, acceptScenes, acceptSentence, discardDraft, rejectParagraph, rejectSentence } from './accept'
import { attention } from './attention'
import { briefing } from './briefing'
import { decideProposals, sceneLabel } from './decide-proposals'
import { runInspect } from './inspect'
import { runSuggest } from './suggest'
import { runDraft } from './draft'
import { CRAFT_MOVES } from './registry'

/** The plan as the viewer sends it back, checked here rather than trusted:
 *  the author may have edited it, and what they edited is text. */
function parsePlan(raw: unknown): CraftPlanned {
  const moves = (raw as { moves?: unknown })?.moves
  if (!Array.isArray(moves) || !moves.length) throw new HttpError(400, 'a plan needs at least one craft move')
  return {
    moves: moves.map(m => {
      const move = (m as { move?: unknown })?.move
      const how = (m as { how?: unknown })?.how
      if (typeof move !== 'string' || typeof how !== 'string' || !move.trim() || !how.trim()) {
        throw new HttpError(400, 'each craft move needs a move and a clause saying what to do')
      }
      // THE VOCABULARY IS CLOSED IN BOTH DIRECTIONS (A69-4). The gate checks
      // what the model answered; this checks what comes back from the page,
      // which the author may have edited. Without it the closed set is a
      // suggestion: anything typed here reaches the writing pass verbatim.
      if (!(move.trim() in CRAFT_MOVES)) {
        throw new HttpError(400,
          `arc does not know how to ask a writing pass for "${move.trim()}". It can work on ${Object.keys(CRAFT_MOVES).join(', ')}.`)
      }
      return { move: move.trim(), how: how.trim() }
    }),
  }
}
import { currentEngine, noEngineSentence } from './engine'
import { authorStylePath, commitAuthorStyle, loadStyleLayers, styleContract } from './style'
import { countableChecks } from './countable'
import { DISMISSED_REL, QUEUE_REL, ratifyRule, ratifyTouchstone, readDismissed, readQueue, readTouchstones } from './style-queue'
import { joinStyleReceipt, stampStyleDecision } from './style-receipt'
import { runLearnStyle } from './learn-style'
import { readJudgments } from './evidence'
import { decisionHistory, previewPutBack, putBack } from './put-back'
import { proposeTouchstoneRefresh, touchstoneStates } from './touchstones'
import { proseChecks } from 'arc-canon-graph'
import { runBootstrapStyle } from './bootstrap-style'
import { runRedraft } from './redraft'
import { runWorkNotes } from './work-notes'
import { addRouteNote, adoptAlternative, deleteRouteNote, dropAlternative, listAlternatives, listRoutes, routeCounts, runReroute, runReceipt, runRevise } from './reroute'
import { doctorRecords } from './doctor'
import { isSessionKind, pingSession, sessionState, startSession, stopSession } from './session'
import type { SessionPingRequest, SessionState } from 'arc-canon-graph/api-types.ts'
import type { AdoptRouteResponse, DoctorRecordsResponse, RerouteResponse, RouteListResponse, WorkNotesMode, WorkNotesResponse } from 'arc-canon-graph/api-types.ts'
import { createLock, lockResolver, locks, removeLock } from './locks'
import { addNote, deleteNote, listNotes, updateNote as reviseNote } from './notes'
import { decideWork, workNote } from './work'
import { closeRun, deleteRunTranscripts, getRun, listRuns, observe, openRun, pendingOutcome, registerRun, stopRun } from './runs'
import { resolveRequest } from './request'
import { hook, listAgents } from './agents'
import { Run, subscribeRuns } from './run'
import { runLensFanOut } from './lenses'
import { decide } from './orchestrate'

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void | Promise<void>
type ParamHandler = (req: http.IncomingMessage, res: http.ServerResponse, id: string) => void | Promise<void>

/** Routes carrying one id in the path. The exact table stays the common case
 *  and is checked first; this is consulted only on a miss, so nothing about
 *  the existing dispatch changes shape. */
const paramRoutes: { pattern: RegExp; methods: Partial<Record<'GET' | 'POST' | 'DELETE', ParamHandler>> }[] = []

function registerRunParamRoutes(): void {
  paramRoutes.push({
    pattern: /^\/api\/runs\/(run\.\d+)$/,
    methods: { GET: (_req, res, id) => json(res, 200, getRun(id) satisfies RunDetailResponse) },
  })
  paramRoutes.push({
    pattern: /^\/api\/runs\/(run\.\d+)\/events$/,
    methods: {
      POST: async (req, res, id) => {
        const b = (await parsedBody(req)) as { detail?: unknown }
        observe(id, b.detail ?? b)
        json(res, 200, { ok: true } satisfies OkResponse)
      },
    },
  })
  // A stop reaches the child (A67-3): what landed stays, the run ends
  // cancelled, and the request that started it returns with what there is.
  paramRoutes.push({
    pattern: /^\/api\/runs\/(run\.\d+)\/stop$/,
    methods: { POST: (_req, res, id) => json(res, 200, { run: stopRun(id) } satisfies StopRunResponse) },
  })
  // WHAT ARC RECORDED ABOUT ONE RUN (A69-11). The fold under a draft opens
  // days after the draft was made, so it cannot read the response that made
  // it: the draft layer carries the run, and this is what the run says.
  // Proven throughout — arc wrote every field about its own work.
  paramRoutes.push({
    pattern: /^\/api\/runs\/(run\.\d+)\/receipt$/,
    methods: {
      GET: (_req, res, id) => {
        const receipt = runReceipt(id)
        if (!receipt) {
          throw new HttpError(404, `arc kept no receipt for ${id} — it was written before arc kept one, or what it kept has been cleared.`)
        }
        json(res, 200, { receipt } satisfies RunReceiptResponse)
      },
    },
  })
  // The transcripts a run's launches named, removed by id — after a run
  // that did not finish, or at the decision.
  paramRoutes.push({
    pattern: /^\/api\/runs\/(run\.\d+)\/transcript$/,
    methods: { DELETE: (_req, res, id) => json(res, 200, deleteRunTranscripts(id) satisfies DeleteTranscriptResponse) },
  })
  paramRoutes.push({
    pattern: /^\/api\/runs\/(run\.\d+)\/decision$/,
    methods: {
      POST: async (req, res, id) => {
        const b = (await parsedBody(req)) as { decision?: unknown; note?: unknown }
        const d = b.decision
        if (d !== 'accepted' && d !== 'rejected' && d !== 'abandoned') {
          throw new HttpError(400, "decision must be 'accepted', 'rejected' or 'abandoned'")
        }
        const out = await decide(pendingOutcome(id), d, typeof b.note === 'string' ? b.note : undefined)
        closeRun(id, d)
        json(res, 200, { ok: true, ...out } satisfies RunDecisionResponse)
      },
    },
  })
}
registerRunParamRoutes()

async function parsedBody(req: http.IncomingMessage): Promise<unknown> {
  const raw = await readBody(req)
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    throw new HttpError(400, 'request body is not valid JSON')
  }
}

/** Validate a sentence decision's shape. The sentence is named by identity —
 *  side plus index — and prose never travels this direction, so there is
 *  nothing here to sanitise, only to check. */
function paragraphTarget(body: unknown): ProseParagraphRequest {
  const b = body as { file?: unknown; paragraph?: unknown; side?: unknown; message?: unknown }
  if (typeof b?.file !== 'string' || !Number.isInteger(b?.paragraph)) {
    throw new HttpError(400, 'file and paragraph required')
  }
  if (b.side !== 'main' && b.side !== 'draft') throw new HttpError(400, 'side must be "main" or "draft"')
  return {
    file: b.file,
    side: b.side,
    paragraph: b.paragraph as number,
    message: typeof b.message === 'string' ? b.message : undefined,
    // Checked in story.ts, where the compare lives (A72-3); carried here.
    base: (b as { base?: unknown }).base as string,
  }
}

function sentenceTarget(body: unknown): ProseSentenceRequest {
  const b = body as { file?: unknown; paragraph?: unknown; side?: unknown; sentence?: unknown; message?: unknown }
  if (typeof b?.file !== 'string' || !Number.isInteger(b?.paragraph) || !Number.isInteger(b?.sentence)) {
    throw new HttpError(400, 'file, paragraph and sentence required')
  }
  if (b.side !== 'main' && b.side !== 'draft') throw new HttpError(400, 'side must be "main" or "draft"')
  return {
    file: b.file,
    paragraph: b.paragraph as number,
    side: b.side,
    sentence: b.sentence as number,
    message: typeof b.message === 'string' ? b.message : undefined,
    base: (b as { base?: unknown }).base as string,
  }
}

const routes: Record<string, Partial<Record<'GET' | 'POST', Handler>>> = {
  '/api/health': {
    GET: (_req, res) => {
      const check = validateStory()
      json(res, check.ok ? 200 : 503, { ok: check.ok, validator: check.output, engine: currentEngine() } satisfies HealthResponse)
    },
  },

  '/api/canon': {
    GET: (_req, res) => {
      // The export JSON is served verbatim — the backend holds no canon types.
      const payload = canonJson()
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
      res.end(payload)
    },
  },

  // The session timer (A76-4): what the author's time is being counted as.
  // Working state in .arc/, never committed, so none of it takes the lane.
  '/api/session': {
    GET: (_req, res) => json(res, 200, sessionState() satisfies SessionState),
  },
  '/api/session/start': {
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { kind?: unknown }
      if (!isSessionKind(b.kind)) throw new HttpError(400, 'kind must be "writing" or "record"')
      json(res, 200, startSession(b.kind) satisfies SessionState)
    },
  },
  '/api/session/stop': {
    POST: (_req, res) => json(res, 200, stopSession() satisfies SessionState),
  },
  '/api/session/ping': {
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as SessionPingRequest
      json(res, 200, pingSession(typeof b?.input === 'string' ? b.input : null) satisfies SessionState)
    },
  },

  // The attention inbox: checks findings, the proposal queue, unfired
  // payoffs — everything needing the author's review, in one response.
  '/api/attention': {
    GET: (_req, res) => json(res, 200, attention() satisfies AttentionResponse),
  },

  // Story material: the unplaced layer (conventions §12).
  '/api/material': {
    GET: (_req, res) => json(res, 200, { items: materialItems() } satisfies MaterialResponse),
  },

  // The book-wide revision fan-out is GONE (A69-9). It put prose in the
  // Changes reading from a pass with no row, which is exactly what the trust
  // boundary forbids once that surface is governed (§11), and nothing called
  // it. Working the notes on ONE scene is `/api/prose/work-notes`, rowed;
  // working every note in the book at once is Revise at manuscript scope,
  // which no slice owns yet.

  // Editorial lenses: several readings of one scene at once, each from its
  // own projection. Read-only by construction, so running them concurrently
  // is safe by the shape of the work rather than by scheduling.
  '/api/prose/lenses': {
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { scene?: unknown }
      if (typeof b.scene !== 'string' || !b.scene) throw new HttpError(400, 'scene required')
      if (!currentEngine()) throw new HttpError(503, noEngineSentence())
      const scene = proseScenes().find(s => s.scene === b.scene || s.file === b.scene)
      if (!scene) throw new HttpError(404, `no such scene: ${b.scene}`)

      const run = new Run('ui', `read ${scene.scene} through the editorial lenses`)
      registerRun(run)
      const out = await runLensFanOut(scene, run)
      // Nothing to accept: a reading changes nothing, so the run is done the
      // moment it has reported.
      closeRun(run.id, 'accepted')
      json(res, 200, { ...out, run: run.id } satisfies LensesResponse)
    },
  },

  // Connected agents: who is working on the story. One route because there is
  // one hook script — see arc-core/hooks/arc-hook.mjs.
  '/api/agents': {
    GET: (_req, res) => json(res, 200, { agents: listAgents() } satisfies AgentsResponse),
  },

  '/api/agents/hook': {
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as Record<string, unknown>
      const str = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '')
      json(res, 200, hook({
        event: str('event'),
        session: str('session'),
        cwd: str('cwd'),
        source: str('source') || undefined,
        prompt: str('prompt') || undefined,
        detail: b.detail,
        run: str('run') || undefined,
      }) satisfies HookResponse)
    },
  },

  // Runs: what arc is doing, and why. The machinery has existed since A13-2
  // and been reachable only from a terminal; these put it on the wire.
  '/api/runs': {
    GET: (_req, res) => json(res, 200, { runs: listRuns() } satisfies RunsResponse),
    // Opens a run and returns at once. Nothing here waits for a model: the
    // hook that will call this is synchronous with a 30s budget, while intake
    // alone measures ~9s. The author's words are carried immediately and the
    // structured reading fills in later.
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { prompt?: unknown; source?: unknown }
      if (typeof b.prompt !== 'string') throw new HttpError(400, 'prompt required')
      const source = b.source === 'ui' || b.source === 'claude-code' || b.source === 'cli' ? b.source : 'external'
      json(res, 200, { run: openRun(b.prompt, source) } satisfies RunResponse)
    },
  },

  // The live stream. events.jsonl stays the record; this is a second listener,
  // so the viewer holds one subscription instead of polling.
  '/api/runs/stream': {
    GET: (req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Vite's dev proxy and any nginx in front of a deployment will buffer
        // an event stream into uselessness without being told not to.
        'x-accel-buffering': 'no',
        ...(corsOrigin(req) ? { 'access-control-allow-origin': corsOrigin(req)! } : {}),
      })
      res.write('retry: 2000\n\n')

      const send = (message: unknown) => {
        try {
          res.write(`data: ${JSON.stringify(message)}\n\n`)
        } catch { /* the unsubscribe below handles a dead socket */ }
      }
      const stop = subscribeRuns(send)
      // A NAMED heartbeat event, not a comment line.
      //
      // A comment keeps intermediaries from reaping an idle stream but is
      // invisible to EventSource, which means a client cannot use it to tell
      // a live stream from a dead one. That matters because a proxy — Vite's
      // included — holds the browser's connection open after the upstream
      // dies, so `onerror` never fires and the viewer believes it is live
      // forever. A named event is deliverable, and stays out of `onmessage`
      // so it never looks like news.
      const beat = setInterval(() => {
        try { res.write(`event: ping\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`) } catch { /* closing */ }
      }, 15_000)
      const close = () => { clearInterval(beat); stop(); res.end() }
      req.on('close', close)
      req.on('error', close)
    },
  },

  // Correct a filed thought, or drop it. Deterministic — no model here.
  '/api/material/update': {
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { id?: unknown; body?: unknown; purpose?: unknown; status?: unknown }
      if (typeof b.id !== 'string' || !b.id) throw new HttpError(400, 'id required')
      for (const k of ['body', 'purpose', 'status'] as const) {
        if (b[k] !== undefined && typeof b[k] !== 'string') throw new HttpError(400, `${k} must be a string`)
      }
      json(res, 200, {
        item: updateMaterial(b.id, { body: b.body as string | undefined, purpose: b.purpose as string | undefined, status: b.status as string | undefined }),
      } satisfies UpdateMaterialResponse)
    },
  },

  // Notes: whatever the author wanted written down. Filing is a WRITE — no
  // model, no engine required, and no failure mode beyond the disk. Turning a
  // note into story material is a separate act (/api/notes/work).
  // Locks (A29): settled prose, reported and edited here — enforced in the
  // write paths, which is where the lock is actually real.
  '/api/locks': {
    GET: (_req, res) => json(res, 200, { locks: locks() } satisfies LocksResponse),
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { scene?: unknown; chapter?: unknown; paragraph?: unknown; quote?: unknown }
      // The three shapes (A40-1): a paragraph with its quote, a scene alone,
      // a chapter alone. createLock refuses blends with the reason.
      if (typeof b.scene !== 'string' && typeof b.chapter !== 'string') throw new HttpError(400, 'a lock names a scene or a chapter')
      if (b.paragraph !== undefined && (typeof b.paragraph !== 'number' || b.paragraph < 0)) throw new HttpError(400, 'paragraph must be a whole number from 0')
      if (b.quote !== undefined && typeof b.quote !== 'string') throw new HttpError(400, 'quote must be a string')
      json(res, 200, {
        lock: createLock({
          ...(typeof b.scene === 'string' ? { scene: b.scene } : {}),
          ...(typeof b.chapter === 'string' ? { chapter: b.chapter } : {}),
          ...(typeof b.paragraph === 'number' ? { paragraph: b.paragraph } : {}),
          ...(typeof b.quote === 'string' ? { quote: b.quote } : {}),
        }),
      })
    },
  },

  '/api/locks/delete': {
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { id?: unknown }
      if (typeof b.id !== 'string' || !b.id) throw new HttpError(400, 'id required')
      removeLock(b.id)
      json(res, 200, { ok: true } satisfies OkResponse)
    },
  },

  '/api/notes': {
    GET: (_req, res) => json(res, 200, { notes: listNotes() } satisfies NotesResponse),
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { text?: unknown }
      if (typeof b.text !== 'string') throw new HttpError(400, 'text required')
      json(res, 200, { note: addNote(b.text) } satisfies NoteResponse)
    },
  },

  '/api/notes/update': {
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { file?: unknown; text?: unknown }
      if (typeof b.file !== 'string') throw new HttpError(400, 'file required')
      if (typeof b.text !== 'string') throw new HttpError(400, 'text required')
      json(res, 200, { note: reviseNote(b.file, b.text) } satisfies NoteResponse)
    },
  },

  '/api/notes/delete': {
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { file?: unknown }
      if (typeof b.file !== 'string') throw new HttpError(400, 'file required')
      deleteNote(b.file)
      json(res, 200, { ok: true } satisfies OkResponse)
    },
  },

  // Work one note into the story: slice 1's whole path, run because the
  // author asked. A failure here leaves the note exactly as it was.
  '/api/notes/work': {
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { file?: unknown }
      if (typeof b.file !== 'string') throw new HttpError(400, 'file required')
      json(res, 200, (await workNote(b.file)) satisfies WorkResponse)
    },
  },

  '/api/notes/work/decide': {
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { run?: unknown; keep?: unknown; note?: unknown }
      if (typeof b.run !== 'string' || !b.run) throw new HttpError(400, 'run required')
      if (typeof b.keep !== 'boolean') throw new HttpError(400, 'keep must be true or false')
      const out = await decideWork(b.run, b.keep, typeof b.note === 'string' ? b.note : undefined)
      json(res, 200, { ok: true, ...out } satisfies WorkDecisionResponse)
    },
  },

  // How the story is drawn — presentation config, kept out of canon.
  '/api/view': {
    GET: (_req, res) => json(res, 200, viewConfig()),
  },

  // The story encyclopedia: docs/ articles with their canon bindings.
  '/api/docs': {
    GET: (_req, res) => json(res, 200, { articles: docsArticles() } satisfies DocsResponse),
  },

  // Annotations (conventions §14): the author's thoughts, anchored to the
  // prose that provoked them, resolved against the manuscript as it stands.
  '/api/annotations': {
    GET: (_req, res) => json(res, 200, { annotations: annotations() } satisfies AnnotationsResponse),
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as Record<string, unknown>
      json(res, 200, createAnnotation({
        scene: String(b.scene ?? ''),
        // Absence is the meaning here, so it has to survive the sanitising:
        // no paragraph is a note about the whole scene (§14). Coercing it to
        // a number turns that into a passage note anchored to a paragraph
        // that does not exist.
        ...(b.paragraph == null ? {} : { paragraph: Number(b.paragraph) }),
        ...(b.quote == null ? {} : { quote: String(b.quote) }),
        body: String(b.body ?? ''),
        ...(b.kind === 'keypoint' ? { kind: 'keypoint' as const } : {}),
        // As said, never filtered: a value arc does not know is refused by
        // the writer with the value named, not silently treated as unsaid.
        ...(b.by == null ? {} : { by: b.by as 'agent' | 'author' }),
      }))
    },
  },

  // Keypoints only — a note refuses (annotations.ts says why).
  '/api/annotations/delete': {
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { id?: unknown }
      if (typeof b.id !== 'string' || !b.id) throw new HttpError(400, 'id required')
      deleteAnnotation(b.id)
      json(res, 200, { ok: true } satisfies OkResponse)
    },
  },

  // Status only — resolving or dropping a note is the author's act.
  '/api/annotations/update': {
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { id?: unknown; status?: unknown; body?: unknown }
      if (typeof b.id !== 'string') throw new HttpError(400, 'id required')
      if (b.status !== undefined && typeof b.status !== 'string') throw new HttpError(400, 'status must be a string')
      if (b.body !== undefined && typeof b.body !== 'string') throw new HttpError(400, 'body must be a string')
      json(res, 200, updateAnnotation(b.id, { status: b.status, body: b.body }))
    },
  },

  // The style contract (conventions §10): both layers, as they are on disk,
  // plus the queue of rules arc has argued for and the author has not
  // ratified. A read — no engine guard.
  '/api/style': {
    GET: (_req, res) => {
      const { author, story } = loadStyleLayers()
      json(res, 200, {
        author, story,
        proposed: readQueue(),
        proposedTouchstones: readTouchstones(),
        // Every ratified touchstone's standing against the prose as it is
        // now — staleness computed, not remembered.
        touchstones: touchstoneStates(),
        // What the author declined, so the page can show it (A74-8).
        dismissed: readDismissed(),
      } satisfies StyleResponse)
    },
  },

  // Refresh the touchstones: find every calibration passage the manuscript
  // has rewritten out from under the contract, and PROPOSE its nearest living
  // descendant. Deterministic end to end — resolution decides which are
  // stale, word distance picks the replacement, the passage is copied from
  // the scene file. No model, no engine guard, nothing binds until ratified.
  '/api/style/touchstones/refresh': {
    POST: (_req, res) => {
      const r = proposeTouchstoneRefresh()
      json(res, 200, { proposed: r.added.length, current: r.current, skipped: r.skipped })
    },
  },

  // Run the learning pass on demand. The author decides when a review episode
  // is closed; draft-drain is a proxy for that, and this is the author saying
  // it outright. Same pass, same queue, same non-binding result.
  '/api/style/learn': {
    POST: async (_req, res) => {
      // Every scene the author has judged since the last pass, plus anything
      // arc has written and nobody has looked at yet.
      const files = [...new Set([
        ...readJudgments().map(j => j.file),
        ...proseScenes().map(sc => sc.file),
      ])].filter(f => f.startsWith('prose/'))
      const r = await runLearnStyle(files)
      json(res, 200, { proposed: r.added.length, considered: r.pairsConsidered, skipped: r.skipped, ...(r.run ? { run: r.run } : {}), ...(r.reply ? { reply: r.reply } : {}) })
    },
  },

  // The bootstrap: one deliberate pass over the book's committed history and
  // the author's notes, for a manuscript that made months of decisions before
  // the learning loop was listening. Files STORY-layer proposals only, under
  // the same cap and the same evidence bar as the live pass.
  '/api/style/bootstrap': {
    POST: async (_req, res) => {
      const r = await runBootstrapStyle()
      json(res, 200, { proposed: r.added.length, considered: r.pairsConsidered, skipped: r.skipped, ...(r.run ? { run: r.run } : {}), ...(r.reply ? { reply: r.reply } : {}) })
    },
  },

  // Ratify a proposed rule into a layer, or dismiss it. Deterministic: no
  // model runs here. Ratifying commits the two style files — the contract's
  // visible history (git log --follow -- docs/style.md) IS the "grows slowly"
  // goal — but a story without git simply keeps the change in its working
  // tree, which is a ratification too.
  '/api/style/proposed': {
    POST: async (req, res) => {
      const body = (await parsedBody(req)) as { id?: unknown; action?: unknown; layer?: unknown; kind?: unknown }
      if (typeof body.id !== 'string' || !body.id) throw new HttpError(400, 'id required')
      if (body.action !== 'ratify' && body.action !== 'dismiss') throw new HttpError(400, "action must be 'ratify' or 'dismiss'")
      const layer = body.layer === 'author' ? 'author' : 'story'

      // THE WRITE IS INSIDE THE TRANSACTION (A72-2), because a ratification
      // that changed the contract and then could not be committed is exactly
      // the half-done state the lane exists to prevent: the files the rule
      // lands in are kept first, so a refusal puts them back.
      const storyContract = path.join(STORY, 'docs', 'style.md')
      let proposedBy: string | undefined
      let receiptRel: string | null = null
      const { target, remaining, committed } = inLane('ratifying a style rule', tx => {
        const queueAbs = path.join(STORY, QUEUE_REL)
        const dismissedAbs = path.join(STORY, DISMISSED_REL)
        tx.keep(storyContract, authorStylePath(process.env, os.homedir()), queueAbs, dismissedAbs)

        // ONLY THIS DECISION'S DELTA LANDS (A74-8). The change is made twice:
        // to HEAD's text of the contract and the declined list (that is what
        // is committed) and then to the author's working files, which keep
        // whatever they have written since. The queue is arc's own file and
        // lands as it stands. Both passes use one moment, so the two copies
        // agree.
        const at = new Date().toISOString()
        const prefix = git('rev-parse', '--show-prefix').trim()
        const read = (abs: string): string | null => { try { return fs.readFileSync(abs, 'utf8') } catch { return null } }
        const atHead = (abs: string): string | null => {
          try { return git('show', `HEAD:${prefix}${path.relative(STORY, abs)}`) } catch { return null }
        }
        const working = new Map([storyContract, dismissedAbs, queueAbs].map(a => [a, read(a)] as const))
        const put = (abs: string, text: string | null): void => {
          if (text === null) fs.rmSync(abs, { force: true })
          else fs.writeFileSync(abs, text)
        }
        // A touchstone is a passage of THIS manuscript; it only ever lands in
        // the story contract, whatever tab the click came from. The author's
        // own file is not the story's to commit: its first pass goes to a
        // scratch path, its real pass is the second.
        const scratchAuthor = path.join(STORY, '.arc', 'style-decision-scratch.md')
        const decide = (authorPath: string) => body.kind === 'touchstone'
          ? ratifyTouchstone(body.id as string, body.action as 'ratify' | 'dismiss', storyContract, at, sceneLabel)
          : ratifyRule(body.id as string, body.action as 'ratify' | 'dismiss', layer, l =>
            l === 'author' ? authorPath : storyContract, at)
        for (const abs of [storyContract, dismissedAbs]) put(abs, atHead(abs) ?? working.get(abs) ?? null)
        let first: ReturnType<typeof decide>
        try { first = decide(scratchAuthor) } finally { fs.rmSync(scratchAuthor, { force: true }) }
        // The decision goes on the receipt of the run that proposed the rule,
        // in this same commit (D10); a proposal with no run skips it.
        if ('rule' in first) {
          proposedBy = first.rule.run
          receiptRel = stampStyleDecision(proposedBy, body.action as 'ratify' | 'dismiss', body.id as string, abs => tx.keep(abs))
        }
        // Only the story layer lives in the story repo; the author layer is
        // in the user's home and is not arc's to commit.
        let landed = false
        try {
          // The dismissal list rides along: saying no is a decision, and a
          // decision that lives only in a working tree is one a fresh clone
          // asks the author again.
          const tracked = ['docs/style.md', QUEUE_REL, DISMISSED_REL, ...(receiptRel ? [receiptRel] : [])]
            .filter(rel => { try { tx.stage([rel]); return true } catch { return false } })
          if (tracked.length) {
            tx.commit(`style: ${body.action} proposed ${body.kind === 'touchstone' ? 'touchstone' : 'rule'} ${body.id}`, tracked)
            landed = true
          }
        } catch (e) {
          // A refusal the author must read — the story's own commit gate, or
          // something outside arc holding the index — is theirs to read, not
          // a `committed: false` they would never notice. Anything else (no
          // git repo at all) leaves the change standing in the working tree,
          // which is a ratification too.
          if (e instanceof HttpError) throw e
          landed = false
        }
        // The author's working files go back, with the same change made to
        // them — their own words kept, the decision applied.
        for (const [abs, text] of working) put(abs, text)
        const out = decide(authorStylePath(process.env, os.homedir()))
        return { target: out.path, remaining: out.remaining, committed: landed }
      })

      // The receipt's commit hash, and the receipt into the record, behind the
      // decision (the accept's own order).
      if (committed) {
        try { joinStyleReceipt(proposedBy, receiptRel, git('rev-parse', '--short', 'HEAD').trim()) } catch { /* the decision stands */ }
      }

      // The author layer has its own repo and its own history; a ratification
      // into it is committed there, so `committed` finally means the same
      // thing for both layers.
      const inTheirOwnRepo = body.action === 'ratify' && body.kind !== 'touchstone' && layer === 'author' && target
        ? commitAuthorStyle(target, `style: ratify proposed rule ${body.id}`)
        : committed

      json(res, 200, { ok: true, action: body.action, path: target, remaining: remaining.length, committed: inTheirOwnRepo } satisfies RatifyRuleResponse)
    },
  },

  // The manuscript: bound prose scenes (conventions §10), each with THE BASE
  // of the file it came from (A72-3) — what a save or an adoption into it
  // must say it was decided about.
  '/api/prose': {
    GET: (_req, res) => {
      const scenes = proseScenes()
      const bases = Object.fromEntries(scenes.map(s => [s.file, baseOf(s.file)]))
      json(res, 200, { scenes, bases } satisfies ProseResponse)
    },
  },

  // The draft layer: working tree vs HEAD, plus ratification history.
  // PUT IT BACK (A72-8). History is read from the records; the preview is
  // read-only and returns the token the confirm must echo; the confirm goes
  // through the lane and is idempotent on the record.
  '/api/prose/history': {
    GET: (req, res) => {
      const scene = new URL(req.url ?? '/', 'http://x').searchParams.get('scene') ?? undefined
      json(res, 200, { decisions: decisionHistory(scene || undefined) } satisfies DecisionHistoryResponse)
    },
  },
  '/api/prose/put-back/preview': {
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { decision?: unknown }
      if (typeof b.decision !== 'string' || !b.decision) throw new HttpError(400, 'decision required')
      json(res, 200, previewPutBack(b.decision).preview satisfies PutBackPreview)
    },
  },
  '/api/prose/put-back': {
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { decision?: unknown; token?: unknown }
      if (typeof b.decision !== 'string' || !b.decision) throw new HttpError(400, 'decision required')
      json(res, 200, putBack(b.decision, b.token) satisfies PutBackResult)
    },
  },

  '/api/prose/draft': {
    // WHERE EACH HANDED NOTE'S CHANGE STANDS rides on the change (A72-7):
    // the rail's badge is read off provenance and the two versions of the
    // scene, never stored, and never a model's view of whether a note was met.
    GET: (_req, res) => {
      const draft = proseDraft()
      json(res, 200, {
        ...draft,
        changes: draft.changes.map(c => {
          const answered = answeredNow(c)
          return answered ? { ...c, answered } : c
        }),
      } satisfies ProseDraft)
    },
  },

  // The re-entry briefing: where the author left off, what is in flight,
  // what is due — read from the record, never generated (harness.md §13
  // item 2, rung 0). Deterministic and instant; no engine is touched.
  '/api/briefing': {
    GET: (_req, res) => json(res, 200, briefing() satisfies BriefingResponse),
  },

  // Accept ratifies the draft into main (a git commit scoped to prose/).
  // What the accept teaches the record and the style contract is the review
  // episode's (A74-3): nothing here reads it, and nothing after the commit
  // is awaited.
  '/api/prose/accept': {
    POST: async (req, res) => {
      const body = (await parsedBody(req)) as { message?: unknown; files?: unknown; bases?: unknown }
      // The scene-scoped accept (A64-3): the author read ONE scene's diff and
      // ratified that. `files` is required (A72-1) — the rules about which
      // paths an accept may name live in one place, `acceptScope` in story.ts,
      // so this route only narrows the wire shape.
      if (body.files !== undefined && !Array.isArray(body.files)) {
        throw new HttpError(400, 'files must be an array of scene paths')
      }
      const files = (body.files ?? []) as string[]
      // The ceremony after the commit — receipts, the routes beside an
      // adopted scene, the notes it answered — is accept.ts's.
      json(res, 200, acceptScenes(typeof body.message === 'string' ? body.message : undefined, files, body.bases) satisfies ProseAcceptResponse)

    },
  },

  // Write a scene's body back into the working tree — the draft layer. The
  // baseline is what the edit started from: without a file watcher it is the
  // only way to tell an edit apart from a clobber.
  '/api/prose/scene': {
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { file?: unknown; body?: unknown; baseline?: unknown; base?: unknown }
      if (typeof b.file !== 'string' || typeof b.body !== 'string') throw new HttpError(400, 'file and body required')
      if (b.baseline !== undefined && typeof b.baseline !== 'string') throw new HttpError(400, 'baseline must be a string')
      json(res, 200, proseWrite(b.file, b.body, b.baseline, b.base))
    },
  },

  // Accept one paragraph, leaving the rest of the draft pending. The body
  // names the paragraph by identity — side plus that side's own index — and
  // never carries prose, exactly as the sentence verbs do.
  '/api/prose/accept-paragraph': {
    POST: async (req, res) => {
      json(res, 200, acceptParagraph(paragraphTarget(await parsedBody(req))) satisfies ProsePartAcceptResponse)
    },
  },

  // Reject is accept's mirror and commits nothing: the working tree loses one
  // change and keeps every other, so the remaining diff is still exactly what
  // has not been decided.
  '/api/prose/reject-paragraph': {
    POST: async (req, res) => {
      json(res, 200, rejectParagraph(paragraphTarget(await parsedBody(req))) satisfies ProsePartRejectResponse)
    },
  },

  // Sentence granularity (A37-3). The body names the sentence by identity and
  // never carries prose; the server re-splits by the shared rule and merges.
  '/api/prose/accept-sentence': {
    POST: async (req, res) => {
      json(res, 200, acceptSentence(sentenceTarget(await parsedBody(req))) satisfies ProsePartAcceptResponse)
    },
  },

  '/api/prose/reject-sentence': {
    POST: async (req, res) => {
      json(res, 200, rejectSentence(sentenceTarget(await parsedBody(req))) satisfies ProsePartRejectResponse)
    },
  },

  // The redraft pass: a rebuild of existing prose, landing in the draft
  // layer like any other generation. Locks and the validator can refuse it;
  // everything else the pass has to say about its own output arrives as
  // argued claims in the reply.
  '/api/prose/redraft': {
    POST: async (req, res) => {
      if (!currentEngine()) {
        throw new HttpError(400, noEngineSentence())
      }
      const b = (await parsedBody(req)) as { scene?: unknown; paragraphs?: unknown; guidance?: unknown; plan?: unknown }
      if (typeof b.scene !== 'string' || !b.scene) throw new HttpError(400, 'scene required')
      let paragraphs: [number, number] | undefined
      if (b.paragraphs !== undefined) {
        if (!Array.isArray(b.paragraphs) || b.paragraphs.length !== 2 || !b.paragraphs.every(n => Number.isInteger(n))) {
          throw new HttpError(400, 'paragraphs must be [from, to]')
        }
        paragraphs = b.paragraphs as [number, number]
      }
      // The same three states as the draft's (A69-4, A69-8): absent, a
      // settled plan, or null for a withdrawn line.
      const plan = b.plan === null ? null : b.plan === undefined ? undefined : parsePlan(b.plan)
      json(res, 200, await runRedraft({
        scene: b.scene,
        paragraphs,
        guidance: typeof b.guidance === 'string' ? b.guidance : undefined,
      }, plan) satisfies DraftSceneResponse)
    },
  },

  // "Work through my notes on this scene": the scene's open notes are the
  // brief. revise is the minimal revision with the notes as instructions;
  // redraft is the clean pass with the notes answered where the rebuild
  // allows. A scene with no open notes is refused (409), never run on nothing.
  '/api/prose/work-notes': {
    POST: async (req, res) => {
      if (!currentEngine()) {
        throw new HttpError(400, noEngineSentence())
      }
      const b = (await parsedBody(req)) as { scene?: unknown; mode?: unknown; guidance?: unknown }
      if (typeof b.scene !== 'string' || !b.scene) throw new HttpError(400, 'scene required')
      if (b.mode !== undefined && b.mode !== 'revise' && b.mode !== 'redraft') throw new HttpError(400, "mode must be 'revise' or 'redraft'")
      json(res, 200, await runWorkNotes({
        scene: b.scene,
        mode: b.mode as WorkNotesMode | undefined,
        guidance: typeof b.guidance === 'string' ? b.guidance : undefined,
        source: 'ui',
      }) satisfies WorkNotesResponse)
    },
  },

  // The reroute pass: another way to the same destination. Alternatives land
  // beside the manuscript, never in it — GET lists them (and the locks that
  // would constrain a run), POST runs the pass, adopt is the lock-gated scene
  // write that also records the ledger, drop deletes the file.
  '/api/prose/reroute': {
    GET: (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const scene = url.searchParams.get('scene')
      if (!scene) throw new HttpError(400, 'scene required')
      json(res, 200, listRoutes(scene) satisfies RouteListResponse)
    },
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { scene?: unknown; count?: unknown; guidance?: unknown; dry?: unknown; depth?: unknown }
      // A dry run consults no engine, so it needs none (A67-2).
      if (b.dry !== true && !currentEngine()) {
        throw new HttpError(400, noEngineSentence())
      }
      if (typeof b.scene !== 'string' || !b.scene) throw new HttpError(400, 'scene required')
      // THE REQUEST (A67-8): the gesture the author made, resolved by code
      // to a cell and then to the row that admits it — refused here, in
      // their words, if the rows do not list it.
      const request = resolveRequest({
        said: `another way through ${b.scene}`,
        job: 'explore', scope: 'scene', mode: 'one-shot',
        depth: typeof b.depth === 'string' ? b.depth : undefined,
        subject: b.scene,
      })
      if (b.count !== undefined && !(Number.isInteger(b.count) && (b.count as number) >= 1 && (b.count as number) <= 3)) {
        throw new HttpError(400, 'count must be 1–3')
      }
      json(res, 200, await runReroute({
        scene: b.scene,
        request,
        count: b.count as number | undefined,
        guidance: typeof b.guidance === 'string' ? b.guidance : undefined,
        dry: b.dry === true,
      }) satisfies RerouteResponse)
    },
  },
  // How many routes wait on each scene: one read, so the manuscript can mark
  // every scene without asking per scene.
  // What is on disk after a killed run or a retired proposal (A67-12). The
  // terminal asks; the counts are the backend's because the record is.
  '/api/doctor/records': {
    GET: (_req, res) => { json(res, 200, doctorRecords() satisfies DoctorRecordsResponse) },
  },

  // ASK AGAIN: one route re-issued from what it recorded, in its own place
  // (A69-13). Separate from the reroute above because the two gestures mean
  // different things — this one replaces, that one adds — and a flag on one
  // endpoint would let a viewer bug turn one into the other.
  '/api/prose/reroute/again': {
    POST: async (req, res) => {
      if (!currentEngine()) {
        throw new HttpError(400, noEngineSentence())
      }
      const b = (await parsedBody(req)) as { scene?: unknown; alt?: unknown; depth?: unknown }
      if (typeof b.scene !== 'string' || !b.scene || typeof b.alt !== 'string' || !b.alt) throw new HttpError(400, 'scene and alt required')
      // THE ROUTE AS RECORDED, not as the page reads it. `listRoutes` strips
      // `reads` on the way out — the fingerprints of the record have no
      // business on a page beside the prose — and `reads` is the only place
      // the notes this route was given are named. Read it here and the
      // re-issue is handed no notes at all, which is the opposite of the
      // job it claims to repeat (A69-13 review).
      const alt = listAlternatives(b.scene).find(a => a.id === b.alt)
      if (!alt) throw new HttpError(404, `no alternative ${b.alt} for ${b.scene}`)
      const request = resolveRequest({
        said: `ask again for this way through ${b.scene}`,
        job: 'explore', scope: 'scene', mode: 'one-shot',
        depth: typeof b.depth === 'string' ? b.depth : undefined,
        subject: b.scene,
      })
      json(res, 200, await runReroute({ scene: b.scene, request, reissue: alt }) satisfies RerouteResponse)
    },
  },

  '/api/prose/reroute/counts': {
    GET: (_req, res) => { json(res, 200, { counts: routeCounts() }) },
  },

  '/api/prose/reroute/adopt': {
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { scene?: unknown; alt?: unknown; base?: unknown }
      if (typeof b.scene !== 'string' || !b.scene || typeof b.alt !== 'string' || !b.alt) throw new HttpError(400, 'scene and alt required')
      // FAILS CLOSED like every other decision (A72-3). Adoption writes the
      // destination scene, so a request that does not say which version it
      // was deciding about is one arc cannot show the author a reason for.
      // The in-process function keeps the parameter optional for a caller
      // with no view to have read — a terminal, a test; the door does not.
      if (typeof b.base !== 'string' || !b.base) {
        throw new HttpError(400, 'putting a route into the book must say which version of the scene it was decided about — reload the manuscript and try again')
      }
      json(res, 200, adoptAlternative(b.scene, b.alt, b.base) satisfies AdoptRouteResponse)
    },
  },
  '/api/prose/reroute/drop': {
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { scene?: unknown; alt?: unknown }
      if (typeof b.scene !== 'string' || !b.scene || typeof b.alt !== 'string' || !b.alt) throw new HttpError(400, 'scene and alt required')
      dropAlternative(b.scene, b.alt)
      json(res, 200, { ok: true } satisfies OkResponse)
    },
  },

  // Rewrite one alternative under the author's note: a new version of the
  // same route lands beside the old one (`revises` names the parent); the
  // ledger still learns of a route only on adopt.
  // A note on a route: about one of its paragraphs, or about the whole of
  // it. Notes live with the route and are the rewrite's brief.
  '/api/prose/reroute/note': {
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { scene?: unknown; alt?: unknown; body?: unknown; paragraph?: unknown }
      if (typeof b.scene !== 'string' || !b.scene || typeof b.alt !== 'string' || !b.alt) throw new HttpError(400, 'scene and alt required')
      if (typeof b.body !== 'string' || !b.body.trim()) throw new HttpError(400, 'a note needs something in it')
      const paragraph = b.paragraph === undefined || b.paragraph === null ? null : b.paragraph
      if (paragraph !== null && typeof paragraph !== 'number') throw new HttpError(400, 'paragraph must be a number, or absent for a note about the whole route')
      json(res, 200, { alternative: addRouteNote(b.scene, b.alt, b.body, paragraph) })
    },
  },
  '/api/prose/reroute/note/delete': {
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { scene?: unknown; alt?: unknown; note?: unknown }
      if (typeof b.scene !== 'string' || !b.scene || typeof b.alt !== 'string' || !b.alt || typeof b.note !== 'string' || !b.note) {
        throw new HttpError(400, 'scene, alt and note required')
      }
      json(res, 200, { alternative: deleteRouteNote(b.scene, b.alt, b.note) })
    },
  },

  '/api/prose/reroute/revise': {
    POST: async (req, res) => {
      if (!currentEngine()) {
        throw new HttpError(400, noEngineSentence())
      }
      const b = (await parsedBody(req)) as { scene?: unknown; alt?: unknown; note?: unknown; depth?: unknown }
      if (typeof b.scene !== 'string' || !b.scene || typeof b.alt !== 'string' || !b.alt) throw new HttpError(400, 'scene and alt required')
      if (b.note !== undefined && typeof b.note !== 'string') throw new HttpError(400, 'note must be text')
      const request = resolveRequest({
        said: `rewrite this route from my notes on it`,
        job: 'explore', scope: 'route', mode: 'one-shot',
        depth: typeof b.depth === 'string' ? b.depth : undefined,
        subject: b.alt,
      })
      json(res, 200, await runRevise({ scene: b.scene, alt: b.alt, request, note: typeof b.note === 'string' ? b.note.trim() : undefined }) satisfies RerouteResponse)
    },
  },

  // ASK AGAIN, for a pending draft (A72-13). The same question arc was asked
  // for these words, asked again from where the record stands now — the row
  // that answered it, its own target, its own scope, the author's own words.
  // The replacement runs through the ordinary guarded landing, so the words on
  // screen stay until the new ones are in, and a failure leaves them.
  '/api/prose/ask-again': {
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { file?: unknown; base?: unknown; replaceMine?: unknown; plan?: unknown }
      if (typeof b.file !== 'string' || !b.file) throw new HttpError(400, 'file required')

      // WHAT IT WOULD DO, asked for on its own and running nothing: the
      // author reads what would be replaced before anything replaces it.
      if (b.plan === true) {
        json(res, 200, { plan: planReplay(b.file) } satisfies AskAgainDraftPlanResponse)
        return
      }

      const { entry, replaces } = admitReplay(b.file, b.base, b.replaceMine === true)
      const r = entry.replay!
      claimReplay(b.file, entry.run ?? 'unknown')
      try {
        // BACK TO THE ROW THAT ANSWERED IT. A replay that chose its own row
        // would be a different job wearing the author's label, so an entry
        // whose row arc no longer has is refused rather than approximated.
        // AN ADOPTED ROUTE is not a redraft, and asking again about it is not
        // asking for a rebuild. It re-issues the ROUTE the words came from —
        // the same seed, the same question (A69-13) — and puts the answer
        // into the same destination through the same guarded adopt path, so
        // the words on screen stay until the new ones are in.
        if (r.row === ROUTE_REPLAY_ROW) {
          const was = entry.route
          const alt = was ? listAlternatives(r.scene!).find(a => a.id === was) : undefined
          if (!alt) {
            throw new HttpError(409,
              'the way through these words came from is no longer on the scene, so arc cannot ask for it again. '
              + 'Ask for another way through from where the scene stands now.')
          }
          const asked = resolveRequest({
            said: `ask again for this way through ${r.scene}`,
            job: 'explore', scope: 'scene', mode: 'one-shot', subject: r.scene!,
          })
          const out = await runReroute({ scene: r.scene!, request: asked, reissue: alt })
          const fresh = out.alternatives[0]
          if (!fresh) {
            // Nothing came back, and the words on screen are untouched: the
            // refusal the pass already rendered is what the author reads.
            json(res, 200, out satisfies RerouteResponse)
            return
          }
          // Into the same destination, through the door that compares the
          // version the author was looking at (A72-3) before it writes.
          adoptAlternative(r.scene!, fresh.id, b.base)
          json(res, 200, out satisfies RerouteResponse)
          return
        }

        // U2's notes revision is the quick depth of the same cell as U3's
        // clean pass, which is exactly why the row key is what dispatches and
        // not the job: the two ask different questions about the same scene.
        if (r.row === 'revise.scene.one-shot.quick') {
          // The notes that apply NOW are the question, which is the whole
          // point of asking again after one of them changed.
          json(res, 200, await runWorkNotes({
            scene: r.scene ?? '', mode: 'revise',
            ...(r.guidance ? { guidance: r.guidance } : {}), replaces, source: 'ui',
          }) satisfies WorkNotesResponse)
          return
        }
        if (r.row === 'revise.scene.one-shot' || r.row === 'revise.selection.one-shot') {
          // U3's rebuild, at its own scope — the range was re-resolved in
          // `admitReplay` and refused there if it no longer lands.
          json(res, 200, await runRedraft({
            scene: r.scene ?? '', ...(r.paragraphs ? { paragraphs: r.paragraphs } : {}),
            ...(r.guidance ? { guidance: r.guidance } : {}), replaces,
          }, r.plan ? { moves: r.plan.moves } : undefined) satisfies DraftSceneResponse)
          return
        }
        // U1 DRAFTS A NEW SCENE, and its replay goes back into ITS OWN slot:
        // `sceneSlot` picks the next FREE one, which after a landing is the
        // one after this, so a replay without the target would write a new
        // scene beside the author's rather than in its place.
        if (r.row === 'draft.scene.one-shot') {
          const chapter = proseScenes().find(s => s.scene === r.scene)?.chapter
          if (!chapter) {
            throw new HttpError(409,
              'arc cannot find the chapter that scene belongs to, so it cannot ask for it again. Ask for a new scene from where the chapter stands now.')
          }
          json(res, 200, await runDraft(chapter, r.guidance, r.plan ? { moves: r.plan.moves } : undefined,
            { replaces, file: r.file, sceneId: r.scene! }) satisfies DraftSceneResponse)
          return
        }
        throw new HttpError(409,
          'arc no longer has the pass that wrote these words, so it cannot ask the same question again. Ask for something new from where the scene stands now.')
      } finally {
        releaseReplay(b.file)
      }
    },
  },

  // THE WORDS A PASS COULD NOT PUT IN (A72-4, read in A72-5). Read one, or
  // let it go. Neither is a decision about the manuscript: nothing here is in
  // it, so nothing here can be accepted or rejected.
  '/api/prose/candidate': {
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { run?: unknown; drop?: unknown }
      if (typeof b.run !== 'string' || !/^run\.\d+$/.test(b.run)) throw new HttpError(400, 'run required')
      if (b.drop === true) {
        if (!dropCandidate(b.run)) {
          throw new HttpError(500, 'arc could not let those words go — they are still kept beside the scene. Try again.')
        }
        json(res, 200, { ok: true } satisfies OkResponse)
        return
      }
      const text = candidateText(b.run)
      if (text === null) throw new HttpError(404, 'arc is no longer holding those words')
      json(res, 200, { run: b.run, text } satisfies CandidateResponse)
    },
  },

  // Discard rolls one draft file back to main (a surfaced git checkout).
  '/api/prose/discard': {
    POST: async (req, res) => {
      const body = (await parsedBody(req)) as { file?: unknown; base?: unknown }
      if (typeof body.file !== 'string') throw new HttpError(400, 'file required')
      json(res, 200, discardDraft(body.file, body.base) satisfies ProseDiscardResponse)
    },
  },

  // The drafting pass: generate one scene into the working tree. The result
  // is an ordinary draft in /api/prose/draft — the author's accept or
  // discard stays the only gate. Engine: headless `claude -p` on the
  // author's subscription login; the SDK only when ARC_DRAFT_ENGINE=sdk.
  '/api/prose/draft-scene': {
    POST: async (req, res) => {
      if (!currentEngine()) {
        throw new HttpError(503, noEngineSentence())
      }
      const body = (await parsedBody(req)) as { chapter?: unknown; guidance?: unknown; plan?: unknown }
      if (typeof body.chapter !== 'string' || !body.chapter) throw new HttpError(400, 'chapter required')
      const guidance = typeof body.guidance === 'string' ? body.guidance : undefined
      // THREE STATES, and they mean three different things (A69-4):
      // absent — the author has not been shown a plan, so a line said now
      // returns one and nothing is written; an object — the plan they
      // settled, as given or edited; null — they read it and withdrew the
      // line, so the draft runs without it.
      const plan = body.plan === null ? null
        : body.plan === undefined ? undefined
          : parsePlan(body.plan)
      json(res, 200, await runDraft(body.chapter, guidance, plan) satisfies DraftSceneResponse)
    },
  },

  // The analysis pass: what would this pending draft do to the story? Runs
  // before the accept decision and writes nothing — its briefing is wholly
  // in the argued register (conventions §11).
  // Selection suggestions: rephrase against the style contract, or synonyms
  // with nuance. Read-only; argued register; never applied by the machine.
  '/api/prose/suggest': {
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { kind?: unknown; selection?: unknown; paragraph?: unknown; file?: unknown }
      if (b.kind !== 'rephrase' && b.kind !== 'synonyms') throw new HttpError(400, "kind must be 'rephrase' or 'synonyms'")
      if (typeof b.selection !== 'string') throw new HttpError(400, 'selection must be a string')
      if (b.paragraph !== undefined && typeof b.paragraph !== 'string') throw new HttpError(400, 'paragraph must be a string')
      if (b.file !== undefined && typeof b.file !== 'string') throw new HttpError(400, 'file must be a string')
      json(res, 200, await runSuggest({ kind: b.kind, selection: b.selection, paragraph: b.paragraph, file: b.file }))
    },
  },

  // The mechanical checks: the proven channel over the manuscript. No
  // engine guard, deliberately — nothing here needs a model, which is the
  // whole point: a doubled space arrives as a fact, instantly and free,
  // where every other reading this surface offers is a model's opinion.
  '/api/prose/checks': {
    GET: (_req, res) => {
      const findings: ProseCheckHit[] = []
      // The ratified contract, read once: the countable rules (A77-1) list a
      // sentence only over a number the contract states, through the gates'
      // own readers and counter. The proposed layer is never read here.
      const style = styleContract()
      const scenes = proseScenes()
      const locksFor = lockResolver(scenes)
      for (const sc of scenes) {
        const hits = proseChecks(sc.body)
        const standing = locksFor(sc.scene, sc.body).filter(l =>
          l.resolution.state === 'resolved' || l.resolution.state === 'drifted')
        // A finding inside settled prose names its lock — the author reads
        // "there is a typo, and you locked it" and decides; nothing repairs.
        const locked = new Map(standing
          .filter(l => l.resolution.paragraph !== null)
          .map(l => [l.resolution.paragraph!, l.id]))
        const wide = standing.find(l => l.scope === 'scene' || l.scope === 'chapter')
        for (const h of hits) {
          const lock = locked.get(h.paragraph) ?? wide?.id
          findings.push({ scene: sc.scene, file: sc.file, ...h, ...(lock ? { lock } : {}) })
        }
        // A count is never held against settled prose: a locked paragraph,
        // or every paragraph under a scene or chapter lock, is not counted.
        if (wide) continue
        for (const h of countableChecks(sc.body, style, (_p, i) => locked.has(i))) {
          findings.push({ scene: sc.scene, file: sc.file, ...h })
        }
      }
      json(res, 200, { findings } satisfies ProseChecksResponse)
    },
  },

  // U9 · WHAT WOULD THIS CHANGE DO TO THE STORY (A72-10). One pending scene,
  // read against the record it was briefed with — rowed, receipted, gated,
  // and it writes nothing. The base of the diff the author is reading comes
  // with the question, so a reading is never made about words they have not
  // seen, and the answer carries it back so the page can tell a current
  // reading from one the draft has moved past.
  '/api/prose/inspect': {
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { scene?: unknown; base?: unknown }
      if (typeof b?.scene !== 'string' || !b.scene) throw new HttpError(400, 'scene required')
      json(res, 200, await runInspect(b.scene, b.base) satisfies InspectDraftResponse)
    },
  },

  // U7 · WHAT SHOULD THE RECORD LEARN FROM WHAT WAS ACCEPTED (A74-1). One
  // scene's accepted change, read against the record, rowed and receipted;
  // each proposal that survives its gates is filed as a canon record with
  // status: proposed in the working tree. Nothing is committed.
  '/api/record/update': {
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { scene?: unknown; from?: unknown; to?: unknown }
      if (typeof b?.scene !== 'string' || !b.scene) throw new HttpError(400, 'scene required')
      for (const k of ['from', 'to'] as const) {
        if (b[k] !== undefined && (typeof b[k] !== 'string' || !b[k])) throw new HttpError(400, `${k} must be a commit`)
      }
      json(res, 200, await readSceneByHand(b.scene, b.from as string | undefined, b.to as string | undefined) satisfies UpdateRecordResponse)
    },
  },

  // THE AUTHOR'S WORD ON PROPOSED RECORDS (A74-4): approve, or never. The
  // whole batch is decided or refused; later is the viewer's and has no route.
  '/api/record/proposals': {
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { ids?: unknown; action?: unknown }
      json(res, 200, decideProposals(b?.ids, b?.action) satisfies DecideProposalsResponse)
    },
  },
}

// Story-owned rendering assets (the basemap coastline, and whatever else a
// story needs drawn). Lives in the story repo, not the viewer.
const assetHandler: Handler = (req, res, url) => {
  if (req.method !== 'GET') throw new HttpError(405, 'GET only')
  const name = decodeURIComponent(url.pathname.slice('/api/assets/'.length))
  const asset = readAsset(name)
  if (!asset) throw new HttpError(404, `no such story asset: ${name}`)
  res.writeHead(200, { 'content-type': asset.contentType, 'content-length': asset.body.length })
  res.end(asset.body)
}

/** The server, unstarted — main.ts listens; tests listen on port 0. */
export function createArcServer(): http.Server {
  return http.createServer(async (req, res) => {
    const started = Date.now()
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    const origin = corsOrigin(req)
    if (origin) res.setHeader('access-control-allow-origin', origin)
    res.setHeader('access-control-allow-headers', 'content-type')
    // DELETE is not a safelisted method, so the viewer's preflight must be
    // answered with the methods or the browser blocks the request before it
    // is made (A67-3, the transcript route).
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // A DECISION MADE, THE RESPONSE SENT, THEN LOOK (A74-3, epic D2): when the
    // lane's commit count moved while this POST was in flight, the due
    // episodes start once the response has gone. Never awaited by the request, never from a GET.
    const commitsBefore = laneCommits()
    res.on('finish', () => {
      if (req.method === 'POST' && laneCommits() !== commitsBefore) {
        void startDueEpisodes().catch(e => console.error('[error] starting the due reads failed:', e))
      }
    })

    try {
      if (url.pathname.startsWith('/api/assets/')) {
        await assetHandler(req, res, url)
      } else {
        const route = routes[url.pathname]
        if (route) {
          const handler = route[req.method as 'GET' | 'POST']
          if (!handler) throw new HttpError(405, `${Object.keys(route).join('/')} only`)
          await handler(req, res, url)
        } else {
          const hit = paramRoutes
            .map(r => ({ r, m: r.pattern.exec(url.pathname) }))
            .find(x => x.m)
          if (!hit) throw new HttpError(404, `no route for ${url.pathname}`)
          const handler = hit.r.methods[req.method as 'GET' | 'POST' | 'DELETE']
          if (!handler) throw new HttpError(405, `${Object.keys(hit.r.methods).join('/')} only`)
          await handler(req, res, decodeURIComponent(hit.m![1]))
        }
      }
    } catch (e) {
      if (e instanceof HttpError) {
        json(res, e.status, { error: e.message, ...(e.detail ?? {}) } satisfies ApiErrorResponse)
      } else {
        console.error(`[error] ${req.method} ${url.pathname}:`, e)
        json(res, 500, { error: 'internal error — see backend log' } satisfies ApiErrorResponse)
      }
    }

    console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`)
  })
}
