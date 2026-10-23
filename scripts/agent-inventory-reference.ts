/** Metadata-only local discovery fixture. This is not a LangGraph, SaaS or Router runtime qualification. */
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { PlatformDiscoveryPage } from '../contracts/agent-registry/v1alpha1/contract.gen.js'

const directory = process.argv[2], port = Number(process.argv[3] ?? 22145)
if (!directory || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Usage: npx tsx scripts/agent-inventory-reference.ts <private-output-directory> [port]')
const token = randomBytes(32).toString('hex')
const data: PlatformDiscoveryPage = {
  api_version: 'agent-inventory.sudo.dev/v1alpha1', scope: 'synthetic-inventory', next_cursor: null,
  items: [
    { id: 'http-synthetic', name: '合成 HTTP 发现样例', platform: 'http', external_domain: false },
    { id: 'saas-synthetic', name: '合成域外台账样例', platform: 'saas', external_domain: true },
  ],
}
const server = createServer((request, response) => {
  const expected = Buffer.from('Bearer ' + token), actual = Buffer.from(request.headers.authorization ?? '')
  response.setHeader('content-type', 'application/json'); response.setHeader('cache-control', 'no-store')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) { response.writeHead(401); response.end('{}'); return }
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (request.method !== 'GET' || url.pathname !== '/agent-inventory/v1/agents' || url.searchParams.get('scope') !== data.scope) {
    response.writeHead(404); response.end('{}'); return
  }
  const after = url.searchParams.get('after') ?? ''
  response.end(JSON.stringify({ ...data, items: data.items.filter(row => row.id > after) }))
})
await mkdir(resolve(directory), { recursive: true, mode: 0o700 })
await new Promise<void>(done => server.listen(port, '127.0.0.1', done))
await writeFile(resolve(directory, 'inventory-reference.json'), JSON.stringify({ kind: 'platform', name: '本地发现协议样例', origin: `http://127.0.0.1:${port}`, scope: data.scope, external_domain: false, api_key: token }), { mode: 0o600, flag: 'wx' })
console.log(JSON.stringify({ origin: `http://127.0.0.1:${port}`, samples: data.items.map(row => row.id), evidence: 'synthetic metadata discovery only' }))
const stop = () => { server.closeAllConnections(); server.close(() => process.exit(0)) }
process.once('SIGTERM', stop); process.once('SIGINT', stop)
