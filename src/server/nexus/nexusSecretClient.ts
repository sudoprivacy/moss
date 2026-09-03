/**
 * nexusSecretClient — GenericSecretsService（vault 插件加密 KV）的点分路由客户端。
 *
 * 单一职责：proto 编解码（@bufbuild/protobuf）+ 点分路由派发
 * （native callBinary，method 形如 "password-vault.secret_put"）。
 * 加密/解密由 nexus 服务端 vault 插件完成（AES-256-GCM），本层只搬运字节。
 *
 * 方法为同步调用：底层 native callBinary 是同步本地回环 IPC。
 * 任何底层错误原样向上抛——"通道故障/插件未加载"与"业务结果"的区分
 * 由上层（NexusClient）负责，本层不做错误字符串匹配（点分路由下业务
 * NotFound 与插件缺方法的错误文本同为 "method not found"，不可区分）。
 */

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
  BatchGetSecretsRequestSchema,
  BatchGetSecretsResponseSchema,
} from './generated/nexus/secrets/v1/secrets_pb.js'
import type {
  SecretMetadata as ProtoSecretMetadata,
} from './generated/nexus/secrets/v1/secrets_pb.js'

/** native NexusGrpcClient 的最小派发接口（由 NexusClient 注入实例）。 */
export interface NativeDispatch {
  callBinary(method: string, payload: Buffer, authToken: string): Buffer
}

export interface SecretEntryMetadata {
  namespace: string
  key: string
  description?: string
  currentVersion: number
  deleted: boolean
  createdAt?: number
  updatedAt?: number
}

function protoTimestampToMs(ts: { seconds: bigint; nanos: number } | undefined): number | undefined {
  if (!ts) return undefined
  return Number(ts.seconds) * 1000 + ts.nanos / 1_000_000
}

function toMetadata(proto: ProtoSecretMetadata): SecretEntryMetadata {
  return {
    namespace: proto.namespace,
    key: proto.key,
    description: proto.description ?? undefined,
    currentVersion: proto.currentVersion,
    deleted: proto.deleted,
    createdAt: protoTimestampToMs(proto.createdAt),
    updatedAt: protoTimestampToMs(proto.updatedAt),
  }
}

export class NexusSecretClient {
  constructor(
    private readonly native: NativeDispatch,
    private readonly authToken: string,
  ) {}

  private dispatch(method: string, payload: Uint8Array): Buffer {
    return this.native.callBinary(`password-vault.${method}`, Buffer.from(payload), this.authToken)
  }

  /** 写入（存在则新版本；隐式恢复软删）。 */
  putSecret(namespace: string, key: string, value: string): SecretEntryMetadata {
    const req = create(PutSecretRequestSchema, { namespace, key, value })
    const resp = fromBinary(
      PutSecretResponseSchema,
      new Uint8Array(this.dispatch('secret_put', toBinary(PutSecretRequestSchema, req))),
    )
    return toMetadata(resp.metadata!)
  }

  /** 读单个（对不存在/软删的 key 由服务端报错——上层负责存在性语义）。 */
  getSecret(namespace: string, key: string): { value: string; version: number } {
    const req = create(GetSecretRequestSchema, { namespace, key })
    const resp = fromBinary(
      GetSecretResponseSchema,
      new Uint8Array(this.dispatch('secret_get', toBinary(GetSecretRequestSchema, req))),
    )
    return { value: resp.value, version: resp.version }
  }

  /** 软删。 */
  deleteSecret(namespace: string, key: string): boolean {
    const req = create(DeleteSecretRequestSchema, { namespace, key })
    const resp = fromBinary(
      DeleteSecretResponseSchema,
      new Uint8Array(this.dispatch('secret_delete', toBinary(DeleteSecretRequestSchema, req))),
    )
    return resp.deleted
  }

  /** 恢复软删（对未软删的 key 幂等成功）。 */
  restoreSecret(namespace: string, key: string): boolean {
    const req = create(RestoreSecretRequestSchema, { namespace, key })
    const resp = fromBinary(
      RestoreSecretResponseSchema,
      new Uint8Array(this.dispatch('secret_restore', toBinary(RestoreSecretRequestSchema, req))),
    )
    return resp.restored
  }

  /** 元数据列表（无值）。namespace 省略 = 全量。 */
  listSecrets(namespace?: string, includeDeleted = false): SecretEntryMetadata[] {
    const req = create(ListSecretsRequestSchema, { namespace, includeDeleted })
    const resp = fromBinary(
      ListSecretsResponseSchema,
      new Uint8Array(this.dispatch('secret_list', toBinary(ListSecretsRequestSchema, req))),
    )
    return resp.secrets.map(toMetadata)
  }

  /**
   * 批量取值：返回以 "namespace:key" 为键的映射。
   * 不存在/软删的键被服务端静默省略（不报错）——这是上层判存在性的
   * 唯一可靠机制（错误文本不可区分，见文件头注释）。
   */
  batchGet(queries: Array<{ namespace: string; key: string }>): Record<string, string> {
    const req = create(BatchGetSecretsRequestSchema, {
      queries: queries.map(q => create(GetSecretRequestSchema, q)),
    })
    const resp = fromBinary(
      BatchGetSecretsResponseSchema,
      new Uint8Array(this.dispatch('secret_batch_get', toBinary(BatchGetSecretsRequestSchema, req))),
    )
    return { ...resp.secrets }
  }
}
