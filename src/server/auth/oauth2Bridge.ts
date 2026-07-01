import { spawn } from 'child_process'
import { createServerLogger, type ServerLogger } from '../serverLog.js'

/**
 * Resolved identity returned by the OAuth2 credential script.
 *
 * `accessToken` is the provider's access token, which moss stores server-side
 * (encrypted, keyed by the moss JWT jti) so it can later call provider
 * resources. It is NOT placed in the moss JWT and never reaches the client.
 *
 * Identity keys: moss looks the user up by `(orgId, extUserId)`, where `orgId`
 * is the moss organization auto-resolved from `extOrgId`. Org / dept are
 * created on first sight; renames propagate from the IdP (the moss row's
 * `name` is rewritten when `extOrgId` / `extDeptId` match but names differ).
 */
export type OAuth2Identity = {
  /** IdP's organization id (e.g. Ruigu's bizOrgCode). Required for auto-create. */
  extOrgId?: string
  /** IdP's organization display name; used when auto-creating the moss org. */
  extOrgName?: string
  /** IdP's user id within that org (e.g. Ruigu's user_id). Required. */
  extUserId: string
  /** IdP's group id (e.g. Ruigu's groupIds[0]). Optional; when absent falls
   *  back to by-name dept lookup. */
  extDeptId?: string
  /** Optional — when omitted, moss synthesizes a synthetic internal email. */
  email?: string
  expiresIn: number
  /** Provider access token — stored server-side by moss for resource access. */
  accessToken: string
  /** IdP login username (e.g. Ruigu's user_name) → moss `users.name`. When
   *  omitted, moss falls back to displayName/email for the login name. */
  username?: string
  /** IdP display name / nickname → moss `users.display_name` (shown in UIs and
   *  the agent's "who am I" identity). */
  displayName?: string
  refreshToken?: string
  /** Department display name from the IdP. With extDeptId set this is the
   *  authoritative name (existing dept gets renamed on mismatch). */
  department?: string
}

/** Refresh result is just the identity (which already carries `accessToken`). */
export type OAuth2RefreshResult = OAuth2Identity

export class OAuth2BridgeError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = 'OAuth2BridgeError'
  }
}

const SCRIPT_TIMEOUT_MS = 10_000

function coerceIdentity(raw: Record<string, unknown>): OAuth2Identity {
  const extUserId =
    typeof raw.extUserId === 'string' ? raw.extUserId.trim() : ''
  const extOrgId =
    typeof raw.extOrgId === 'string' && raw.extOrgId.trim()
      ? raw.extOrgId.trim()
      : undefined
  const extOrgName =
    typeof raw.extOrgName === 'string' && raw.extOrgName.trim()
      ? raw.extOrgName.trim()
      : undefined
  const extDeptId =
    typeof raw.extDeptId === 'string' && raw.extDeptId.trim()
      ? raw.extDeptId.trim()
      : undefined
  const email = typeof raw.email === 'string' ? raw.email.trim() : ''
  const expiresIn =
    typeof raw.expiresIn === 'number' && Number.isFinite(raw.expiresIn)
      ? Math.floor(raw.expiresIn)
      : 0
  // Accept access_token or accessToken (snake/camel) from the script.
  const accessToken =
    typeof raw.access_token === 'string'
      ? raw.access_token
      : typeof raw.accessToken === 'string'
        ? raw.accessToken
        : ''
  if (!extUserId) {
    throw new OAuth2BridgeError(401, 'OAuth2 script returned no extUserId')
  }
  // email is optional: moss synthesizes a synthetic email when it is absent.
  if (expiresIn <= 0) {
    throw new OAuth2BridgeError(401, 'OAuth2 script returned invalid expiresIn')
  }
  if (!accessToken) {
    throw new OAuth2BridgeError(401, 'OAuth2 script returned no access_token')
  }
  return {
    extOrgId,
    extOrgName,
    extUserId,
    extDeptId,
    email: email || undefined,
    expiresIn,
    accessToken,
    username:
      typeof raw.username === 'string' && raw.username.trim()
        ? raw.username.trim()
        : undefined,
    displayName:
      typeof raw.displayName === 'string' ? raw.displayName : undefined,
    refreshToken:
      typeof raw.refreshToken === 'string' ? raw.refreshToken : undefined,
    department:
      typeof raw.department === 'string' && raw.department.trim()
        ? raw.department.trim()
        : undefined,
  }
}

/**
 * Invokes the configured OAuth2 credential script. The script reads its input
 * token from an environment variable (never argv, so tokens stay out of `ps`)
 * and prints a single JSON object to stdout.
 */
export class OAuth2Bridge {
  private readonly logger: ServerLogger

  constructor(
    private readonly getScriptPath: () => string | null,
    logger?: ServerLogger,
  ) {
    this.logger = logger ?? createServerLogger()
  }

  private resolveScriptPath(): string {
    const scriptPath = this.getScriptPath()?.trim()
    if (!scriptPath) {
      throw new OAuth2BridgeError(500, 'OAuth2 credential script is not configured')
    }
    return scriptPath
  }

  /**
   * `resolve` mode: hand the deep-link params (code / access_token / …) to the
   * script, which resolves them to a user identity + provider access_token.
   */
  async resolve(params: Record<string, string>): Promise<OAuth2Identity> {
    const raw = await this.run('resolve', params)
    return coerceIdentity(raw)
  }

  /**
   * `refresh` mode: hand the refresh params (e.g. {refresh_token}) to the
   * script. Returns `null` when the script signals that refresh is unavailable
   * for this provider (exit 0 with no access_token) — the caller then ends the
   * session rather than treating it as an error.
   */
  async refresh(params: Record<string, string>): Promise<OAuth2RefreshResult | null> {
    const raw = await this.run('refresh', params)
    const accessToken =
      typeof raw.access_token === 'string'
        ? raw.access_token
        : typeof raw.accessToken === 'string'
          ? raw.accessToken
          : ''
    if (!accessToken) {
      // Provider does not support refresh (or returned nothing) — signal no-op.
      return null
    }
    return coerceIdentity(raw)
  }

  /**
   * Invoke the script in the given mode, passing the param dict as a single
   * JSON env var OAUTH2_PARAMS (never argv — keeps tokens out of `ps`).
   */
  private run(
    mode: 'resolve' | 'refresh',
    params: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const scriptPath = this.resolveScriptPath()
    return new Promise((resolve, reject) => {
      const child = spawn(scriptPath, [mode], {
        env: { ...process.env, OAUTH2_PARAMS: JSON.stringify(params) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let settled = false

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        this.logger.error(`OAuth2 script '${mode}' timed out after ${SCRIPT_TIMEOUT_MS}ms`)
        reject(new OAuth2BridgeError(504, 'OAuth2 credential service timed out'))
      }, SCRIPT_TIMEOUT_MS)

      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString()
      })
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString()
      })

      child.on('error', err => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.logger.error(`OAuth2 script '${mode}' spawn error: ${err.message}`)
        reject(new OAuth2BridgeError(500, 'Failed to invoke OAuth2 credential service'))
      })

      child.on('close', code => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (code !== 0) {
          this.logger.error(
            `OAuth2 script '${mode}' exited with code ${code}: ${stderr.trim()}`,
          )
          reject(new OAuth2BridgeError(401, 'OAuth2 authentication failed'))
          return
        }
        const parsed = parseLastJsonObject(stdout)
        if (!parsed) {
          this.logger.error(`OAuth2 script '${mode}' returned invalid JSON: ${stdout.trim()}`)
          reject(new OAuth2BridgeError(502, 'OAuth2 credential service returned invalid data'))
          return
        }
        resolve(parsed)
      })
    })
  }
}

/** Parse the last complete JSON object from possibly multi-line stdout. */
function parseLastJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const lines = trimmed.split('\n').filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]!) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // keep scanning upward
    }
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fall through
  }
  return null
}
