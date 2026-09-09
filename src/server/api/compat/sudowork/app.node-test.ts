import assert from 'node:assert/strict'
import { createDecipheriv } from 'node:crypto'
import { describe, test } from 'node:test'
import { SudoworkIdentityError, type SudoworkLegacyUser } from './identityService.js'
import { SudoworkAdministrationError } from './adminService.js'
import { SudoworkUserProjectionError } from './userProjectionService.js'
import { QmsAuthorizationService } from '../../../qms/qmsAuthorization.js'
import {
  createSudoworkCompatibilityApp,
  type SudoworkAdministrationPort,
  type SudoworkCatalogPort,
  type SudoworkConfigPort,
  type SudoworkIdentityPort,
  type SudoworkManagedImagePort,
  type SudoworkSystemConfigPort,
} from './app.js'

const user: SudoworkLegacyUser = {
  id: 17,
  phone: '13800000000',
  nickname: '旧用户',
  role: 'USER',
  status: 1,
  enterpriseId: 9,
  enterpriseCode: 'ENT-A',
}

function createIdentity(): SudoworkIdentityPort {
  return {
    async loginByPassword(input) {
      if (input.password !== 'correct') throw new SudoworkIdentityError(401, '账号或密码错误')
      return {
        accessToken: 'access-token', legacyToken: 'legacy-token', refreshToken: 'refresh-token',
        expiresIn: 7_200, user,
      }
    },
    async loginAdminByPassword(input) {
      if (input.phone === 'regular') throw new SudoworkIdentityError(404, '账号不存在')
      if (input.password !== 'correct') throw new SudoworkIdentityError(401, '密码错误')
      return {
        accessToken: 'admin-access', legacyToken: 'admin-legacy', refreshToken: 'admin-refresh',
        expiresIn: 7_200, user: { ...user, role: 'ENTERPRISE_ADMIN' },
      }
    },
    async changePassword(input) {
      if (input.oldPassword !== 'correct') {
        throw new SudoworkIdentityError(401, input.oldPasswordError ?? '原始密码错误')
      }
    },
    getActor(token) {
      return token === 'admin-access'
        ? { userId: 'admin-a', orgId: 'org-a', role: 'super_admin' }
        : token === 'access-token'
          ? { userId: 'user-a', orgId: 'org-a', role: 'user' }
          : null
    },
    updateProfile(token, nickname) {
      if (token !== 'access-token') throw new SudoworkIdentityError(401, '未授权')
      return { ...user, nickname }
    },
    async registerByPassword() {
      return {
        accessToken: 'registered-access', legacyToken: 'registered-legacy',
        refreshToken: 'registered-refresh', expiresIn: 7_200,
        user: { ...user, id: 18, phone: 'new-user', nickname: '新用户' },
      }
    },
    async loginByVerifiedPhone(input) {
      if (input.phone === '13900000000') {
        return { needRegistration: true as const, registerToken: 'register-token', phone: input.phone }
      }
      return {
        needRegistration: false as const,
        session: {
          accessToken: 'sms-access', legacyToken: 'sms-legacy', refreshToken: 'sms-refresh',
          expiresIn: 7_200, user,
        },
      }
    },
    async registerByVerifiedPhone() {
      return {
        needRegistration: false as const,
        session: {
          accessToken: 'phone-access', legacyToken: 'phone-legacy', refreshToken: 'phone-refresh',
          expiresIn: 7_200, user: { ...user, id: 19, phone: '13900000000' },
        },
      }
    },
    async refresh(input) {
      if (input.refreshToken !== 'refresh-token') {
        throw new SudoworkIdentityError(401, 'refresh_token 无效或已过期')
      }
      return { accessToken: 'access-two', refreshToken: 'refresh-two', expiresIn: 7_200 }
    },
    getProfile(token) {
      return token === 'access-token' ? user : null
    },
    async logout() {},
  }
}

function createApp(
  loginMethod: 'sms' | 'password' | 'cas' = 'password',
  systemConfig?: { skillhubBaseUrl?: string },
  extra: Partial<Parameters<typeof createSudoworkCompatibilityApp>[0]> = {},
) {
  const systemConfiguration: SudoworkSystemConfigPort = {
    getLoginMethod() { return loginMethod },
    getPublicConfig() {
      return {
        login_method: loginMethod === 'sms' ? 0 : loginMethod === 'password' ? 1 : 2,
        log_report: { enabled: 0 }, version_update: { enabled: 0 },
        product_improvement: { enabled: 0 }, sudorouter_baseurl: '',
        skillhub_baseurl: systemConfig?.skillhubBaseUrl?.replace(/\/+$/, '') ?? '', scode_auto_model: '',
        third_party_auth: {
          enabled: loginMethod === 'cas' ? 1 : 0,
          default_provider: loginMethod === 'cas' ? 'cas-main' : '',
          providers: loginMethod === 'cas' ? [{ id: 'cas-main', name: '统一认证', type: 'cas', enabled: 1 }] : [],
        },
        recharge_mode: 'disabled', credit_application: { enabled: 0 },
      }
    },
    getAdminConfig() { return { login_method: 1, sms_configured: true } },
    async update() {},
    getCredentialData() { return {} },
  }
  const managedImages: SudoworkManagedImagePort = {
    async put(input) {
      const filename = input.kind === 'config-item' ? 'config-icon.png' : 'enterprise-logo.png'
      return {
        filename,
        publicPath: input.kind === 'config-item'
          ? `/uploads/config-items/${filename}`
          : `/uploads/enterprises/${filename}`,
      }
    },
    async read(kind, filename) {
      if (filename.includes('missing')) throw new Error('missing')
      return { bytes: Buffer.from(`${kind}:${filename}`), mimeType: 'image/png' }
    },
  }
  const administration: SudoworkAdministrationPort = {
    listEnterprises() {
      return [{
        id: 9, name: '企业 A', code: 'ENT-A', credit_pool: 10_000, logo: null,
        app_name: '应用 A', top_name: null, about_name: null, app_company_name: null,
        login_desp: null, userCount: 1,
      }]
    },
    createEnterprise() { return { id: 10 } },
    updateEnterprise() {},
    deleteEnterprise() {},
    listInvitationCodes(input) {
      return {
        items: [{ id: 31, code: 'CODE-A', enterprise_id: input.enterpriseId ?? 9 }],
        total: 1, page: input.page ?? 1, page_size: input.pageSize ?? 20,
      }
    },
    createInvitationCodes() { return { codes: ['CODE-A'], count: 1 } },
    deleteInvitationCode() { return true },
    listUsers() {
      return [{
        id: 17, phone: '13800000000', nickname: '旧用户', enterprise_id: 9,
        enterprise_name: '企业 A', role: 'USER', status: 1, invitation_code: 'CODE-A',
        quota: 100, used_quota: 25, balance: 75, login_type: 1, created_at: 1,
      }]
    },
    createPasswordUser() {
      return { id: 18, phone: 'new-user', sudorouter_user_id: null, initial_points: 50 }
    },
    createPhoneUser() {
      return { id: 19, phone: '13900000000', sudorouter_user_id: null, initial_points: 50 }
    },
    updateUser() {},
    setUserRole() {},
    manageUser(input) { return input.action === 'enable' ? 1 : 2 },
    deleteUser() {},
    updatePasswordUser() {},
  }
  const catalog: SudoworkCatalogPort = {
    listAgents() {
      return { success: true, message: 'success', data: { assistants: [{ id: 'agent-1' }], next_cursor: null, has_more: false } }
    },
    listSkills() {
      return { success: true, message: 'success', data: { skills: [{ id: 'skill-1' }], next_cursor: null, has_more: false } }
    },
    listVisibleAgents() {
      return { success: true, data: [{ id: 'agent-1', enhancement: { enabled: false } }] }
    },
    listVisibleBindings() { return { success: true, data: [] } },
    getAgentDetail() {
      return { success: true, data: { assistant: { id: 'agent-1' }, versions: [{ version: '1.0.0' }] } }
    },
    getSkillDetail() {
      return { success: true, data: { skill: { id: 'skill-1' }, versions: [{ version: '1.0.0' }] } }
    },
    listCategories(_actor, type) {
      return { success: true, data: type === 'agent' ? ['效率'] : ['开发'] }
    },
    async uploadAgent(input) {
      return { success: true, message: 'success', data: { assistant: { id: 'uploaded-agent', name: input.name } } as any }
    },
    async uploadSkill(input) {
      return { success: true, message: 'success', data: { skill: { id: 'uploaded-skill', name: input.name } } as any }
    },
    async getArtifact() { return { bytes: Buffer.from('zip'), filename: 'artifact.zip' } },
    reviewAgent() {},
    reviewSkill() {},
    deleteAgent() {},
    deleteSkill() {},
  }
  const configuration: SudoworkConfigPort = {
    list() { return { items: [{ id: 1, name: 'Token' }], total: 1, page: 1, page_size: 20 } },
    create() { return { id: 1 } },
    get() { return { id: 1, name: 'Token', entries: [], enterprises: [] } },
    update() {},
    updateStatus() {},
    entriesFor() { return [{ id: 2, config_key: 'token' }] },
    replaceEntries() {},
    listEnterprises() { return { items: [], total: 0, page: 1, page_size: 20 } },
    associate() {},
    dissociate() {},
    listForUser() { return [{ id: 1, name: 'Token' }] },
    async getTenantConfig() {
      return { logo: null, app_name: 'Sudowork', top_name: null, about_name: null, app_company_name: null, login_desp: null }
    },
  }
  return createSudoworkCompatibilityApp({
    identity: createIdentity(),
    administration,
    catalog,
    configuration,
    managedImages,
    systemConfiguration,
    cas: {
      async login() {
        return {
          accessToken: 'cas-access', legacyToken: 'cas-legacy', refreshToken: 'cas-refresh',
          expiresIn: 7_200, user,
        }
      },
      async createHandoff() {
        return { redirectUrl: 'sudowork://cas-callback/cas-main/callback?code=handoff' }
      },
      async exchange() {
        return {
          accessToken: 'cas-access', legacyToken: 'cas-legacy', refreshToken: 'cas-refresh',
          expiresIn: 7_200, user,
        }
      },
      logoutCallbackUrl() { return 'sudowork://cas-callback/cas-main/logout' },
      listPublicProviders() { return [{ id: 'cas-main', name: '统一认证', type: 'cas', enabled: 1 }] },
    },
    loginMethod,
    systemConfig,
    sms: {
      async sendCode() {
        return { success: true, expire: 300, nextSendIn: 60, dailyRemaining: 9 }
      },
      async verifyCode(_phone, code) {
        return code === '123456'
          ? { success: true }
          : { success: false, message: '验证码错误' }
      },
    },
    getUserProjection: async () => ({
      sudorouterKey: 'sk-router-key',
      modelServiceUrl: 'https://models.example.test/v1',
      models: ['model-a'],
      scodeAutoModel: 'model-a',
      totalPoints: 100,
      usedPoints: 25,
      remainingPoints: 75,
      bonusPoints: 10,
      quota: 75_000,
      usedQuota: 25_000,
    }),
    ...extra,
  })
}

describe('Sudowork compatibility Hono app', () => {
  test('登录投影缺少 Sudorouter Token 时返回明确兼容错误', async () => {
    const app = createApp('password', undefined, {
      getUserProjection: async () => {
        throw new SudoworkUserProjectionError(500, 'Sudorouter 用户 Token 不存在')
      },
    })
    const response = await app.request('/api/v1/auth/login-by-config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '13800000000', password: 'correct' }),
    })
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { success: false, msg: 'Sudorouter 用户 Token 不存在' })
  })

  test('QMS 未启用时已知质量接口返回 503 而不是 404', async () => {
    const app = createSudoworkCompatibilityApp({ identity: createIdentity() })
    const response = await app.request('/api/v1/qms/system/health')
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { success: false, msg: 'QMS 未配置' })
  })

  test('maps legacy administration domain errors to the old JSON error envelope', async () => {
    const app = createApp('password', undefined, {
      legacyAdministration: {
        approveUser() { throw new SudoworkAdministrationError(403, '无权操作该用户') },
      } as never,
    })
    const response = await app.request('/api/v1/admin/approve', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-access', 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 7 }),
    })
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { success: false, msg: '无权操作该用户' })
  })

  test('Moss 运营入口把超级管理员标记为当前组织作用域，旧入口保持全局语义', async () => {
    const received: Array<Record<string, unknown>> = []
    const administration = {
      listInvitationCodes(input: { actor: Record<string, unknown> }) {
        received.push(input.actor)
        return { items: [], total: 0, page: 1, page_size: 20 }
      },
    } as never
    const legacy = createApp('password', undefined, { administration })
    const operations = createApp('password', undefined, {
      administration,
      organizationScopedAdmin: true,
    } as never)
    const headers = { authorization: 'Bearer admin-access' }

    await legacy.request('/api/v1/admin/invitation-codes', { headers })
    await operations.request('/api/v1/admin/invitation-codes', { headers })

    assert.equal(received[0]?.organizationScoped, undefined)
    assert.equal(received[1]?.organizationScoped, true)
  })

  test('registers Dify administration routes through the compatibility app', async () => {
    const app = createApp('password', undefined, {
      difyAdministration: { getBinding: () => ({ dify_tenant_id: 'tenant-a' }) } as never,
      resolveEnterpriseAlias: id => id === 9 ? { resourceId: 'org-a', orgId: 'org-a' } : null,
    })
    const response = await app.request('/api/v1/admin/dify/binding?enterprise_id=9', {
      headers: { Authorization: 'Bearer admin-access' },
    })
    assert.deepEqual([response.status, await response.json()], [200, {
      success: true, data: { dify_tenant_id: 'tenant-a' },
    }])
  })

  test('registers every P1 identity and organization route from the legacy contract', () => {
    const actual = new Set(createApp().routes.map((route) => `${route.method} ${route.path}`))
    const expected = [
      'POST /api/v1/auth/send-code',
      'POST /api/v1/auth/login',
      'POST /api/v1/auth/register',
      'POST /api/v1/auth/login-by-config',
      'POST /api/v1/auth/register-password',
      'POST /api/v1/auth/change-password',
      'POST /api/v1/auth/refresh',
      'POST /api/v1/auth/logout',
      'POST /api/v1/auth/third-party/cas/login',
      'GET /api/v1/auth/third-party/cas/callback/:provider',
      'POST /api/v1/auth/third-party/cas/exchange',
      'GET /api/v1/auth/third-party/cas/logout/callback/:provider',
      'GET /api/v1/system-config',
      'GET /api/v1/system-config/credentials',
      'GET /api/v1/admin/system-config',
      'PUT /api/v1/admin/system-config',
      'GET /api/v1/user/profile',
      'POST /api/v1/user/update-profile',
      'POST /api/v1/admin/login',
      'POST /api/v1/admin/change-password',
      'GET /api/v1/admin/enterprises',
      'POST /api/v1/admin/enterprises',
      'PUT /api/v1/admin/enterprises/:id',
      'DELETE /api/v1/admin/enterprises/:id',
      'GET /api/v1/admin/invitation-codes',
      'POST /api/v1/admin/invitation-codes',
      'DELETE /api/v1/admin/invitation-codes/:id',
      'GET /api/v1/admin/invitation-codes/available',
      'GET /api/v1/admin/users',
      'POST /api/v1/admin/users',
      'PUT /api/v1/admin/users/:id',
      'POST /api/v1/admin/users/:id/role',
      'POST /api/v1/admin/users/:id/manage',
      'DELETE /api/v1/admin/users/:id',
      'GET /api/v1/admin/config-items',
      'POST /api/v1/admin/config-items',
      'GET /api/v1/admin/config-items/:id',
      'PUT /api/v1/admin/config-items/:id',
      'PUT /api/v1/admin/config-items/:id/status',
      'GET /api/v1/admin/config-items/:id/entries',
      'PUT /api/v1/admin/config-items/:id/entries',
      'GET /api/v1/admin/config-items/:id/enterprises',
      'POST /api/v1/admin/config-items/:id/enterprises/:enterpriseId',
      'DELETE /api/v1/admin/config-items/:id/enterprises/:enterpriseId',
      'GET /api/v1/config/items',
      'GET /api/v1/tenant/config',
      'POST /api/v1/admin/upload/config-item-icon',
      'POST /api/v1/admin/upload/enterprise-logo',
      'GET /uploads/config-items/:filename',
      'GET /uploads/enterprises/:filename',
      'POST /api/v1/admin/users-password',
      'PUT /api/v1/admin/users-password/:id',
      'GET /api/assistants/cursor',
      'GET /api/assistants/:assistantId',
      'POST /api/assistants',
      'POST /api/assistants/:assistantId/approve',
      'DELETE /api/assistants/:assistantId',
      'GET /api/skills',
      'GET /api/skills/cursor',
      'GET /api/skills/:skillId',
      'POST /api/skills',
      'POST /api/skills/:skillId/approve',
      'DELETE /api/skills/:skillId',
      'GET /api/v1/agents/visible',
      'GET /api/v1/agents/visible/bindings',
      'GET /api/categories',
      'GET /api/catalog/artifacts/:kind/:resourceId',
    ]
    for (const route of expected) assert(actual.has(route), `missing compatibility route: ${route}`)
  })

  test('keeps Hub cursor and visible-agent envelopes on the unified catalog', async () => {
    const app = createApp()
    const adminHeaders = { authorization: 'Bearer admin-access' }
    const agents = await app.request('/api/assistants/cursor?tenant_id=ENT-A&limit=20', { headers: adminHeaders })
    assert.deepEqual(await agents.json(), {
      success: true, message: 'success',
      data: { assistants: [{ id: 'agent-1' }], next_cursor: null, has_more: false },
    })
    const skills = await app.request('/api/skills/cursor?tenant_id=ENT-A', { headers: adminHeaders })
    assert.equal((await skills.json() as any).data.skills[0].id, 'skill-1')

    const userSkills = await app.request('/api/skills/cursor?limit=20', {
      headers: { authorization: 'Bearer access-token' },
    })
    assert.equal(userSkills.status, 200)
    assert.equal((await userSkills.json() as any).data.skills[0].id, 'skill-1')

    const pageSkills = await app.request('/api/skills?page=1&size=20', {
      headers: { authorization: 'Bearer access-token' },
    })
    assert.equal(pageSkills.status, 200)
    assert.equal((await pageSkills.json() as any).data.skills[0].id, 'skill-1')

    const visible = await app.request('/api/v1/agents/visible', {
      headers: { authorization: 'Bearer access-token' },
    })
    assert.deepEqual(await visible.json(), {
      success: true, data: [{ id: 'agent-1', enhancement: { enabled: false } }],
    })

    const approved = await app.request('/api/assistants/agent-1/approve', {
      method: 'POST', headers: adminHeaders,
    })
    assert.equal(approved.status, 200)
    assert.deepEqual(await approved.json(), { success: true, message: 'success' })

    const agentDetail = await app.request('/api/assistants/agent-1', {
      headers: { authorization: 'Bearer access-token' },
    })
    assert.equal((await agentDetail.json() as any).data.assistant.id, 'agent-1')
    const skillDetail = await app.request('/api/skills/skill-1', {
      headers: { authorization: 'Bearer access-token' },
    })
    assert.equal((await skillDetail.json() as any).data.skill.id, 'skill-1')
    const categories = await app.request('/api/categories?type=1', {
      headers: { authorization: 'Bearer access-token' },
    })
    assert.deepEqual(await categories.json(), { success: true, data: ['效率'] })
  })

  test('保持旧 Agent/Skill multipart 上传字段和 ZIP 下载传输行为', async () => {
    const app = createApp()
    const agentForm = new FormData()
    agentForm.set('tenant_id', 'ENT-A')
    agentForm.set('name', '写作助手')
    agentForm.set('profession', '写作')
    agentForm.set('categories', JSON.stringify(['效率']))
    agentForm.set('source_url', new File([Buffer.from('zip')], 'agent.zip', { type: 'application/zip' }))
    const agent = await app.request('/api/assistants', {
      method: 'POST', headers: { authorization: 'Bearer access-token' }, body: agentForm,
    })
    assert.equal(agent.status, 200)
    assert.equal((await agent.json() as any).data.assistant.id, 'uploaded-agent')

    const skillForm = new FormData()
    skillForm.set('tenant_id', 'ENT-A')
    skillForm.set('name', 'writer')
    skillForm.set('display_name', '写作技能')
    skillForm.set('skill_file', new File([Buffer.from('zip')], 'skill.zip', { type: 'application/zip' }))
    const skill = await app.request('/api/skills', {
      method: 'POST', headers: { authorization: 'Bearer access-token' }, body: skillForm,
    })
    assert.equal((await skill.json() as any).data.skill.id, 'uploaded-skill')

    const artifact = await app.request('/api/catalog/artifacts/skill/uploaded-skill')
    assert.equal(artifact.headers.get('content-type'), 'application/zip')
    assert.equal(await artifact.text(), 'zip')
  })

  test('保持旧配置项分页、明细和用户可见列表响应外壳', async () => {
    const app = createApp()
    const headers = { authorization: 'Bearer admin-access' }
    const list = await app.request('/api/v1/admin/config-items?page=1&page_size=20', { headers })
    assert.deepEqual(await list.json(), {
      success: true,
      data: { items: [{ id: 1, name: 'Token' }], total: 1, page: 1, page_size: 20 },
    })
    const detail = await app.request('/api/v1/admin/config-items/1', { headers })
    assert.equal((await detail.json() as any).data.name, 'Token')
    const visible = await app.request('/api/v1/config/items', {
      headers: { authorization: 'Bearer access-token' },
    })
    assert.deepEqual(await visible.json(), { success: true, data: [{ id: 1, name: 'Token' }] })
    const tenant = await app.request('/api/v1/tenant/config?code=ENT-A', {
      headers: { authorization: 'Bearer access-token' },
    })
    assert.equal((await tenant.json() as any).data.app_name, 'Sudowork')
  })

  test('保持配置图标和企业 Logo 的 multipart 与公开读取契约', async () => {
    const app = createApp()
    const unauthorized = await app.request('/api/v1/admin/upload/config-item-icon', {
      method: 'POST', body: new FormData(),
    })
    assert.equal(unauthorized.status, 401)

    const missingFile = await app.request('/api/v1/admin/upload/config-item-icon', {
      method: 'POST', headers: { authorization: 'Bearer admin-access' }, body: new FormData(),
    })
    assert.equal(missingFile.status, 400)
    assert.deepEqual(await missingFile.json(), { success: false, msg: '请选择要上传的文件' })

    const iconForm = new FormData()
    iconForm.set('file', new File([Buffer.from('png')], 'icon.png', { type: 'image/png' }))
    const icon = await app.request('/api/v1/admin/upload/config-item-icon', {
      method: 'POST', headers: { authorization: 'Bearer admin-access' }, body: iconForm,
    })
    assert.deepEqual(await icon.json(), {
      success: true, data: { filename: 'config-icon.png' }, msg: '图标上传成功',
    })

    const logoForm = new FormData()
    logoForm.set('file', new File([Buffer.from('png')], 'logo.png', { type: 'image/png' }))
    const logo = await app.request('/api/v1/admin/upload/enterprise-logo', {
      method: 'POST', headers: { authorization: 'Bearer admin-access' }, body: logoForm,
    })
    assert.deepEqual(await logo.json(), {
      success: true, data: { filename: 'enterprise-logo.png' }, msg: 'Logo上传成功',
    })

    const publicIcon = await app.request('/uploads/config-items/config-icon.png')
    assert.equal(publicIcon.status, 200)
    assert.equal(publicIcon.headers.get('content-type'), 'image/png')
    assert.equal(publicIcon.headers.get('cache-control'), 'public, max-age=31536000')
    assert.equal(await publicIcon.text(), 'config-item:config-icon.png')
  })

  test('keeps the password login response shape and CORS behavior', async () => {
    const app = createApp()
    const response = await app.request('/api/v1/auth/login-by-config', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-device-id': 'desktop-a',
        origin: 'https://desktop.test',
      },
      body: JSON.stringify({ phone: '13800000000', password: 'correct' }),
    })

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('access-control-allow-origin'), '*')
    assert.deepEqual(await response.json(), {
      success: true,
      data: {
        token: 'legacy-token',
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 7_200,
        user: {
          id: 17,
          phone: '13800000000',
          nickname: '旧用户',
          role: 'USER',
          status: 1,
          enterprise_code: 'ENT-A',
          sudorouter_key: 'sk-router-key',
          model_service_url: 'https://models.example.test/v1',
          models: ['model-a'],
          scode_auto_model: 'model-a',
          points: { total: 100, used: 25, remaining: 75, bonus: 10 },
        },
      },
    })
  })

  test('keeps legacy validation and authentication errors', async () => {
    const app = createApp()
    const missing = await app.request('/api/v1/auth/login-by-config', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    assert.equal(missing.status, 400)
    assert.deepEqual(await missing.json(), { success: false, msg: '账号或密码不能为空' })

    const wrong = await app.request('/api/v1/auth/login-by-config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '13800000000', password: 'wrong' }),
    })
    assert.equal(wrong.status, 401)
    assert.deepEqual(await wrong.json(), { success: false, msg: '账号或密码错误' })

    const unauthorized = await app.request('/api/v1/user/profile')
    assert.equal(unauthorized.status, 401)
    assert.deepEqual(await unauthorized.json(), { success: false, msg: '未授权' })
  })

  test('keeps refresh, profile, and logout contracts', async () => {
    const app = createApp()
    const refresh = await app.request('/api/v1/auth/refresh', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: 'refresh-token', device_id: 'desktop-a' }),
    })
    assert.deepEqual(await refresh.json(), {
      success: true, access_token: 'access-two', refresh_token: 'refresh-two', expires_in: 7_200,
    })

    const profile = await app.request('/api/v1/user/profile', {
      headers: { authorization: 'Bearer access-token' },
    })
    assert.deepEqual(await profile.json(), {
      success: true,
      data: {
        id: 17,
        phone: '13800000000',
        nickname: '旧用户',
        role: 'USER',
        status: 1,
        enterprise_id: 9,
        enterprise_code: 'ENT-A',
        bonus_points: 10,
        remaining_points: 75,
        used_points: 25,
        quota: 75_000,
        used_quota: 25_000,
      },
    })

    const logout = await app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer access-token' },
      body: JSON.stringify({ all: true }),
    })
    assert.deepEqual(await logout.json(), { success: true, msg: '注销成功' })
  })

  test('registers password users through the same legacy session response contract', async () => {
    const app = createApp()
    const response = await app.request('/api/v1/auth/register-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-device-id': 'desktop-b' },
      body: JSON.stringify({
        phone: 'new-user', password: 'StrongPass456', nickname: '新用户', invitation_code: 'INVITE-B',
      }),
    })
    assert.equal(response.status, 200)
    const body = await response.json() as Record<string, any>
    assert.equal(body.success, true)
    assert.equal(body.data.access_token, 'registered-access')
    assert.equal(body.data.refresh_token, 'registered-refresh')
    assert.equal(body.data.user.id, 18)
    assert.equal(body.data.user.enterprise_code, 'ENT-A')
  })

  test('keeps SMS send, login handoff, and verified registration contracts', async () => {
    const app = createApp()
    const sent = await app.request('/api/v1/auth/send-code', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '13900000000' }),
    })
    assert.deepEqual(await sent.json(), {
      success: true, msg: '验证码已发送', expire: 300, next_send_in: 60, daily_remaining: 9,
    })

    const login = await app.request('/api/v1/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '13900000000', code: '123456' }),
    })
    assert.deepEqual(await login.json(), {
      success: false,
      need_register: true,
      register_token: 'register-token',
      phone: '13900000000',
      msg: '用户不存在，请先注册',
    })

    const registered = await app.request('/api/v1/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        register_token: 'register-token', nickname: '手机用户', invitation_code: 'PHONE-INVITE',
      }),
    })
    assert.equal(registered.status, 200)
    const registeredBody = await registered.json() as Record<string, any>
    assert.equal(registeredBody.data.access_token, 'phone-access')
    assert.equal(registeredBody.data.user.id, 19)
  })

  test('dispatches login-by-config from the migrated global login policy', async () => {
    const smsApp = createApp('sms')
    const smsLogin = await smsApp.request('/api/v1/auth/login-by-config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '13900000000', code: '123456' }),
    })
    assert.equal(smsLogin.status, 200)
    assert.equal((await smsLogin.json() as Record<string, unknown>).need_register, true)

    const casApp = createApp('cas')
    const casLogin = await casApp.request('/api/v1/auth/login-by-config', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    assert.equal(casLogin.status, 403)
    assert.deepEqual(await casLogin.json(), {
      success: false, msg: '当前系统已开启三方认证登录，请使用 CAS 登录',
    })

    const config = await smsApp.request('/api/v1/system-config')
    assert.deepEqual(await config.json(), {
      success: true,
      data: {
        login_method: 0,
        log_report: { enabled: 0 },
        version_update: { enabled: 0 },
        product_improvement: { enabled: 0 },
        sudorouter_baseurl: '',
        skillhub_baseurl: '',
        scode_auto_model: '',
        third_party_auth: { enabled: 0, default_provider: '', providers: [] },
        recharge_mode: 'disabled',
        credit_application: { enabled: 0 },
      },
    })
  })

  test('系统配置管理接口复用统一策略服务并保持旧响应', async () => {
    const app = createApp()
    const unauthorized = await app.request('/api/v1/admin/system-config')
    assert.equal(unauthorized.status, 401)
    const read = await app.request('/api/v1/admin/system-config', {
      headers: { authorization: 'Bearer admin-access' },
    })
    assert.deepEqual(await read.json(), {
      success: true, data: { login_method: 1, sms_configured: true },
    })
    const updated = await app.request('/api/v1/admin/system-config', {
      method: 'PUT',
      headers: { authorization: 'Bearer admin-access', 'content-type': 'application/json' },
      body: JSON.stringify({ login_method: 1 }),
    })
    assert.deepEqual(await updated.json(), { success: true, msg: '系统配置更新成功' })
  })

  test('下发旧客户端可解密的按用户 Hub 凭证和 Moss Hub 地址', async () => {
    const app = createApp('password', { skillhubBaseUrl: 'https://moss.example.test/' })
    const publicConfig = await app.request('/api/v1/system-config')
    assert.equal((await publicConfig.json() as any).data.skillhub_baseurl, 'https://moss.example.test')

    const unauthorized = await app.request('/api/v1/system-config/credentials')
    assert.equal(unauthorized.status, 401)

    const response = await app.request('/api/v1/system-config/credentials', {
      headers: { authorization: 'Bearer access-token' },
    })
    assert.equal(response.status, 200)
    const envelope = await response.json() as { success: boolean; nonce: string; ciphertext: string }
    const encrypted = Buffer.from(envelope.ciphertext, 'base64')
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from('L7CbnQlwVrzWlaehCWSIiKuwBxFDh9i1AFaifYv7UXE=', 'base64'),
      Buffer.from(envelope.nonce, 'base64'),
    )
    decipher.setAuthTag(encrypted.subarray(encrypted.length - 16))
    const plaintext = Buffer.concat([
      decipher.update(encrypted.subarray(0, encrypted.length - 16)),
      decipher.final(),
    ])
    assert.deepEqual(JSON.parse(plaintext.toString('utf8')), {
      skillhub: { token: 'Bearer access-token' },
    })
  })

  test('keeps legacy administrator login and password-change responses', async () => {
    const app = createApp()
    const login = await app.request('/api/v1/admin/login', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-device-id': 'admin-a' },
      body: JSON.stringify({ phone: 'admin', password: 'correct' }),
    })
    assert.equal(login.status, 200)
    assert.deepEqual(await login.json(), {
      success: true,
      data: {
        token: 'admin-legacy', access_token: 'admin-access', refresh_token: 'admin-refresh',
        expires_in: 7_200,
        user: {
          id: 17, phone: '13800000000', nickname: '旧用户', role: 'ENTERPRISE_ADMIN',
          avatar: null, enterprise_id: 9, tenant_id: 'ENT-A',
        },
      },
    })

    const changed = await app.request('/api/v1/auth/change-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer admin-access' },
      body: JSON.stringify({ oldPassword: 'correct', newPassword: 'AnotherPass456' }),
    })
    assert.deepEqual(await changed.json(), { success: true, msg: '密码修改成功' })

    const adminChanged = await app.request('/api/v1/admin/change-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer admin-access' },
      body: JSON.stringify({ oldPassword: 'wrong', newPassword: 'AnotherPass456' }),
    })
    assert.equal(adminChanged.status, 401)
    assert.deepEqual(await adminChanged.json(), { success: false, msg: '旧密码错误' })
  })

  test('keeps enterprise and invitation administration contracts', async () => {
    const app = createApp()
    const headers = { authorization: 'Bearer admin-access', 'content-type': 'application/json' }
    const enterprises = await app.request('/api/v1/admin/enterprises', { headers })
    assert.deepEqual(await enterprises.json(), {
      success: true,
      data: [{
        id: 9, name: '企业 A', code: 'ENT-A', credit_pool: 10_000, logo: null,
        app_name: '应用 A', top_name: null, about_name: null, app_company_name: null,
        login_desp: null, userCount: 1,
      }],
    })

    const created = await app.request('/api/v1/admin/invitation-codes', {
      method: 'POST', headers,
      body: JSON.stringify({ count: 1, enterprise_id: 9, initial_quota_usd: 12.5 }),
    })
    assert.deepEqual(await created.json(), {
      success: true, data: { codes: ['CODE-A'], count: 1 }, msg: '成功创建 1 个邀请码',
    })

    const listed = await app.request('/api/v1/admin/invitation-codes?enterprise_id=9&page=1&page_size=20', {
      headers,
    })
    assert.deepEqual(await listed.json(), {
      success: true,
      data: { items: [{ id: 31, code: 'CODE-A', enterprise_id: 9 }], total: 1, page: 1, page_size: 20 },
    })
  })

  test('keeps legacy user administration routes on the unified user model', async () => {
    const app = createApp()
    const headers = { authorization: 'Bearer admin-access', 'content-type': 'application/json' }
    const listed = await app.request('/api/v1/admin/users?enterprise_id=9&status=1&keyword=旧', { headers })
    assert.equal(listed.status, 200)
    assert.equal((await listed.json() as any).data[0].id, 17)

    const created = await app.request('/api/v1/admin/users-password', {
      method: 'POST', headers,
      body: JSON.stringify({
        phone: 'new-user', nickname: '新用户', password: 'StrongPass123',
        enterprise_id: 9, invitation_code_id: 31,
      }),
    })
    assert.deepEqual(await created.json(), {
      success: true, msg: '用户创建成功',
      data: { id: 18, phone: 'new-user', sudorouter_user_id: null, initial_points: 50 },
    })

    const smsCreated = await createApp('sms').request('/api/v1/admin/users', {
      method: 'POST', headers,
      body: JSON.stringify({
        phone: '13900000000', nickname: '手机用户', enterprise_id: 9, invitation_code_id: 31,
      }),
    })
    assert.equal(smsCreated.status, 200)

    const managed = await app.request('/api/v1/admin/users/17/manage', {
      method: 'POST', headers, body: JSON.stringify({ action: 'disable' }),
    })
    assert.deepEqual(await managed.json(), {
      success: true, msg: '用户已禁用', data: { status: 2 },
    })

    const role = await app.request('/api/v1/admin/users/17/role', {
      method: 'POST', headers, body: JSON.stringify({ role: 'ENTERPRISE_ADMIN' }),
    })
    assert.deepEqual(await role.json(), { success: true, msg: '角色更新成功' })

    const deleted = await app.request('/api/v1/admin/users/17', { method: 'DELETE', headers })
    assert.deepEqual(await deleted.json(), { success: true, msg: '用户删除成功，所有关联数据已清除' })
  })

  test('updates the current profile through the canonical user', async () => {
    const app = createApp()
    const response = await app.request('/api/v1/user/update-profile', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer access-token' },
      body: JSON.stringify({ nickname: ' 新昵称 ' }),
    })
    assert.deepEqual(await response.json(), { success: true, msg: '昵称已更新' })
  })

  test('keeps CAS direct, callback, exchange, and logout callback protocols', async () => {
    const app = createApp('cas')
    const direct = await app.request('/api/v1/auth/third-party/cas/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'cas-main', ticket: 'ST-1', service: 'https://api.test/callback' }),
    })
    assert.equal((await direct.json() as any).data.access_token, 'cas-access')

    const callback = await app.request('/api/v1/auth/third-party/cas/callback/cas-main?ticket=ST-1')
    assert.match(callback.headers.get('content-type') ?? '', /^text\/html/)
    assert.match(await callback.text(), /sudowork:\/\/cas-callback\/cas-main\/callback\?code=handoff/)

    const exchange = await app.request('/api/v1/auth/third-party/cas/exchange', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'cas-main', code: 'handoff' }),
    })
    assert.equal((await exchange.json() as any).data.refresh_token, 'cas-refresh')

    const logout = await app.request('/api/v1/auth/third-party/cas/logout/callback/cas-main')
    assert.match(await logout.text(), /sudowork:\/\/cas-callback\/cas-main\/logout/)
  })

  test('mounts QMS on the same Sudowork host app and reuses the unified legacy actor', async () => {
    const calls: string[] = []
    const app = createApp('password', undefined, {
      qms: {
        apiKeyHeader: 'X-QMS-Key',
        authorization: new QmsAuthorizationService({
          apiKey: 'qms-secret',
          organizations: { getCode: () => 'ENT-A', hasCode: code => code === 'ENT-A' },
        }),
        encryption: { encryptionRequired: false },
        operations: {
          async execute(input) {
            calls.push(`${input.key}:${input.scope?.userId ?? 'api-key'}`)
            return { status: 200, body: { success: true } }
          },
        },
      },
    })

    const health = await app.request('/api/v1/qms/system/health', {
      headers: { authorization: 'Bearer admin-access' },
    })
    const telemetry = await app.request('/api/v1/telemetry/perf', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-QMS-Key': 'qms-secret' },
      body: JSON.stringify({ tenant_id: 'ENT-A' }),
    })

    assert.equal(health.status, 200)
    assert.equal(telemetry.status, 200)
    assert.deepEqual(calls, [
      'GET /api/v1/qms/system/health:admin-a',
      'POST /api/v1/telemetry/perf:api-key',
    ])
  })
})
