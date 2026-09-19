import { describe, expect, it } from 'bun:test'
import { createSecretsApi } from '../api/secrets.js'
import { NexusClient } from '../nexus/nexusClient.js'

type NativeMetadata = {
  namespace: string
  key: string
  currentVersion: number
  deleted: boolean
}

type FakeSecretClient = {
  listSecrets: (namespace?: string, includeDeleted?: boolean) => Promise<NativeMetadata[]>
  batchGet: (queries: Array<{ namespace: string; key: string }>) => Promise<Record<string, string>>
  getSecret: (namespace: string, key: string) => Promise<{ value: string; version: number }>
}

type MetadataCall = { namespace: string | undefined; includeDeleted: boolean | undefined }

function makeNexus(entries: NativeMetadata[], listError?: Error): {
  client: NexusClient
  metadataCalls: MetadataCall[]
} {
  const metadataCalls: MetadataCall[] = []
  const fake: FakeSecretClient = {
    async listSecrets(namespace, includeDeleted) {
      metadataCalls.push({ namespace, includeDeleted })
      if (listError) throw listError
      return entries
    },
    async batchGet() {
      throw new Error('value retrieval must not be called by metadata list APIs')
    },
    async getSecret() {
      throw new Error('value retrieval must not be called by metadata list APIs')
    },
  }
  const client = new NexusClient('http://nexus-fixture.invalid:1')
  ;(client as unknown as { getSecretClient: () => FakeSecretClient }).getSecretClient = () => fake
  return { client, metadataCalls }
}

function createListApi(nexus: NexusClient) {
  const db = new Proxy({}, {
    get() {
      throw new Error('secret list APIs must not access the database')
    },
  })
  return createSecretsApi(db as never, nexus, async () => undefined)
}

function assertNoValueInSerializedResponse(result: unknown): void {
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      expect(Object.prototype.hasOwnProperty.call(record, 'value')).toBe(false)
      Object.values(record).forEach(visit)
    }
  }

  visit(JSON.parse(JSON.stringify(result)))
}

function maliciousMetadata(namespace: string, key: string, status: string, version: number) {
  const result = { namespace, key, status, version }
  Object.defineProperty(result, 'value', {
    enumerable: true,
    get() {
      throw new Error('the API must never read or spread secret values')
    },
  })
  return result
}

describe('secret metadata list APIs', () => {
  it('lists only the current organization metadata without retrieving values', async () => {
    const { client, metadataCalls } = makeNexus([
      { namespace: 'org:org-a:system:github', key: 'token', currentVersion: 3, deleted: false },
      { namespace: 'org:org-a:system:mail', key: 'smtp-password', currentVersion: 7, deleted: true },
      { namespace: 'org:org-b:system:github', key: 'token', currentVersion: 11, deleted: false },
      { namespace: 'org:org-a:role:slack', key: 'webhook', currentVersion: 1, deleted: false },
    ])
    const result = await createListApi(client).listEnterpriseSecrets('org-a', 'admin-a')

    expect(result).toEqual({
      success: true,
      data: [
        {
          namespace: 'org:org-a:system:github',
          key: 'token',
          status: 'enabled',
          version: 3,
          enabled: true,
          config_item: { pinyin: 'github' },
        },
        {
          namespace: 'org:org-a:system:mail',
          key: 'smtp-password',
          status: 'disabled',
          version: 7,
          enabled: false,
          config_item: { pinyin: 'mail' },
        },
      ],
    })
    expect(metadataCalls).toEqual([{ namespace: undefined, includeDeleted: true }])
    assertNoValueInSerializedResponse(result)
  })

  it('lists legacy and per-department metadata for the current organization only', async () => {
    const { client, metadataCalls } = makeNexus([
      { namespace: 'org:org-a:role:slack', key: 'webhook', currentVersion: 2, deleted: false },
      { namespace: 'org:org-a:role:@d1:slack', key: 'webhook', currentVersion: 8, deleted: true },
      { namespace: 'org:org-b:role:slack', key: 'webhook', currentVersion: 9, deleted: false },
      { namespace: 'org:org-a:system:github', key: 'token', currentVersion: 1, deleted: false },
    ])
    const result = await createListApi(client).listDepartmentSecrets('org-a', 'admin-a')

    expect(result).toEqual({
      success: true,
      data: [
        {
          namespace: 'org:org-a:role:slack',
          key: 'webhook',
          status: 'enabled',
          version: 2,
          enabled: true,
          department_id: null,
          config_item: { pinyin: 'slack' },
        },
        {
          namespace: 'org:org-a:role:@d1:slack',
          key: 'webhook',
          status: 'disabled',
          version: 8,
          enabled: false,
          department_id: 'd1',
          config_item: { pinyin: 'slack' },
        },
      ],
    })
    expect(metadataCalls).toEqual([{ namespace: undefined, includeDeleted: true }])
    assertNoValueInSerializedResponse(result)
  })

  it('lists a department by exact colon-delimited prefix without crossing d1 into d10', async () => {
    const { client, metadataCalls } = makeNexus([
      { namespace: 'org:org-a:role:@d1:slack', key: 'webhook', currentVersion: 4, deleted: false },
      { namespace: 'org:org-a:role:@d10:slack', key: 'webhook', currentVersion: 5, deleted: true },
      { namespace: 'org:org-b:role:@d1:slack', key: 'webhook', currentVersion: 6, deleted: false },
      { namespace: 'org:org-a:role:slack', key: 'webhook', currentVersion: 7, deleted: false },
    ])
    const result = await createListApi(client).listDepartmentSecretsForDept('org-a', 'admin-a', 'd1')

    expect(result).toEqual({
      success: true,
      data: [
        {
          namespace: 'org:org-a:role:@d1:slack',
          key: 'webhook',
          status: 'enabled',
          version: 4,
          enabled: true,
          department_id: 'd1',
          config_item: { pinyin: 'slack' },
        },
      ],
    })
    expect(metadataCalls).toEqual([{ namespace: undefined, includeDeleted: true }])
    assertNoValueInSerializedResponse(result)
  })

  it('allowlists metadata fields without touching an enumerable secret value getter', async () => {
    const { client } = makeNexus([])
    const metadata = [
      maliciousMetadata('org:org-a:system:github', 'token', 'enabled', 1),
      maliciousMetadata('org:org-a:role:slack', 'webhook', 'disabled', 2),
      maliciousMetadata('org:org-a:role:@d1:slack', 'webhook', 'enabled', 3),
    ]
    ;(client as unknown as {
      listSecretMetadata: (namespace?: string, subject?: string) => Promise<typeof metadata>
    }).listSecretMetadata = async (namespace) => metadata.filter(entry =>
      !namespace || entry.namespace === namespace || entry.namespace.startsWith(`${namespace}:`),
    )
    const api = createListApi(client)

    const enterprise = await api.listEnterpriseSecrets('org-a', 'admin-a')
    const departments = await api.listDepartmentSecrets('org-a', 'admin-a')
    const department = await api.listDepartmentSecretsForDept('org-a', 'admin-a', 'd1')

    expect(enterprise.success).toBe(true)
    expect(departments.success).toBe(true)
    expect(department.success).toBe(true)
    assertNoValueInSerializedResponse(enterprise)
    assertNoValueInSerializedResponse(departments)
    assertNoValueInSerializedResponse(department)
  })

  it('returns the canonical store-unavailable error without falling back to value lists', async () => {
    const { client, metadataCalls } = makeNexus([], new Error('native storage failure with internal details'))
    let valueListCalls = 0
    ;(client as unknown as {
      listSecrets: (namespace?: string, subject?: string) => Promise<never>
    }).listSecrets = async () => {
      valueListCalls += 1
      throw new Error('value-bearing fallback must not be called')
    }
    const api = createListApi(client)
    const expected = {
      success: false,
      error: { code: 'secret_store_unavailable', message: '凭据存储服务不可用' },
    }

    expect(await api.listEnterpriseSecrets('org-a', 'admin-a')).toEqual(expected)
    expect(await api.listDepartmentSecrets('org-a', 'admin-a')).toEqual(expected)
    expect(await api.listDepartmentSecretsForDept('org-a', 'admin-a', 'd1')).toEqual(expected)
    expect(valueListCalls).toBe(0)
    expect(metadataCalls).toEqual([
      { namespace: undefined, includeDeleted: true },
      { namespace: undefined, includeDeleted: true },
      { namespace: undefined, includeDeleted: true },
    ])
  })
})
