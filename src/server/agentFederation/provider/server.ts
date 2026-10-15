import { createServer, type IncomingMessage } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { AgentProtocolError, parseSubmitAgentRun } from './protocol.js'
import { HttpAgentRuntime, agentManifest } from './runtime.js'

export interface ProviderClient { id: string; token: string; agentIds: string[] }
async function jsonBody(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] ?? ''))) throw new AgentProtocolError(415, 'JSON_REQUIRED')
  if (Number(req.headers['content-length']) > 64 * 1024) throw new AgentProtocolError(413, 'REQUEST_TOO_LARGE')
  const chunks: Buffer[] = []; let length = 0
  for await (const chunk of req) {
    length += Buffer.byteLength(chunk)
    if (length > 64 * 1024) throw new AgentProtocolError(413, 'REQUEST_TOO_LARGE')
    chunks.push(Buffer.from(chunk))
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
  catch { throw new AgentProtocolError(400, 'INVALID_JSON') }
}

export function providerServer(runtime: HttpAgentRuntime, clients: ProviderClient[]) {
  const ids = new Set<string>(), tokens = new Set<string>()
  const configured = clients.map(client => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(client.id) || ids.has(client.id)
      || typeof client.token !== 'string' || client.token.length < 32 || client.token.length > 1024 || /\s/.test(client.token)
      || !Array.isArray(client.agentIds) || !client.agentIds.length || client.agentIds.some(id => !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(id))) throw new AgentProtocolError(400, 'INVALID_PROVIDER_CLIENT')
    const tokenHash = createHash('sha256').update(client.token).digest()
    if (tokens.has(tokenHash.toString('hex'))) throw new AgentProtocolError(400, 'DUPLICATE_PROVIDER_TOKEN')
    ids.add(client.id); tokens.add(tokenHash.toString('hex'))
    return { id: client.id, tokenHash, agents: new Set(client.agentIds) }
  })
  if (!configured.length || configured.length > 100) throw new AgentProtocolError(400, 'INVALID_PROVIDER_CLIENTS')
  let active = 0
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (active >= 128) { res.writeHead(503, { Connection: 'close' }); res.end(JSON.stringify({ code: 'REQUEST_CONCURRENCY_LIMIT' })); return }
    active++
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://provider.invalid')
      if (url.pathname === '/healthz' && req.method === 'GET') { await runtime.store.ready; await runtime.store.now(); return { status: 'ready' } }
      const token = /^Bearer ([^\s]{1,1024})$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? ''
      const hash = createHash('sha256').update(token).digest()
      const client = configured.find(entry => timingSafeEqual(entry.tokenHash, hash))
      if (!client) throw new AgentProtocolError(401, 'AUTHENTICATION_REQUIRED')
      const allowed = (id: string) => { if (!client.agents.has(id)) throw new AgentProtocolError(404, 'AGENT_NOT_FOUND') }
      const manifest = /^\/v1\/agents\/([A-Za-z0-9_.:-]+)\/manifest$/.exec(url.pathname)
      if (manifest && req.method === 'GET') {
        allowed(manifest[1]); return agentManifest(runtime.agent(manifest[1], url.searchParams.get('revision') ?? undefined))
      }
      if (url.pathname === '/v1/runs' && req.method === 'POST') {
        const input = parseSubmitAgentRun(await jsonBody(req)); allowed(input.external_agent_id)
        const run = await runtime.submit(client.id, input); res.statusCode = run.status === 'accepted' ? 202 : 200; return run
      }
      const runPath = /^\/v1\/runs\/([A-Za-z0-9_.:-]+)(\/cancel)?$/.exec(url.pathname)
      if (runPath) {
        const run = await runtime.store.get(client.id, runPath[1]); allowed(run.external_agent_id)
        if (req.method === 'GET' && !runPath[2]) return run
        if (req.method === 'POST' && runPath[2]) return runtime.store.cancelQueued(client.id, runPath[1])
      }
      throw new AgentProtocolError(404, 'ROUTE_NOT_FOUND')
    })().then(body => { res.end(JSON.stringify(body)) }, error => {
      const known = error instanceof AgentProtocolError
      res.statusCode = known ? error.status : 503
      // Never echo router bodies, credentials, queries or database errors.
      res.setHeader('Connection', 'close')
      res.end(JSON.stringify({ code: known ? error.code : 'PROVIDER_UNAVAILABLE' }))
    }).finally(() => { active-- })
  })
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5000
  return server
}
