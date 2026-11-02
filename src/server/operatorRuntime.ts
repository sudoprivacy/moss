import { timingSafeEqual } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
// A reverse proxy on the same host connects from loopback; its forwarded
// requests are never operator requests.
const FORWARDING_HEADERS = ['forwarded', 'x-forwarded-for', 'x-real-ip']
const ROUTE = /^\/api\/v1\/operator\/agent-runtimes\/([^/]+)(\/upgrade)?$/

/**
 * Host-only credential for fleet operations that cross organizations, such as
 * moving every owner runtime to a new release. Organization admins keep the
 * per-organization endpoint; this one exists only when the deployment names a
 * private token file.
 */
export class OperatorAccess {
  private constructor(private readonly token: Buffer) {}

  static load(path: string | undefined): OperatorAccess | null {
    if (!path) return null
    const stat = statSync(path)
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
      throw new Error(`Operator token file must be a private regular file (mode 600): ${path}`)
    }
    const token = readFileSync(path, 'utf8').trim()
    if (token.length < 32) throw new Error('Operator token must be at least 32 characters')
    return new OperatorAccess(Buffer.from(token))
  }

  /** A direct loopback caller presenting the exact token. */
  permits(req: IncomingMessage): boolean {
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return false
    if (FORWARDING_HEADERS.some(name => req.headers[name] !== undefined)) return false
    const presented = req.headers['x-moss-operator-token']
    if (typeof presented !== 'string') return false
    const bytes = Buffer.from(presented)
    return bytes.length === this.token.length && timingSafeEqual(bytes, this.token)
  }
}

export type OperatorRuntimeDependencies = {
  inspect(ownerId: string): Promise<unknown>
  /** The owner's organization when the owner is active; otherwise null. */
  ownerOrganization(ownerId: string): Promise<string | null>
  upgrade(ownerId: string, orgId: string): Promise<unknown>
  record(event: { name: string; fields: Record<string, unknown> }): void
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * Serve the operator runtime routes. An upgrade uses the same owner lock,
 * active-work refusal and rollback as an organization admin's upgrade.
 * Returns false for any other path, or when operator access is not configured.
 */
export async function serveOperatorRuntime(req: IncomingMessage, res: ServerResponse, pathname: string,
  access: OperatorAccess | null, deps: OperatorRuntimeDependencies): Promise<boolean> {
  const match = pathname.match(ROUTE)
  if (!match || !access) return false
  if (!access.permits(req)) {
    send(res, 403, { error: 'Operator access denied' })
    return true
  }
  const ownerId = decodeURIComponent(match[1]!)
  try {
    if (req.method === 'GET' && !match[2]) {
      send(res, 200, { runtime: await deps.inspect(ownerId) })
    } else if (req.method === 'POST' && match[2]) {
      const orgId = await deps.ownerOrganization(ownerId)
      if (!orgId) {
        send(res, 404, { error: 'Runtime owner is unavailable' })
        return true
      }
      const runtime = await deps.upgrade(ownerId, orgId)
      deps.record({ name: 'agent_runtime_upgraded', fields: { ownerId, orgId, actor: 'operator' } })
      send(res, 200, { runtime })
    } else {
      send(res, 405, { error: 'Method not allowed' })
    }
  } catch (error) {
    const statusCode = (error as { statusCode?: unknown }).statusCode
    if (typeof statusCode !== 'number') throw error
    send(res, statusCode, { error: error instanceof Error ? error.message : String(error) })
  }
  return true
}
