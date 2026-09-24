import { randomUUID, createPrivateKey, createPublicKey } from 'node:crypto'
import type { DbDriver } from '../db/driver.js'
import { PlatformIntegrationSettingsRepository } from './platformIntegrationSettingsRepository.js'
import { PLATFORM_DEFINITIONS, PLATFORM_PROVIDERS, type PlatformProvider, type PlatformValues } from './platformConfigDefinition.js'

export const PLATFORM_SECRET_NAMESPACE = 'moss:platform-config'
export interface PlatformVault {
  getSecret(namespace: string, key: string): Promise<{ value: string | null } | null>
  putSecret(namespace: string, key: string, value: string): Promise<unknown>
  deleteSecret(namespace: string, key: string): Promise<unknown>
}
export interface PlatformSnapshot {
  config: PlatformValues
  secrets: Record<string, string>
  sources: Record<string, string>
  conflicts?: string[]
}
interface SavedProvider {
  version: string
  config: PlatformValues
  secretRefs: Record<string, string>
  updatedBy: string
  updatedAt: number
}
export class PlatformConfigError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message) }
}
export class PlatformConfigService {
  private readonly repository: PlatformIntegrationSettingsRepository
  private readonly active = new Map<PlatformProvider, { version: string | null; snapshot: PlatformSnapshot }>()
  constructor(private readonly options: {
    driver: DbDriver
    vault: PlatformVault
    legacy: (providers: PlatformProvider[]) => Promise<Partial<Record<PlatformProvider, PlatformSnapshot>>>
    instanceId: string
  }) { this.repository = new PlatformIntegrationSettingsRepository(options.driver) }

  async initialize(): Promise<void> {
    const savedProviders = new Map(await Promise.all(PLATFORM_PROVIDERS.map(async id => [id, await this.readSaved(id)] as const)))
    const legacy = await this.options.legacy(PLATFORM_PROVIDERS.filter(id => !savedProviders.get(id)))
    for (const id of PLATFORM_PROVIDERS) {
      const saved = savedProviders.get(id)
      const snapshot = saved ? await this.readSnapshot(id, saved) : legacy[id]
      if (!snapshot) throw new PlatformConfigError(500, `平台配置未加载: ${id}`)
      this.active.set(id, { version: saved?.version ?? null, snapshot })
    }
    await this.reportVersions()
  }

  getActive(id: PlatformProvider): PlatformSnapshot {
    const active = this.active.get(id)
    if (!active) throw new Error('Platform configuration has not been initialized')
    return structuredClone(active.snapshot)
  }
  isManaged(id: PlatformProvider): boolean { return this.active.get(id)?.version != null }
  async hasSaved(id: PlatformProvider): Promise<boolean> { return Boolean(await this.readSaved(id)) }

  async list() {
    const items = []
    for (const id of PLATFORM_PROVIDERS) {
      const saved = await this.readSaved(id)
      const snapshot = saved ? await this.readSnapshot(id, saved) : this.getActive(id)
      items.push({ id, ...PLATFORM_DEFINITIONS[id], config: snapshot.config,
        secrets: Object.fromEntries(PLATFORM_DEFINITIONS[id].fields.filter(f => f.type === 'secret').map(f => [f.key, Boolean(snapshot.secrets[f.key])])),
        sources: snapshot.sources, conflicts: snapshot.conflicts ?? [],
        managed: Boolean(saved), version: saved?.version ?? null, activeVersion: this.active.get(id)?.version ?? null,
        restartRequired: (saved?.version ?? null) !== (this.active.get(id)?.version ?? null),
        issues: validatePlatformConfig(id, snapshot), updatedAt: saved?.updatedAt ?? null,
      })
    }
    const instances = await this.options.driver.all<{ value_json: string }>(
      "SELECT value_json FROM platform_integration_settings WHERE setting_key LIKE 'platform.instance.%'",
    )
    return { items, instanceId: this.options.instanceId, instances: instances.map(row => JSON.parse(row.value_json) as unknown) }
  }

  async check(id: PlatformProvider, input: unknown) {
    const candidate = await this.prepare(id, input)
    return { ready: validatePlatformConfig(id, candidate.snapshot).length === 0, issues: validatePlatformConfig(id, candidate.snapshot) }
  }

  async save(id: PlatformProvider, input: unknown, actorId: string) {
    const candidate = await this.prepare(id, input)
    const issues = validatePlatformConfig(id, candidate.snapshot)
    if (issues.length) throw new PlatformConfigError(400, issues.join('；'))
    const version = randomUUID()
    const refs: Record<string, string> = {}
    // Stage immutable secrets first. A failed DB commit never changes the active configuration.
    for (const [key, value] of Object.entries(candidate.snapshot.secrets)) {
      if (!value) continue
      const ref = `${id}.${version}.${key}`
      await this.options.vault.putSecret(PLATFORM_SECRET_NAMESPACE, ref, value)
      const verified = await this.options.vault.getSecret(PLATFORM_SECRET_NAMESPACE, ref)
      if (verified?.value !== value) throw new PlatformConfigError(503, '凭据保存校验失败，当前配置未改变')
      refs[key] = ref
    }
    const next: SavedProvider = { version, config: candidate.snapshot.config, secretRefs: refs, updatedBy: actorId, updatedAt: Date.now() }
    const result = await this.options.driver.tryRunExclusive(`platform-config:${id}`, () => this.options.driver.transaction(async () => {
      const current = await this.readSaved(id)
      if ((current?.version ?? null) !== candidate.expectedVersion) throw new PlatformConfigError(409, '配置已被其他管理员修改，请刷新后重试')
      if (current) await this.repository.put(`platform.history.${id}.${current.version}`, { ...current }, actorId)
      await this.repository.put(`platform.v1.${id}`, { ...next }, actorId)
      return { version, restartRequired: true }
    }))
    if (!result) throw new PlatformConfigError(409, '该配置正在保存，请稍后重试')
    return result
  }

  async reportVersions(): Promise<void> {
    await this.repository.put(`platform.instance.${this.options.instanceId}`, {
      instanceId: this.options.instanceId, seenAt: Date.now(),
      versions: Object.fromEntries([...this.active].map(([id, value]) => [id, value.version])),
    }, 'runtime')
  }

  private async prepare(id: PlatformProvider, input: unknown) {
    if (!isRecord(input) || !isRecord(input.config) || !('expectedVersion' in input)
      || (input.expectedVersion !== null && typeof input.expectedVersion !== 'string')) {
      throw new PlatformConfigError(400, '配置及 expectedVersion 必填')
    }
    const configInput = input.config
    const saved = await this.readSaved(id)
    if ((saved?.version ?? null) !== input.expectedVersion) throw new PlatformConfigError(409, '配置版本已变化，请刷新')
    const previous = saved ? await this.readSnapshot(id, saved) : this.getActive(id)
    const snapshot = structuredClone(previous)
    const fields = PLATFORM_DEFINITIONS[id].fields
    for (const [key, value] of Object.entries(input.config)) {
      const field = fields.find(f => f.key === key && f.type !== 'secret')
      if (!field || !validValue(field.type, value)) throw new PlatformConfigError(400, `无效配置字段: ${key}`)
      snapshot.config[key] = typeof value === 'string' ? value.trim() : value as PlatformValues[string]
    }
    const secrets = input.secrets ?? {}
    if (!isRecord(secrets)) throw new PlatformConfigError(400, '凭据必须为对象')
    for (const [key, value] of Object.entries(secrets)) {
      if (!fields.some(f => f.key === key && f.type === 'secret') || (value !== null && typeof value !== 'string')) {
        throw new PlatformConfigError(400, `无效凭据字段: ${key}`)
      }
      if (typeof value === 'string' && value.startsWith('****')) throw new PlatformConfigError(400, '不能将脱敏占位符保存为凭据')
      snapshot.secrets[key] = typeof value === 'string' ? value.trim() : ''
    }
    // A clear must not silently resurrect an env value; managed snapshots are complete.
    if (!saved && previous.conflicts?.some(key => !(key in configInput) && !(key in secrets))) {
      throw new PlatformConfigError(409, '历史配置存在冲突，请明确填写冲突字段后再接管')
    }
    // Historical payment callbacks and telemetry ciphertext must remain readable.
    {
      const protectedFields = id === 'qms' ? ['privateKeyPem', 'publicKeyPem']
        : id === 'fuiou' ? ['merchantPrivateKey', 'publicKey'] : []
      for (const key of protectedFields) {
        if (previous.secrets[key] && snapshot.secrets[key] !== previous.secrets[key]) {
          throw new PlatformConfigError(409, '历史支付或遥测数据依赖此密钥；请先完成专门的密钥轮换迁移，不能在此直接覆盖或清除')
        }
      }
      if (id === 'fuiou' && previous.secrets.merchantPrivateKey && ['merchantCode', 'testMode'].some(key => snapshot.config[key] !== previous.config[key])) {
        throw new PlatformConfigError(409, '已启用商户的商户号或环境变更需要先处理在途订单')
      }
    }
    snapshot.conflicts = []
    return { snapshot, expectedVersion: input.expectedVersion as string | null }
  }

  private async readSaved(id: PlatformProvider): Promise<SavedProvider | undefined> {
    const row = await this.repository.get(`platform.v1.${id}`)
    if (!row) return undefined
    if (typeof row.version !== 'string' || !isRecord(row.config) || !isRecord(row.secretRefs)) throw new PlatformConfigError(500, '平台配置记录损坏')
    return row as unknown as SavedProvider
  }
  private async readSnapshot(id: PlatformProvider, saved: SavedProvider): Promise<PlatformSnapshot> {
    const secrets: Record<string, string> = {}
    for (const [key, ref] of Object.entries(saved.secretRefs)) {
      if (!ref.startsWith(`${id}.${saved.version}.`) || !PLATFORM_DEFINITIONS[id].fields.some(f => f.key === key && f.type === 'secret')) {
        throw new PlatformConfigError(500, '平台凭据引用无效')
      }
      const record = await this.options.vault.getSecret(PLATFORM_SECRET_NAMESPACE, ref)
      if (!record?.value) throw new PlatformConfigError(503, '平台凭据暂不可读取，请检查凭据服务')
      secrets[key] = record.value
    }
    return { config: saved.config, secrets, sources: Object.fromEntries(PLATFORM_DEFINITIONS[id].fields.map(f => [f.key, 'platform'])) }
  }
}
function isRecord(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v) }
function validValue(type: string, v: unknown): boolean {
  if (type === 'boolean') return typeof v === 'boolean'
  if (type === 'number') return typeof v === 'number' && Number.isSafeInteger(v)
  if (type === 'lines') return Array.isArray(v) && v.every(x => typeof x === 'string')
  return typeof v === 'string'
}
export function validatePlatformConfig(id: PlatformProvider, snapshot: PlatformSnapshot): string[] {
  const issues: string[] = []
  for (const f of PLATFORM_DEFINITIONS[id].fields) {
    const value = f.type === 'secret' ? snapshot.secrets[f.key] : snapshot.config[f.key]
    if (snapshot.config.enabled && f.required && (value === undefined || value === '')) issues.push(`缺少${f.label}`)
    if (value === undefined || value === '') continue
    if (f.type === 'number' && (!Number.isSafeInteger(value) || Number(value) < (f.min ?? 1) || Number(value) > (f.max ?? 86400000))) issues.push(`${f.label}超出有效范围`)
    if (f.type === 'url') {
      try { const url = new URL(String(value)); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error() }
      catch { issues.push(`${f.label}须为不含账号密码的 HTTP(S) 地址`) }
    }
  }
  if (id === 'sudorouter' && snapshot.config.enabled && !/^\d+$/.test(String(snapshot.config.adminUserId))) issues.push('管理员用户 ID 须为数字')
  if (id === 'sms' && snapshot.config.enabled && (!Array.isArray(snapshot.config.templateParams) || !snapshot.config.templateParams.some(x => x.includes('{code}')))) issues.push('模板参数必须包含 {code}')
  if (snapshot.config.enabled && (id === 'fuiou' || id === 'qms')) {
    const privateName = id === 'fuiou' ? 'merchantPrivateKey' : 'privateKeyPem'
    const publicName = id === 'fuiou' ? 'publicKey' : 'publicKeyPem'
    for (const [key, privatePart] of [[privateName, true], [publicName, false]] as const) {
      const value = snapshot.secrets[key]
      if (!value) continue
      try {
        const text = value.replaceAll('\\n', '\n')
        const pem = text.includes('-----BEGIN') ? text : `-----BEGIN ${privatePart ? 'PRIVATE' : 'PUBLIC'} KEY-----\n${text}\n-----END ${privatePart ? 'PRIVATE' : 'PUBLIC'} KEY-----`
        const parsed = privatePart ? createPrivateKey(pem) : createPublicKey(pem)
        if (parsed.asymmetricKeyType !== 'rsa') throw new Error()
      } catch { issues.push(`${key} 不是有效的 RSA 密钥`) }
    }
  }
  if (id === 'qms' && snapshot.config.enabled) {
    if (snapshot.config.encryptionRequired && (!snapshot.secrets.privateKeyPem || !snapshot.secrets.publicKeyPem)) issues.push('加密遥测需要公钥和私钥')
    for (const [key, protocols] of [['postgresUrl', ['postgres:', 'postgresql:']], ['redisUrl', ['redis:', 'rediss:']]] as const) {
      try {
        const url = new URL(snapshot.secrets[key] ?? '')
        if (!protocols.includes(url.protocol as never)) throw new Error()
        if (key === 'postgresUrl' && url.username === 'postgres' && url.password === 'postgres') issues.push('QMS 数据库不能使用不安全的默认账号密码')
      }
      catch { issues.push(`${key} 协议或格式无效`) }
    }
    if (!/^[A-Za-z0-9-]+$/.test(String(snapshot.config.apiKeyHeader))) issues.push('API Key 请求头格式无效')
  }
  return issues
}
