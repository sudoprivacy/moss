import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { RouterMock } from '../src/server/billing/testing/routerMock.js'

const port = Number(process.env.ROUTER_MOCK_PORT ?? 3301)
const stateFile = resolve(process.env.ROUTER_MOCK_STATE_FILE ?? `${homedir()}/.local/state/moss-router-mock/${process.env.ROUTER_MOCK_UPSTREAM_ENV_FILE ? 'hybrid' : 'standalone'}.json`)
mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 })
const upstreamFile = process.env.ROUTER_MOCK_UPSTREAM_ENV_FILE
const upstreamEnv = upstreamFile ? Object.fromEntries(readFileSync(upstreamFile, 'utf8').split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => {
  const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]
})) : null
const mock = new RouterMock({
  adminToken: process.env.ROUTER_MOCK_ADMIN_TOKEN ?? 'local-router-test',
  adminUserId: process.env.ROUTER_MOCK_ADMIN_USER_ID ?? '1',
  registrationQuota: 0,
  state: existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : undefined,
  upstream: upstreamEnv ? { baseUrl: upstreamEnv.SUDOROUTER_BASE_URL!, apiToken: upstreamEnv.SUDOROUTER_API_TOKEN!, adminUserId: upstreamEnv.SUDOROUTER_ADMIN_USER_ID! } : undefined,
  save: state => { writeFileSync(`${stateFile}.tmp`, JSON.stringify(state), { mode: 0o600 }); renameSync(`${stateFile}.tmp`, stateFile) },
})
const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of incoming) {
      length += chunk.length
      if (length > 1_048_576) { outgoing.writeHead(413).end(); return }
      chunks.push(Buffer.from(chunk))
    }
    const method = incoming.method ?? 'GET'
    const headers = new Headers()
    for (const [key, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(key, value)
    const response = await mock.handle(new Request(`http://127.0.0.1:${port}${incoming.url}`, { method, headers, ...(['GET', 'HEAD'].includes(method) ? {} : { body: Buffer.concat(chunks) }) }))
    outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()))
  } catch { outgoing.writeHead(500).end('Mock request failed') }
})
server.listen(port, '127.0.0.1', () => console.info(`Router mock listening on http://127.0.0.1:${port} (${upstreamEnv ? 'hybrid: existing APIs upstream, new APIs simulated' : 'standalone simulation'})`))
