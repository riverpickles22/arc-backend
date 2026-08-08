// arc-backend: the canon API and the embedded world-shaping agent.
//
// Routing is a plain table — path → method → handler — dispatched by one
// function that also owns the error mapping: HttpError becomes its status
// with a clean {error} body; anything else is logged in full to stderr and
// answered with a generic 500, so tool output and stack traces never reach
// the browser. Every JSON payload is checked against the shared wire types
// (arc-canon-graph/api-types.ts) with `satisfies`.
import http from 'node:http'
import type {
  ApiErrorResponse, AttentionResponse, ChatMessage, ChatRequest, DocsResponse, HealthResponse,
  MaterialResponse, OkResponse, ProseAcceptResponse, ProseResponse,
} from 'arc-canon-graph'
import { HttpError, corsOrigin, json, readBody } from './http'
import { canonJson, validateStory } from './canon'
import { docsArticles, materialItems, proseAccept, proseDiscard, proseDraft, proseScenes, readAsset, viewConfig } from './story'
import { handleChat } from './agent'
import { attention } from './attention'
import { runCapture } from './capture'

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void | Promise<void>

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
      json(res, check.ok ? 200 : 503, { ok: check.ok, validator: check.output } satisfies HealthResponse)
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

  // How the story is drawn — presentation config, kept out of canon.
  '/api/view': {
    GET: (_req, res) => json(res, 200, viewConfig()),
  },

  // The story encyclopedia: docs/ articles with their canon bindings.
  '/api/docs': {
    GET: (_req, res) => json(res, 200, { articles: docsArticles() } satisfies DocsResponse),
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
      json(res, 200, { ...result, ...(capture ? { capture } : {}) } satisfies ProseAcceptResponse)
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
        if (!route) throw new HttpError(404, `no route for ${url.pathname}`)
        const handler = route[req.method as 'GET' | 'POST']
        if (!handler) throw new HttpError(405, `${Object.keys(route).join('/')} only`)
        await handler(req, res, url)
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
