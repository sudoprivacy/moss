import { timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { isAbsolute, resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { SudographCompilerError, SudographModelClient, type ISudographContext, type ISudographRuntime } from '@sudowork/sudograph-runtime'
import { z } from 'zod'
import type { OntologyProject } from './projectRegistry.js'
import { registerModelContextReadTool, registerModelContextTool } from './contextWorker.js'

export interface CompilerContextWorkerConfig {
  binding: Pick<OntologyProject, 'authorityRef' | 'modelRef' | 'sourceRefs'>
  runtime: ISudographRuntime
  actor: string
  /** Deployment-owned credential, normally injected from Nexus. Never a tool argument. */
  token: string
}

/** One authenticated endpoint, one registered model, and the published shared compiler client. */
export function createCompilerContextWorker(config: CompilerContextWorkerConfig): Server {
  if (!/^[\x21-\x7e]{32,512}$/.test(config.token)) throw new Error('A deployment-owned worker token of 32-512 ASCII characters is required')
  const binding = structuredClone(config.binding), actor = config.actor
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(binding.modelRef) || !actor.trim()) throw new Error('Invalid compiler worker binding')
  const client = new SudographModelClient(structuredClone(config.runtime))
  const privateValues = [resolve(config.runtime.compilerRoot), resolve(config.runtime.modelDirectory),
    ...[config.runtime.python, config.runtime.compilerRoot, config.runtime.modelDirectory].filter(isAbsolute),
    config.runtime.source?.connector.password, config.token].filter((value): value is string => Boolean(value)).sort((a, b) => b.length - a.length)
  const redact = (value: unknown): unknown => {
    if (typeof value === 'string') return privateValues.reduce((text, secret) => text.replaceAll(secret, '[private]'), value)
    if (Array.isArray(value)) return value.map(redact)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [String(redact(key)), redact(item)]))
    return value
  }
  const invoke = async (request: Record<string, unknown>) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await client.invoke(binding.modelRef, actor, request)) }] } }
    catch (error) {
      const diagnostic = error instanceof SudographCompilerError
        ? redact({ code: error.code, reason: error.message, recovery: error.recovery })
        : { code: 'MODEL_OPERATION_UNAVAILABLE', reason: 'The registered model operation could not be completed',
          recovery: 'Read the model contract; retry an interrupted write with its original operation ID and payload.' }
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(diagnostic) }] }
    }
  }
  const expected = Buffer.from(`Bearer ${config.token}`)
  return createServer((req, res) => {
    void (async () => {
      res.setHeader('Cache-Control', 'no-store')
      if (req.url !== '/mcp' || req.method !== 'POST' || req.headers.origin) { res.writeHead(403).end(); return }
      const supplied = Buffer.from(req.headers.authorization ?? '')
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(401).end(); return }
      const sdk = new McpServer({ name: 'sudograph-compiler-worker', version: '1.0.0' })
      registerModelContextTool(sdk, binding, () => client.invoke<ISudographContext>(
        binding.modelRef, actor, { operation: 'read', product: 'context' }))
      registerModelContextReadTool(sdk, request => client.invoke(
        binding.modelRef, actor, { operation: 'context_read', request }))
      sdk.registerTool('sudograph_model_contract', {
        description: 'Read the bound canonical YAML, current revision and checked write contract.',
        inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true, destructiveHint: false },
      }, () => invoke({ operation: 'contract' }))
      sdk.registerTool('sudograph_model_apply', {
        description: 'Compile and atomically commit a model edit, graph and context. Compatible concurrent edits merge; conflicts and compiler errors include recovery details. Does not modify source data.',
        inputSchema: z.object({ base_revision: z.string().min(1), operation_id: z.string().min(1), model: z.string() }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      }, request => invoke({ operation: 'apply', request }))
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.once('close', () => { void sdk.close() })
      try { await sdk.connect(transport); await transport.handleRequest(req, res) }
      catch { res.destroy() }
    })().catch(() => res.destroy())
  })
}
