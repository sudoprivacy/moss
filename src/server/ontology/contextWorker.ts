import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { SudographCompilerError } from '@sudowork/sudograph-runtime'
import { validateOntologyContext, type OntologyContextPorts, type OntologyProject } from './projectRegistry.js'
import { WORKER_REVIEW_PROFILE, WORKER_REVIEW_PROFILE_KEY } from './workerReviewProtocol.js'

/** Register on the deployment's authenticated MCP server; no paths or authority arrive in tool arguments. */
export function registerModelContextTool(server: McpServer,
  binding: Pick<OntologyProject, 'authorityRef' | 'modelRef' | 'sourceRefs'>,
  read: () => ReturnType<OntologyContextPorts['readContext']>) {
  const identity = { authority_ref: binding.authorityRef, model_ref: binding.modelRef,
    source_refs: [...new Set(binding.sourceRefs)].sort() }
  server.registerTool('sudograph_context', {
    description: 'Read the current complete registered model context',
    inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true, destructiveHint: false },
  }, async () => {
    try {
      const context = validateOntologyContext(await read())
      return { content: [{ type: 'text', text: JSON.stringify({ format: 'sudograph-worker-context/v1',
        ...identity, scope: 'full-registered-model', context }) }] }
    } catch {
      // Compiler/provider exceptions can contain private execution paths or connection details.
      return { isError: true, content: [{ type: 'text', text: 'Registered model context is unavailable' }] }
    }
  })
}

/** Exact reads use compiler-issued pointers; the deployment fixes every execution option. */
export function registerModelContextReadTool(server: McpServer,
  read: (request: Record<string, unknown>) => Promise<unknown>, options: { hostReview?: boolean } = {}) {
  server.registerTool('sudograph_context_read', {
    description: 'Read a source object, field, definition, evidence item, catalogue, subgraph or bounded live record page using the revision and digest from sudograph_context.',
    _meta: { 'moss/input-profile': 'bounded-record-v1', ...(options.hostReview ? { [WORKER_REVIEW_PROFILE_KEY]: WORKER_REVIEW_PROFILE } : {}) },
    inputSchema: z.object({
      revision: z.string().min(1), context_digest: z.string().min(1), id: z.string().min(1),
      records: z.boolean().optional(), offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      selection: z.record(z.string(), z.unknown()).optional(),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async request => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await read(request)) }] }
    } catch (error) {
      // Keep actionable protocol errors without returning compiler paths, SQL or credentials.
      const stale = error instanceof SudographCompilerError && error.code === 'CONTEXT_STALE'
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({
        code: stale ? 'CONTEXT_STALE' : 'MODEL_READ_UNAVAILABLE',
        reason: stale ? 'The context digest does not match the requested revision' : 'The registered model read could not be completed',
        recovery: 'Read sudograph_context and use its exact read pointers; if the read still fails, ask the host to check the registered source.',
      }) }] }
    }
  })
}
