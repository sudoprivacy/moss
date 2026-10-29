import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { validateOntologyContext, type OntologyContextPorts, type OntologyProject } from './projectRegistry.js'

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
