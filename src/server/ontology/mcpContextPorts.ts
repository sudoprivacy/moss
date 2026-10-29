import type { McpStore } from '../mcp/db.js'
import { ReviewedMcpAccess } from '../mcp/reviewedAccess.js'
import { ResourceAccessError } from '../catalog/resourceError.js'
import { validateOntologyContext, type OntologyContextPorts, type OntologyProject, type OntologySessionBinding } from './projectRegistry.js'

const tool = 'sudograph_context'
const invalid = () => new ResourceAccessError(502, 'Registered model worker returned an incompatible identity or scope')

/** One reviewed MCP endpoint represents one complete registered model, never a prompt-selected path. */
export class McpOntologyContextPorts implements OntologyContextPorts {
  constructor(private readonly access: ReviewedMcpAccess, private readonly audit: Pick<McpStore, 'insertAuditLog'>) {}

  async authorize(binding: OntologySessionBinding): Promise<void> {
    await this.authorizeProject(binding, binding.userId)
  }

  async authorizeProject(project: OntologyProject, userId: string): Promise<void> {
    await this.access.authorizeHostRead(project.orgId, userId, project.workerRef, tool)
  }

  async readContext(binding: OntologySessionBinding) {
    let status = 'error'
    try {
      const result = await this.access.readForHost(binding.orgId, binding.userId, binding.workerRef, tool)
      if (result.content.length !== 1 || result.content[0]?.type !== 'text') throw invalid()
      let value: Record<string, unknown>
      try { value = JSON.parse(result.content[0].text) as Record<string, unknown> } catch { throw invalid() }
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !['format', 'authority_ref', 'model_ref', 'source_refs', 'scope', 'context'].includes(key))
        || value.format !== 'sudograph-worker-context/v1' || value.scope !== 'full-registered-model'
        || value.authority_ref !== binding.authorityRef || value.model_ref !== binding.modelRef
        || !Array.isArray(value.source_refs) || value.source_refs.some(ref => typeof ref !== 'string')
        || JSON.stringify(value.source_refs) !== JSON.stringify(binding.sourceRefs)
        || !value.context || typeof value.context !== 'object' || Array.isArray(value.context)) throw invalid()
      // The canonical registry validates the context format, semantic digest, revision and text.
      // No remote path, URL, grant or credential becomes a local execution option.
      const context = validateOntologyContext(value.context)
      status = 'success'
      return context
    } finally {
      try {
        await this.audit.insertAuditLog({ org_id: binding.orgId, mcp_server_id: binding.workerRef, mcp_server_name: null,
          user_id: binding.userId, session_id: binding.sessionId, action: 'ontology.context.read', tool_name: tool, status })
      } catch { throw new ResourceAccessError(503, 'Canonical context access audit is unavailable') }
    }
  }
}
