/**
 * nexusClient — moss 侧 Nexus secrets 门面。
 *
 * 存储通道：vault 插件 GenericSecretsService（AES-256-GCM 服务端加密，经
 * native callBinary 点分路由 "password-vault.secret_*"，见 nexusSecretClient.ts）。
 * 公开方法签名与语义适配（null 映射、前缀过滤、status 映射）全部收在本
 * 门面层，上层消费方无感。
 *
 * 语义要点（对抗审核定稿，勿改）：
 *  - 读路径（getSecret）的存在性用 batch_get 的静默省略语义：不存在与
 *    软删（禁用）均返回 null；点分路由下业务 NotFound 与"插件缺方法"
 *    的错误文本同为 "method not found"，不可编程区分，任何错误字符串
 *    匹配方案不可行
 *  - 写路径（delete/enable/disable）的预探用 metadata 判定（含软删）——
 *    enable 的目标恰是软删项，误用 batch_get 会导致禁用后无法重新启用
 *  - 通道故障/插件未加载 → 向上抛（与"未设置"严格区分）
 *  - delete/enable/disable 对不存在的 key 静默成功（对齐旧实现的吞错行为）
 *  - getSecret 返回的 status 恒为 'enabled'（disabled/软删项已在存在性
 *    判定阶段返回 null）
 */

import { NexusSecretClient } from './nexusSecretClient.js'

// Lazy-load the native gRPC client
function loadNativeBinding(): typeof import('../../../native/nexus-napi') {
  try {
    const { app } = require('electron')
    const path = require('path')
    const appRoot = app.isPackaged
      ? app.getAppPath().replace('app.asar', 'app.asar.unpacked')
      : app.getAppPath()
    return require(path.join(appRoot, 'native', 'nexus-napi'))
  } catch {
    // Fallback for non-Electron environment (standalone server)
    try {
      return require('../../../native/nexus-napi')
    } catch {
      throw new Error('nexus-napi native module not available. Run `bun run build:native` first.')
    }
  }
}

interface SecretMetadata {
  namespace: string
  key: string
  value: string | null
  status: string
  version: number
}

/** mTLS material for connecting to an auth-on external `nexusd-cluster`. */
export type NexusClientTlsConfig = {
  caPath: string
  certPath: string
  keyPath: string
  /** Server-cert SAN to validate; defaults to the cluster's `nexus-node`. */
  serverName?: string
}

export class NexusClient {
  private client: InstanceType<ReturnType<typeof loadNativeBinding>['NexusGrpcClient']> | null = null
  private secretClient: NexusSecretClient | null = null
  private readonly endpoint: string
  private readonly authToken: string
  private readonly tls: NexusClientTlsConfig | null
  private nativeBinding: ReturnType<typeof loadNativeBinding> | null = null

  constructor(grpcEndpoint: string, authToken = '', tls: NexusClientTlsConfig | null = null) {
    this.endpoint = grpcEndpoint
    this.authToken = authToken
    this.tls = tls
  }

  private getClient(): InstanceType<ReturnType<typeof loadNativeBinding>['NexusGrpcClient']> {
    if (!this.client) {
      this.nativeBinding = loadNativeBinding()
      // mTLS to an auth-on cluster vs. plaintext trusted-loopback serve-local.
      this.client = this.tls
        ? this.nativeBinding.NexusGrpcClient.withMtls(
            this.endpoint,
            this.tls.caPath,
            this.tls.certPath,
            this.tls.keyPath,
            this.tls.serverName,
          )
        : new this.nativeBinding.NexusGrpcClient(this.endpoint)
    }
    return this.client
  }

  private getSecretClient(): NexusSecretClient {
    if (!this.secretClient) {
      this.secretClient = new NexusSecretClient(this.getClient(), this.authToken)
    }
    return this.secretClient
  }

  // ── 公开 API（签名与旧版完全一致） ────────────────────────────────────

  async putSecret(namespace: string, key: string, value: string, subject?: string): Promise<void> {
    void subject
    this.getSecretClient().putSecret(namespace, key, value)
  }

  async getSecret(namespace: string, key: string, subject?: string): Promise<{ value: string | null; status: string; version: number } | null> {
    void subject
    // 存在性用 batch_get 的静默省略语义判定（文件头语义要点）
    const values = this.getSecretClient().batchGet([{ namespace, key }])
    if (values[`${namespace}:${key}`] === undefined) return null
    const { value, version } = this.getSecretClient().getSecret(namespace, key)
    return { value, status: 'enabled', version }
  }

  /** 写路径预探：metadata 判定（含软删项——enable 的目标恰是软删项）。 */
  private existsIncludingDeleted(namespace: string, key: string): boolean {
    return this.getSecretClient()
      .listSecrets(namespace, true)
      .some(m => m.key === key)
  }

  async deleteSecret(namespace: string, key: string, subject?: string): Promise<void> {
    void subject
    if (!this.existsIncludingDeleted(namespace, key)) return
    this.getSecretClient().deleteSecret(namespace, key)
  }

  async enableSecret(namespace: string, key: string, subject?: string): Promise<void> {
    void subject
    if (!this.existsIncludingDeleted(namespace, key)) return
    this.getSecretClient().restoreSecret(namespace, key)
  }

  async disableSecret(namespace: string, key: string, subject?: string): Promise<void> {
    void subject
    if (!this.existsIncludingDeleted(namespace, key)) return
    this.getSecretClient().deleteSecret(namespace, key)
  }

  async listSecrets(namespace?: string, subject?: string): Promise<SecretMetadata[]> {
    void subject
    const secretClient = this.getSecretClient()
    const all = secretClient.listSecrets(undefined, true)
    const matchesPrefix = (ns: string) => !namespace || ns === namespace || ns.startsWith(`${namespace}:`)
    const filtered = all.filter(m => matchesPrefix(m.namespace))
    const values = secretClient.batchGet(filtered.map(m => ({ namespace: m.namespace, key: m.key })))
    return filtered.map(m => ({
      namespace: m.namespace,
      key: m.key,
      value: values[`${m.namespace}:${m.key}`] ?? null,
      status: m.deleted ? 'disabled' : 'enabled',
      version: m.currentVersion,
    }))
  }

  /**
   * List namespaces that have at least one secret record.
   * Reads the encrypted service's metadata list — no VFS reads.
   */
  listConfiguredNamespaces(prefix?: string): Set<string> {
    const all = this.getSecretClient().listSecrets(undefined, true)
    const out = new Set<string>()
    for (const m of all) {
      if (!prefix || m.namespace === prefix || m.namespace.startsWith(`${prefix}:`)) {
        out.add(m.namespace)
      }
    }
    return out
  }
}
