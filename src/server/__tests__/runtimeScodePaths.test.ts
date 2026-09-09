import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getDefaultServerConfig, readServerConfig } from '../config.js'
import { resolveRuntimeScodePath } from '../runtimeScodePath.js'
import type { ServerConfig } from '../types.js'

const config = {
  defaultRuntime: 'docker',
  engine: 'scode',
  scodePath: '/legacy/scode',
  hostScodePath: '/opt/moss/bin/scode',
  dockerScodePath: '/usr/local/bin/scode',
} as ServerConfig

describe('runtime scode paths', () => {
  it('selects the path for each runtime type', () => {
    expect(resolveRuntimeScodePath(config, 'host')).toBe('/opt/moss/bin/scode')
    expect(resolveRuntimeScodePath(config, 'docker')).toBe('/usr/local/bin/scode')
  })

  it('keeps explicit and legacy scode paths compatible', () => {
    expect(resolveRuntimeScodePath(config, 'host', '/custom/scode')).toBe('/custom/scode')
    expect(resolveRuntimeScodePath({ ...config, hostScodePath: undefined }, 'host'))
      .toBe('/legacy/scode')
    expect(resolveRuntimeScodePath({ ...config, dockerScodePath: undefined }, 'docker'))
      .toBe('/legacy/scode')
  })

  it('only expands the host path on the host filesystem', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'moss-scode-config-'))
    const configPath = join(dir, 'server.json')
    const raw = getDefaultServerConfig()
    raw.runtimeDefaults.hostScodePath = './bin/scode'
    raw.runtimeDefaults.dockerScodePath = 'scode'
    writeFileSync(configPath, JSON.stringify(raw), 'utf8')

    try {
      const { config: loaded } = await readServerConfig(configPath)
      expect(loaded.hostScodePath).toBe(join(process.cwd(), 'bin', 'scode'))
      expect(loaded.dockerScodePath).toBe('scode')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('loads non-secret Sudowork compatibility settings and keeps secrets out of server.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'moss-sudowork-config-'))
    const configPath = join(dir, 'server.json')
    const raw = getDefaultServerConfig()
    raw.sudoworkCompatibility = {
      enabled: true,
      hosts: ['api.sudowork.test'],
      publicBaseUrl: 'https://api.sudowork.test/',
      loginMethod: 'sms',
      dify: { baseUrl: 'https://dify.sudowork.test/' },
      sms: {
        provider: 'tencent',
        sdkAppId: '1400000000',
        signName: '测试签名',
        templateId: '1234',
        signId: '5678',
        region: 'ap-beijing',
        codeLength: 6,
        expireMinutes: 5,
        sendIntervalSeconds: 60,
        maxPerDay: 10,
      },
    }
    writeFileSync(configPath, JSON.stringify(raw), 'utf8')
    process.env.SUDOWORK_LEGACY_JWT_SECRET = 'env-jwt'
    process.env.SUDOWORK_REDIS_URL = 'redis://env'
    process.env.SUDOWORK_TENCENT_SECRET_ID = 'env-secret-id'
    process.env.SUDOWORK_TENCENT_SECRET_KEY = 'env-secret-key'
    process.env.DIFY_SYSTEM_TOKEN = 'env-system-token'
    process.env.DIFY_SYSTEM_SECRET = 'env-system-secret'
    process.env.DIFY_SSO_SECRET = 'env-sso-secret'

    try {
      const { config: loaded } = await readServerConfig(configPath)
      expect(loaded.sudoworkCompatibility).toEqual({
        enabled: true,
        hosts: ['api.sudowork.test'],
        publicBaseUrl: 'https://api.sudowork.test',
        loginMethod: 'sms',
        legacyJwtSecret: 'env-jwt',
        redisUrl: 'redis://env',
        dify: {
          baseUrl: 'https://dify.sudowork.test',
          systemToken: 'env-system-token',
          provisionSecret: 'env-system-secret',
          ssoSecret: 'env-sso-secret',
        },
        sms: {
          provider: 'tencent', sdkAppId: '1400000000', signName: '测试签名',
          templateId: '1234', signId: '5678', region: 'ap-beijing', codeLength: 6,
          expireMinutes: 5, sendIntervalSeconds: 60, maxPerDay: 10,
          secretId: 'env-secret-id', secretKey: 'env-secret-key',
        },
      })
      const persisted = JSON.parse(readFileSync(configPath, 'utf8'))
      expect(persisted.sudoworkCompatibility.legacyJwtSecret).toBeUndefined()
      expect(persisted.sudoworkCompatibility.redisUrl).toBeUndefined()
      expect(persisted.sudoworkCompatibility.dify.systemToken).toBeUndefined()
      expect(persisted.sudoworkCompatibility.dify.provisionSecret).toBeUndefined()
      expect(persisted.sudoworkCompatibility.dify.ssoSecret).toBeUndefined()
      expect(persisted.sudoworkCompatibility.loginMethod).toBe('sms')
    } finally {
      delete process.env.SUDOWORK_LEGACY_JWT_SECRET
      delete process.env.SUDOWORK_REDIS_URL
      delete process.env.SUDOWORK_TENCENT_SECRET_ID
      delete process.env.SUDOWORK_TENCENT_SECRET_KEY
      delete process.env.DIFY_SYSTEM_TOKEN
      delete process.env.DIFY_SYSTEM_SECRET
      delete process.env.DIFY_SSO_SECRET
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fills complete SMS defaults when an older server.json has no Sudowork section', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'moss-sudowork-defaults-'))
    const configPath = join(dir, 'server.json')
    const raw = getDefaultServerConfig()
    delete raw.sudoworkCompatibility
    writeFileSync(configPath, JSON.stringify(raw), 'utf8')

    try {
      const { config: loaded } = await readServerConfig(configPath)
      expect(loaded.sudoworkCompatibility.sms).toEqual({
        provider: 'disabled', sdkAppId: '', signName: '', templateId: '', signId: '',
        region: 'ap-beijing', codeLength: 6, expireMinutes: 5,
        sendIntervalSeconds: 60, maxPerDay: 10,
        secretId: undefined, secretKey: undefined,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('loads QMS policy while keeping database, queue, API and RSA secrets out of server.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'moss-qms-config-'))
    const configPath = join(dir, 'server.json')
    const raw = getDefaultServerConfig()
    raw.qms = {
      enabled: true,
      apiKeyHeader: 'X-QMS-Key',
      queueFlushIntervalMs: 1500,
      queueBatchSize: 25,
      perfRetentionDays: 30,
      conversationRetentionDays: 60,
      encryptionRequired: true,
    }
    writeFileSync(configPath, JSON.stringify(raw), 'utf8')
    process.env.QMS_POSTGRES_URL = 'postgres://qms:secret@db.internal/qms'
    process.env.QMS_REDIS_URL = 'redis://cache.internal/3'
    process.env.QMS_API_KEY = 'qms-api-key'
    process.env.QMS_TELEMETRY_PRIVATE_KEY = 'private-key'
    process.env.QMS_TELEMETRY_PUBLIC_KEY = 'public-key'

    try {
      const { config: loaded } = await readServerConfig(configPath)
      expect(loaded.qms.enabled).toBe(true)
      expect(loaded.qms.apiKeyHeader).toBe('X-QMS-Key')
      expect(loaded.qms.secrets.postgresUrl).toBe('postgres://qms:secret@db.internal/qms')
      expect(loaded.qms.secrets.redisUrl).toBe('redis://cache.internal/3')
      expect(loaded.qms.secrets.apiKey).toBe('qms-api-key')
      expect(loaded.qms.secrets.privateKeyPem).toBe('private-key')
      const persisted = JSON.parse(readFileSync(configPath, 'utf8'))
      expect(persisted.qms.postgresUrl).toBeUndefined()
      expect(persisted.qms.redisUrl).toBeUndefined()
      expect(persisted.qms.apiKey).toBeUndefined()
      expect(persisted.qms.privateKeyPem).toBeUndefined()
    } finally {
      delete process.env.QMS_POSTGRES_URL
      delete process.env.QMS_REDIS_URL
      delete process.env.QMS_API_KEY
      delete process.env.QMS_TELEMETRY_PRIVATE_KEY
      delete process.env.QMS_TELEMETRY_PUBLIC_KEY
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps host and Docker release scode versions aligned', () => {
    const root = join(import.meta.dir, '..', '..', '..')
    const workflow = readFileSync(join(root, '.github/workflows/build-release.yml'), 'utf8')
    const hostDockerfile = readFileSync(join(root, 'deploy/server.Dockerfile.local'), 'utf8')
    const runtimeDockerfile = readFileSync(join(root, 'deploy/runtime/Dockerfile'), 'utf8')
    const packageScript = readFileSync(join(root, 'deploy/package-server.sh'), 'utf8')
    const versions = JSON.parse(
      readFileSync(join(root, 'src/server/nexus/runtime-versions.json'), 'utf8'),
    ) as Record<string, string>

    expect(versions.scode).toMatch(/^v\d+\.\d+\.\d+$/)
    expect(versions['scode-linux-x64-bundle-sha256']).toMatch(/^[0-9a-f]{64}$/)
    expect(workflow).toContain("require('./src/server/nexus/runtime-versions.json').scode")
    expect(hostDockerfile).toContain('COPY src/server/nexus/runtime-versions.json /runtime-versions.json')
    expect(hostDockerfile).toContain("SCODE_VERSION=\"$(jq -er '.scode' /runtime-versions.json)\"")
    expect(hostDockerfile).toContain('scode-linux-x64-bundle.tar.gz')
    expect(hostDockerfile).toContain('scode-linux-x64-bundle/scode /out/bin/scode')
    expect(hostDockerfile).not.toContain('scode-setup')
    expect(hostDockerfile).toContain('EXPECTED_VERSION_PATTERN=')
    expect(runtimeDockerfile).toContain('COPY src/server/nexus/runtime-versions.json /tmp/moss-runtime-versions.json')
    expect(runtimeDockerfile).toContain('require("/tmp/moss-runtime-versions.json").scode')
    expect(runtimeDockerfile).toContain('scode-linux-x64-bundle.tar.gz')
    expect(runtimeDockerfile).toContain('scode-linux-x64-bundle/scode /usr/local/bin/scode')
    expect(runtimeDockerfile).not.toContain('scode-setup')
    expect(packageScript).not.toContain('SCODE_VERSION')
    expect(hostDockerfile).toContain('COPY --from=host-scode-runtime /usr/local/bin/scode ./app/bin/scode')
  })
})
