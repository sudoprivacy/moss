import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http'
import { request as httpsRequest } from 'https'
import { request as httpRequest } from 'http'
import { URL } from 'url'
import { validateRemoteUrl } from './ssrfGuard.js'
import { injectAuth, injectMultiAuth, type InjectAuthResult } from './authInjectors.js'
import { handleSecretsRequest } from './secretsApi.js'
import { secretSubject, orgScopedNamespace } from '../secrets/secretSubject.js'
import type { NexusClient } from '../nexus/nexusClient.js'
import type { TokenMinter } from './tokenMinter.js'
import { getSystemSettings } from '../systemSettings.js'

export interface AuthProxyRule {
  configItemId: number
  name: string
  urlPattern: string
  scheme: string
  bearerPrefix: string
  // 'user' | 'system' | 'department'. User-scoped credentials are authorized by possession of
  // the secret itself, so they are NOT subject to the department policy gate;
  // only department credentials are. Enterprise (system) credentials are visible to all users.
  scope: string
  // Owning org for non-user (system/department) rules; null for user-scope
  // definitions which are global. A request only matches rules whose orgId is
  // its own org (or null), so two orgs' identical URL patterns never collide.
  orgId: string | null
  secretNamespace: string
  entries: Array<{ configKey: string; name: string; required: boolean }>
  // Login-type services: when authType is set and not 'static', the stored
  // secrets are credentials to mint an access_token from (rather than inject
  // directly). See tokenMinter.
  authType?: string | null
  tokenUrl?: string | null
  tokenRequestJson?: string | null
  // For auth_type 'script' the login script path is composed as
  // `<mintScriptsDir>/<pinyin>_mint.sh`; carry the pinyin for the minter.
  pinyin?: string | null
}

/**
 * Map a `config_items` row (+ its entries) to an AuthProxyRule. Shared by the
 * startup loader and the `refreshAuthProxyRules` reload path so the mapping —
 * including the mint fields — stays in one place.
 */
export function configItemToRule(
  item: Record<string, unknown>,
  getEntries: (configItemId: number) => Array<Record<string, unknown>>,
): AuthProxyRule {
  const id = item.id as number
  const scope = (item.scope as string) || 'system'
  const orgId = (item.org_id as string | null) ?? null
  // Non-user namespaces are org-scoped so each org's enterprise/department
  // secret lives under a distinct Nexus namespace; user namespaces are global.
  const baseNamespace = scope === 'user'
    ? `user:{userId}:${item.pinyin}`
    : scope === 'department'
      ? `role:${item.pinyin}`
      : `system:${item.pinyin}`
  return {
    configItemId: id,
    name: item.name as string,
    urlPattern: (item.url_pattern as string) || '',
    scheme: (item.scheme as string) || '',
    bearerPrefix: (item.bearer_prefix as string) || '',
    scope,
    orgId: scope === 'user' ? null : orgId,
    secretNamespace: scope === 'user' || !orgId
      ? baseNamespace
      : orgScopedNamespace(baseNamespace, orgId),
    entries: (getEntries(id) || []).map(e => ({
      configKey: e.config_key as string,
      name: e.name as string,
      required: !!e.required,
    })),
    authType: (item.auth_type as string | null) ?? null,
    tokenUrl: (item.token_url as string | null) ?? null,
    tokenRequestJson: (item.token_request_json as string | null) ?? null,
    pinyin: (item.pinyin as string | null) ?? null,
  }
}

interface TokenEntry {
  userId: string
  orgId: string
  departmentId: string | null
  // Owner carries full administrative capability (admin/super_admin). Admins
  // have all privileges within their org (super_admin across orgs), so their
  // sessions bypass the department-credential policy gate regardless of which
  // department — if any — they belong to.
  isAdmin: boolean
  pid: number | null
  registeredAt: number
}

interface DepartmentPolicyProvider {
  getAuthorizedConfigItemIds(departmentId: string): number[]
}

/**
 * Decide whether a request may use a matched credential rule, applying the
 * department-policy gate. Only department-scoped credentials are gated:
 * enterprise (system) creds are visible to all users and user-scoped creds are
 * authorized by possession of the secret itself.
 *
 * Admins/super_admins bypass the gate entirely — they hold all privileges
 * within their org (super_admin across orgs), so a job they own may use any
 * department's credential regardless of the owner's own (or absent) department
 * membership.
 *
 * A department-less non-admin is left as-is (allowed): the policy gate only
 * applies once a user belongs to a department, preserving the proxy's prior
 * behavior for that edge — this change adds only the admin bypass.
 *
 * Extracted as a pure function so the decision is unit-testable without
 * standing up the HTTP proxy, nexus, and token minting.
 */
export function isDepartmentCredentialAllowed(
  match: { scope: string; configItemId: number },
  actor: { isAdmin: boolean; departmentId: string | null },
  getAuthorizedConfigItemIds: (departmentId: string) => number[],
): boolean {
  if (match.scope !== 'department') return true
  if (actor.isAdmin) return true
  if (!actor.departmentId) return true
  return getAuthorizedConfigItemIds(actor.departmentId).includes(match.configItemId)
}

const CONTROL_HEADERS = new Set([
  'authorization', 'x-secret-namespace', 'x-secret-key', 'x-secret-scheme',
  'x-auth-scheme', 'x-remote-url', 'x-remote-method', 'host', 'connection',
])

const UPSTREAM_TIMEOUT_MS = 30_000
const AUTH_PROXY_PORT = 12013
// Token TTL: tokens older than this are considered expired and will be cleaned up
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const TOKEN_CLEANUP_INTERVAL_MS = 60 * 60 * 1000 // 1 hour
// Bind host for the proxy listener. Defaults to loopback (the safe local-runner
// case). In the Docker runtime, moss-server and the session containers are peers
// on the `moss-network` bridge, so the proxy must bind on all interfaces
// (MOSS_AUTH_PROXY_HOST=0.0.0.0) for containers to reach it by container name.
// It remains protected by the per-session bearer token in every case.
const AUTH_PROXY_HOST = process.env.MOSS_AUTH_PROXY_HOST?.trim() || '127.0.0.1'

export class AuthProxyServer {
  private server: Server | null = null
  private readonly tokenRegistry = new Map<string, TokenEntry>()
  private rules = new Map<number, AuthProxyRule>()
  private nexusClient: NexusClient | null = null
  private policyProvider: DepartmentPolicyProvider | null = null
  private tokenMinter: TokenMinter | null = null
  private tokenCleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor() {}

  setNexusClient(client: NexusClient): void {
    this.nexusClient = client
  }

  setTokenMinter(minter: TokenMinter): void {
    this.tokenMinter = minter
  }

  setPolicyProvider(provider: DepartmentPolicyProvider): void {
    this.policyProvider = provider
  }

  updateRules(rules: AuthProxyRule[]): void {
    this.rules.clear()
    for (const rule of rules) {
      this.rules.set(rule.configItemId, rule)
    }
  }

  registerToken(token: string, userId: string, orgId: string, departmentId: string | null, isAdmin: boolean, pid: number | null): void {
    this.tokenRegistry.set(token, { userId, orgId, departmentId, isAdmin, pid, registeredAt: Date.now() })
  }

  revokeToken(token: string): void {
    this.tokenRegistry.delete(token)
  }

  isValidToken(token: string): boolean {
    const entry = this.tokenRegistry.get(token)
    if (!entry) return false
    // Check if token has expired
    if (Date.now() - entry.registeredAt > TOKEN_TTL_MS) {
      this.tokenRegistry.delete(token)
      return false
    }
    return true
  }

  private cleanupExpiredTokens(): void {
    const now = Date.now()
    let cleaned = 0
    for (const [token, entry] of this.tokenRegistry) {
      if (now - entry.registeredAt > TOKEN_TTL_MS) {
        this.tokenRegistry.delete(token)
        cleaned++
      }
    }
    if (cleaned > 0) {
      console.log(`[AuthProxy] Cleaned up ${cleaned} expired tokens`)
    }
  }

  async start(): Promise<void> {
    // Start token cleanup timer
    this.tokenCleanupTimer = setInterval(() => {
      this.cleanupExpiredTokens()
    }, TOKEN_CLEANUP_INTERVAL_MS)
    this.tokenCleanupTimer.unref()

    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch(err => {
          console.error('[AuthProxy] Error:', err)
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'proxy_error' }))
          }
        })
      })

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Auth Proxy port ${AUTH_PROXY_PORT} is already in use`))
        } else {
          reject(err)
        }
      })

      this.server.listen(AUTH_PROXY_PORT, AUTH_PROXY_HOST, () => {
        console.log(`[AuthProxy] Listening on ${AUTH_PROXY_HOST}:${AUTH_PROXY_PORT}`)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    // Stop token cleanup timer
    if (this.tokenCleanupTimer) {
      clearInterval(this.tokenCleanupTimer)
      this.tokenCleanupTimer = null
    }
    if (!this.server) return
    return new Promise(resolve => {
      this.server?.closeAllConnections?.()
      this.server?.close(() => {
        this.server = null
        resolve()
      })
    })
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', port: AUTH_PROXY_PORT }))
      return
    }

    const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (parsedUrl.pathname === '/secrets' || parsedUrl.pathname.startsWith('/secrets/')) {
      const authHeader = req.headers['authorization']
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
      if (!token || !this.isValidToken(token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid_token' }))
        return
      }
      const tokenEntry = this.tokenRegistry.get(token)!
      await handleSecretsRequest(req, res, parsedUrl.pathname, parsedUrl, {
        userId: tokenEntry.userId,
        orgId: tokenEntry.orgId,
        departmentId: tokenEntry.departmentId,
        isAdmin: tokenEntry.isAdmin,
      })
      return
    }

    // The forwarding endpoint is /proxy (any method). The intended upstream
    // method travels in X-Remote-Method (set by fetchurl), so a GET upstream
    // isn't forced to POST. Match by pathname so a query string doesn't break it.
    if (parsedUrl.pathname !== '/proxy') {
      if (req.method === 'GET' && parsedUrl.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', service: 'moss-auth-proxy' }))
        return
      }
      res.writeHead(404)
      res.end('Not found')
      return
    }

    // 1. Auth check
    const authHeader = req.headers['authorization']
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!token || !this.isValidToken(token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid_token' }))
      return
    }

    const tokenEntry = this.tokenRegistry.get(token)!

    // 2. Validate remote URL
    const remoteUrl = req.headers['x-remote-url'] as string
    if (!remoteUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'missing_x-remote-url' }))
      return
    }

    const urlValidation = validateRemoteUrl(remoteUrl)
    if (!urlValidation.valid) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid_url', message: urlValidation.error }))
      return
    }

    // 3. Resolve credentials and inject
    let injectResult: InjectAuthResult = { headers: {} }
    let matchedConfigItemId: number | null = null

    // Priority 1: Explicit headers
    const explicitNs = req.headers['x-secret-namespace'] as string
    const explicitKey = req.headers['x-secret-key'] as string
    const explicitScheme = req.headers['x-secret-scheme'] as string || req.headers['x-auth-scheme'] as string

    if (explicitNs && explicitKey && this.nexusClient) {
      // 显式头路径不允许消费企业凭据和部门凭据：缺少策略门，避免越权
      if (explicitNs.startsWith('system:') || explicitNs.startsWith('role:')) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          error: 'forbidden_namespace',
          message: 'Enterprise secrets cannot be fetched via explicit headers',
        }))
        return
      }
      const secret = await this.nexusClient.getSecret(explicitNs, explicitKey, tokenEntry.userId)
      if (secret?.value) {
        // For explicit headers, treat non-standard scheme as a Bearer prefix
        const scheme = explicitScheme || 'bearer'
        if (['bearer', 'basic', 'header', 'query'].includes(scheme)) {
          injectResult = injectAuth({ scheme, secret: secret.value })
        } else {
          // Custom scheme string used as Bearer prefix
          injectResult = injectAuth({ scheme: 'bearer', secret: secret.value, prefix: scheme })
        }
      }
    } else {
      // Priority 2: URL pattern matching (longest path first), scoped to the
      // requester's org so credentials never leak across organizations.
      const match = this.findRuleForUrl(remoteUrl, tokenEntry.orgId)
      if (!match) {
        // No matching rule found — reject request
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'no_matching_rule', message: 'No matching secret configuration found for this URL' }))
        return
      }

      // 4. Department policy check — see isDepartmentCredentialAllowed. Only
      // department credentials are gated; admins bypass; a department-less
      // non-admin has no authorized department creds. Guarded on policyProvider
      // so a misconfigured proxy (no provider) fails open exactly as before.
      if (
        this.policyProvider &&
        !isDepartmentCredentialAllowed(
          match,
          { isAdmin: tokenEntry.isAdmin, departmentId: tokenEntry.departmentId },
          deptId => this.policyProvider!.getAuthorizedConfigItemIds(deptId),
        )
      ) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'rejected_no_policy', message: 'Department not authorized for this resource' }))
        return
      }

      matchedConfigItemId = match.configItemId

      // 5. Resolve secrets from Nexus
      const resolvedNamespace = match.secretNamespace.replaceAll('{userId}', tokenEntry.userId)
      const secrets: Array<{ configKey: string; value: string }> = []
      for (const entry of match.entries) {
        if (this.nexusClient) {
          try {
            const secret = await this.nexusClient.getSecret(resolvedNamespace, entry.configKey, secretSubject(resolvedNamespace, tokenEntry.userId))
            if (secret?.value) {
              secrets.push({ configKey: entry.configKey, value: secret.value })
            }
          } catch {
            // Secret not found, skip
          }
        }
      }

      if (secrets.length === 0) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'rejected_no_secret', message: 'No secret values found for this configuration' }))
        return
      }

      const isLoginType =
        typeof match.authType === 'string' && match.authType !== '' && match.authType !== 'static'
      if (isLoginType) {
        // The stored "secrets" are login credentials: mint (or reuse a cached)
        // access_token from them and inject it as a Bearer token. The raw
        // credential never reaches the upstream request or the skill.
        if (!this.tokenMinter) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'mint_unavailable', message: 'Token minting is not configured' }))
          return
        }
        const creds: Record<string, string> = {}
        for (const s of secrets) creds[s.configKey] = s.value
        const minted = await this.tokenMinter.getOrMint(
          tokenEntry.userId,
          {
            configItemId: match.configItemId,
            authType: match.authType!,
            tokenUrl: match.tokenUrl,
            tokenRequestJson: match.tokenRequestJson,
            pinyin: match.pinyin,
            mintScriptsDir: getSystemSettings().mintScriptsDir,
          },
          creds,
        )
        if (!minted) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'mint_failed', message: 'Could not obtain an access token; the user may need to set or refresh their credential' }))
          return
        }
        injectResult = injectAuth({ scheme: 'bearer', secret: minted.token })
      } else if (['bearer', 'basic'].includes(match.scheme)) {
        injectResult = injectAuth({
          scheme: match.scheme,
          secret: secrets[0].value,
          prefix: match.bearerPrefix || undefined,
        })
      } else {
        injectResult = injectMultiAuth(match.scheme, secrets)
      }
    }

    // 6. Build upstream headers
    const targetUrl = new URL(remoteUrl)
    const upstreamHeaders: Record<string, string> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (!CONTROL_HEADERS.has(key.toLowerCase()) && typeof value === 'string') {
        upstreamHeaders[key] = value
      }
    }
    Object.assign(upstreamHeaders, injectResult.headers)
    upstreamHeaders['host'] = targetUrl.host

    // Handle query injection
    let finalUrl = remoteUrl
    if (injectResult.url) {
      const separator = targetUrl.search ? '&' : '?'
      finalUrl = `${remoteUrl}${separator}${injectResult.url}`
    }

    // 7. Forward request
    const targetFinal = new URL(finalUrl)
    const requestOptions = {
      hostname: targetFinal.hostname,
      port: targetFinal.port || (targetFinal.protocol === 'https:' ? '443' : '80'),
      path: targetFinal.pathname + targetFinal.search,
      // Upstream method comes from X-Remote-Method (fetchurl sets it); fall back
      // to the incoming method for direct callers.
      method: (req.headers['x-remote-method'] as string | undefined)?.toUpperCase() || req.method,
      headers: upstreamHeaders,
      timeout: UPSTREAM_TIMEOUT_MS,
    }

    const upstreamReq = targetFinal.protocol === 'https:'
      ? httpsRequest(requestOptions)
      : httpRequest(requestOptions)

    upstreamReq.on('response', (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    })

    upstreamReq.on('error', (err) => {
      console.error('[AuthProxy] Upstream error:', err.message)
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'upstream_error', message: err.message }))
      }
    })

    upstreamReq.on('timeout', () => {
      upstreamReq.destroy()
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'upstream_timeout', message: 'Upstream request timed out' }))
      }
    })

    req.pipe(upstreamReq)
  }

  /**
   * Find the best matching rule for a URL.
   * Uses longest-path-first matching: among all matching rules, the one with
   * the longest urlPattern string wins (most specific match).
   */
  private findRuleForUrl(url: string, orgId: string): AuthProxyRule | null {
    let bestMatch: AuthProxyRule | null = null
    let bestLength = -1
    let bestId = -1

    for (const rule of this.rules.values()) {
      if (!rule.urlPattern) continue
      // Org isolation: only consider rules belonging to the requester's org, or
      // global (user-scope) rules (orgId === null). This is what prevents one
      // org's credential from matching another org's identical URL pattern.
      if (rule.orgId !== null && rule.orgId !== orgId) continue
      if (this.matchUrl(rule.urlPattern, url)) {
        if (rule.urlPattern.length > bestLength || (rule.urlPattern.length === bestLength && rule.configItemId > bestId)) {
          bestMatch = rule
          bestLength = rule.urlPattern.length
          bestId = rule.configItemId
        }
      }
    }
    return bestMatch
  }

  /**
   * Convert glob-style URL pattern to regex and match.
   * Supports * (any chars) and ? (single char) wildcards.
   */
  private matchUrl(pattern: string, url: string): boolean {
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
    try {
      return new RegExp(`^${regexStr}$`).test(url)
    } catch {
      return false
    }
  }

  /** Clean up tokens for processes that no longer exist */
  cleanupStaleTokens(): void {
    for (const [token, entry] of this.tokenRegistry.entries()) {
      if (entry.pid !== null) {
        try {
          process.kill(entry.pid, 0)
        } catch {
          this.tokenRegistry.delete(token)
        }
      }
    }
  }
}
