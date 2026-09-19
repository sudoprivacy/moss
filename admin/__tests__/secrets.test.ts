import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ConfigItem } from '../lib/api/secrets'

type BackendSecretListFixture = {
  namespace: string
  key: string
  enabled: boolean
  version: number
}

type Call = {
  method: 'get' | 'post' | 'put'
  path: string
  body?: unknown
}

let calls: Call[] = []
let getResponses = new Map<string, unknown>()
let postHandler: (path: string, body?: unknown) => unknown
let putHandler: (path: string, body?: unknown) => unknown

const dcClient = {
  get<T>(path: string): Promise<T> {
    calls.push({ method: 'get', path })
    const response = getResponses.get(path)
    if (response === undefined) return Promise.reject(new Error(`Unexpected GET ${path}`))
    return Promise.resolve(response as T)
  },
  post<T>(path: string, body?: unknown): Promise<T> {
    calls.push({ method: 'post', path, body })
    return Promise.resolve(postHandler(path, body) as T)
  },
  put<T>(path: string, body?: unknown): Promise<T> {
    calls.push({ method: 'put', path, body })
    return Promise.resolve(putHandler(path, body) as T)
  },
}

mock.module('../lib/api/client', () => ({ dcClient }))

let secrets: typeof import('../lib/api/secrets')

const ok = (data?: unknown) => ({ success: true, data })

function configItem(id: number, pinyin = `service-${id}`): ConfigItem {
  return {
    id,
    name: pinyin,
    description: `${pinyin} configuration`,
    icon: null,
    icon_url: null,
    pinyin,
    scope: 'system',
    url_pattern: null,
    scheme: 'bearer',
    bearer_prefix: null,
    auth_type: null,
    token_url: null,
    token_request_json: null,
    mint_script: null,
    body_auth_check: null,
    status: 1,
    entries: [],
    created_at: 0,
    updated_at: 0,
  }
}

function listRecord(namespace: string, key: string, enabled: boolean, version: number): BackendSecretListFixture {
  return { namespace, key, enabled, version }
}

beforeAll(async () => {
  secrets = await import('../lib/api/secrets')
})

beforeEach(() => {
  calls = []
  getResponses = new Map()
  postHandler = path => {
    throw new Error(`Unexpected POST ${path}`)
  }
  putHandler = path => {
    throw new Error(`Unexpected PUT ${path}`)
  }
})

describe('secret list adapters', () => {
  test('maps enterprise and department metadata without reading plaintext', async () => {
    const enterpriseEmptyValue = Object.assign(
      listRecord('org:acme:system:github', 'token', true, 3),
      { value: '' },
    ) as BackendSecretListFixture
    const disabledDepartment = listRecord('org:acme:role:slack', 'webhook', false, 8)
    Object.defineProperty(disabledDepartment, 'value', {
      enumerable: true,
      get() {
        throw new Error('list adapters must not read secret values')
      },
    })

    const github = configItem(1, 'github')
    const slack = configItem(2, 'slack')
    getResponses.set('/api/v1/secrets', ok([enterpriseEmptyValue]))
    getResponses.set('/api/v1/department-secrets', ok([disabledDepartment]))

    const [enterprise, department] = await Promise.all([
      secrets.getEnterpriseSecrets([github]),
      secrets.getDepartmentSecrets([slack]),
    ])

    expect(enterprise).toEqual([{
      namespace: 'org:acme:system:github',
      key: 'token',
      status: 'enabled',
      version: 3,
      config_item: github,
    }])
    expect(department).toEqual([{
      namespace: 'org:acme:role:slack',
      key: 'webhook',
      status: 'disabled',
      version: 8,
      config_item: slack,
    }])
    expect('value' in enterprise[0]).toBe(false)
    expect('value' in department[0]).toBe(false)
  })

  test('keeps saved-record state independent of plaintext and filters empty or unknown lists', async () => {
    const github = configItem(1, 'github')
    const savedEmpty = Object.assign(
      listRecord('org:acme:system:github', 'token', true, 1),
      { value: '' },
    ) as BackendSecretListFixture
    const savedDisabled = listRecord('org:acme:system:github', 'legacy-token', false, 2)

    getResponses.set('/api/v1/secrets', ok([savedEmpty, savedDisabled]))
    const saved = await secrets.getEnterpriseSecrets([github])
    expect(saved.map(({ key, status, version }) => ({ key, status, version }))).toEqual([
      { key: 'token', status: 'enabled', version: 1 },
      { key: 'legacy-token', status: 'disabled', version: 2 },
    ])
    expect(saved.every(entry => !('value' in entry))).toBe(true)

    getResponses.set('/api/v1/secrets', ok([]))
    expect(await secrets.getEnterpriseSecrets([github])).toEqual([])

    getResponses.set('/api/v1/secrets', ok([
      listRecord('org:acme:system:not-configured', 'token', true, 1),
    ]))
    expect(await secrets.getEnterpriseSecrets([github])).toEqual([])
  })

  test('uses the loaded config page for joins without fetching all configs or secret values', async () => {
    const allConfigs = Array.from({ length: 21 }, (_, index) => configItem(index + 1))
    const finalConfig = allConfigs[20]
    getResponses.set('/api/v1/config-items?page=2&page_size=20', {
      success: true,
      data: [finalConfig],
      total: 21,
      page: 2,
      page_size: 20,
    })

    const page = await secrets.getConfigItems({ page: 2, page_size: 20 })
    expect(page).toEqual({ items: [finalConfig], total: 21, page: 2, page_size: 20 })

    calls = []
    getResponses.set('/api/v1/secrets', ok(allConfigs.map(item =>
      listRecord(`org:acme:system:${item.pinyin}`, 'token', item.id !== 21, item.id),
    )))
    const result = await secrets.getEnterpriseSecrets(page.items)

    expect(result).toHaveLength(1)
    expect(result[0].config_item).toBe(finalConfig)
    expect(result[0]).toMatchObject({ key: 'token', status: 'disabled', version: 21 })
    expect(calls).toEqual([{ method: 'get', path: '/api/v1/secrets' }])
  })
})

describe('secret mutation contracts', () => {
  test('posts enable and disable routes and exposes refreshed metadata', async () => {
    const namespace = 'org:acme:system:github'
    const github = configItem(1, 'github')
    const records = [
      listRecord(namespace, 'api key', false, 4),
      listRecord(namespace, 'legacy', true, 7),
    ]
    getResponses.set('/api/v1/secrets', ok(records))
    postHandler = path => {
      if (path.endsWith('/api%20key/enable')) {
        records[0].enabled = true
      } else if (path.endsWith('/legacy/disable')) {
        records[1].enabled = false
      } else {
        throw new Error(`Unexpected POST ${path}`)
      }
      return ok()
    }

    await secrets.enableSecret(namespace, 'api key')
    const afterEnable = await secrets.getEnterpriseSecrets([github])
    await secrets.disableSecret(namespace, 'legacy')
    const afterDisable = await secrets.getEnterpriseSecrets([github])

    expect(calls.filter(call => call.method === 'post').map(call => call.path)).toEqual([
      '/api/v1/secrets/org%3Aacme%3Asystem%3Agithub/api%20key/enable',
      '/api/v1/secrets/org%3Aacme%3Asystem%3Agithub/legacy/disable',
    ])
    expect(afterEnable.map(({ key, status, version }) => ({ key, status, version }))).toEqual([
      { key: 'api key', status: 'enabled', version: 4 },
      { key: 'legacy', status: 'enabled', version: 7 },
    ])
    expect(afterDisable.map(({ key, status, version }) => ({ key, status, version }))).toEqual([
      { key: 'api key', status: 'enabled', version: 4 },
      { key: 'legacy', status: 'disabled', version: 7 },
    ])
  })

  test('retains put content in the fixture while the refreshed list marks the record saved', async () => {
    const namespace = 'org:acme:system:github'
    const key = 'token'
    const github = configItem(1, 'github')
    let storedValue: string | null = null
    const records: BackendSecretListFixture[] = []
    const secretPath = '/api/v1/secrets/org%3Aacme%3Asystem%3Agithub/token'

    putHandler = (path, body) => {
      expect(path).toBe(secretPath)
      expect(body).toEqual({ value: 'stored content' })
      storedValue = (body as { value: string }).value
      records.push(listRecord(namespace, key, true, 1))
      return ok()
    }
    getResponses.set('/api/v1/secrets', ok(records))

    await secrets.putSecret(namespace, key, 'stored content')
    getResponses.set(secretPath, ok({
      namespace,
      key,
      enabled: true,
      current_version: 1,
      value: storedValue,
    }))
    const detail = await secrets.getSecret(namespace, key)
    const refreshed = await secrets.getEnterpriseSecrets([github])

    expect(detail.value).toBe('stored content')
    expect(refreshed.map(({ key: refreshedKey, status, version }) => ({ key: refreshedKey, status, version }))).toEqual([
      { key: 'token', status: 'enabled', version: 1 },
    ])
    expect('value' in refreshed[0]).toBe(false)
  })

  test('keeps user-secret values on the value-bearing endpoint', async () => {
    const github = configItem(1, 'github')
    getResponses.set('/api/v1/me/secrets', ok([{
      namespace: 'user:42:github',
      key: 'token',
      enabled: true,
      current_version: 9,
      value: 'user plaintext',
    }]))

    const userSecrets = await secrets.getUserSecrets([github])

    expect(userSecrets).toHaveLength(1)
    expect(userSecrets[0]).toMatchObject({
      namespace: 'user:42:github',
      key: 'token',
      status: 'enabled',
      version: 9,
      value: 'user plaintext',
      config_item: github,
    })
  })
})
