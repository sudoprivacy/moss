import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http'
import { request as httpsRequest } from 'https'
import { request as httpRequest } from 'http'
import { URL } from 'url'
import { validateRemoteUrl } from './ssrfGuard.js'
import { injectAuth, injectMultiAuth, type InjectAuthResult } from './authInjectors.js'
import { handleSecretsRequest } from './secretsApi.js'
import { secretSubject, orgScopedNamespace, deptSecretNamespace } from '../secrets/secretSubject.js'
import type { NexusClient } from '../nexus/nexusClient.js'
import type { TokenMinter } from './tokenMinter.js'
import { getSystemSettings } from '../systemSettings.js'
import {
  parseBodyAuthCheck,
  bodyIndicatesUnauthorized,
  type BodyAuthCheckRecipe,
} from './bodyAuthCheck.js'

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
  // Opt-in recipe (JSON) for detecting a body-level "unauthorized" reply
  // (HTTP 200 + {"code":401,...}) so re-mint fires on it too. See bodyAuthCheck.
  bodyAuthCheck?: string | null
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
    bodyAuthCheck: (item.body_auth_check as string | null) ?? null,
  }
}

/**
 * Selection rank for a credential scope: higher wins. A user's own credential
 * takes precedence over a department one, which takes precedence over the
 * corp/enterprise (system) default. Unknown scopes rank lowest. Used only to
 * break ties between rules whose URL patterns are equally specific.
 */
function scopeRank(scope: string): number {
  switch (scope) {
    case 'user':
      return 3
    case 'department':
      return 2
    case 'system':
      return 1
    default:
      return 0
  }
}

/**
 * Convert a glob-style URL pattern (supporting `*` = any chars, `?` = single
 * char) to a regex and test it against `url`. Invalid patterns never match.
 */
export function matchUrlPattern(pattern: string, url: string): boolean {
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

/**
 * Compare two matching rules by the selection precedence (see
 * {@link selectRuleForUrl}): longer urlPattern first, then scope
 * (user > department > system). Returns >0 if `a` outranks `b`, <0 if `b`
 * outranks `a`, 0 if they tie on both dimensions (in which case configItemId is
 * the remaining tie-break). configItemId is intentionally NOT compared here so
 * the caller can detect the tie and warn.
 */
function compareRulePriority(a: AuthProxyRule, b: AuthProxyRule): number {
  if (a.urlPattern.length !== b.urlPattern.length) {
    return a.urlPattern.length - b.urlPattern.length
  }
  return scopeRank(a.scope) - scopeRank(b.scope)
}

/**
 * Pick the best matching credential rule for a URL from `rules`.
 *
 * Precedence among all matching rules, in order:
 *   1. Longest urlPattern (most specific match).
 *   2. Scope: user > department > system. A user's own credential beats a
 *      department one, which beats the corp/enterprise (system) default.
 *   3. Latest created (highest configItemId).
 *
 * Org isolation: only rules belonging to `orgId`, or global user-scope rules
 * (orgId === null), are considered — so two orgs' identical URL patterns never
 * collide.
 *
 * When the top two rules tie on both length AND scope, only configItemId (3)
 * separated them — an arbitrary choice from the admin's point of view — so we
 * emit a warning naming every rule in that tied group to flag the likely
 * misconfiguration. Extracted as a pure function so the ranking is unit-testable
 * without the HTTP proxy, nexus, and token minting.
 */
export function selectRuleForUrl(
  rules: Iterable<AuthProxyRule>,
  url: string,
  orgId: string,
): AuthProxyRule | null {
  const matches: AuthProxyRule[] = []
  for (const rule of rules) {
    if (!rule.urlPattern) continue
    if (rule.orgId !== null && rule.orgId !== orgId) continue
    if (matchUrlPattern(rule.urlPattern, url)) matches.push(rule)
  }
  if (matches.length === 0) return null

  // Highest priority first: longest pattern, then scope (user>dept>system),
  // then latest created (highest id).
  matches.sort((a, b) => {
    const cmp = compareRulePriority(a, b)
    if (cmp !== 0) return -cmp
    return b.configItemId - a.configItemId
  })

  const best = matches[0]

  const tied = matches.filter(r => compareRulePriority(r, best) === 0)
  if (tied.length > 1) {
    const desc = tied
      .map(r => `#${r.configItemId} '${r.name}' (${r.scope}, pattern='${r.urlPattern}')`)
      .join(', ')
    console.warn(
      `[AuthProxy] Ambiguous credential match for ${url}: ${tied.length} rules tie on ` +
        `URL-pattern length and scope: ${desc}. Using #${best.configItemId} (latest created). ` +
        `Disambiguate by URL pattern or scope.`,
    )
  }

  return best
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

/** Collect a request's body into a single Buffer (empty when there is none). */
function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

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
  // Resolves a department's ordered ancestor chain `[deptId, parent, ...]` for
  // hierarchical department-credential value inheritance. Null → no inheritance
  // (value resolution stays own-dept-then-org-default).
  private deptAncestorProvider: ((orgId: string, deptId: string) => string[]) | null = null
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

  setDeptAncestorProvider(provider: (orgId: string, deptId: string) => string[]): void {
    this.deptAncestorProvider = provider
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
    // When the injected credential was a minted (login-type) token, capture what
    // we'd need to re-mint it. If the upstream rejects the cached token with 401
    // (e.g. the provider enforces a single active session and a login elsewhere
    // invalidated ours), we force a fresh mint and retry the request once — so a
    // single fetchurl call self-heals instead of surfacing a spurious 401.
    let mintRetry: {
      cfg: {
        configItemId: number
        authType: string
        tokenUrl: string | null | undefined
        tokenRequestJson: string | null | undefined
        pinyin: string | null | undefined
        mintScriptsDir: string | null | undefined
      }
      creds: Record<string, string>
      userId: string
      // Parsed per-item body-level 401 recipe (null = HTTP-status-only).
      bodyAuthCheck: BodyAuthCheckRecipe | null
    } | null = null

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

      // 5. Resolve secrets from Nexus.
      const resolvedNamespace = match.secretNamespace.replaceAll('{userId}', tokenEntry.userId)
      // For a department-scoped credential, prefer a value specific to the
      // consumer's current department (`role:@{deptId}:{pinyin}`) and fall back
      // to the legacy org-wide value (`role:{pinyin}`) when the dept-specific one
      // is unset — so pre-migration values keep working and departments without
      // their own value inherit the org default. The candidate list is tried in
      // order per config key.
      const namespaceCandidates: string[] = []
      if (match.scope === 'department' && tokenEntry.departmentId && match.pinyin && match.orgId) {
        // Hierarchical inheritance: try the consumer's own department, then walk
        // UP each ancestor department, using the nearest one that has a value.
        // (Access is already gated by the exact-department policy above; this
        // only chooses which value an authorized consumer receives.)
        const chain = this.deptAncestorProvider
          ? this.deptAncestorProvider(match.orgId, tokenEntry.departmentId)
          : [tokenEntry.departmentId]
        for (const deptId of chain) {
          namespaceCandidates.push(
            orgScopedNamespace(deptSecretNamespace(deptId, match.pinyin), match.orgId),
          )
        }
      }
      // Finally the legacy org-wide default value.
      namespaceCandidates.push(resolvedNamespace)

      const secrets: Array<{ configKey: string; value: string }> = []
      for (const entry of match.entries) {
        if (!this.nexusClient) continue
        for (const ns of namespaceCandidates) {
          try {
            const secret = await this.nexusClient.getSecret(ns, entry.configKey, secretSubject(ns, tokenEntry.userId))
            if (secret?.value) {
              secrets.push({ configKey: entry.configKey, value: secret.value })
              break // first namespace with a value wins (per-dept over org default)
            }
          } catch {
            // Secret not found in this namespace; try the next candidate.
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
        const mintCfg = {
          configItemId: match.configItemId,
          authType: match.authType!,
          tokenUrl: match.tokenUrl,
          tokenRequestJson: match.tokenRequestJson,
          pinyin: match.pinyin,
          mintScriptsDir: getSystemSettings().mintScriptsDir,
        }
        const minted = await this.tokenMinter.getOrMint(tokenEntry.userId, mintCfg, creds)
        if (!minted) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'mint_failed', message: 'Could not obtain an access token; the user may need to set or refresh their credential' }))
          return
        }
        injectResult = injectAuth({ scheme: 'bearer', secret: minted.token })
        // Enable the on-401 re-mint-and-retry path for this request. The body
        // check is opt-in per config item; null keeps HTTP-status-only behavior.
        mintRetry = {
          cfg: mintCfg,
          creds,
          userId: tokenEntry.userId,
          bodyAuthCheck: parseBodyAuthCheck(match.bodyAuthCheck),
        }
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
    const method = (req.headers['x-remote-method'] as string | undefined)?.toUpperCase() || req.method
    const baseRequestOptions = {
      hostname: targetFinal.hostname,
      port: targetFinal.port || (targetFinal.protocol === 'https:' ? '443' : '80'),
      path: targetFinal.pathname + targetFinal.search,
      // Upstream method comes from X-Remote-Method (fetchurl sets it); fall back
      // to the incoming method for direct callers.
      method,
      timeout: UPSTREAM_TIMEOUT_MS,
    }
    const doRequest = targetFinal.protocol === 'https:' ? httpsRequest : httpRequest

    // Fast path: no minted credential, so no re-mint/retry is possible. Keep the
    // original zero-copy streaming pipe (request body and upstream response both
    // streamed) — unchanged behavior for every non-login-type credential.
    if (!mintRetry) {
      const upstreamReq = doRequest({ ...baseRequestOptions, headers: upstreamHeaders })
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
      return
    }

    // Retry path (login-type credential): buffer the request body so it can be
    // replayed, and buffer the upstream response so its status can be inspected
    // before we commit to the client. On a 401 (stale/invalidated minted token)
    // we force a fresh mint, swap the Bearer header, and forward once more.
    const reqBody = await readRequestBody(req)

    type UpstreamResult = { status: number; headers: IncomingMessage['headers']; body: Buffer }
    const sendUpstream = (headers: Record<string, string>): Promise<UpstreamResult> =>
      new Promise<UpstreamResult>((resolve, reject) => {
        const upstreamReq = doRequest({ ...baseRequestOptions, headers })
        upstreamReq.on('response', (upstreamRes) => {
          const chunks: Buffer[] = []
          upstreamRes.on('data', (c: Buffer) => chunks.push(c))
          upstreamRes.on('end', () =>
            resolve({
              status: upstreamRes.statusCode || 502,
              headers: upstreamRes.headers,
              body: Buffer.concat(chunks),
            }),
          )
          upstreamRes.on('error', reject)
        })
        upstreamReq.on('error', reject)
        upstreamReq.on('timeout', () => {
          upstreamReq.destroy(new Error('upstream_timeout'))
        })
        if (reqBody.length > 0) upstreamReq.write(reqBody)
        upstreamReq.end()
      })

    try {
      let result = await sendUpstream(upstreamHeaders)

      // The cached minted token can be rejected two ways: a real HTTP 401, or —
      // for providers that always answer 200 — a body-level envelope such as
      // {"code":401,...} (opt-in per config item via body_auth_check). Either
      // triggers a single force-mint + retry so a lone fetchurl call self-heals.
      const httpUnauthorized = result.status === 401
      const bodyUnauthorized = bodyIndicatesUnauthorized(mintRetry.bodyAuthCheck, result.body)
      if ((httpUnauthorized || bodyUnauthorized) && this.tokenMinter) {
        const reminted = await this.tokenMinter.forceMint(mintRetry.userId, mintRetry.cfg, mintRetry.creds)
        if (reminted) {
          const reason = httpUnauthorized ? 'HTTP 401' : 'body-level 401'
          console.warn(
            `[AuthProxy] Upstream ${reason} for config item #${mintRetry.cfg.configItemId}; ` +
              're-minted token and retrying once.',
          )
          const retryInject = injectAuth({ scheme: 'bearer', secret: reminted.token })
          const retryHeaders = { ...upstreamHeaders, ...retryInject.headers }
          result = await sendUpstream(retryHeaders)
        }
      }

      // Strip hop-by-hop / length headers Node will recompute for the buffered body.
      const outHeaders: Record<string, string | string[]> = {}
      for (const [k, v] of Object.entries(result.headers)) {
        const lk = k.toLowerCase()
        if (lk === 'transfer-encoding' || lk === 'connection' || lk === 'content-length') continue
        if (v !== undefined) outHeaders[k] = v
      }
      res.writeHead(result.status, outHeaders)
      res.end(result.body)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[AuthProxy] Upstream error:', message)
      if (!res.headersSent) {
        const timedOut = message === 'upstream_timeout'
        res.writeHead(timedOut ? 504 : 502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          error: timedOut ? 'upstream_timeout' : 'upstream_error',
          message: timedOut ? 'Upstream request timed out' : message,
        }))
      }
    }
  }

  /**
   * Find the best matching rule for a URL, applying the credential-selection
   * precedence. Delegates to the pure {@link selectRuleForUrl} so the ranking
   * logic is unit-testable without the HTTP proxy. See that function for the
   * full precedence rules.
   */
  private findRuleForUrl(url: string, orgId: string): AuthProxyRule | null {
    return selectRuleForUrl(this.rules.values(), url, orgId)
  }

  /**
   * Convert glob-style URL pattern to regex and match.
   * Supports * (any chars) and ? (single char) wildcards.
   */
  private matchUrl(pattern: string, url: string): boolean {
    return matchUrlPattern(pattern, url)
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
