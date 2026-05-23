import { randomUUID } from 'crypto'
import type { DatabaseSync } from 'node:sqlite'
import { hasScope, issueAccessToken, verifyAccessToken, type AuthContext } from './token.js'
import {
  AuthCenterDb,
  type AuthCenterApiKey,
  type AuthCenterBootstrap,
  type AuthCenterDepartment,
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

export type AuthRole = 'admin' | 'dept_admin' | 'user'

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

function defaultScopesForRole(role: string): string[] {
  if (role === 'admin') {
    return ['*']
  }
  if (role === 'dept_admin') {
    return [
      'sessions:create',
      'sessions:attach',
      'sessions:list',
      'admin:users',
      'admin:api_keys',
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
  return value === 'admin' || value === 'dept_admin' || value === 'user'
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

export class AuthService {
  constructor(
    private readonly db: AuthCenterDb,
    private readonly tokenTtlSec: number,
  ) {}

  verifyAccessToken(token: string): AuthContext | null {
    return verifyAccessToken(token, this.db.getJwtSecret(), this.db.getIssuer())
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

  getMe(auth: AuthContext): {
    user: SanitizedAuthCenterUser | null
    organization: { id: string; name: string; createdAt: number } | null
    scopes: string[]
    role: string
    key_id: string
  } {
    return {
      user: this.getUserOrNull(auth.userId, auth.orgId),
      organization: this.db.getOrganization(auth.orgId),
      scopes: auth.scopes,
      role: auth.role,
      key_id: auth.keyId,
    }
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

  createUser(input: {
    orgId: string
    email?: string
    name: string
    departmentId?: string | null
    role: string
    password: string
  }, auth?: AuthContext): {
    user: SanitizedAuthCenterUser
  } {
    const email = input.email?.trim() || ''
    const name = input.name.trim()
    const departmentId = input.departmentId?.trim() || null
    const role = input.role.trim()
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

    const createdAt = Date.now()
    const userId = randomUUID()
    const user: AuthCenterUser = {
      id: userId,
      orgId: input.orgId,
      email: email || createSyntheticUserEmail(userId),
      name,
      departmentId,
      role,
      status: 'active',
      createdAt,
      passwordHash: hashPassword(input.password),
      passwordUpdatedAt: createdAt,
      lastLoginAt: null,
    }
    this.db.createUser(user)
    return { user: sanitizeUser(user) }
  }

  updateUser(input: {
    orgId: string
    userId: string
    name?: string
    departmentId?: string | null
    role?: string
    status?: string
  }, auth?: AuthContext): {
    user: SanitizedAuthCenterUser
  } {
    const user = this.db.getUserByIdAndOrg(input.userId, input.orgId)
    if (!user) {
      throw new AuthServiceError(404, 'Unknown user_id')
    }

    const patch: {
      name?: string
      departmentId?: string | null
      role?: AuthRole
      status?: 'active' | 'disabled'
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
    if (typeof input.role === 'string') {
      const role = input.role.trim()
      if (!isAuthRole(role)) {
        throw new AuthServiceError(400, `Unsupported role: ${role}`)
      }
      patch.role = role
    }
    if (input.departmentId !== undefined) {
      const departmentId = input.departmentId?.trim() || null
      if (
        departmentId &&
        !this.db.getDepartmentByIdAndOrg(departmentId, input.orgId)
      ) {
        throw new AuthServiceError(400, 'Unknown department_id')
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

    const nextRole = patch.role ?? user.role
    const nextDepartmentId =
      patch.departmentId === undefined ? user.departmentId : patch.departmentId
    if (nextRole === 'dept_admin' && !nextDepartmentId) {
      throw new AuthServiceError(400, 'Department admin must be assigned to a department')
    }
    this.assertCanManageExistingUser(user, auth)
    this.assertCanManageUserMutation(
      input.orgId,
      {
        role: nextRole,
        departmentId: nextDepartmentId,
      },
      auth,
    )

    if (
      patch.name === undefined &&
      patch.departmentId === undefined &&
      patch.role === undefined &&
      patch.status === undefined
    ) {
      throw new AuthServiceError(400, 'Missing user update fields')
    }

    this.db.updateUser(user.id, patch)
    return {
      user: sanitizeUser(this.db.getUserByIdAndOrg(user.id, input.orgId) ?? user),
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

  setDepartmentTokenLimit(input: {
    orgId: string
    departmentId: string
    tokenLimit: number | null
  }, auth?: AuthContext): { ok: true } {
    const department = this.db.getDepartmentByIdAndOrg(input.departmentId, input.orgId)
    if (!department) {
      throw new AuthServiceError(404, 'Unknown department_id')
    }
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
  }): {
    department: SanitizedAuthCenterDepartment
  } {
    const name = input.name.trim()
    const parentId = input.parentId?.trim() || null
    if (!name) {
      throw new AuthServiceError(400, 'Missing department name')
    }

    if (parentId && !this.db.getDepartmentByIdAndOrg(parentId, input.orgId)) {
      throw new AuthServiceError(400, 'Unknown parent department')
    }

    const existingSibling = this.findSiblingDepartment(input.orgId, parentId, name)
    if (existingSibling) {
      throw new AuthServiceError(409, 'Department name already exists under the same parent')
    }

    const timestamp = Date.now()
    const department: AuthCenterDepartment = {
      id: randomUUID(),
      orgId: input.orgId,
      parentId,
      name,
      createdAt: timestamp,
      updatedAt: timestamp,
    }

    this.db.createDepartment(department)
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
  }): {
    department: SanitizedAuthCenterDepartment
  } {
    const department = this.db.getDepartmentByIdAndOrg(input.departmentId, input.orgId)
    if (!department) {
      throw new AuthServiceError(404, 'Unknown department_id')
    }

    const patch: {
      name?: string
      parentId?: string | null
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
      patch.parentId = parentId
    }

    const nextName = patch.name ?? department.name
    const nextParentId =
      patch.parentId === undefined ? department.parentId : patch.parentId
    const sibling = this.findSiblingDepartment(input.orgId, nextParentId, nextName)
    if (sibling && sibling.id !== department.id) {
      throw new AuthServiceError(409, 'Department name already exists under the same parent')
    }

    if (patch.name === undefined && patch.parentId === undefined) {
      throw new AuthServiceError(400, 'Missing department update fields')
    }

    this.db.updateDepartment(department.id, patch)
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
  }): { ok: true } {
    const department = this.db.getDepartmentByIdAndOrg(input.departmentId, input.orgId)
    if (!department) {
      throw new AuthServiceError(404, 'Unknown department_id')
    }

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

  private issueToken(input: {
    user: AuthCenterUser
    scopes: string[]
    keyId: string
  }): {
    access_token: string
    token_type: 'Bearer'
    expires_in: number
    user: SanitizedAuthCenterUser
    organization: { id: string; name: string; createdAt: number } | null
    scopes: string[]
  } {
    const issued = issueAccessToken(
      {
        iss: this.db.getIssuer(),
        sub: input.user.id,
        org_id: input.user.orgId,
        role: input.user.role,
        scopes: input.scopes,
        key_id: input.keyId,
      },
      this.db.getJwtSecret(),
      this.tokenTtlSec,
    )

    return {
      access_token: issued.token,
      token_type: 'Bearer',
      expires_in: issued.expiresAt - Math.floor(Date.now() / 1000),
      user: sanitizeUser(input.user),
      organization: this.db.getOrganization(input.user.orgId),
      scopes: input.scopes,
    }
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
    if (actor.role === 'admin') {
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
    const user = this.db.getUserByIdAndOrg(auth.userId, auth.orgId)
    if (!user || user.status !== 'active') {
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
    if (actor.role === 'admin') {
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

  private assertCanManageApiKeyScopes(
    scopes: string[],
    auth?: AuthContext,
  ): void {
    if (!auth) {
      return
    }

    const actor = this.requireAuthUser(auth)
    if (actor.role === 'admin') {
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
}
