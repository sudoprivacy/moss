import type { IncomingMessage, ServerResponse } from 'http'
import type { URL } from 'url'
import type { NexusClient } from '../nexus/nexusClient.js'
import { SYSTEM_SECRET_SUBJECT, DEPT_SECRET_SUBJECT } from '../secrets/secretSubject.js'

interface DepartmentPolicyProvider {
  getAuthorizedConfigItemIds(departmentId: string): number[]
}

interface ConfigItemRow {
  id: number
  scope: string
  pinyin: string
  [k: string]: unknown
}

interface SecretsApiContext {
  userId: string
  departmentId: string | null
}

interface SecretSummary {
  namespace: string
  key: string
  status: string
  version: number
}

const MAX_BODY_BYTES = 64 * 1024

let nexusClient: NexusClient | null = null
let policyProvider: DepartmentPolicyProvider | null = null
let getAllActiveConfigItemsFn: (() => ConfigItemRow[]) | null = null

export function setSecretsApiDependencies(
  nexus: NexusClient,
  policy: DepartmentPolicyProvider,
  getAllActiveConfigItems: () => ConfigItemRow[],
): void {
  nexusClient = nexus
  policyProvider = policy
  getAllActiveConfigItemsFn = getAllActiveConfigItems
}

export async function handleSecretsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  _parsedUrl: URL,
  context: SecretsApiContext,
): Promise<void> {
  if (!nexusClient || !policyProvider || !getAllActiveConfigItemsFn) {
    respond(res, 503, { error: 'secrets_api_unavailable' })
    return
  }

  // GET /secrets — list visible secrets metadata (no value)
  if (pathname === '/secrets') {
    if (req.method === 'GET') {
      await handleList(res, context)
      return
    }
    respond(res, 405, { error: 'method_not_allowed' })
    return
  }

  // /secrets/:namespace/:key — PUT / DELETE
  const match = pathname.match(/^\/secrets\/([^/]+)\/([^/]+)$/)
  if (match) {
    const namespace = decodeURIComponent(match[1])
    const key = decodeURIComponent(match[2])
    if (req.method === 'PUT') {
      await handlePut(req, res, namespace, key, context)
      return
    }
    if (req.method === 'DELETE') {
      await handleDelete(res, namespace, key, context)
      return
    }
    respond(res, 405, { error: 'method_not_allowed' })
    return
  }

  respond(res, 404, { error: 'not_found' })
}

async function handleList(res: ServerResponse, context: SecretsApiContext): Promise<void> {
  try {
    const raw = await nexusClient!.listSecrets(undefined, context.userId)
    // Immediately strip value to minimize plaintext exposure window
    const allMeta: SecretSummary[] = raw.map(s => ({
      namespace: s.namespace,
      key: s.key,
      status: s.status,
      version: s.version,
    }))

    const personalPrefix = `user:${context.userId}:`
    const personal = allMeta.filter(s => s.namespace.startsWith(personalPrefix))

    // Enterprise (system) secrets: visible to all users, no department filtering
    const enterpriseRaw = await nexusClient!.listSecrets(undefined, SYSTEM_SECRET_SUBJECT)
    const enterprise = enterpriseRaw
      .filter(s => s.namespace.startsWith('system:'))
      .map(s => ({ namespace: s.namespace, key: s.key, status: s.status, version: s.version }))

    // Department (role) secrets: filtered by department policy
    let department: SecretSummary[] = []
    if (context.departmentId) {
      const authorizedIds = policyProvider!.getAuthorizedConfigItemIds(context.departmentId)
      if (authorizedIds.length > 0) {
        const items = getAllActiveConfigItemsFn!()
        const authorizedPinyins = new Set<string>()
        for (const item of items) {
          if (item.scope === 'department' && authorizedIds.includes(item.id) && typeof item.pinyin === 'string') {
            authorizedPinyins.add(item.pinyin)
          }
        }
        const deptRaw = await nexusClient!.listSecrets(undefined, DEPT_SECRET_SUBJECT)
        department = deptRaw
          .filter(s => s.namespace.startsWith('role:') && authorizedPinyins.has(s.namespace.slice('role:'.length)))
          .map(s => ({ namespace: s.namespace, key: s.key, status: s.status, version: s.version }))
      }
    }

    respond(res, 200, { success: true, data: [...personal, ...enterprise, ...department] })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    respond(res, 502, { error: 'nexus_error', message })
  }
}

async function handlePut(
  req: IncomingMessage,
  res: ServerResponse,
  namespace: string,
  key: string,
  context: SecretsApiContext,
): Promise<void> {
  if (!namespace || !key) {
    respond(res, 400, { error: 'invalid_namespace_or_key' })
    return
  }

  if (!isUserOwnedNamespace(namespace, context.userId)) {
    respond(res, 403, { error: 'forbidden_namespace' })
    return
  }

  let body: Buffer
  try {
    body = await readBody(req)
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'body_too_large') {
      respond(res, 413, { error: 'body_too_large' })
      return
    }
    respond(res, 400, { error: 'read_body_failed' })
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    respond(res, 400, { error: 'invalid_json' })
    return
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    respond(res, 400, { error: 'invalid_body' })
    return
  }
  const value = (parsed as { value?: unknown }).value
  if (typeof value !== 'string') {
    respond(res, 400, { error: 'missing_or_invalid_value' })
    return
  }

  try {
    await nexusClient!.putSecret(namespace, key, value, context.userId)
    respond(res, 200, { success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    respond(res, 502, { error: 'nexus_error', message })
  }
}

async function handleDelete(
  res: ServerResponse,
  namespace: string,
  key: string,
  context: SecretsApiContext,
): Promise<void> {
  if (!namespace || !key) {
    respond(res, 400, { error: 'invalid_namespace_or_key' })
    return
  }

  if (!isUserOwnedNamespace(namespace, context.userId)) {
    respond(res, 403, { error: 'forbidden_namespace' })
    return
  }

  try {
    await nexusClient!.deleteSecret(namespace, key, context.userId)
    respond(res, 200, { success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    respond(res, 502, { error: 'nexus_error', message })
  }
}

function isUserOwnedNamespace(namespace: string, userId: string): boolean {
  if (namespace.startsWith('system:')) return false
  return namespace.startsWith(`user:${userId}:`)
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        const err = new Error('body too large') as Error & { code: string }
        err.code = 'body_too_large'
        req.destroy()
        reject(err)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function respond(res: ServerResponse, statusCode: number, body: unknown): void {
  if (res.headersSent) return
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
