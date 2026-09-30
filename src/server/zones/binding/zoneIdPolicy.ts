/**
 * default Zone 候选 ID 的 provisioning 政策（§10.4）：
 *  - 不使用 display name；
 *  - 不假定 org_id == zone_id（org uuid 含连字符形态上恰好合法，但语义上
 *    Zone identity 与 Org identity 是两回事——持久化关联只走 binding 表）；
 *  - 独立候选 `org-<hex32>`：小写 hex 满足 nexus-vfs zone-id 字符集与
 *    3–63 长度，边缘无连字符；
 *  - 生成后必须过 owner validator（@sudo/contracts/zone-id，规则 SSOT 在
 *    nexus-vfs，本仓不重写）——不合法即抛错，绝不静默放宽。
 */
import { validateZoneId } from '@sudo/contracts/zone-id'

export function defaultZoneIdCandidate(orgId: string): string {
  const result = tryDefaultZoneIdCandidate(orgId)
  if (!result.ok) {
    // 防御分支：hex 输入理论上恒合法；走到这里说明政策本身被破坏，必须炸出
    throw new Error(
      `default zone id candidate ${JSON.stringify(result.candidate)} rejected by owner validator: ${result.refusal.kind}`,
    )
  }
  return result.zoneId
}

/**
 * 低-15②：非抛出的判定形式——存量迁移（migrateFromJson）的 org id 可能含
 * zone-id 非法字符（非 UUID 历史数据），迁移路径据此优雅降级（跳过 binding
 * 写入、org 行照插，由 backfill 补），不再 fail-loud 回滚整个迁移。在线
 * 入口（org 创建）仍走抛出的 defaultZoneIdCandidate——政策不被静默放宽。
 */
export function tryDefaultZoneIdCandidate(orgId: string):
  | { ok: true; zoneId: string }
  | { ok: false; candidate: string; refusal: { kind: string } } {
  const hex = orgId.replaceAll('-', '').toLowerCase()
  const candidate = `org-${hex.slice(0, 32)}`
  const refusal = validateZoneId(candidate)
  if (refusal) return { ok: false, candidate, refusal: { kind: refusal.kind } }
  return { ok: true, zoneId: candidate }
}
