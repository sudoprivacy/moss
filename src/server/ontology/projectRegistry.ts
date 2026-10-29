import { randomUUID } from 'node:crypto'
import type { DbDriver, SqlRow } from '../db/driver.js'
import { ResourceAccessError } from '../catalog/resourceError.js'
import type { BackendHostContextResolver } from '../sessionManager.js'

export interface OntologyProject {
  projectId: string
  orgId: string
  authorityRef: string
  workerRef: string
  modelRef: string
  sourceRefs: string[]
  generation: number
}

export interface OntologySessionBinding extends OntologyProject {
  sessionId: string
  userId: string
  bindingId: string
}

/** Trusted host ports; never deserialized from a request or runner manifest. */
export interface OntologyContextPorts {
  /** Reuse current membership and resource/source policy, including revocation. */
  authorize(binding: OntologySessionBinding): Promise<void>
  /** Resolve the registered worker and model, never a caller-supplied local path. */
  readContext(binding: OntologySessionBinding): Promise<{
    format: 'sudograph-agent-context/v1'
    revision: string
    context_digest: string
    text: string
  }>
}

/** Shared worker contract check; semantic input identity is not a rendered-text hash. */
export function validateOntologyContext(value: unknown): Awaited<ReturnType<OntologyContextPorts['readContext']>> {
  const context = value as Awaited<ReturnType<OntologyContextPorts['readContext']>> | null
  if (!context || context.format !== 'sudograph-agent-context/v1'
    || typeof context.revision !== 'string' || !/^[a-f0-9]{64}$/.test(context.revision)
    || typeof context.context_digest !== 'string' || !/^[a-f0-9]{64}$/.test(context.context_digest)
    || typeof context.text !== 'string' || !context.text.trim() || Buffer.byteLength(context.text) > 4 * 1024 * 1024) {
    throw new ResourceAccessError(502, 'Registered worker returned invalid canonical context')
  }
  return { format: context.format, revision: context.revision, context_digest: context.context_digest, text: context.text }
}

const unavailable = () => new ResourceAccessError(403, 'Canonical model binding is unavailable')
function reference(value: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) {
    throw new ResourceAccessError(400, 'Expected a registered reference, not a path, URL or credential')
  }
  return value
}
function project(row: SqlRow): OntologyProject {
  const refs: unknown = JSON.parse(String(row.source_refs_json))
  if (!Array.isArray(refs) || !refs.every(item => typeof item === 'string')) throw unavailable()
  const generation = Number(row.generation)
  if (!Number.isSafeInteger(generation) || generation < 1) throw unavailable()
  return {
    projectId: String(row.project_id), orgId: String(row.org_id),
    authorityRef: String(row.authority_ref), workerRef: String(row.worker_ref),
    modelRef: String(row.model_ref), sourceRefs: refs, generation,
  }
}

/** Durable host bookkeeping; no model content, access grants or connection passwords. */
export class OntologyProjectRegistry {
  constructor(private readonly driver: DbDriver) {}

  /** Only the trusted source/project registrar may call this operation. */
  async register(input: Omit<OntologyProject, 'projectId' | 'generation'>): Promise<OntologyProject> {
    const orgId = reference(input.orgId)
    const authorityRef = reference(input.authorityRef)
    const workerRef = reference(input.workerRef)
    const modelRef = reference(input.modelRef)
    if (!Array.isArray(input.sourceRefs) || input.sourceRefs.length > 1000) throw new ResourceAccessError(400, 'Invalid registered sources')
    const sourceRefs = [...new Set(input.sourceRefs.map(reference))].sort()
    return this.driver.transaction(async () => {
      await this.driver.run(`INSERT INTO ontology_projects
        (project_id, org_id, authority_ref, worker_ref, model_ref, source_refs_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [randomUUID(), orgId, authorityRef, workerRef, modelRef, JSON.stringify(sourceRefs), Date.now()])
      const row = await this.driver.get('SELECT * FROM ontology_projects WHERE org_id = ? AND authority_ref = ?', [orgId, authorityRef])
      if (!row) throw new ResourceAccessError(409, 'Canonical worker/model already has a registered authority')
      if (Number(row.enabled) !== 1) throw unavailable()
      const existing = project(row)
      if (existing.workerRef !== workerRef || existing.modelRef !== modelRef || JSON.stringify(existing.sourceRefs) !== JSON.stringify(sourceRefs)) {
        throw new ResourceAccessError(409, 'Registered authority already has a different canonical binding')
      }
      return existing
    })
  }

  /** Explicit operator lifecycle change. Generations fence disable/re-enable during a read. */
  async setEnabled(orgId: string, projectId: string, isEnabled: boolean): Promise<void> {
    const changes = await this.driver.run(`UPDATE ontology_projects SET enabled = ?, generation = generation + 1
      WHERE org_id = ? AND project_id = ? AND enabled <> ?`, [isEnabled ? 1 : 0, orgId, projectId, isEnabled ? 1 : 0])
    if (!changes && !await this.driver.get('SELECT 1 FROM ontology_projects WHERE org_id = ? AND project_id = ?', [orgId, projectId])) throw unavailable()
  }

  /** Bind once. Reopening another graph must not retarget an existing agent conversation. */
  async bind(input: { sessionId: string; projectId: string; orgId: string; userId: string }, ports: Pick<OntologyContextPorts, 'authorize'>): Promise<OntologySessionBinding> {
    const pending = await this.candidate(input)
    await ports.authorize(pending)
    return this.driver.transaction(async () => {
      const current = await this.candidate(input)
      if (current.generation !== pending.generation) throw unavailable()
      await this.driver.run(`INSERT INTO ontology_session_bindings
        (session_id, project_id, org_id, user_id, binding_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (session_id) DO NOTHING`,
      [input.sessionId, input.projectId, input.orgId, input.userId, pending.bindingId, Date.now()])
      const bound = await this.resolveSession(input.sessionId)
      if (!bound || bound.projectId !== input.projectId || bound.orgId !== input.orgId || bound.userId !== input.userId) {
        throw new ResourceAccessError(409, 'Conversation already belongs to another canonical project')
      }
      return bound
    })
  }

  private async candidate(input: { sessionId: string; projectId: string; orgId: string; userId: string }): Promise<OntologySessionBinding> {
    const row = await this.driver.get(`SELECT p.* FROM ontology_projects p JOIN sessions s ON s.session_id = ?
      WHERE p.project_id = ? AND p.org_id = ? AND p.enabled = 1
      AND s.org_id = p.org_id AND s.user_id = ? AND s.deleted_at IS NULL`,
    [input.sessionId, input.projectId, input.orgId, input.userId])
    if (!row) throw unavailable()
    return { ...project(row), sessionId: input.sessionId, userId: input.userId, bindingId: randomUUID() }
  }

  /** Undefined means an ordinary legacy session; a disabled/stale binding always refuses. */
  async resolveSession(sessionId: string): Promise<OntologySessionBinding | undefined> {
    const binding = await this.driver.get('SELECT * FROM ontology_session_bindings WHERE session_id = ?', [sessionId])
    if (!binding) return undefined
    const row = await this.driver.get(`SELECT p.* FROM ontology_projects p JOIN sessions s ON s.session_id = ?
      WHERE p.project_id = ? AND p.enabled = 1 AND p.org_id = ? AND s.org_id = p.org_id
      AND s.user_id = ? AND s.deleted_at IS NULL`,
    [sessionId, String(binding.project_id), String(binding.org_id), String(binding.user_id)])
    if (!row) throw unavailable()
    return { ...project(row), sessionId, userId: String(binding.user_id), bindingId: String(binding.binding_id) }
  }

  /** Every runner recovers authority from the database, never from manifest context text. */
  async runnerContext(owner: { sessionId: string; orgId: string; userId: string }, ports?: OntologyContextPorts): Promise<BackendHostContextResolver | undefined> {
    const current = await this.resolveSession(owner.sessionId)
    if (!current) return undefined
    const assertOwner = (binding: OntologySessionBinding) => {
      if (binding.orgId !== owner.orgId || binding.userId !== owner.userId) throw unavailable()
    }
    assertOwner(current)
    if (!ports) throw new ResourceAccessError(503, 'Canonical model worker and policy are not configured for this runner')
    await ports.authorize(current)
    return this.contextReader(owner.sessionId, {
      authorize: async binding => { assertOwner(binding); await ports.authorize(binding) },
      readContext: binding => ports.readContext(binding),
    })
  }

  /** Reconstruct from durable references, including on runner recovery; cache no business text. */
  async contextReader(sessionId: string, ports: OntologyContextPorts): Promise<BackendHostContextResolver | undefined> {
    if (!await this.resolveSession(sessionId)) return undefined
    return async request => {
      if (request.sessionId !== sessionId) throw unavailable()
      const before = await this.resolveSession(sessionId)
      if (!before) throw unavailable()
      await ports.authorize(before)
      const context = await ports.readContext(before)
      const after = await this.resolveSession(sessionId)
      if (!after || JSON.stringify(before) !== JSON.stringify(after)) throw unavailable()
      await ports.authorize(after)
      return validateOntologyContext(context).text
    }
  }
}
