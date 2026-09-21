/**
 * Zone binding / NexusZoneClient 运行配置（§8.7 client 规则第 2 条）。
 *
 * 与 VFS/secrets 通道（nexusManager 的 gRPC `MOSS_NEXUS_*`）完全分离：
 * NexusZoneClient 只走 Nexus public `/v2` HTTP API，endpoint、service
 * credential、timeout 各自独立，互不复用——管理面凭证绝不流入 runtime
 * 数据通道，反之亦然。
 *
 * 环境变量：
 *   - `MOSS_NEXUS_V2_BASE_URL`     例 `http://127.0.0.1:8090`（契约路径
 *                                  `/v2/...` 由 client 拼接；部署若统一
 *                                  base 为 `https://host/api`，则配
 *                                  `https://host/api`，语义一致）
 *   - `MOSS_NEXUS_V2_SERVICE_TOKEN` Moss provisioning service 的 bearer
 *                                  credential（仅用于 binding 管理与
 *                                  delegation 换发，见 auth/service.ts）
 *   - `MOSS_NEXUS_DEPLOYMENT_ID`   binding 行的 nexus_deployment_id；
 *                                  默认 `local`
 *   - `MOSS_NEXUS_V2_TIMEOUT_MS`   请求超时，默认 10s；超时/断连一律按
 *                                  `unknown` 处理（先查 operation，不得
 *                                  换 idempotency key 重试）
 *
 * 未配置 base URL 时 `zoneBindingEnabled` 为 false：binding 仍会写入本地
 * 表并保持 `pending`（§8.7 验收——Nexus 离线时 Org 创建可完成），reconciler
 * 每轮空转跳过。
 */
export interface ZoneBindingConfig {
  zoneBindingEnabled: boolean
  nexusV2BaseUrl: string
  nexusV2ServiceToken: string
  nexusDeploymentId: string
  nexusV2TimeoutMs: number
}

export function resolveZoneBindingConfig(env: NodeJS.ProcessEnv = process.env): ZoneBindingConfig {
  const nexusV2BaseUrl = env.MOSS_NEXUS_V2_BASE_URL?.trim() ?? ''
  return {
    zoneBindingEnabled: nexusV2BaseUrl !== '',
    nexusV2BaseUrl,
    nexusV2ServiceToken: env.MOSS_NEXUS_V2_SERVICE_TOKEN?.trim() ?? '',
    nexusDeploymentId: env.MOSS_NEXUS_DEPLOYMENT_ID?.trim() || 'local',
    nexusV2TimeoutMs: Number(env.MOSS_NEXUS_V2_TIMEOUT_MS) || 10_000,
  }
}
