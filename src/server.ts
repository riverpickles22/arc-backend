// arc-backend: the canon API and the embedded world-shaping agent.
//
// In the monorepo this was a Vite dev-server plugin, so it only existed while
// the frontend was running. It is now a standalone service the frontend
// proxies to, which is what lets the two repos version independently.
import http from 'node:http'
import { describeConfig, PORT } from './config'
import { canonJson, validateStory } from './canon'
import { docsArticles, proseAccept, proseDiscard, proseDraft, proseScenes, readAsset, viewConfig } from './story'
import { handleChat } from './agent'

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

  // The frontend dev server proxies /api, so same-origin in practice; CORS is
  // here so the app can also be served from a different host in production.
  res.setHeader('access-control-allow-origin', process.env.ARC_CORS_ORIGIN ?? '*')
  res.setHeader('access-control-allow-headers', 'content-type')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }

  try {
    if (url.pathname === '/api/health') {
      const check = validateStory()
      return json(res, check.ok ? 200 : 503, { ok: check.ok, validator: check.output })
    }

    if (url.pathname === '/api/canon') {
      if (req.method !== 'GET') return json(res, 405, { error: 'GET only' })
      const payload = canonJson()
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
      return res.end(payload)
    }

    // How the story is drawn — presentation config, kept out of canon.
    if (url.pathname === '/api/view') {
      if (req.method !== 'GET') return json(res, 405, { error: 'GET only' })
      return json(res, 200, viewConfig())
    }

    // The story encyclopedia: docs/ articles with their canon bindings.
    if (url.pathname === '/api/docs') {
      if (req.method !== 'GET') return json(res, 405, { error: 'GET only' })
      return json(res, 200, { articles: docsArticles() })
    }

    // The manuscript: bound prose scenes (conventions §10).
    if (url.pathname === '/api/prose') {
      if (req.method !== 'GET') return json(res, 405, { error: 'GET only' })
      return json(res, 200, { scenes: proseScenes() })
    }

    // The draft layer: working tree vs HEAD, plus ratification history.
    if (url.pathname === '/api/prose/draft') {
      if (req.method !== 'GET') return json(res, 405, { error: 'GET only' })
      return json(res, 200, proseDraft())
    }

    // Accept ratifies the draft into main (a git commit scoped to prose/).
    if (url.pathname === '/api/prose/accept') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
      const body = JSON.parse((await readBody(req)) || '{}')
      return json(res, 200, proseAccept(typeof body.message === 'string' ? body.message : undefined))
    }

    // Discard rolls one draft file back to main (a surfaced git checkout).
    if (url.pathname === '/api/prose/discard') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
      const body = JSON.parse((await readBody(req)) || '{}')
      if (typeof body.file !== 'string') return json(res, 400, { error: 'file required' })
      proseDiscard(body.file)
      return json(res, 200, { ok: true })
    }

    // Story-owned rendering assets (the basemap coastline, and whatever else
    // a story needs drawn). Lives in the story repo, not the viewer.
    if (url.pathname.startsWith('/api/assets/')) {
      if (req.method !== 'GET') return json(res, 405, { error: 'GET only' })
      const name = decodeURIComponent(url.pathname.slice('/api/assets/'.length))
      const asset = readAsset(name)
      if (!asset) return json(res, 404, { error: `no such story asset: ${name}` })
      res.writeHead(200, { 'content-type': asset.contentType, 'content-length': asset.body.length })
      return res.end(asset.body)
    }

    if (url.pathname === '/api/chat') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
      if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
        return json(res, 500, {
          error: 'No Anthropic credentials. Set ANTHROPIC_API_KEY in the environment and restart the backend.',
        })
      }
      const body = JSON.parse(await readBody(req))
      return json(res, 200, await handleChat(body))
    }

    return json(res, 404, { error: `no route for ${url.pathname}` })
  } catch (e: any) {
    return json(res, 500, { error: e?.message ?? String(e) })
  }
})

// Fail at startup rather than mid-request: importing config resolves and
// checks both repo paths, so a missing checkout is reported here.
console.log('arc-backend\n' + describeConfig())
server.listen(PORT, () => console.log(`  listening on http://localhost:${PORT}`))
