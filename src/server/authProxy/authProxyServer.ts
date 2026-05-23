import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http'
import { request as httpsRequest } from 'https'
import { request as httpRequest } from 'http'
import { URL } from 'url'
import { validateRemoteUrl } from './ssrfGuard.js'
import { injectAuth, injectMultiAuth, type InjectAuthResult } from './authInjectors.js'
import type { NexusClient } from '../nexus/nexusClient.js'

export interface AuthProxyRule {
  configItemId: number
  name: string
  urlPattern: string
  scheme: string
  bearerPrefix: string
  secretNamespace: string
  entries: Array<{ configKey: string; name: string; required: boolean }>
}

interface TokenEntry {
  userId: string
  departmentId: string | null
  pid: number | null
  registeredAt: number
}

interface DepartmentPolicyProvider {
  getAuthorizedConfigItemIds(departmentId: string): number[]
}

const CONTROL_HEADERS = new Set([
  'authorization', 'x-secret-namespace', 'x-secret-key', 'x-secret-scheme',
  'x-auth-scheme', 'x-remote-url', 'host', 'connection',
])

const UPSTREAM_TIMEOUT_MS = 30_000
const AUTH_PROXY_PORT = 12013

export class AuthProxyServer {
  private server: Server | null = null
  private readonly tokenRegistry = new Map<string, TokenEntry>()
  private rules = new Map<number, AuthProxyRule>()
  private nexusClient: NexusClient | null = null
  private policyProvider: DepartmentPolicyProvider | null = null

  constructor() {}

  setNexusClient(client: NexusClient): void {
    this.nexusClient = client
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

  registerToken(token: string, userId: string, departmentId: string | null, pid: number | null): void {
    this.tokenRegistry.set(token, { userId, departmentId, pid, registeredAt: Date.now() })
  }

  revokeToken(token: string): void {
    this.tokenRegistry.delete(token)
  }

  isValidToken(token: string): boolean {
    return this.tokenRegistry.has(token)
  }

  async start(): Promise<void> {
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

      this.server.listen(AUTH_PROXY_PORT, '127.0.0.1', () => {
        console.log(`[AuthProxy] Listening on 127.0.0.1:${AUTH_PROXY_PORT}`)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
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

    if (req.url !== '/proxy' || req.method !== 'POST') {
      if (req.method === 'GET' && req.url === '/') {
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
      // Priority 2: URL pattern matching (longest path first)
      const match = this.findRuleForUrl(remoteUrl)
      if (!match) {
        // No matching rule found — reject request
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'no_matching_rule', message: 'No matching secret configuration found for this URL' }))
        return
      }

      // 4. Department policy check
      if (tokenEntry.departmentId && this.policyProvider) {
        const authorizedIds = this.policyProvider.getAuthorizedConfigItemIds(tokenEntry.departmentId)
        if (!authorizedIds.includes(match.configItemId)) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'rejected_no_policy', message: 'Department not authorized for this resource' }))
          return
        }
      }

      matchedConfigItemId = match.configItemId

      // 5. Resolve secrets from Nexus
      const secrets: Array<{ configKey: string; value: string }> = []
      for (const entry of match.entries) {
        if (this.nexusClient) {
          try {
            const secret = await this.nexusClient.getSecret(match.secretNamespace, entry.configKey, tokenEntry.userId)
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

      if (['bearer', 'basic'].includes(match.scheme)) {
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
      method: req.method,
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
  private findRuleForUrl(url: string): AuthProxyRule | null {
    let bestMatch: AuthProxyRule | null = null
    let bestLength = -1
    let bestId = -1

    for (const rule of this.rules.values()) {
      if (!rule.urlPattern) continue
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
