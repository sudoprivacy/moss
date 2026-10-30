import { SudographCompilerError } from '@sudowork/sudograph-runtime'
import { snapshotToolArguments } from '../agentFederation/toolProtocol.js'
import { hostReviewJsonTransport } from '../agentFederation/provider/routerTransport.js'
import { ResourceAccessError } from '../catalog/resourceError.js'
import type { McpStore } from '../mcp/db.js'
import type { ReviewedMcpAccess } from '../mcp/reviewedAccess.js'
import type { OntologySessionBinding } from './projectRegistry.js'
import { modelReviewRequest, WORKER_REVIEW_PROFILE, WORKER_REVIEW_PROFILE_KEY } from './workerReviewProtocol.js'

const tool = 'sudograph_context_read'
const incompatible = () => new ResourceAccessError(502, 'Registered review worker returned an incompatible identity or scope')
const codes = new Set(['ACCESS_DENIED', 'CONTEXT_STALE', 'REVISION_UNKNOWN', 'SOURCE_SCHEMA_CHANGED',
  'READ_CONTRACT', 'TARGET_UNKNOWN', 'CONTEXT_TARGET_UNKNOWN', 'VIEW_UNAVAILABLE'])

/** Full-model human reads require their own reviewed exact-read descriptor, not just context access. */
export class McpOntologyReviewPorts {
  constructor(private readonly access: ReviewedMcpAccess, private readonly audit: Pick<McpStore, 'insertAuditLog'>,
    private readonly authorizeBinding: (binding: OntologySessionBinding) => Promise<void>) {}

  async authorize(binding: OntologySessionBinding): Promise<void> {
    await this.authorizeBinding(binding)
    const { review } = await this.access.authorizeHostRead(binding.orgId, binding.userId, binding.workerRef, tool)
    if (review.tool._meta?.[WORKER_REVIEW_PROFILE_KEY] !== WORKER_REVIEW_PROFILE) {
      throw new ResourceAccessError(409, 'The registered worker requires review of its human-read profile')
    }
  }

  async read(binding: OntologySessionBinding, input: Record<string, unknown>, cancellation?: AbortSignal): Promise<unknown> {
    let status = 'error'
    try {
      const parsed = modelReviewRequest.safeParse(snapshotToolArguments(input))
      if (!parsed.success) throw new ResourceAccessError(400, 'Invalid registered review request')
      const request = parsed.data
      await this.authorize(binding)
      // Page reads retain exact pointer/record argument checks; other human
      // reads still require the same full-model exact-read effect classification.
      const args = request.operation === 'page' ? { ...request.params, records: true } : undefined
      const value = await this.access.withHostRead(binding.orgId, binding.userId, binding.workerRef, tool,
        { arguments: args, signal: cancellation }, async ({ review, config, signal }) => {
          if (review.tool._meta?.[WORKER_REVIEW_PROFILE_KEY] !== WORKER_REVIEW_PROFILE) throw incompatible()
          const endpoint = new URL('review', config.endpoint).href
          const send = hostReviewJsonTransport(endpoint, { allowedAddresses: config.allowedAddresses })
          const response = await send(endpoint, { method: 'POST', redirect: 'error', signal,
            headers: { ...config.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, resource: binding.projectId }) })
          if (!response.ok) {
            let error: unknown
            try { error = await response.json() } catch { error = null }
            const remote = error && typeof error === 'object' ? (error as Record<string, unknown>).error : undefined
            const code = [401, 403].includes(response.status) ? 'ACCESS_DENIED'
              : typeof remote === 'string' && codes.has(remote) ? remote : 'VIEW_UNAVAILABLE'
            // Return only protocol codes and host-owned recovery text, never
            // an upstream SQL error, path, credential or arbitrary diagnostic.
            throw new SudographCompilerError(code, 'The registered review request could not be completed',
              'Refresh the model head and use its current pointers; ask the host operator if this read remains unavailable.')
          }
          return response.json() as Promise<unknown>
        })
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw incompatible()
      const envelope = value as Record<string, unknown>
      if (Object.keys(envelope).some(key => !['format', 'authority_ref', 'model_ref', 'resource_ref', 'source_refs', 'scope', 'result'].includes(key))
        || envelope.format !== WORKER_REVIEW_PROFILE || envelope.scope !== 'full-registered-model'
        || envelope.authority_ref !== binding.authorityRef || envelope.model_ref !== binding.modelRef || envelope.resource_ref !== binding.projectId
        || JSON.stringify(envelope.source_refs) !== JSON.stringify(binding.sourceRefs) || !Object.hasOwn(envelope, 'result')) throw incompatible()
      await this.authorize(binding)
      status = 'success'
      return envelope.result
    } finally {
      try {
        await this.audit.insertAuditLog({ org_id: binding.orgId, mcp_server_id: binding.workerRef, mcp_server_name: null,
          user_id: binding.userId, session_id: binding.sessionId, action: 'ontology.review.read', tool_name: tool, status })
      } catch { throw new ResourceAccessError(503, 'Canonical review access audit is unavailable') }
    }
  }
}
