// arc-backend: the canon API and the embedded world-shaping agent.
//
// Routing is a plain table — path → method → handler — dispatched by one
// function that also owns the error mapping: HttpError becomes its status
// with a clean {error} body; anything else is logged in full to stderr and
// answered with a generic 500, so tool output and stack traces never reach
// the browser. Every JSON payload is checked against the shared wire types
// (arc-canon-graph/api-types.ts) with `satisfies`.
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type {
  AnalyzeResponse, ApiErrorResponse, AttentionResponse, ChatMessage, ChatRequest, DocsResponse, DraftSceneResponse,
  AnnotationsResponse, HealthResponse, MaterialResponse, NoteResponse, NotesResponse,
  AgentsResponse, HookResponse, LensesResponse, OkResponse, RunDecisionResponse, RunDetailResponse, RunResponse, RunsResponse,
  UpdateMaterialResponse, WorkDecisionResponse, WorkResponse,
  ProseAcceptResponse, ProseResponse,
  RatifyRuleResponse, StyleResponse,
} from 'arc-canon-graph'
import { STORY } from './config'
import { HttpError, corsOrigin, json, readBody } from './http'
import { canonJson, validateStory } from './canon'
import { docsArticles, git, materialItems, updateMaterial, proseAccept, proseAcceptParagraph, proseDiscard, proseDraft, proseWrite, proseScenes, readAsset, viewConfig } from './story'
import { handleChat } from './agent'
import { annotations, createAnnotation, updateAnnotation } from './annotations'
import { attention } from './attention'
import { runCapture } from './capture'
import { runAnalysis } from './analyze'
import { runSuggest } from './suggest'
import { runDraft } from './draft'
import { currentEngine } from './engine'
import { authorStylePath, loadStyleLayers } from './style'
import { QUEUE_REL, ratifyRule, readQueue } from './style-queue'
import { runLearnStyle } from './learn-style'
import { addNote, deleteNote, listNotes, updateNote as reviseNote } from './notes'
import { decideWork, workNote } from './work'
import { closeRun, getRun, listRuns, observe, openRun, pendingOutcome, registerRun } from './runs'
import { hook, listAgents } from './agents'
import { Run, subscribeRuns } from './run'
import { runLensFanOut } from './lenses'
import { decide } from './orchestrate'

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void | Promise<void>
type ParamHandler = (req: http.IncomingMessage, res: http.ServerResponse, id: string) => void | Promise<void>

/** Routes carrying one id in the path. The exact table stays the common case
 *  and is checked first; this is consulted only on a miss, so nothing about
 *  the existing dispatch changes shape. */
const paramRoutes: { pattern: RegExp; methods: Partial<Record<'GET' | 'POST', ParamHandler>> }[] = []

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

/** Validate the chat request shape before it goes anywhere near the SDK. */
function chatRequest(body: unknown): ChatRequest {
  const b = body as { messages?: unknown }
  if (!b || !Array.isArray(b.messages) || b.messages.length === 0 || b.messages.length > 200) {
    throw new HttpError(400, 'messages must be a non-empty array of at most 200 items')
  }
  for (const m of b.messages as { role?: unknown; content?: unknown }[]) {
    if ((m?.role !== 'user' && m?.role !== 'assistant') || typeof m?.content !== 'string') {
      throw new HttpError(400, 'each message needs role "user"|"assistant" and string content')
    }
  }
  return { messages: b.messages as ChatMessage[] }
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

  // The attention inbox: checks findings, the proposal queue, unfired
  // payoffs — everything needing the author's review, in one response.
  '/api/attention': {
    GET: (_req, res) => json(res, 200, attention() satisfies AttentionResponse),
  },

  // Story material: the unplaced layer (conventions §12).
  '/api/material': {
    GET: (_req, res) => json(res, 200, { items: materialItems() } satisfies MaterialResponse),
  },

  // Editorial lenses: several readings of one scene at once, each from its
  // own projection. Read-only by construction, so running them concurrently
  // is safe by the shape of the work rather than by scheduling.
  '/api/prose/lenses': {
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { scene?: unknown }
      if (typeof b.scene !== 'string' || !b.scene) throw new HttpError(400, 'scene required')
      if (!currentEngine()) throw new HttpError(503, 'No generation engine available.')
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
        paragraph: Number(b.paragraph ?? -1),
        quote: String(b.quote ?? ''),
        body: String(b.body ?? ''),
      }))
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
      json(res, 200, { author, story, proposed: readQueue() } satisfies StyleResponse)
    },
  },

  // Ratify a proposed rule into a layer, or dismiss it. Deterministic: no
  // model runs here. Ratifying commits the two style files — the contract's
  // visible history (git log --follow -- docs/style.md) IS the "grows slowly"
  // goal — but a story without git simply keeps the change in its working
  // tree, which is a ratification too.
  '/api/style/proposed': {
    POST: async (req, res) => {
      const body = (await parsedBody(req)) as { id?: unknown; action?: unknown; layer?: unknown }
      if (typeof body.id !== 'string' || !body.id) throw new HttpError(400, 'id required')
      if (body.action !== 'ratify' && body.action !== 'dismiss') throw new HttpError(400, "action must be 'ratify' or 'dismiss'")
      const layer = body.layer === 'author' ? 'author' : 'story'

      const { path: target, remaining } = ratifyRule(body.id, body.action, layer, l =>
        l === 'author' ? authorStylePath(process.env, os.homedir()) : path.join(STORY, 'docs', 'style.md'))

      // Only the story layer lives in the story repo; the author layer is in
      // the user's home and is not arc's to commit.
      let committed = false
      try {
        git('add', '--', 'docs/style.md', QUEUE_REL)
        git('commit', '-m', `style: ${body.action} proposed rule ${body.id}`, '--', 'docs/style.md', QUEUE_REL)
        committed = true
      } catch {
        committed = false // not a git repo, or nothing staged — the file change stands either way
      }

      json(res, 200, { ok: true, action: body.action, path: target, remaining: remaining.length, committed } satisfies RatifyRuleResponse)
    },
  },

  // The manuscript: bound prose scenes (conventions §10).
  '/api/prose': {
    GET: (_req, res) => json(res, 200, { scenes: proseScenes() } satisfies ProseResponse),
  },

  // The draft layer: working tree vs HEAD, plus ratification history.
  '/api/prose/draft': {
    GET: (_req, res) => json(res, 200, proseDraft()),
  },

  // Accept ratifies the draft into main (a git commit scoped to prose/).
  // With capture: true and credentials present, the capture pass then
  // extracts what the accepted scenes changed and files proposals — its
  // failure is logged, never fatal: capture must never un-accept prose.
  '/api/prose/accept': {
    POST: async (req, res) => {
      const body = (await parsedBody(req)) as { message?: unknown; capture?: unknown }
      const result = proseAccept(typeof body.message === 'string' ? body.message : undefined)
      let capture
      if (body.capture === true && (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)) {
        try {
          capture = await runCapture(result.files)
        } catch (e) {
          console.error('[error] capture pass failed (the accept itself succeeded):', e)
        }
      }

      // The learning pass: what did the author change about what arc wrote?
      // Non-fatal on the same contract as capture — losing a style proposal is
      // a smaller harm than failing an accept that already committed. It runs
      // on every accept, not behind the capture flag: it costs nothing when
      // the scene was written by hand or kept unedited, because it never
      // reaches the model in those cases.
      let learned
      try {
        const r = await runLearnStyle(result.files)
        if (r.added.length) learned = { proposed: r.added.length }
      } catch (e) {
        console.error('[error] style learning pass failed (the accept itself succeeded):', e)
      }

      json(res, 200, { ...result, ...(capture ? { capture } : {}), ...(learned ?? {}) } satisfies ProseAcceptResponse)
    },
  },

  // Write a scene's body back into the working tree — the draft layer. The
  // baseline is what the edit started from: without a file watcher it is the
  // only way to tell an edit apart from a clobber.
  '/api/prose/scene': {
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { file?: unknown; body?: unknown; baseline?: unknown }
      if (typeof b.file !== 'string' || typeof b.body !== 'string') throw new HttpError(400, 'file and body required')
      if (b.baseline !== undefined && typeof b.baseline !== 'string') throw new HttpError(400, 'baseline must be a string')
      json(res, 200, proseWrite(b.file, b.body, b.baseline))
    },
  },

  // Accept one paragraph, leaving the rest of the draft pending.
  '/api/prose/accept-paragraph': {
    POST: async (req, res) => {
      const b = (await parsedBody(req)) as { file?: unknown; paragraph?: unknown; message?: unknown }
      if (typeof b.file !== 'string' || typeof b.paragraph !== 'number') throw new HttpError(400, 'file and paragraph required')
      json(res, 200, proseAcceptParagraph(b.file, b.paragraph, typeof b.message === 'string' ? b.message : undefined))
    },
  },

  // Discard rolls one draft file back to main (a surfaced git checkout).
  '/api/prose/discard': {
    POST: async (req, res) => {
      const body = (await parsedBody(req)) as { file?: unknown }
      if (typeof body.file !== 'string') throw new HttpError(400, 'file required')
      proseDiscard(body.file)
      json(res, 200, { ok: true } satisfies OkResponse)
    },
  },

  '/api/chat': {
    POST: async (req, res) => {
      if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
        throw new HttpError(503, 'No Anthropic credentials. Set ANTHROPIC_API_KEY in the environment and restart the backend.')
      }
      json(res, 200, await handleChat(chatRequest(await parsedBody(req))))
    },
  },

  // The drafting pass: generate one scene into the working tree. The result
  // is an ordinary draft in /api/prose/draft — the author's accept or
  // discard stays the only gate. Engine: the SDK when a key is set, else
  // headless `claude -p` on the author's subscription login.
  '/api/prose/draft-scene': {
    POST: async (req, res) => {
      if (!currentEngine()) {
        throw new HttpError(503,
          'No generation engine. Either set ANTHROPIC_API_KEY in the environment, ' +
          'or install and log in the claude CLI (its subscription login works — no key needed), then restart the backend.')
      }
      const body = (await parsedBody(req)) as { chapter?: unknown; guidance?: unknown }
      if (typeof body.chapter !== 'string' || !body.chapter) throw new HttpError(400, 'chapter required')
      const guidance = typeof body.guidance === 'string' ? body.guidance : undefined
      json(res, 200, await runDraft(body.chapter, guidance) satisfies DraftSceneResponse)
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
      if (typeof b.selection !== 'string' || !b.selection.trim()) throw new HttpError(400, 'selection required')
      if (b.paragraph !== undefined && typeof b.paragraph !== 'string') throw new HttpError(400, 'paragraph must be a string')
      if (b.file !== undefined && typeof b.file !== 'string') throw new HttpError(400, 'file must be a string')
      json(res, 200, await runSuggest({ kind: b.kind, selection: b.selection, paragraph: b.paragraph, file: b.file }))
    },
  },

  '/api/prose/analyze': {
    POST: async (_req, res) => {
      if (!currentEngine()) {
        throw new HttpError(503,
          'No generation engine. Either set ANTHROPIC_API_KEY in the environment, ' +
          'or install and log in the claude CLI (its subscription login works — no key needed), then restart the backend.')
      }
      json(res, 200, await runAnalysis() satisfies AnalyzeResponse)
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

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

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
          const handler = hit.r.methods[req.method as 'GET' | 'POST']
          if (!handler) throw new HttpError(405, `${Object.keys(hit.r.methods).join('/')} only`)
          await handler(req, res, decodeURIComponent(hit.m![1]))
        }
      }
    } catch (e) {
      if (e instanceof HttpError) {
        json(res, e.status, { error: e.message } satisfies ApiErrorResponse)
      } else {
        console.error(`[error] ${req.method} ${url.pathname}:`, e)
        json(res, 500, { error: 'internal error — see backend log' } satisfies ApiErrorResponse)
      }
    }

    console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`)
  })
}
