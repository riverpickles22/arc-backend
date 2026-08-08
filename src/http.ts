// Transport plumbing: the error type the route layer maps to statuses,
// JSON writing, bounded body reading, and the CORS policy.
import type http from 'node:http'

/** A domain error with an HTTP status. Anything else that escapes a
 *  handler is logged server-side and answered with a generic 500. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** Read a request body, rejecting with 413 past the cap. The socket is left
 *  open so the 413 can actually be delivered; late chunks are ignored. */
export function readBody(req: http.IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    req.on('data', c => {
      if (done) return
      size += c.length
      if (size > maxBytes) {
        done = true
        reject(new HttpError(413, `request body exceeds ${maxBytes} bytes`))
      } else {
        chunks.push(c)
      }
    })
    req.on('end', () => { if (!done) resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', e => { if (!done) { done = true; reject(e) } })
  })
}

const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/

/** The allowed CORS origin for this request, or undefined for no header.
 *  ARC_CORS_ORIGIN wins when set; otherwise only localhost origins are
 *  reflected — this server can create git commits and spend API credit,
 *  so a wildcard default is not acceptable. The dev proxy is same-origin
 *  and unaffected. */
export function corsOrigin(req: http.IncomingMessage): string | undefined {
  if (process.env.ARC_CORS_ORIGIN) return process.env.ARC_CORS_ORIGIN
  const origin = req.headers.origin
  return origin && LOCALHOST_RE.test(origin) ? origin : undefined
}
