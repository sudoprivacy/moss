/**
 * HTTP surface for agentify.
 *
 *   /api/v1/agent/agentify/*    called by `agentctl` inside an agent session
 *                               (session token: agent + session identity)
 *   /api/v1/agentify/*          any signed-in employee (tasks they confirm)
 *   /api/v1/admin/agentify/*    administrators (config, memory, history, calls)
 *
 * Mounted behind the server's auth wall; every handler receives the verified
 * token. Returns false for paths it does not own.
 */
import type http from 'http'
import { writeJson } from '../httpRespond.js'
import { hasScope } from '../auth/token.js'
import { A2AError, type CallerContext } from './a2aService.js'
import { AgentifyConfigError, historyPolicy, serverHistoryDefaults } from './config.js'
import type { AgentAuth, AgentifyService } from './service.js'
import type { A2ACall, A2ACallStatus, DocKind } from './store.js'
import { getInstalledAssistants } from '../agentStore.js'
import { canAccessDoc, canAccessType } from './access.js'

type JsonBody = Record<string, unknown>

export interface AgentifyRouteDeps {
  readJsonBody: (req: http.IncomingMessage, maxBytes?: number) => Promise<JsonBody>
  getUserName: (userId: string) => string | undefined
  /** Embedded Nexus upgrade outcome (null when Nexus is external or absent). */
  getNexusStatus?: () => unknown
}

const DOC_KINDS: DocKind[] = ['summary', 'conversation', 'memory', 'a2a', 'artifact', 'input']
const CALL_STATUSES: A2ACallStatus[] = ['pending_confirmation', 'queued', 'running', 'done', 'failed', 'rejected', 'cancelled', 'expired']

export function isAgentifyAdmin(auth: AgentAuth): boolean {
  return auth.role === 'admin' || auth.role === 'super_admin' || hasScope(auth.scopes, 'admin:settings')
}

function fail(res: http.ServerResponse, err: unknown): void {
  if (err instanceof A2AError) {
    writeJson(res, err.status, { error: { code: err.code, message: err.message } })
  } else if (err instanceof AgentifyConfigError) {
    writeJson(res, 400, { error: { code: 'invalid_config', message: err.message } })
  } else {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[agentify] route error:', err)
    writeJson(res, 500, { error: { code: 'internal_error', message } })
  }
}

function kindsParam(raw: string | null): DocKind[] | undefined {
  if (!raw) return undefined
  const kinds = raw.split(',').map(k => k.trim()).filter((k): k is DocKind => (DOC_KINDS as string[]).includes(k))
  return kinds.length > 0 ? kinds : undefined
}

export function createAgentifyRoutes(svc: AgentifyService, deps: AgentifyRouteDeps) {
  const view = (call: A2ACall) => {
    const caller = svc.store.getAgent(call.orgId, call.callerAgentId)
    const target = svc.store.getAgent(call.orgId, call.targetAgentId)
    return {
      id: call.id,
      kind: call.kind,
      status: call.status,
      capability: call.capability,
      caller: { id: call.callerAgentId, name: caller?.displayName ?? call.callerAgentId },
      target: { id: call.targetAgentId, name: target?.displayName ?? call.targetAgentId },
      input: call.input,
      result: call.resultText,
      files: call.resultFiles,
      error: call.error,
      depth: call.depth,
      actor: call.actorUserId ? { id: call.actorUserId, name: deps.getUserName(call.actorUserId) ?? null } : null,
      /**
       * Whose credentials the answering session used (or, before it starts,
       * will use per the capability); null = the actor's.
       */
      runAs: (() => {
        const id = call.runAsUserId ?? (call.startedAt === null ? target?.config.a2a.capabilities.find(c => c.id === call.capability)?.runAsUserId ?? null : null)
        return id ? { id, name: deps.getUserName(id) ?? null } : null
      })(),
      requiresConfirmation: call.requiresConfirmation,
      confirmedBy: call.confirmedBy,
      targetSessionId: call.targetSessionId,
      callerSessionId: call.callerSessionId,
      createdAt: call.createdAt,
      startedAt: call.startedAt,
      finishedAt: call.finishedAt,
    }
  }

  async function docWithText(caller: CallerContext, docId: string) {
    const doc = svc.store.getDoc(docId) ?? svc.store.listDocs({ orgId: caller.orgId, agentId: caller.agent.agentId, limit: 500 }).find(d => d.id.startsWith(docId))
    if (!doc || doc.orgId !== caller.orgId || doc.agentId !== caller.agent.agentId) throw new A2AError(404, 'doc_not_found', 'no such history entry')
    if (!canAccessDoc(doc, svc.callerViewer(caller), caller.agent.config)) throw new A2AError(404, 'doc_not_found', 'no such history entry')
    const buf = await svc.home.read(doc.path)
    return { ...doc, text: buf ? buf.toString('utf8') : '' }
  }

  /** Reading another agent's home is not possible; say what to do instead. */
  function rejectOtherAgent(caller: CallerContext, other: string | null): void {
    if (!other || other === caller.agent.agentId || other === caller.agent.agentName || other === caller.agent.displayName) return
    throw new A2AError(
      403,
      'handoff_only',
      `${other} keeps its history to itself. Ask it with \`agentctl ask\`; files it hands over come back with the answer (\`agentctl call <id> --save\`).`,
    )
  }

  // ---------------------------------------------------------- agent routes

  async function handleAgent(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, url: URL, auth: AgentAuth): Promise<void> {
    const caller = await svc.callerFromAuth(auth)
    const sub = pathname.slice('/api/v1/agent/agentify'.length) || '/'

    if (req.method === 'GET' && sub === '/whoami') {
      writeJson(res, 200, {
        agent: { id: caller.agent.agentId, name: caller.agent.agentName, displayName: caller.agent.displayName },
        sessionId: caller.sessionId,
        depth: caller.depth,
        readonly: svc.isReadonlySession(caller.sessionId),
        home: svc.home.kind,
      })
      return
    }

    if (req.method === 'GET' && sub === '/recall') {
      const q = url.searchParams.get('q') ?? ''
      const limit = Number(url.searchParams.get('limit')) || undefined
      rejectOtherAgent(caller, url.searchParams.get('agent'))
      const hits = await svc.index.search({
        orgId: caller.orgId,
        agentId: caller.agent.agentId,
        query: q,
        viewer: svc.callerViewer(caller),
        kinds: kindsParam(url.searchParams.get('kind')),
        limit,
      })
      writeJson(res, 200, { hits: hits.map(h => ({ ...h, id: h.docId })) })
      return
    }

    if (req.method === 'GET' && sub === '/history') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 100)
      const docs = svc.store
        .listDocs({ orgId: caller.orgId, agentId: caller.agent.agentId, kinds: kindsParam(url.searchParams.get('kind')) ?? ['summary', 'a2a'], limit: limit * 3 })
        .filter(d => canAccessDoc(d, svc.callerViewer(caller), caller.agent.config))
        .slice(0, limit)
      writeJson(res, 200, { items: docs.map(d => ({ id: d.id, kind: d.kind, title: d.title, path: d.path, sessionId: d.sessionId, createdAt: d.createdAt, origin: typeof d.meta.origin === 'string' ? d.meta.origin : null })) })
      return
    }

    const histMatch = sub.match(/^\/history\/([^/]+)$/)
    if (req.method === 'GET' && histMatch) {
      writeJson(res, 200, await docWithText(caller, decodeURIComponent(histMatch[1]!)))
      return
    }

    if (sub === '/memory') {
      if (req.method === 'GET') {
        const sharedOk = canAccessType('sharedMemory', null, svc.callerViewer(caller), caller.agent.config)
        writeJson(res, 200, {
          shared: sharedOk ? await svc.memory.read(caller.orgId, caller.agent.agentId, 'shared', null) : '',
          // Personal notes stay with the employee, never with a session answering another agent.
          private: caller.serving ? '' : await svc.memory.read(caller.orgId, caller.agent.agentId, 'private', caller.userId),
        })
        return
      }
      if (req.method === 'POST') {
        const body = await deps.readJsonBody(req, 64 * 1024)
        const scope = body.scope === 'private' ? 'private' : 'shared'
        if (caller.serving || (svc.isReadonlySession(caller.sessionId) && scope === 'shared')) {
          // A session answering another agent must not rewrite this agent's memory.
          throw new A2AError(403, 'readonly_session', 'this session answers another agent and cannot change memory')
        }
        try {
          const count = await svc.memory.add({
            orgId: caller.orgId,
            agentId: caller.agent.agentId,
            agentDisplayName: caller.agent.displayName,
            scope,
            userId: scope === 'private' ? caller.userId : null,
            author: deps.getUserName(caller.userId) ?? caller.userId,
            text: typeof body.text === 'string' ? body.text : '',
          })
          writeJson(res, 200, { ok: true, entries: count })
        } catch (err) {
          throw new A2AError(400, 'invalid_memory', err instanceof Error ? err.message : String(err))
        }
        return
      }
    }

    if (req.method === 'GET' && sub === '/agents') {
      writeJson(res, 200, { agents: await svc.a2a.listCallable(caller) })
      return
    }

    if (req.method === 'POST' && (sub === '/ask' || sub === '/tasks')) {
      const body = await deps.readJsonBody(req, 64 * 1024)
      const common = {
        agent: typeof body.agent === 'string' ? body.agent : '',
        capability: typeof body.capability === 'string' ? body.capability : '',
        idempotencyKey: typeof body.idempotencyKey === 'string' && body.idempotencyKey ? body.idempotencyKey.slice(0, 128) : null,
      }
      const call = sub === '/ask'
        ? await svc.a2a.ask(caller, { ...common, question: body.question })
        : await svc.a2a.delegate(caller, { ...common, input: body.input })
      writeJson(res, 202, { call: view(call) })
      return
    }

    const callMatch = sub.match(/^\/calls\/([^/]+)(\/cancel|\/files)?$/)
    if (callMatch) {
      const id = decodeURIComponent(callMatch[1]!)
      if (req.method === 'GET' && callMatch[2] === '/files') {
        const { buf, name } = await svc.a2a.callFile(caller, id, url.searchParams.get('name') ?? '')
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': buf.length,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        })
        res.end(buf)
        return
      }
      if (req.method === 'GET' && !callMatch[2]) {
        writeJson(res, 200, { call: view(svc.a2a.callVisibleTo(caller, id)) })
        return
      }
      if (req.method === 'POST' && callMatch[2] === '/cancel') {
        writeJson(res, 200, { call: view(svc.a2a.cancel(caller, id)) })
        return
      }
    }

    if (req.method === 'GET' && sub === '/files') {
      rejectOtherAgent(caller, url.searchParams.get('agent'))
      const { buf } = await svc.a2a.readHomeFile(caller.orgId, caller.agent, url.searchParams.get('path') ?? '', svc.callerViewer(caller))
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length })
      res.end(buf)
      return
    }

    if (req.method === 'POST' && sub === '/handoff') {
      const body = await deps.readJsonBody(req, 16 * 1024)
      const handed = await svc.a2a.handoff(caller, typeof body.path === 'string' ? body.path : '')
      writeJson(res, 200, { handed })
      return
    }

    writeJson(res, 404, { error: { code: 'not_found', message: `no agentify route ${req.method} ${sub}` } })
  }

  // ------------------------------------------------------- employee routes

  async function handleUser(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, auth: AgentAuth): Promise<void> {
    if (req.method === 'GET' && pathname === '/api/v1/agentify/confirmations') {
      const admin = isAgentifyAdmin(auth)
      const pending = svc.store
        .listCalls({ orgId: auth.orgId, status: 'pending_confirmation', limit: 200 })
        .filter(c => admin || svc.store.getAgent(auth.orgId, c.targetAgentId)?.config.a2a.confirmers.includes(auth.userId))
      writeJson(res, 200, { calls: pending.map(view) })
      return
    }
    const m = pathname.match(/^\/api\/v1\/agentify\/confirmations\/([^/]+)$/)
    if (req.method === 'POST' && m) {
      const body = await deps.readJsonBody(req, 16 * 1024)
      const call = await svc.a2a.confirm({
        orgId: auth.orgId,
        userId: auth.userId,
        callId: decodeURIComponent(m[1]!),
        approve: body.approve === true,
        note: typeof body.note === 'string' ? body.note.slice(0, 500) : undefined,
      })
      writeJson(res, 200, { call: view(call) })
      return
    }
    writeJson(res, 404, { error: { code: 'not_found', message: 'no such route' } })
  }

  // ---------------------------------------------------------- admin routes

  async function handleAdmin(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, url: URL, auth: AgentAuth): Promise<void> {
    if (!isAgentifyAdmin(auth)) {
      writeJson(res, 403, { error: { code: 'forbidden', message: 'administrators only' } })
      return
    }
    const sub = pathname.slice('/api/v1/admin/agentify'.length) || '/'

    if (req.method === 'GET' && sub === '/agents') {
      const rows = new Map(svc.store.listAgents(auth.orgId).map(r => [r.agentId, r]))
      const installed = await getInstalledAssistants()
      const seen = new Set<string>()
      const agents = []
      for (const a of installed) {
        const ref = await svc.registry.resolve(a.id || a.name)
        if (!ref || seen.has(ref.id)) continue
        seen.add(ref.id)
        const row = rows.get(ref.id)
        agents.push({
          id: ref.id,
          name: ref.name,
          displayName: ref.displayName,
          description: ref.description,
          category: a.tag,
          enabled: a.enabled,
          agentified: Boolean(row?.config.enabled),
          config: row?.config ?? null,
          /** Hours in effect, after server defaults and the lookback ≤ deletion rule. */
          historyPolicy: historyPolicy(row?.config),
          documents: row ? svc.store.countDocs(auth.orgId, ref.id) : 0,
        })
      }
      writeJson(res, 200, { agents, home: svc.home.kind, historyDefaults: serverHistoryDefaults() })
      return
    }

    const agentMatch = sub.match(/^\/agents\/([^/]+)(\/[a-z]+)?(\/[^/]+)?$/)
    if (agentMatch) {
      const ref = await svc.registry.resolve(decodeURIComponent(agentMatch[1]!))
      if (!ref) {
        writeJson(res, 404, { error: { code: 'agent_not_found', message: 'no such agent' } })
        return
      }
      const tail = agentMatch[2] ?? ''
      const row = svc.store.getAgent(auth.orgId, ref.id)

      if (tail === '' && req.method === 'PUT') {
        const body = await deps.readJsonBody(req, 256 * 1024)
        const saved = await svc.configure(auth.orgId, ref.id, body.config ?? body)
        writeJson(res, 200, { agent: { id: saved.agentId, displayName: saved.displayName, config: saved.config } })
        return
      }
      if (tail === '' && req.method === 'DELETE') {
        writeJson(res, 200, { ok: svc.removeAgent(auth.orgId, ref.id) })
        return
      }
      if (tail === '' && req.method === 'GET') {
        writeJson(res, 200, { agent: { id: ref.id, name: ref.name, displayName: ref.displayName, config: row?.config ?? null } })
        return
      }
      if (tail === '/memory') {
        const scope = url.searchParams.get('scope') === 'private' ? 'private' : 'shared'
        const userId = url.searchParams.get('userId')
        if (scope === 'private' && !userId) {
          writeJson(res, 400, { error: { code: 'invalid_request', message: 'userId is required for private memory' } })
          return
        }
        if (req.method === 'GET') {
          writeJson(res, 200, { text: await svc.memory.read(auth.orgId, ref.id, scope, userId) })
          return
        }
        if (req.method === 'PUT') {
          const body = await deps.readJsonBody(req, 128 * 1024)
          await svc.memory.replace({ orgId: auth.orgId, agentId: ref.id, agentDisplayName: ref.displayName, scope, userId, text: typeof body.text === 'string' ? body.text : '' })
          writeJson(res, 200, { ok: true })
          return
        }
      }
      if (tail === '/history' && req.method === 'GET') {
        const docId = agentMatch[3]?.slice(1)
        if (docId) {
          const doc = svc.store.getDoc(decodeURIComponent(docId))
          if (!doc || doc.orgId !== auth.orgId || doc.agentId !== ref.id) {
            writeJson(res, 404, { error: { code: 'doc_not_found', message: 'no such document' } })
            return
          }
          const buf = await svc.home.read(doc.path)
          writeJson(res, 200, { ...doc, text: buf ? buf.toString('utf8') : '' })
          return
        }
        const q = url.searchParams.get('q') ?? ''
        const kinds = kindsParam(url.searchParams.get('kind'))
        if (q.trim()) {
          // Administrators see everything, including private documents.
          const hits = await svc.index.search({ orgId: auth.orgId, agentId: ref.id, query: q, viewer: { kind: 'admin' }, kinds, limit: 30, maxChars: 20_000 })
          writeJson(res, 200, { hits })
          return
        }
        const docs = svc.store.listDocs({ orgId: auth.orgId, agentId: ref.id, kinds, limit: Math.min(Number(url.searchParams.get('limit')) || 50, 200), offset: Number(url.searchParams.get('offset')) || 0 })
        writeJson(res, 200, { items: docs, total: svc.store.countDocs(auth.orgId, ref.id) })
        return
      }
      if (tail === '/purge' && req.method === 'POST') {
        // Delete this agent's expired history now instead of at the next hourly pass.
        writeJson(res, 200, await svc.digest.purgeExpired(Date.now(), { orgId: auth.orgId, agentId: ref.id }))
        return
      }
      if (tail === '/digest' && req.method === 'POST') {
        writeJson(res, 200, await svc.digest.digestAgent(auth.orgId, ref.id))
        return
      }
    }

    if (req.method === 'GET' && sub === '/nexus') {
      writeJson(res, 200, { home: svc.home.kind, nexus: deps.getNexusStatus?.() ?? null })
      return
    }

    if (req.method === 'GET' && sub === '/calls') {
      const status = url.searchParams.get('status') as A2ACallStatus | null
      const calls = svc.store.listCalls({
        orgId: auth.orgId,
        agentId: url.searchParams.get('agentId') ?? undefined,
        status: status && CALL_STATUSES.includes(status) ? status : undefined,
        limit: Math.min(Number(url.searchParams.get('limit')) || 100, 500),
      })
      writeJson(res, 200, { calls: calls.map(view) })
      return
    }

    writeJson(res, 404, { error: { code: 'not_found', message: `no admin agentify route ${req.method} ${sub}` } })
  }

  return {
    async handle(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, url: URL, auth: AgentAuth): Promise<boolean> {
      try {
        if (pathname.startsWith('/api/v1/agent/agentify/')) {
          await handleAgent(req, res, pathname, url, auth)
          return true
        }
        if (pathname.startsWith('/api/v1/admin/agentify/')) {
          await handleAdmin(req, res, pathname, url, auth)
          return true
        }
        if (pathname.startsWith('/api/v1/agentify/')) {
          await handleUser(req, res, pathname, auth)
          return true
        }
        return false
      } catch (err) {
        fail(res, err)
        return true
      }
    },
  }
}
