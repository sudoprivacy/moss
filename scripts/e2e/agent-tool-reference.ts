/** Local AM-07 reference only: no files, database, model or external network access. */
import { createServer } from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

const path = process.env.AGENT_TOOL_KEY_FILE ?? ''
if (!path.startsWith('/') || (statSync(path).mode & 0o077)) throw new Error('private key file required')
const key = readFileSync(path, 'utf8').trim()
if (key.length < 32 || key.length > 1024) throw new Error('invalid reference credential')
const port = Number(process.env.AGENT_TOOL_PORT ?? 22175)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid port')
let calls = 0
const server = createServer((req, res) => {
  const expected = Buffer.from(`Bearer ${key}`), actual = Buffer.from(req.headers.authorization ?? '')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { res.writeHead(401); res.end(); return }
  if (req.method === 'GET' && req.url === '/metrics') {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ calls, profile: 'synthetic-arithmetic-only', model_calls: 0 })); return
  }
  if (req.url !== '/mcp') { res.writeHead(404); res.end(); return }
  void (async () => {
    const mcp = new McpServer({ name: 'agent-tool-reference', version: '1.0.0' })
    mcp.registerTool('add_numbers', {
      description: 'Add two synthetic numbers; no data access or external effects.',
      inputSchema: z.object({ a: z.number().min(-100000).max(100000), b: z.number().min(-100000).max(100000) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, ({ a, b }) => { calls++; return { content: [{ type: 'text', text: String(a + b) }] } })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.once('close', () => { void mcp.close() })
    await mcp.connect(transport); await transport.handleRequest(req, res)
  })().catch(() => { res.destroy() })
})
server.listen(port, '127.0.0.1', () => process.stdout.write(`Synthetic MCP reference listening on 127.0.0.1:${port}\n`))
