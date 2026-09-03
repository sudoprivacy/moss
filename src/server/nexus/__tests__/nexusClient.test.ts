import { describe, expect, it } from 'bun:test'
import { create, toBinary, fromBinary } from '@bufbuild/protobuf'
import {
  PutSecretRequestSchema,
  PutSecretResponseSchema,
  GetSecretRequestSchema,
  GetSecretResponseSchema,
  DeleteSecretRequestSchema,
  DeleteSecretResponseSchema,
  RestoreSecretRequestSchema,
  RestoreSecretResponseSchema,
  ListSecretsRequestSchema,
  ListSecretsResponseSchema,
  SecretMetadataSchema,
  BatchGetSecretsRequestSchema,
  BatchGetSecretsResponseSchema,
} from '../generated/nexus/secrets/v1/secrets_pb.js'
import { NexusClient } from '../nexusClient.js'

interface FakeEntry {
  ns: string
  key: string
  value: string
  version: number
  deleted: boolean
}

/**
 * FakeNative — 模拟 native NexusGrpcClient + 加密服务语义。
 * 响应用真实 proto 编码构造，因此本测试同时覆盖 nexusSecretClient 的
 * 编解码正确性。业务 NotFound 按点分路由的真实形态压平为
 * "method not found" 字符串抛出（对齐 RustCallError::NotFound 的 Display）。
 */
class FakeNative {
  entries: FakeEntry[] = []
  calls: string[] = []

  private find(ns: string, key: string): FakeEntry | undefined {
    return this.entries.find(e => e.ns === ns && e.key === key)
  }

  set(ns: string, key: string, value: string, version = 1, deleted = false): void {
    this.entries.push({ ns, key, value, version, deleted })
  }

  callBinary(method: string, payload: Buffer, _authToken: string): Buffer {
    const short = method.replace('password-vault.', '')
    this.calls.push(short)
    const bytes = new Uint8Array(payload)
    switch (short) {
      case 'secret_put': {
        const req = fromBinary(PutSecretRequestSchema, bytes)
        const existing = this.find(req.namespace, req.key)
        const version = (existing?.version ?? 0) + 1
        if (existing) {
          existing.value = req.value
          existing.version = version
          existing.deleted = false
        } else {
          this.entries.push({ ns: req.namespace, key: req.key, value: req.value, version, deleted: false })
        }
        // 对齐真实服务端：do_put 总是返回完整 metadata
        const resp = create(PutSecretResponseSchema, {
          metadata: create(SecretMetadataSchema, {
            namespace: req.namespace,
            key: req.key,
            currentVersion: version,
            deleted: false,
          }),
        })
        return Buffer.from(toBinary(PutSecretResponseSchema, resp))
      }
      case 'secret_get': {
        const req = fromBinary(GetSecretRequestSchema, bytes)
        const entry = this.find(req.namespace, req.key)
        if (!entry || entry.deleted) {
          throw new Error('gRPC call failed: password-vault.secret_get: method not found')
        }
        const resp = create(GetSecretResponseSchema, {
          namespace: req.namespace,
          key: req.key,
          value: entry.value,
          version: entry.version,
        })
        return Buffer.from(toBinary(GetSecretResponseSchema, resp))
      }
      case 'secret_delete': {
        const req = fromBinary(DeleteSecretRequestSchema, bytes)
        const entry = this.find(req.namespace, req.key)
        if (entry) entry.deleted = true
        const resp = create(DeleteSecretResponseSchema, {
          namespace: req.namespace,
          key: req.key,
          deleted: true,
        })
        return Buffer.from(toBinary(DeleteSecretResponseSchema, resp))
      }
      case 'secret_restore': {
        const req = fromBinary(RestoreSecretRequestSchema, bytes)
        const entry = this.find(req.namespace, req.key)
        if (entry) entry.deleted = false
        const resp = create(RestoreSecretResponseSchema, { restored: true })
        return Buffer.from(toBinary(RestoreSecretResponseSchema, resp))
      }
      case 'secret_list': {
        const req = fromBinary(ListSecretsRequestSchema, bytes)
        const resp = create(ListSecretsResponseSchema, {})
        for (const e of this.entries) {
          if (req.namespace && req.namespace !== e.ns) continue
          if (!req.includeDeleted && e.deleted) continue
          resp.secrets.push(create(SecretMetadataSchema, {
            namespace: e.ns,
            key: e.key,
            currentVersion: e.version,
            deleted: e.deleted,
          }))
        }
        return Buffer.from(toBinary(ListSecretsResponseSchema, resp))
      }
      case 'secret_batch_get': {
        const req = fromBinary(BatchGetSecretsRequestSchema, bytes)
        const resp = create(BatchGetSecretsResponseSchema, {})
        for (const q of req.queries) {
          const entry = this.find(q.namespace, q.key)
          if (!entry || entry.deleted) continue // 静默省略语义
          resp.secrets[`${q.namespace}:${q.key}`] = entry.value
        }
        return Buffer.from(toBinary(BatchGetSecretsResponseSchema, resp))
      }
      default:
        throw new Error(`gRPC call failed: unknown method ${method}`)
    }
  }
}

function makeClient(fake: FakeNative): NexusClient {
  const client = new NexusClient('http://127.0.0.1:2126')
  // 覆盖 private getClient（TS 私有仅为编译期）注入 fake native
  ;(client as unknown as Record<string, unknown>).getClient = () => fake
  return client
}

describe('NexusClient（加密服务门面语义）', () => {
  it('getSecret: 不存在的 key 返回 null（batch_get 静默省略）', async () => {
    const fake = new FakeNative()
    const client = makeClient(fake)
    expect(await client.getSecret('moss:config', 'missing')).toBeNull()
    expect(fake.calls).toEqual(['secret_batch_get'])
  })

  it('getSecret: 存在的 key 返回 value/version/status=enabled（两段式）', async () => {
    const fake = new FakeNative()
    fake.set('moss:config', 'k', 'v1', 3)
    const client = makeClient(fake)
    expect(await client.getSecret('moss:config', 'k')).toEqual({
      value: 'v1',
      status: 'enabled',
      version: 3,
    })
    expect(fake.calls).toEqual(['secret_batch_get', 'secret_get'])
  })

  it('putSecret: 走 secret_put', async () => {
    const fake = new FakeNative()
    const client = makeClient(fake)
    await client.putSecret('ns', 'k', 'v')
    expect(fake.calls).toEqual(['secret_put'])
    expect(fake.entries[0]).toEqual({ ns: 'ns', key: 'k', value: 'v', version: 1, deleted: false })
  })

  it('deleteSecret: 不存在静默成功（不触发 secret_delete）；存在则软删', async () => {
    const fake = new FakeNative()
    const client = makeClient(fake)
    await client.deleteSecret('ns', 'missing')
    expect(fake.calls).toEqual(['secret_list'])

    fake.set('ns', 'k', 'v')
    await client.deleteSecret('ns', 'k')
    expect(fake.calls[fake.calls.length - 1]).toBe('secret_delete')
    expect(fake.entries[0].deleted).toBe(true)
  })

  it('enableSecret: 不存在静默成功；软删项走 secret_restore 恢复', async () => {
    const fake = new FakeNative()
    fake.set('ns', 'k', 'v', 1, true)
    const client = makeClient(fake)
    await client.enableSecret('ns', 'missing')
    expect(fake.calls).toEqual(['secret_list'])
    await client.enableSecret('ns', 'k')
    expect(fake.calls[fake.calls.length - 1]).toBe('secret_restore')
    expect(fake.entries[0].deleted).toBe(false)
  })

  it('disableSecret: 不存在静默成功；存在软删', async () => {
    const fake = new FakeNative()
    fake.set('ns', 'k', 'v')
    const client = makeClient(fake)
    await client.disableSecret('ns', 'missing')
    expect(fake.calls).toEqual(['secret_list'])
    await client.disableSecret('ns', 'k')
    expect(fake.calls[fake.calls.length - 1]).toBe('secret_delete')
    expect(fake.entries[0].deleted).toBe(true)
  })

  it('listSecrets: 前缀过滤 + status 映射 + 软删项 value 为 null', async () => {
    const fake = new FakeNative()
    fake.set('org:1:system:weather', 'token', 'abc', 1)
    fake.set('org:1:system:mail', 'smtp-pass', 'xyz', 2, true)
    fake.set('org:2:system:weather', 'token', 'zzz', 1)
    fake.set('user:u1:foo', 'apiKey', 'bar', 1)
    const client = makeClient(fake)
    const list = await client.listSecrets('org:1:system')
    expect(list).toEqual([
      { namespace: 'org:1:system:weather', key: 'token', value: 'abc', status: 'enabled', version: 1 },
      { namespace: 'org:1:system:mail', key: 'smtp-pass', value: null, status: 'disabled', version: 2 },
    ])
  })

  it('listConfiguredNamespaces: DISTINCT + 前缀', () => {
    const fake = new FakeNative()
    fake.set('org:1:system:weather', 'token', 'a')
    fake.set('org:1:role:dept1', 'apiKey', 'b')
    fake.set('user:u1:foo', 'apiKey', 'c')
    const client = makeClient(fake)
    expect(client.listConfiguredNamespaces('org:1'))
      .toEqual(new Set(['org:1:system:weather', 'org:1:role:dept1']))
    expect(client.listConfiguredNamespaces())
      .toEqual(new Set(['org:1:system:weather', 'org:1:role:dept1', 'user:u1:foo']))
  })
})
