import { randomUUID } from 'crypto'
import type { DatabaseSync } from 'node:sqlite'
import { hasScope, issueAccessToken, issueWikiSessionToken, verifyAccessToken, type AuthContext } from './token.js'
import { OAuth2Bridge, OAuth2BridgeError, type OAuth2Identity } from './oauth2Bridge.js'
import { buildVisibilityFilter, getUserAncestorIds } from '../visibilityFilter.js'
import { getSystemSettings } from '../systemSettings.js'
import {
  AuthCenterDb,
  type AuthCenterApiKey,
  type AuthCenterBootstrap,
  type AuthCenterDepartment,
  type AuthCenterOrganization,
  type BootstrapAdminConfig,
  type AuthCenterUser,
  type SanitizedAuthCenterDepartment,
  type SanitizedAuthCenterUser,
  createApiKeyRecord,
  createSyntheticUserEmail,
  hashPassword,
  sanitizeApiKey,
  sanitizeUser,
  verifyPassword,
} from '../authCenter/db.js'

export type AuthRole = 'super_admin' | 'admin' | 'dept_admin' | 'user'

/**
 * The human-facing name for a user: the optional `displayName` when set,
 * otherwise the login `name` (username). Used for the outgoing login-response
 * `user.name`, `getUserName`, and the agent's "who am I" identity — so clients
 * and the agent see e.g. `数牍技术01` while login still matches the username.
 */
function resolveDisplayName(user: { name: string; displayName?: string | null }): string {
  return user.displayName?.trim() || user.name
}

/**
 * Roles that carry full administrative capability (wildcard scope, cross-org
 * actor resolution, no department-visibility filtering). `super_admin` is a
 * strict superset of `admin`: it additionally may switch its effective org and
 * mint/edit other `super_admin` accounts. Everything that previously checked
 * `role === 'admin'` for *capability* should check membership here instead.
 */
const ADMIN_ROLES = new Set<string>(['admin', 'super_admin'])

function isSuperAdmin(role: string): boolean {
  return role === 'super_admin'
}

export type AuthServiceOptions = {
  db: DatabaseSync
  dbPath: string
  tokenTtlSec: number
  bootstrapAdmin: BootstrapAdminConfig
}

export class AuthServiceError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = 'AuthServiceError'
  }
}

function toAuthServiceError(error: unknown): AuthServiceError {
  if (error instanceof AuthServiceError) {
    return error
  }
  if (error instanceof OAuth2BridgeError) {
    return new AuthServiceError(error.statusCode, error.message)
  }
  return new AuthServiceError(500, 'OAuth2 authentication failed')
}

/**
 * Run a DAO write and translate the SQLite partial-UNIQUE constraint
 * violation for one of the ext_* columns into a clean 409. Used by the
 * org/user/dept mutators since the partial UNIQUEs (users_ext_uniq,
 * departments_ext_uniq, organizations_ext_uniq) are the authoritative
 * source of truth for ext-id uniqueness.
 */
function withExtIdConflict<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/UNIQUE constraint failed: users\.org_id, users\.ext_user_id/i.test(msg)) {
      throw new AuthServiceError(409, 'External user id already exists in this organization')
    }
    if (/UNIQUE constraint failed: departments\.org_id, departments\.ext_dept_id/i.test(msg)) {
      throw new AuthServiceError(409, 'External department id already exists in this organization')
    }
    if (/UNIQUE constraint failed: organizations\.ext_org_id/i.test(msg)) {
      throw new AuthServiceError(409, 'External organization id already exists')
    }
    throw err
  }
}

function defaultScopesForRole(role: string): string[] {
  if (role === 'admin' || role === 'super_admin') {
    return ['*']
  }
  if (role === 'dept_admin') {
    return [
      'sessions:create',
      'sessions:attach',
      'sessions:list',
      'admin:users',
      'admin:api_keys',
      'admin:secrets',
      'admin:mcp',
      'admin:mcp:write',
      'admin:mcp:audit',
    ]
  }
  return ['sessions:create', 'sessions:attach', 'sessions:list']
}

const DEFAULT_SCOPES_FOR_USER_ROLE = defaultScopesForRole('user')

async function initializeStore(
  db: AuthCenterDb,
  bootstrapAdmin: BootstrapAdminConfig,
): Promise<AuthCenterBootstrap> {
  if (!db.isInitialized()) {
    return db.bootstrap(bootstrapAdmin)
  }

  return db.ensureBootstrapAdmin(bootstrapAdmin)
}

function isAuthRole(value: string): value is AuthRole {
  return (
    value === 'super_admin' ||
    value === 'admin' ||
    value === 'dept_admin' ||
    value === 'user'
  )
}

function isUserStatus(value: string): value is 'active' | 'disabled' {
  return value === 'active' || value === 'disabled'
}

export async function createAuthService(
  options: AuthServiceOptions,
): Promise<{
  service: AuthService
  bootstrap: AuthCenterBootstrap
}> {
  const db = new AuthCenterDb(options.db, options.dbPath)
  const bootstrap = await initializeStore(
    db,
    options.bootstrapAdmin,
  )
  return {
    service: new AuthService(db, options.tokenTtlSec),
    bootstrap,
  }
}

const REVOKED_TOKENS_CLEANUP_INTERVAL_MS = 60 * 60 * 1000

export class AuthService {
  private readonly cleanupTimer: ReturnType<typeof setInterval>
  private readonly oauth2Bridge: OAuth2Bridge

  constructor(
    private readonly db: AuthCenterDb,
    private readonly tokenTtlSec: number,
  ) {
    this.cleanupTimer = setInterval(() => {
      this.db.cleanupExpiredRevokedTokens()
    }, REVOKED_TOKENS_CLEANUP_INTERVAL_MS)
    this.cleanupTimer.unref?.()
    this.oauth2Bridge = new OAuth2Bridge(() => getSystemSettings().oauth2.scriptPath || null)
  }

  destroy(): void {
    clearInterval(this.cleanupTimer)
  }

  verifyAccessToken(token: string): AuthContext | null {
    const auth = verifyAccessToken(token, this.db.getJwtSecret(), this.db.getIssuer())
    if (!auth) {
      return null
    }
    if (this.db.isTokenRevoked(auth.jti)) {
      return null
    }
    return auth
  }

  logout(accessToken: string, refreshToken?: string): void {
    const access = verifyAccessToken(accessToken, this.db.getJwtSecret(), this.db.getIssuer(), 'access')
    if (access) {
      this.db.revokeToken(access.jti, access.exp)
      // Drop the user's stored provider token. Provider tokens are now keyed by
      // user_id (one per user), so this clears it for all of the user's sessions.
      this.db.deleteProviderToken(access.userId)
    }

    if (refreshToken) {
      const refresh = verifyAccessToken(refreshToken, this.db.getJwtSecret(), this.db.getIssuer(), 'refresh')
      if (refresh) {
        this.db.revokeToken(refresh.jti, refresh.exp)
      }
    }

    this.db.cleanupExpiredRevokedTokens()
  }

  refreshToken(token: string): {
    access_token: string
    refresh_token: string
    token_type: 'Bearer'
    expires_in: number
    user: SanitizedAuthCenterUser
    organization: { id: string; name: string; createdAt: number } | null
    scopes: string[]
  } {
    
    const auth = verifyAccessToken(token, this.db.getJwtSecret(), this.db.getIssuer(), 'refresh')
    if (!auth || this.db.isTokenRevoked(auth.jti)) {
      throw new AuthServiceError(401, 'Invalid refresh token')
    }

    const user = this.db.getUserByIdAndOrg(auth.userId, auth.orgId)
    if (!user || user.status !== 'active') {
      throw new AuthServiceError(401, 'User is invalid')
    }

    return this.issueToken({
      user,
      scopes: auth.scopes,
      keyId: auth.keyId,
    })
  }

  introspect(token: string): {
    active: boolean
    sub?: string
    org_id?: string
    role?: string
    scopes?: string[]
    key_id?: string
  } {
    const auth = this.verifyAccessToken(token)
    if (!auth) {
      return { active: false }
    }
    return {
      active: true,
      sub: auth.userId,
      org_id: auth.orgId,
      role: auth.role,
      scopes: auth.scopes,
      key_id: auth.keyId,
    }
  }

  issueTokenFromPassword(input: {
    username?: string
    email?: string
    password: string
  }): {
    access_token: string
    refresh_token: string
    token_type: 'Bearer'
    expires_in: number
    user: SanitizedAuthCenterUser
    organization: { id: string; name: string; createdAt: number } | null
    scopes: string[]
  } {
    const username = input.username?.trim() || ''
    const email = input.email?.trim() || ''
    if ((!username && !email) || !input.password) {
      throw new AuthServiceError(400, 'Missing username/email or password')
    }

    const user = username
      ? this.getUniqueUserByName(username)
      : this.db.getUserByEmail(email)
    if (
      !user ||
      user.status !== 'active' ||
      !verifyPassword(input.password, user.passwordHash)
    ) {
      throw new AuthServiceError(401, 'Invalid username/email or password')
    }

    this.db.updateUserLastLogin(user.id)
    return this.issueToken({
      user,
      scopes: defaultScopesForRole(user.role),
      keyId: 'password-login',
    })
  }

  issueTokenFromApiKey(apiKeyValue: string): {
    access_token: string
    refresh_token: string
    token_type: 'Bearer'
    expires_in: number
    user: SanitizedAuthCenterUser
    organization: { id: string; name: string; createdAt: number } | null
    scopes: string[]
  } {
    const value = apiKeyValue.trim()
    if (!value) {
      throw new AuthServiceError(400, 'Missing api_key')
    }

    const apiKey = this.db.findActiveApiKey(value)
    if (!apiKey) {
      throw new AuthServiceError(401, 'Invalid API key')
    }

    const user = this.db.getUserById(apiKey.userId)
    const organization = this.db.getOrganization(apiKey.orgId)
    if (!user || user.status !== 'active' || !organization) {
      throw new AuthServiceError(401, 'API key owner is invalid')
    }

    this.db.updateApiKeyLastUsed(apiKey.id)
    return this.issueToken({
      user,
      scopes: apiKey.scopes,
      keyId: apiKey.id,
    })
  }

  /**
   * OAuth2 login: resolve the provider access_token to a moss user (creating or
   * linking as needed), then issue a wrapper JWT whose lifetime equals the
   * provider token's `expiresIn`. The provider's refresh_token is NOT stored on
   * moss — the client holds it and replays it via `oauth2_refresh_token`.
   */
  async issueTokenFromOAuth2(input: { params: Record<string, string> }): Promise<{
    access_token: string
    refresh_token: string
    token_type: 'Bearer'
    expires_in: number
    user: SanitizedAuthCenterUser
    organization: { id: string; name: string; createdAt: number } | null
    scopes: string[]
  }> {
    let identity: OAuth2Identity
    try {
      identity = await this.oauth2Bridge.resolve(input.params)
    } catch (error) {
      throw toAuthServiceError(error)
    }
    const { user, scopes } = this.applyScriptIdentity(identity)
    this.db.updateUserLastLogin(user.id)
    const issued = this.issueToken({
      user,
      scopes,
      keyId: 'oauth2-login',
      accessTtlSec: identity.expiresIn,
    })
    // Stash the provider access_token server-side, keyed by user_id, so moss
    // (and runtime sessions via the corpauth CLI) can call provider resources
    // later. expiry == the provider token's own lifetime. The provider
    // refresh_token is NOT stored here — the client holds it (symmetric with
    // other login types).
    this.storeProviderToken(
      user.id,
      identity.accessToken,
      Math.floor(Date.now() / 1000) + identity.expiresIn,
    )
    // Echo the provider refresh_token so the client can persist it.
    return { ...issued, refresh_token: identity.refreshToken ?? '' }
  }

  /**
   * OAuth2 refresh: replay the provider refresh params (the client holds the
   * provider refresh_token and sends it back) through the credential script to
   * obtain a fresh provider access_token + identity, re-sync the moss user, and
   * issue a new wrapper JWT. The (possibly rotated) provider refresh_token is
   * echoed back so the client can update its storage.
   */
  async refreshOAuth2Token(input: { params: Record<string, string> }): Promise<{
    access_token: string
    refresh_token: string
    token_type: 'Bearer'
    expires_in: number
    user: SanitizedAuthCenterUser
    organization: { id: string; name: string; createdAt: number } | null
    scopes: string[]
  }> {
    let result
    try {
      result = await this.oauth2Bridge.refresh(input.params)
    } catch (error) {
      throw toAuthServiceError(error)
    }
    // Provider does not support refresh: end the session so the client re-logs in.
    if (!result) {
      throw new AuthServiceError(401, 'OAuth2 session cannot be refreshed; please sign in again')
    }
    const { user, scopes } = this.applyScriptIdentity(result)
    this.db.updateUserLastLogin(user.id)
    const issued = this.issueToken({
      user,
      scopes,
      keyId: 'oauth2-login',
      accessTtlSec: result.expiresIn,
    })
    // Store the rotated provider access_token (overwrites the user's row).
    this.storeProviderToken(
      user.id,
      result.accessToken,
      Math.floor(Date.now() / 1000) + result.expiresIn,
    )
    // Echo the (possibly rotated) provider refresh_token so the client persists it.
    const echoedRefresh = result.refreshToken ?? input.params.refresh_token ?? ''
    return { ...issued, refresh_token: echoedRefresh }
  }

  /**
   * Persist a provider access_token keyed by user_id, with expiry equal to the
   * provider token's own lifetime. Keying by user_id (rather than the login
   * JWT's jti) lets any of the user's sessions — including a runtime
   * container's SESSION_TOKEN — resolve it, and makes a mid-session refresh
   * overwrite the same row. `expiresAt` is an absolute Unix-seconds timestamp.
   */
  private storeProviderToken(userId: string, providerAccessToken: string, expiresAt: number): void {
    this.db.putProviderToken(userId, providerAccessToken, expiresAt)
  }

  /** Recover the provider access_token for a user, or null if absent/expired. */
  getProviderTokenForUser(userId: string): { token: string; expiresAt: number } | null {
    return this.db.getProviderToken(userId)
  }

  /**
   * Minimal per-(user, service) minted-token store for the auth proxy's
   * TokenMinter. Exposes just the cache get/put over the encrypted
   * minted_service_tokens table without leaking the AuthCenterDb handle.
   */
  getMintedTokenStore(): {
    getMintedToken(userId: string, configItemId: number): { token: string; expiresAt: number } | null
    putMintedToken(userId: string, configItemId: number, token: string, expiresAt: number): void
  } {
    return {
      getMintedToken: (userId, configItemId) => this.db.getMintedToken(userId, configItemId),
      putMintedToken: (userId, configItemId, token, expiresAt) =>
        this.db.putMintedToken(userId, configItemId, token, expiresAt),
    }
  }

  /**
   * Find-or-link a user for an OAuth2 identity and apply the IdP-authoritative
   * org / department / scopes. New lookup contract (IdP-authoritative,
   * multi-tenant):
   *   1. Org by `extOrgId` → auto-create if missing (was: fail; only by-name).
   *   2. User by `(orgId, extUserId)`; if miss AND email is real, attempt
   *      email-link only when the target moss user has `extUserId == null`
   *      AND `localAuth == false` (so local-auth users — incl. the bootstrap
   *      admin — never get silently pulled into an IdP org).
   *   3. Dept by `(orgId, extDeptId)` when extDeptId set: rename existing
   *      row's name if it drifted from the IdP. Otherwise fall back to the
   *      legacy by-name resolve-or-create.
   * Org, dept name, and dept membership are re-synced on every login.
   */
  private applyScriptIdentity(identity: OAuth2Identity): {
    user: AuthCenterUser
    scopes: string[]
  } {
    // ── 1. Org resolution ─────────────────────────────────────────────────
    let targetOrg: AuthCenterOrganization | null = null
    if (identity.extOrgId) {
      targetOrg = this.db.getOrganizationByExtId(identity.extOrgId)
      const incomingOrgName = identity.extOrgName?.trim() || ''
      if (!targetOrg) {
        const orgId = randomUUID()
        const orgName = incomingOrgName || `org-${identity.extOrgId}`
        const createdAt = Date.now()
        try {
          this.db.createOrganization(orgId, orgName, createdAt, identity.extOrgId)
          targetOrg = {
            id: orgId,
            name: orgName,
            extOrgId: identity.extOrgId,
            createdAt,
          }
        } catch (err) {
          // Race: another concurrent OAuth2 login created the same org first.
          // Re-read and continue with whichever row won.
          const msg = err instanceof Error ? err.message : String(err)
          if (/UNIQUE constraint failed: organizations\.ext_org_id/i.test(msg)) {
            targetOrg = this.db.getOrganizationByExtId(identity.extOrgId)
          }
          if (!targetOrg) throw err
        }
      } else if (incomingOrgName && incomingOrgName !== targetOrg.name) {
        // IdP-authoritative rename. Empty incoming value preserves the moss
        // row's name so a momentarily-missing IdP field doesn't clobber.
        try {
          this.db.updateOrganization(targetOrg.id, { name: incomingOrgName })
          targetOrg = { ...targetOrg, name: incomingOrgName }
        } catch {
          // A naming collision with another moss org is non-fatal here —
          // login proceeds with the stale name.
        }
      }
    }
    if (!targetOrg) {
      // Legacy fallback for IdPs that don't send extOrgId: use the existing
      // user's org if we can find one later, otherwise the first org.
      targetOrg = this.db.listOrganizations()[0] ?? null
    }
    if (!targetOrg) {
      throw new AuthServiceError(500, 'No organization available for OAuth2 user')
    }

    // ── 2. User resolution ────────────────────────────────────────────────
    const realEmail = identity.email?.trim() || ''
    const isSynthetic = realEmail.length === 0
    const email = realEmail || createSyntheticUserEmail(`oauth2-${identity.extUserId}`)

    let user = this.db.getUserByExtId(targetOrg.id, identity.extUserId)

    if (!user && !isSynthetic) {
      // Email-link guard: only link when the existing row has never been
      // claimed by any IdP AND isn't a local-auth (password) user. This keeps
      // the bootstrap admin@local from being pulled into a Ruigu org by an
      // accidental email collision, and protects manually-created password
      // users from silent IdP-takeover.
      const byEmail = this.db.getUserByEmail(email)
      if (byEmail && byEmail.extUserId == null && !byEmail.localAuth) {
        const patch: { extUserId: string; orgId?: string } = {
          extUserId: identity.extUserId,
        }
        if (byEmail.orgId !== targetOrg.id) patch.orgId = targetOrg.id
        this.db.updateUser(byEmail.id, patch)
        user = this.db.getUserById(byEmail.id)
      }
    }

    if (!user) {
      const userId = randomUUID()
      const createdAt = Date.now()
      const newUser: AuthCenterUser = {
        id: userId,
        orgId: targetOrg.id,
        email,
        // Login username from the IdP's `username`. Fall back to the legacy
        // `displayName` (older scripts only emitted that) or email so existing
        // integrations keep working. The friendly name goes to displayName.
        name: identity.username?.trim() || identity.displayName?.trim() || email,
        displayName: identity.displayName?.trim() || null,
        departmentId: null,
        role: 'user',
        status: 'active',
        localAuth: false,
        tokenLimit: null,
        createdAt,
        passwordHash: null,
        passwordUpdatedAt: null,
        lastLoginAt: null,
        extUserId: identity.extUserId,
      }
      try {
        this.db.createUser(newUser)
        user = newUser
      } catch (err) {
        // Race: concurrent login created the same user. Re-read.
        const msg = err instanceof Error ? err.message : String(err)
        if (/UNIQUE constraint failed: users\.org_id, users\.ext_user_id/i.test(msg)) {
          user = this.db.getUserByExtId(targetOrg.id, identity.extUserId)
        }
        if (!user) throw err
      }
    } else {
      // Existing user: re-sync IdP-authoritative profile fields (org membership,
      // username, display name, email) if any drifted. Empty IdP values are
      // guards — a momentarily-missing IdP field won't clobber the moss row.
      const profilePatch: { orgId?: string; name?: string; displayName?: string; email?: string } = {}
      if (user.orgId !== targetOrg.id) profilePatch.orgId = targetOrg.id

      // Login username drift (IdP `username`).
      const incomingName = identity.username?.trim() || ''
      if (incomingName && incomingName !== user.name) {
        profilePatch.name = incomingName
      }
      // Display name drift (IdP `displayName`/nickname).
      const incomingDisplay = identity.displayName?.trim() || ''
      if (incomingDisplay && incomingDisplay !== user.displayName) {
        profilePatch.displayName = incomingDisplay
      }

      // Email: only re-sync when the incoming email is real (non-synthetic).
      // The stored email may itself be synthetic (created when the IdP didn't
      // supply one) — upgrading to a real email on the next login is the
      // desired behaviour. Catches collisions with the global email UNIQUE.
      if (!isSynthetic && email !== user.email) {
        try {
          this.db.updateUser(user.id, { ...profilePatch, email })
          user = { ...user, ...profilePatch, email }
        } catch (err) {
          // Email collision with another moss user: log-and-continue rather
          // than fail the login. Profile patch (name / orgId) still applies.
          const msg = err instanceof Error ? err.message : String(err)
          if (/UNIQUE constraint failed: users\.email/i.test(msg)) {
            if (Object.keys(profilePatch).length > 0) {
              this.db.updateUser(user.id, profilePatch)
              user = { ...user, ...profilePatch }
            }
          } else {
            throw err
          }
        }
      } else if (Object.keys(profilePatch).length > 0) {
        this.db.updateUser(user.id, profilePatch)
        user = { ...user, ...profilePatch }
      }
    }

    // ── 3. Department resolution ──────────────────────────────────────────
    let departmentId: string | null = null
    if (identity.extDeptId) {
      const existingDept = this.db.getDepartmentByExtId(targetOrg.id, identity.extDeptId)
      const intendedName = identity.department?.trim() || `dept-${identity.extDeptId}`
      if (existingDept) {
        // IdP-authoritative rename. Don't renest (IdP path stays flat —
        // parent_id NULL). May create same-named siblings; acceptable since
        // by-extDeptId lookup runs first for IdP-managed depts.
        if (existingDept.name !== intendedName) {
          this.db.updateDepartment(existingDept.id, { name: intendedName })
        }
        departmentId = existingDept.id
      } else {
        const timestamp = Date.now()
        const dept: AuthCenterDepartment = {
          id: randomUUID(),
          orgId: targetOrg.id,
          parentId: null,
          name: intendedName,
          extDeptId: identity.extDeptId,
          tokenLimit: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        }
        try {
          this.db.createDepartment(dept)
          departmentId = dept.id
        } catch (err) {
          // Race: concurrent login created the same dept. Re-read.
          const msg = err instanceof Error ? err.message : String(err)
          if (/UNIQUE constraint failed: departments\.org_id, departments\.ext_dept_id/i.test(msg)) {
            const existing = this.db.getDepartmentByExtId(targetOrg.id, identity.extDeptId)
            if (existing) departmentId = existing.id
            else throw err
          } else {
            throw err
          }
        }
      }
    } else if (identity.department) {
      departmentId = this.resolveOrCreateDepartment(targetOrg.id, identity.department).id
    }

    if (user.departmentId !== departmentId) {
      this.db.updateUser(user.id, { departmentId })
      user = { ...user, departmentId }
    }

    if (user.status !== 'active') {
      throw new AuthServiceError(403, 'User account is disabled')
    }

    // moss JWT scopes are moss's own permission vocabulary, derived from the
    // user's role — identical to the password/api_key paths. The provider's
    // OAuth2 scope (e.g. "server") is a different vocabulary meant for the
    // provider's own APIs and must NOT leak into moss's authorization claim.
    const scopes = defaultScopesForRole(user.role)
    return { user, scopes }
  }

  /**
   * Resolve a top-level department by name within an org, creating it if absent.
   * Used only by the legacy OAuth2 path that has no extDeptId. Mirrors the
   * admin createDepartment write path but is idempotent (no 409), since
   * OAuth2 login re-runs on every authentication.
   */
  private resolveOrCreateDepartment(orgId: string, name: string): AuthCenterDepartment {
    const trimmed = name.trim()
    const existing = this.findSiblingDepartment(orgId, null, trimmed)
    if (existing) {
      return existing
    }
    const timestamp = Date.now()
    const department: AuthCenterDepartment = {
      id: randomUUID(),
      orgId,
      parentId: null,
      name: trimmed,
      extDeptId: null,
      tokenLimit: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.db.createDepartment(department)
    return department
  }

  getMe(auth: AuthContext): {
    user: SanitizedAuthCenterUser | null
    organization: { id: string; name: string; createdAt: number } | null
    scopes: string[]
    role: string
    key_id: string
    isSuperAdmin: boolean
  } {
    // Resolve the actor by id so a super_admin who has switched into a foreign
    // org still returns their own profile. `organization` reflects the
    // currently-selected org (auth.orgId), which is what the UI should show.
    const actor = this.db.getUserById(auth.userId)
    return {
      user: actor ? sanitizeUser(actor) : null,
      organization: this.db.getOrganization(auth.orgId),
      scopes: auth.scopes,
      role: auth.role,
      key_id: auth.keyId,
      isSuperAdmin: isSuperAdmin(actor?.role ?? auth.role),
    }
  }

  /**
   * Super-admin-only: re-issue this actor's tokens scoped to a different org so
   * every org-scoped endpoint (which reads auth.orgId) serves the selected
   * org's resources. The actor identity (sub) and role/scopes are unchanged;
   * only org_id moves. Returns the same shape as a login response.
   */
  switchOrg(auth: AuthContext, targetOrgId: string): {
    access_token: string
    refresh_token: string
    token_type: 'Bearer'
    expires_in: number
    user: SanitizedAuthCenterUser
    organization: { id: string; name: string; createdAt: number } | null
    scopes: string[]
  } {
    const actor = this.requireAuthUser(auth)
    if (!isSuperAdmin(actor.role)) {
      throw new AuthServiceError(403, 'Only a super admin can switch organization')
    }
    const orgId = targetOrgId.trim()
    if (!orgId || !this.db.getOrganization(orgId)) {
      throw new AuthServiceError(400, 'Unknown target organization')
    }
    return this.issueToken({
      user: actor,
      scopes: auth.scopes,
      keyId: auth.keyId,
      orgIdOverride: orgId,
    })
  }

  listUsers(
    orgId: string,
    auth?: AuthContext,
  ): {
    users: SanitizedAuthCenterUser[]
  } {
    return {
      users: this.listVisibleUsers(orgId, auth).map(user => sanitizeUser(user)),
    }
  }

  listDepartments(
    orgId: string,
    auth?: AuthContext,
  ): {
    departments: SanitizedAuthCenterDepartment[]
  } {
    const userCountByDepartment = this.listVisibleUsers(orgId, auth).reduce(
      (counts, user) => {
        if (user.departmentId) {
          counts.set(user.departmentId, (counts.get(user.departmentId) ?? 0) + 1)
        }
        return counts
      },
      new Map<string, number>(),
    )

    const visibleDepartmentIds = this.getVisibleDepartmentIds(orgId, auth)
    const visibleDepartments = this.db.listDepartmentsByOrg(orgId).filter(department =>
      visibleDepartmentIds === null ? true : visibleDepartmentIds.has(department.id),
    )

    return {
      departments: visibleDepartments.map(department => ({
        ...department,
        userCount: userCountByDepartment.get(department.id) ?? 0,
      })),
    }
  }

  // ── Organization CRUD ───────────────────────────────────────────────────
  // Multi-tenancy was always in the schema; these methods surface it through
  // the admin UI for the first time. Org delete relies on the SQL FK
  // constraint to reject non-empty orgs (PRAGMA foreign_keys=ON in db.ts);
  // we translate that SQLite error into a clean 409 here.

  listAllOrganizations(): {
    organizations: Array<AuthCenterOrganization & {
      userCount: number
      departmentCount: number
    }>
  } {
    return {
      organizations: this.db.listOrganizations().map(org => ({
        ...org,
        userCount: this.db.countUsersByOrg(org.id),
        departmentCount: this.db.countDepartmentsByOrg(org.id),
      })),
    }
  }

  createOrganization(input: {
    name: string
    extOrgId?: string | null
  }): {
    organization: AuthCenterOrganization & { userCount: number; departmentCount: number }
  } {
    const name = input.name.trim()
    const extOrgId = input.extOrgId?.trim() || null
    if (!name) {
      throw new AuthServiceError(400, 'Missing organization name')
    }
    // Org name uniqueness has no SQL constraint (the column isn't unique),
    // so this check is the source of truth. extOrgId uniqueness is enforced
    // by the SQL partial UNIQUE (organizations_ext_uniq) — caught below.
    if (this.db.getOrganizationByName(name)) {
      throw new AuthServiceError(409, 'Organization name already exists')
    }
    const id = randomUUID()
    const createdAt = Date.now()
    withExtIdConflict(() => this.db.createOrganization(id, name, createdAt, extOrgId))
    return {
      organization: { id, name, extOrgId, createdAt, userCount: 0, departmentCount: 0 },
    }
  }

  updateOrganization(input: {
    orgId: string
    name?: string
    extOrgId?: string | null
  }): {
    organization: AuthCenterOrganization & { userCount: number; departmentCount: number }
  } {
    const org = this.db.getOrganization(input.orgId)
    if (!org) {
      throw new AuthServiceError(404, 'Unknown organization')
    }
    const patch: { name?: string; extOrgId?: string | null } = {}
    if (typeof input.name === 'string') {
      const name = input.name.trim()
      if (!name) {
        throw new AuthServiceError(400, 'Organization name cannot be empty')
      }
      if (name !== org.name) {
        const conflict = this.db.getOrganizationByName(name)
        if (conflict && conflict.id !== org.id) {
          throw new AuthServiceError(409, 'Organization name already exists')
        }
        patch.name = name
      }
    }
    if (input.extOrgId !== undefined) {
      const extOrgId = input.extOrgId?.trim() || null
      if (extOrgId !== org.extOrgId) {
        // extOrgId conflicts get caught by the partial UNIQUE in withExtIdConflict.
        patch.extOrgId = extOrgId
      }
    }
    if (patch.name === undefined && patch.extOrgId === undefined) {
      throw new AuthServiceError(400, 'Missing organization update fields')
    }
    withExtIdConflict(() => this.db.updateOrganization(org.id, patch))
    const updated = this.db.getOrganization(org.id) ?? org
    return {
      organization: {
        ...updated,
        userCount: this.db.countUsersByOrg(updated.id),
        departmentCount: this.db.countDepartmentsByOrg(updated.id),
      },
    }
  }

  deleteOrganization(input: { orgId: string }): { ok: true } {
    const org = this.db.getOrganization(input.orgId)
    if (!org) {
      throw new AuthServiceError(404, 'Unknown organization')
    }
    try {
      this.db.deleteOrganization(org.id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/FOREIGN KEY constraint failed/i.test(msg)) {
        throw new AuthServiceError(
          409,
          'Cannot delete organization: users or departments still reference it',
        )
      }
      throw err
    }
    return { ok: true }
  }

  listRoles(): {
    roles: Array<{
      id: AuthRole
      name: string
      description: string
      scopes: string[]
    }>
  } {
    return {
      roles: [
        {
          id: 'super_admin',
          name: '超级管理员',
          description: '可跨组织查看与管理资源，并指定其他超级管理员。',
          scopes: ['*'],
        },
        {
          id: 'admin',
          name: '系统管理员',
          description: '可管理整个组织、部门、用户、会话和系统设置。',
          scopes: ['*'],
        },
        {
          id: 'dept_admin',
          name: '部门管理员',
          description: '可在后台管理部门内用户并代为生成 API Key。',
          scopes: defaultScopesForRole('dept_admin'),
        },
        {
          id: 'user',
          name: '普通用户',
          description: '具备基础会话创建与接入能力。',
          scopes: defaultScopesForRole('user'),
        },
      ],
    }
  }

  getUserOrNull(
    userId: string,
    orgId: string,
    auth?: AuthContext,
  ): SanitizedAuthCenterUser | null {
    const user = this.db.getUserByIdAndOrg(userId, orgId)
    if (!user) {
      return null
    }
    if (!this.canViewUser(user, auth)) {
      return null
    }
    return sanitizeUser(user)
  }

  /** Get user status by userId only (no orgId or permission check). Used by userStatusCache. */
  getUserById(userId: string): { status: string; departmentId: string | null } | null {
    const user = this.db.getUserById(userId)
    if (!user) return null
    return { status: user.status || 'active', departmentId: user.departmentId ?? null }
  }

  getUserName(userId: string): string | undefined {
    const user = this.db.getUserById(userId)
    return user ? resolveDisplayName(user) : undefined
  }

  createUser(input: {
    orgId: string
    email?: string
    name: string
    displayName?: string | null
    departmentId?: string | null
    role: string
    password: string
    extUserId?: string | null
  }, auth?: AuthContext): {
    user: SanitizedAuthCenterUser
  } {
    const email = input.email?.trim() || ''
    const name = input.name.trim()
    const displayName = input.displayName?.trim() || null
    const departmentId = input.departmentId?.trim() || null
    const role = input.role.trim()
    const extUserId = input.extUserId?.trim() || null
    if (!name || !input.password) {
      throw new AuthServiceError(400, 'Missing name or password')
    }
    if (!isAuthRole(role)) {
      throw new AuthServiceError(400, `Unsupported role: ${role}`)
    }
    if (role === 'dept_admin' && !departmentId) {
      throw new AuthServiceError(400, 'Department admin must be assigned to a department')
    }
    if (departmentId && !this.db.getDepartmentByIdAndOrg(departmentId, input.orgId)) {
      throw new AuthServiceError(400, 'Unknown department_id')
    }
    // Only a super_admin may create a super_admin (req 5).
    this.assertCanManageSuperAdminTarget(null, role, auth)
    this.assertCanManageUserMutation(
      input.orgId,
      {
        role,
        departmentId,
      },
      auth,
    )

    if (email) {
      const existingUser = this.db.getUserByEmail(email)
      if (existingUser) {
        throw new AuthServiceError(409, 'User email already exists')
      }
    }
    if (this.db.listUsersByName(name).length > 0) {
      throw new AuthServiceError(409, 'Username already exists')
    }
    // extUserId uniqueness is enforced by the partial UNIQUE
    // (users_ext_uniq); the constraint violation is translated to 409 below.

    const createdAt = Date.now()
    const userId = randomUUID()
    const user: AuthCenterUser = {
      id: userId,
      orgId: input.orgId,
      email: email || createSyntheticUserEmail(userId),
      name,
      displayName,
      departmentId,
      role,
      status: 'active',
      localAuth: true,
      tokenLimit: null,
      createdAt,
      passwordHash: hashPassword(input.password),
      passwordUpdatedAt: createdAt,
      lastLoginAt: null,
      extUserId,
    }
    withExtIdConflict(() => this.db.createUser(user))
    return { user: sanitizeUser(user) }
  }

  updateUser(input: {
    orgId: string
    userId: string
    name?: string
    displayName?: string | null
    departmentId?: string | null
    role?: string
    status?: string
    targetOrgId?: string
    extUserId?: string | null
  }, auth?: AuthContext): {
    user: SanitizedAuthCenterUser
  } {
    const user = this.db.getUserByIdAndOrg(input.userId, input.orgId)
    if (!user) {
      throw new AuthServiceError(404, 'Unknown user_id')
    }

    const patch: {
      name?: string
      displayName?: string | null
      departmentId?: string | null
      role?: AuthRole
      status?: 'active' | 'disabled'
      extUserId?: string | null
    } = {}

    if (typeof input.name === 'string') {
      const name = input.name.trim()
      if (!name) {
        throw new AuthServiceError(400, 'Name cannot be empty')
      }
      const conflictingUsers = this.db
        .listUsersByName(name)
        .filter(existingUser => existingUser.id !== user.id)
      if (conflictingUsers.length > 0) {
        throw new AuthServiceError(409, 'Username already exists')
      }
      patch.name = name
    }
    if (input.displayName !== undefined) {
      // Nullable display name: empty/whitespace clears it (resolves back to name).
      patch.displayName = input.displayName?.trim() || null
    }
    if (typeof input.role === 'string') {
      const role = input.role.trim()
      if (!isAuthRole(role)) {
        throw new AuthServiceError(400, `Unsupported role: ${role}`)
      }
      patch.role = role
    }

    // A user's organization is immutable: no role may move a user between orgs
    // (req 3). Reject any attempt that names a different org rather than
    // silently ignoring it, so callers get clear feedback.
    const nextOrgId = user.orgId
    if (typeof input.targetOrgId === 'string') {
      const targetOrgId = input.targetOrgId.trim()
      if (targetOrgId && targetOrgId !== user.orgId) {
        throw new AuthServiceError(400, 'Organization cannot be changed')
      }
    }

    if (input.departmentId !== undefined) {
      const departmentId = input.departmentId?.trim() || null
      if (
        departmentId &&
        !this.db.getDepartmentByIdAndOrg(departmentId, nextOrgId)
      ) {
        throw new AuthServiceError(400, 'Unknown department_id for target organization')
      }
      patch.departmentId = departmentId
    }
    if (typeof input.status === 'string') {
      const status = input.status.trim()
      if (!isUserStatus(status)) {
        throw new AuthServiceError(400, `Unsupported status: ${status}`)
      }
      patch.status = status
    }
    if (input.extUserId !== undefined) {
      // Conflict is caught by users_ext_uniq via withExtIdConflict.
      patch.extUserId = input.extUserId?.trim() || null
    }

    const nextRole = patch.role ?? user.role
    const nextDepartmentId =
      patch.departmentId === undefined ? user.departmentId : patch.departmentId
    if (nextRole === 'dept_admin' && !nextDepartmentId) {
      throw new AuthServiceError(400, 'Department admin must be assigned to a department')
    }
    // Only a super_admin may edit an existing super_admin or set a target's
    // role to super_admin (req 5). Runs before the generic mutation check so a
    // normal admin can't promote/demote/alter super admins.
    this.assertCanManageSuperAdminTarget(user.role, nextRole, auth)
    this.assertCanManageExistingUser(user, auth)
    this.assertCanManageUserMutation(
      nextOrgId,
      {
        role: nextRole,
        departmentId: nextDepartmentId,
      },
      auth,
    )

    if (
      patch.name === undefined &&
      patch.displayName === undefined &&
      patch.departmentId === undefined &&
      patch.role === undefined &&
      patch.status === undefined &&
      patch.extUserId === undefined
    ) {
      throw new AuthServiceError(400, 'Missing user update fields')
    }

    withExtIdConflict(() => this.db.updateUser(user.id, patch))
    return {
      user: sanitizeUser(this.db.getUserByIdAndOrg(user.id, nextOrgId) ?? user),
    }
  }

  setUserTokenLimit(input: {
    orgId: string
    userId: string
    tokenLimit: number | null
  }, auth?: AuthContext): { ok: true } {
    const user = this.db.getUserByIdAndOrg(input.userId, input.orgId)
    if (!user) {
      throw new AuthServiceError(404, 'Unknown user_id')
    }
    this.assertCanManageExistingUser(user, auth)
    this.db.setUserTokenLimit(input.userId, input.tokenLimit)
    return { ok: true }
  }

  setLocalAuth(input: {
    orgId: string
    userId: string
    localAuth: boolean
  }, auth: AuthContext): { ok: true; local_auth: boolean } {
    const user = this.db.getUserByIdAndOrg(input.userId, input.orgId)
    if (!user) {
      throw new AuthServiceError(404, 'Unknown user_id')
    }
    this.assertCanManageExistingUser(user, auth)
    this.db.setLocalAuth(input.userId, input.localAuth)
    return { ok: true, local_auth: input.localAuth }
  }

  setDepartmentTokenLimit(input: {
    orgId: string
    departmentId: string
    tokenLimit: number | null
  }, auth?: AuthContext): { ok: true } {
    const department = this.db.getDepartmentByIdAndOrg(input.departmentId, input.orgId)
    if (!department) {
      throw new AuthServiceError(404, 'Unknown department_id')
    }
    this.assertCanManageDepartment(input.orgId, department.id, auth)
    this.db.setDepartmentTokenLimit(input.departmentId, input.tokenLimit)
    return { ok: true }
  }

  setUserPassword(input: {
    orgId: string
    userId: string
    password: string
  }, auth?: AuthContext): { ok: true } {
    const user = this.db.getUserByIdAndOrg(input.userId, input.orgId)
    if (!user) {
      throw new AuthServiceError(404, 'Unknown user_id')
    }
    if (!input.password) {
      throw new AuthServiceError(400, 'Missing password')
    }
    this.assertCanManageExistingUser(user, auth)

    this.db.updateUserPassword(
      input.userId,
      hashPassword(input.password),
      Date.now(),
    )
    return { ok: true }
  }

  listApiKeys(
    orgId: string,
    auth?: AuthContext,
  ): {
    api_keys: Array<Omit<AuthCenterApiKey, 'secretHash'>>
  } {
    const visibleUserIds = new Set(this.listVisibleUsers(orgId, auth).map(user => user.id))
    return {
      api_keys: this.db
        .listApiKeysByOrg(orgId)
        .filter(apiKey => visibleUserIds.has(apiKey.userId))
        .map(apiKey => sanitizeApiKey(apiKey)),
    }
  }

  createApiKey(input: {
    orgId: string
    userId: string
    name: string
    scopes: string[]
  }, auth?: AuthContext): {
    api_key: Omit<AuthCenterApiKey, 'secretHash'>
    plain_text_key: string
  } {
    const user = this.db.getUserByIdAndOrg(input.userId, input.orgId)
    if (!user) {
      throw new AuthServiceError(404, 'Unknown user_id')
    }
    this.assertCanManageExistingUser(user, auth)

    const name = input.name.trim()
    const scopes = input.scopes
      .map(scope => scope.trim())
      .filter(Boolean)

    if (!name || scopes.length === 0) {
      throw new AuthServiceError(400, 'Missing name or scopes')
    }
    this.assertCanManageApiKeyScopes(scopes, auth)

    const created = createApiKeyRecord({
      orgId: input.orgId,
      userId: user.id,
      name,
      scopes,
    })
    this.db.createApiKey(created.apiKey)
    return {
      api_key: sanitizeApiKey(created.apiKey),
      plain_text_key: created.plainTextKey,
    }
  }

  revokeApiKey(input: {
    orgId: string
    keyId: string
  }, auth?: AuthContext): { ok: true } {
    const apiKey = this.db.getApiKeyById(input.keyId)
    if (!apiKey || apiKey.orgId !== input.orgId) {
      throw new AuthServiceError(404, 'Unknown key_id')
    }
    const user = this.db.getUserByIdAndOrg(apiKey.userId, input.orgId)
    if (!user) {
      throw new AuthServiceError(404, 'Unknown user_id')
    }
    this.assertCanManageExistingUser(user, auth)

    this.db.revokeApiKey(apiKey.id)
    return { ok: true }
  }

  createDepartment(input: {
    orgId: string
    name: string
    parentId?: string | null
    extDeptId?: string | null
  }, auth?: AuthContext): {
    department: SanitizedAuthCenterDepartment
  } {
    const name = input.name.trim()
    const parentId = input.parentId?.trim() || null
    const extDeptId = input.extDeptId?.trim() || null
    if (!name) {
      throw new AuthServiceError(400, 'Missing department name')
    }

    if (parentId && !this.db.getDepartmentByIdAndOrg(parentId, input.orgId)) {
      throw new AuthServiceError(400, 'Unknown parent department')
    }
    // A dept_admin may only create sub-departments under a department they
    // manage; creating a top-level department (parentId null) is admin-only.
    this.assertCanManageDepartment(input.orgId, parentId, auth)

    const existingSibling = this.findSiblingDepartment(input.orgId, parentId, name)
    if (existingSibling) {
      throw new AuthServiceError(409, 'Department name already exists under the same parent')
    }
    // extDeptId uniqueness is enforced by departments_ext_uniq (caught below).

    const timestamp = Date.now()
    const department: AuthCenterDepartment = {
      id: randomUUID(),
      orgId: input.orgId,
      parentId,
      name,
      extDeptId,
      tokenLimit: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }

    withExtIdConflict(() => this.db.createDepartment(department))
    return {
      department: {
        ...department,
        userCount: 0,
      },
    }
  }

  updateDepartment(input: {
    orgId: string
    departmentId: string
    name?: string
    parentId?: string | null
    extDeptId?: string | null
  }, auth?: AuthContext): {
    department: SanitizedAuthCenterDepartment
  } {
    const department = this.db.getDepartmentByIdAndOrg(input.departmentId, input.orgId)
    if (!department) {
      throw new AuthServiceError(404, 'Unknown department_id')
    }
    // Must manage the target department...
    this.assertCanManageDepartment(input.orgId, department.id, auth)

    const patch: {
      name?: string
      parentId?: string | null
      extDeptId?: string | null
    } = {}

    if (typeof input.name === 'string') {
      const name = input.name.trim()
      if (!name) {
        throw new AuthServiceError(400, 'Department name cannot be empty')
      }
      patch.name = name
    }

    if (input.parentId !== undefined) {
      const parentId = input.parentId?.trim() || null
      if (parentId === department.id) {
        throw new AuthServiceError(400, 'Department cannot be its own parent')
      }
      if (parentId && !this.db.getDepartmentByIdAndOrg(parentId, input.orgId)) {
        throw new AuthServiceError(400, 'Unknown parent department')
      }
      if (parentId && this.isDepartmentDescendant(input.orgId, department.id, parentId)) {
        throw new AuthServiceError(400, 'Department cannot be moved under its descendant')
      }
      // ...and the new parent must also be within the actor's managed scope
      // (moving to org-root, parentId null, is admin-only).
      this.assertCanManageDepartment(input.orgId, parentId, auth)
      patch.parentId = parentId
    }

    if (input.extDeptId !== undefined) {
      // Conflict is caught by departments_ext_uniq via withExtIdConflict.
      patch.extDeptId = input.extDeptId?.trim() || null
    }

    const nextName = patch.name ?? department.name
    const nextParentId =
      patch.parentId === undefined ? department.parentId : patch.parentId
    const sibling = this.findSiblingDepartment(input.orgId, nextParentId, nextName)
    if (sibling && sibling.id !== department.id) {
      throw new AuthServiceError(409, 'Department name already exists under the same parent')
    }

    if (patch.name === undefined && patch.parentId === undefined && patch.extDeptId === undefined) {
      throw new AuthServiceError(400, 'Missing department update fields')
    }

    withExtIdConflict(() => this.db.updateDepartment(department.id, patch))
    const updatedDepartment = this.db.getDepartmentByIdAndOrg(department.id, input.orgId) ?? department
    return {
      department: {
        ...updatedDepartment,
        userCount: this.countUsersForDepartment(input.orgId, updatedDepartment.id),
      },
    }
  }

  deleteDepartment(input: {
    orgId: string
    departmentId: string
  }, auth?: AuthContext): { ok: true } {
    const department = this.db.getDepartmentByIdAndOrg(input.departmentId, input.orgId)
    if (!department) {
      throw new AuthServiceError(404, 'Unknown department_id')
    }
    this.assertCanManageDepartment(input.orgId, department.id, auth)

    const hasChildren = this.db
      .listDepartmentsByOrg(input.orgId)
      .some(item => item.parentId === department.id)
    if (hasChildren) {
      throw new AuthServiceError(409, 'Department has child departments')
    }

    const hasUsers = this.db
      .listUsersByOrg(input.orgId)
      .some(user => user.departmentId === department.id)
    if (hasUsers) {
      throw new AuthServiceError(409, 'Department still has assigned users')
    }

    this.db.deleteDepartment(department.id)
    return { ok: true }
  }

  requireScope(
    auth: AuthContext,
    scope: string,
  ): void {
    if (!hasScope(auth.scopes, scope)) {
      throw new AuthServiceError(403, `Missing scope: ${scope}`)
    }
  }

  requireAnyScope(
    auth: AuthContext,
    scopes: string[],
  ): void {
    if (!scopes.some(scope => hasScope(auth.scopes, scope))) {
      throw new AuthServiceError(403, `Missing any scope: ${scopes.join(', ')}`)
    }
  }

  /**
   * Gate cross-org operations to super_admin. Resolves the actor by id (so it
   * works regardless of the token's current org) and verifies the real role —
   * scopes alone aren't enough since a normal admin also holds `*`. Used by the
   * organization-management endpoints (list/create/update/delete orgs), which
   * are inherently cross-org and must not be reachable by a normal admin.
   */
  requireSuperAdmin(auth: AuthContext): void {
    const actor = this.requireAuthUser(auth)
    if (!isSuperAdmin(actor.role)) {
      throw new AuthServiceError(403, 'Only a super admin can manage organizations')
    }
  }

  /**
   * Public guard for department-targeted operations handled outside this class
   * (e.g. secret-policy routes in server.ts). admin/super_admin: unrestricted
   * in-org; dept_admin: only their subtree; throws otherwise.
   */
  requireDepartmentInScope(orgId: string, departmentId: string, auth: AuthContext): void {
    this.assertCanManageDepartment(orgId, departmentId, auth)
  }

  private issueToken(input: {
    user: AuthCenterUser
    scopes: string[]
    keyId: string
    /** Override the access-token TTL (seconds). Used by OAuth2 to bound the
     *  wrapper JWT to the provider's token lifetime. */
    accessTtlSec?: number
    /** Override the token's org_id without changing the actor identity (sub).
     *  Used by switchOrg so a super_admin can scope every org-scoped endpoint
     *  to a different org while remaining themselves. */
    orgIdOverride?: string
  }): {
    access_token: string
    refresh_token: string
    token_type: 'Bearer'
    expires_in: number
    user: SanitizedAuthCenterUser
    organization: { id: string; name: string; createdAt: number } | null
    scopes: string[]
  } {
    const orgId = input.orgIdOverride ?? input.user.orgId
    const access = issueAccessToken(
      {
        iss: this.db.getIssuer(),
        sub: input.user.id,
        org_id: orgId,
        role: input.user.role,
        scopes: input.scopes,
        key_id: input.keyId,
      },
      this.db.getJwtSecret(),
      input.accessTtlSec ?? this.tokenTtlSec,
      'access',
    )

    const refresh = issueAccessToken(
      {
        iss: this.db.getIssuer(),
        sub: input.user.id,
        org_id: orgId,
        role: input.user.role,
        scopes: input.scopes,
        key_id: input.keyId,
      },
      this.db.getJwtSecret(),
      7 * 24 * 60 * 60, // 7 days
      'refresh',
    )

    // The outgoing `user.name` is the resolved display name (displayName ||
    // name) so clients show the friendly name with no client change, while the
    // DB `name` (login username) is unchanged and still used for login lookup.
    // The raw `displayName` is included as well for callers that want both.
    return {
      access_token: access.token,
      refresh_token: refresh.token,
      token_type: 'Bearer',
      expires_in: access.expiresAt - Math.floor(Date.now() / 1000),
      user: {
        ...sanitizeUser(input.user),
        name: resolveDisplayName(input.user),
        displayName: input.user.displayName ?? null,
      },
      organization: this.db.getOrganization(orgId),
      scopes: input.scopes,
    }
  }

  /**
   * Document Center v2: sign a short-lived JWT for in-container scode
   * sessions to call /api/v1/agent/wikis* via the `wiki` CLI.
   *
   * The token carries an `assistant_id` claim (= `assistantName`) so the
   * server-side handler can filter wikis by the assistant's
   * `enabledWikis` field in `_moss_meta.json`.
   *
   * Caller (`RuntimeService.spawnAttempt`) wires the result into
   * `SESSION_TOKEN` env in the spawned runner / container.
   */
  issueWikiSession(input: {
    userId: string
    orgId: string
    role: string
    scopes: string[]
    assistantName: string | null
    expiresInSec?: number
  }): { token: string; expiresAt: number } {
    return issueWikiSessionToken({
      secret: this.db.getJwtSecret(),
      issuer: this.db.getIssuer(),
      userId: input.userId,
      orgId: input.orgId,
      role: input.role,
      scopes: input.scopes,
      keyId: randomUUID(),
      assistantName: input.assistantName,
      expiresInSec: input.expiresInSec,
    })
  }

  private getUniqueUserByName(name: string): AuthCenterUser | null {
    const users = this.db.listUsersByName(name)
    if (users.length > 1) {
      throw new AuthServiceError(
        409,
        'Username is not unique; contact admin to resolve the conflict',
      )
    }
    return users[0] ?? null
  }

  private countUsersForDepartment(orgId: string, departmentId: string): number {
    return this.db
      .listUsersByOrg(orgId)
      .filter(user => user.departmentId === departmentId)
      .length
  }

  private findSiblingDepartment(
    orgId: string,
    parentId: string | null,
    name: string,
  ): AuthCenterDepartment | null {
    return (
      this.db
        .listDepartmentsByOrg(orgId)
        .find(department => department.parentId === parentId && department.name === name) ??
      null
    )
  }

  private isDepartmentDescendant(
    orgId: string,
    departmentId: string,
    candidateParentId: string,
  ): boolean {
    const departments = this.db.listDepartmentsByOrg(orgId)
    const byId = new Map(departments.map(department => [department.id, department]))
    let current = byId.get(candidateParentId) ?? null

    while (current) {
      if (current.id === departmentId) {
        return true
      }
      current = current.parentId ? byId.get(current.parentId) ?? null : null
    }

    return false
  }

  private listVisibleUsers(
    orgId: string,
    auth?: AuthContext,
  ): AuthCenterUser[] {
    const users = this.db.listUsersByOrg(orgId)
    if (!auth) {
      return users
    }

    const visibleDepartmentIds = this.getVisibleDepartmentIds(orgId, auth)
    if (visibleDepartmentIds === null) {
      return users
    }

    return users.filter(user =>
      user.role === 'user' &&
      user.departmentId !== null &&
      visibleDepartmentIds.has(user.departmentId),
    )
  }

  private getVisibleDepartmentIds(
    orgId: string,
    auth?: AuthContext,
  ): Set<string> | null {
    if (!auth) {
      return null
    }

    const actor = this.requireAuthUser(auth)
    if (ADMIN_ROLES.has(actor.role)) {
      return null
    }
    if (actor.role !== 'dept_admin' || !actor.departmentId) {
      return new Set<string>()
    }

    const childrenByParent = new Map<string | null, AuthCenterDepartment[]>()
    for (const department of this.db.listDepartmentsByOrg(orgId)) {
      const bucket = childrenByParent.get(department.parentId) ?? []
      bucket.push(department)
      childrenByParent.set(department.parentId, bucket)
    }

    const visibleIds = new Set<string>()
    const stack = [actor.departmentId]
    while (stack.length > 0) {
      const currentId = stack.pop()
      if (!currentId || visibleIds.has(currentId)) {
        continue
      }
      visibleIds.add(currentId)
      const children = childrenByParent.get(currentId) ?? []
      for (const child of children) {
        stack.push(child.id)
      }
    }

    return visibleIds
  }

  private requireAuthUser(auth: AuthContext): AuthCenterUser {
    // Resolve the actor by id (globally unique). A super_admin may have switched
    // their effective org (auth.orgId points at a foreign org), so their own
    // record won't be found via getUserByIdAndOrg — accept it regardless of org.
    // Every other role stays pinned to its home org to preserve isolation.
    const user = this.db.getUserById(auth.userId)
    if (!user || user.status !== 'active') {
      throw new AuthServiceError(403, 'Current user is not allowed to manage users')
    }
    if (!isSuperAdmin(user.role) && user.orgId !== auth.orgId) {
      throw new AuthServiceError(403, 'Current user is not allowed to manage users')
    }
    return user
  }

  private canViewUser(
    user: AuthCenterUser,
    auth?: AuthContext,
  ): boolean {
    if (!auth) {
      return true
    }

    const visibleDepartmentIds = this.getVisibleDepartmentIds(user.orgId, auth)
    if (visibleDepartmentIds === null) {
      return true
    }

    return (
      user.role === 'user' &&
      user.departmentId !== null &&
      visibleDepartmentIds.has(user.departmentId)
    )
  }

  private assertCanManageExistingUser(
    user: AuthCenterUser,
    auth?: AuthContext,
  ): void {
    if (!this.canViewUser(user, auth)) {
      throw new AuthServiceError(403, 'You cannot manage this user')
    }
  }

  /**
   * Gate a department-targeted mutation to the actor's managed scope.
   * - admin/super_admin: unrestricted within the org.
   * - dept_admin: only departments inside their own subtree (self + descendants).
   * - others / no auth: unrestricted (auth omitted = internal/IdP path).
   * `departmentId` null means "no specific department" (e.g. creating a
   * top-level department) — only admins may target the org root.
   */
  private assertCanManageDepartment(
    orgId: string,
    departmentId: string | null,
    auth?: AuthContext,
  ): void {
    if (!auth) {
      return
    }
    const visibleDepartmentIds = this.getVisibleDepartmentIds(orgId, auth)
    if (visibleDepartmentIds === null) {
      return // admin / super_admin
    }
    // dept_admin (or a role with an empty visible set): must target a dept
    // inside the managed subtree. A null target (org-root op) is admin-only.
    if (!departmentId || !visibleDepartmentIds.has(departmentId)) {
      throw new AuthServiceError(403, 'Target department is outside your managed scope')
    }
  }

  private assertCanManageUserMutation(
    orgId: string,
    input: {
      role: string
      departmentId: string | null
    },
    auth?: AuthContext,
  ): void {
    if (!auth) {
      return
    }

    const actor = this.requireAuthUser(auth)
    if (ADMIN_ROLES.has(actor.role)) {
      return
    }

    const visibleDepartmentIds = this.getVisibleDepartmentIds(orgId, auth)
    if (input.role !== 'user') {
      throw new AuthServiceError(403, 'Department admin can only manage user role accounts')
    }
    if (
      !input.departmentId ||
      visibleDepartmentIds === null ||
      !visibleDepartmentIds.has(input.departmentId)
    ) {
      throw new AuthServiceError(403, 'Target department is outside your managed scope')
    }
  }

  /**
   * Gate any mutation that touches a super_admin account (req 5):
   * - editing an existing super_admin (currentRole === 'super_admin'), or
   * - assigning the super_admin role to a target (nextRole === 'super_admin')
   * is allowed only when the actor is itself a super_admin. This blocks a
   * normal admin from promoting anyone (including themselves) to super_admin,
   * and from demoting/altering an existing super_admin.
   */
  private assertCanManageSuperAdminTarget(
    currentRole: string | null,
    nextRole: string,
    auth?: AuthContext,
  ): void {
    if (!auth) {
      return
    }
    if (currentRole !== 'super_admin' && nextRole !== 'super_admin') {
      return
    }
    const actor = this.requireAuthUser(auth)
    if (!isSuperAdmin(actor.role)) {
      throw new AuthServiceError(403, 'Only a super admin can manage super admin accounts')
    }
  }

  private assertCanManageApiKeyScopes(
    scopes: string[],
    auth?: AuthContext,
  ): void {
    if (!auth) {
      return
    }

    const actor = this.requireAuthUser(auth)
    if (ADMIN_ROLES.has(actor.role)) {
      return
    }

    const allowedScopes = new Set(DEFAULT_SCOPES_FOR_USER_ROLE)
    if (!scopes.every(scope => allowedScopes.has(scope))) {
      throw new AuthServiceError(
        403,
        'Department admin can only issue user-scoped API keys',
      )
    }
  }

  getTokenLimits(userId: string, orgId: string): { userLimit: number | null; departmentLimit: number | null } {
    const user = this.db.getUserByIdAndOrg(userId, orgId)
    if (!user) {
      return { userLimit: null, departmentLimit: null }
    }

    let departmentLimit: number | null = null
    if (user.departmentId) {
      const dept = this.db.getDepartmentByIdAndOrg(user.departmentId, orgId)
      departmentLimit = dept?.tokenLimit ?? null
    }

    return {
      userLimit: user.tokenLimit ?? null,
      departmentLimit,
    }
  }

  buildVisibilityFilter(auth: AuthContext): import('../visibilityFilter.js').VisibilityFilter {
    return buildVisibilityFilter(
      auth,
      (userId, orgId) => this.db.getUserByIdAndOrg(userId, orgId),
      (orgId) => this.db.listDepartmentsByOrg(orgId),
    )
  }

  getUserDepartmentAncestorIds(userId: string, orgId: string): Set<string> | null {
    const user = this.db.getUserByIdAndOrg(userId, orgId)
    if (!user || ADMIN_ROLES.has(user.role)) return null
    return getUserAncestorIds(
      userId,
      orgId,
      (uid, oid) => this.db.getUserByIdAndOrg(uid, oid),
      (oid) => this.db.listDepartmentsByOrg(oid),
    )
  }
}
