import type { IncomingMessage, ServerResponse } from 'node:http'

export function setCorsHeaders(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin
  if (!origin) return false

  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key, X-Device-Id, X-Cabin-Tablet-Token, X-Cabin-Tablet-Id')
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Max-Age', '86400')
  return true
}

export function handleCorsPreflight(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === 'OPTIONS' && req.headers.origin) {
    setCorsHeaders(req, res)
    res.writeHead(204)
    res.end()
    return true
  }
  return false
}
