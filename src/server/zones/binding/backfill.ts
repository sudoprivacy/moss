/**
 * existing Org backfill（§8.7 七入口之一 / §10.4）：
 * 为存量无 default binding 的 Org 生成 binding plan，经批准后分批写入
 * binding + outbox（与在线入口同一张表、同一条 reconciler 收敛路径）。
 *
 * 语义要点：
 *  - 只输出 plan/dry-run 报告，不自动认领（§10.2/§10.4——报告先行）；
 *  - 候选 zone_id 由政策生成（zoneIdPolicy，不用 display name、不假定
 *    org_id == zone_id），collision（候选已被他 Org 占用）在 plan 中显式
 *    报告为 blocked，不静默改写；detached 的遗留 zone 同样计入占用
 *    （不给 B org 自动签发 A org 遗留数据所在 zone 的授权）；
 *  - 自身的 detached default 行（解绑后待恢复）标 would-rebind——apply 走
 *    reviveBindingIntent（H-2 恢复路径单点），不再撞 UNIQUE 归 skipped；
 *  - apply 可重入：已有 default binding 的 Org 跳过；写入走与在线入口
 *    相同的 insertDefaultBindingIntent（同表同约束）；
 *  - Nexus unavailable 不影响本地写入（行保持 pending，§10.4）。
 */
import type { DbDriver } from '../../db/driver.js'
import { insertDefaultBindingIntent } from './bindingRepository.js'
import { reviveBindingIntent } from './bindingRepository.js'
import { defaultZoneIdCandidate } from './zoneIdPolicy.js'

export interface OrgBackfillPlanItem {
  orgId: string
  orgName: string
  candidateZoneId: string
  status: 'would-create' | 'would-rebind' | 'already-bound' | 'collision' | 'invalid'
  /** would-rebind 时的既有 detached default 行（apply 复活目标）。 */
  bindingId?: string
  collisionWith?: string
  error?: string
}

export interface OrgBackfillReport {
  total: number
  wouldCreate: number
  rebinds: number
  alreadyBound: number
  collisions: number
  invalid: number
  items: OrgBackfillPlanItem[]
}

export async function planOrgZoneBackfill(
  driver: DbDriver,
  input: { nexusDeploymentId: string },
): Promise<OrgBackfillReport> {
  const orgs = await driver.all(
    `SELECT o.id AS org_id, o.name AS org_name FROM organizations o
     ORDER BY o.created_at, o.id`,
  )
  // 当前 deployment 下的占用与恢复目标（collision 检测 + would-rebind 判定）。
  // bound 与 detached 行都计入 takenZones（detached 遗留 zone 不复用）；
  // 判定顺序固定：already-bound → would-rebind（自己的 detached default）
  // → collision（taken 且 owner ≠ 自己）——自己的 detached 非 default 行占用
  // 候选 zone 时落 would-create（新行 purpose='default' 与既有行 purpose 不同，
  // 4 列 UNIQUE 与 partial unique 均不撞，同 org 同 zone 双 purpose 合法）。
  const takenZones = new Map<string, string>()
  const boundOrgs = new Set<string>()
  const detachedDefaultByOrg = new Map<string, { bindingId: string; zoneId: string }>()
  const rows = await driver.all(
    `SELECT binding_id, org_id, zone_id, is_default, desired_state FROM org_zone_bindings
     WHERE nexus_deployment_id = ?`,
    [input.nexusDeploymentId],
  )
  for (const row of rows) {
    const zoneId = String(row.zone_id)
    const orgId = String(row.org_id)
    takenZones.set(zoneId, orgId)
    if (String(row.desired_state) === 'bound') {
      if (Number(row.is_default) === 1) boundOrgs.add(orgId)
    } else if (Number(row.is_default) === 1) {
      detachedDefaultByOrg.set(orgId, { bindingId: String(row.binding_id), zoneId })
    }
  }

  const items: OrgBackfillPlanItem[] = []
  for (const org of orgs) {
    const orgId = String(org.org_id)
    if (boundOrgs.has(orgId)) {
      items.push({
        orgId,
        orgName: String(org.org_name),
        candidateZoneId: '',
        status: 'already-bound',
      })
      continue
    }
    let candidate: string
    try {
      candidate = defaultZoneIdCandidate(orgId)
    } catch (error) {
      items.push({
        orgId,
        orgName: String(org.org_name),
        candidateZoneId: '',
        status: 'invalid',
        error: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    const detachedDefault = detachedDefaultByOrg.get(orgId)
    if (detachedDefault && detachedDefault.zoneId === candidate) {
      items.push({
        orgId,
        orgName: String(org.org_name),
        candidateZoneId: candidate,
        status: 'would-rebind',
        bindingId: detachedDefault.bindingId,
      })
      continue
    }
    const owner = takenZones.get(candidate)
    if (owner !== undefined && owner !== orgId) {
      items.push({
        orgId,
        orgName: String(org.org_name),
        candidateZoneId: candidate,
        status: 'collision',
        collisionWith: owner,
      })
      continue
    }
    takenZones.set(candidate, orgId)
    items.push({
      orgId,
      orgName: String(org.org_name),
      candidateZoneId: candidate,
      status: 'would-create',
    })
  }

  return {
    total: items.length,
    wouldCreate: items.filter((i) => i.status === 'would-create').length,
    rebinds: items.filter((i) => i.status === 'would-rebind').length,
    alreadyBound: items.filter((i) => i.status === 'already-bound').length,
    collisions: items.filter((i) => i.status === 'collision').length,
    invalid: items.filter((i) => i.status === 'invalid').length,
    items,
  }
}

/**
 * 批准后的分批写入。可重入：每批内逐 Org 检查（已有 default bound
 * binding 跳过），单 Org 失败不中断整批（返回失败清单）。
 */
export async function applyOrgZoneBackfill(
  driver: DbDriver,
  input: { nexusDeploymentId: string; batchSize?: number },
): Promise<{ created: string[]; revived: string[]; skipped: string[]; failed: Array<{ orgId: string; error: string }> }> {
  const plan = await planOrgZoneBackfill(driver, input)
  const created: string[] = []
  const revived: string[] = []
  const skipped: string[] = []
  const failed: Array<{ orgId: string; error: string }> = []
  const batch = plan.items
    .filter((i) => i.status === 'would-create' || i.status === 'would-rebind')
    .slice(0, input.batchSize ?? 100)
  for (const item of batch) {
    if (item.status === 'would-rebind') {
      // H-2 恢复路径：detached default → 复活（与 addBinding 冲突分支同一单点）。
      try {
        const result = await reviveBindingIntent(driver, {
          bindingId: String(item.bindingId),
          isDefault: true,
          now: Date.now(),
        })
        if (result.ok) revived.push(item.orgId)
        else if (result.reason === 'outbox-in-flight') skipped.push(item.orgId) // 下轮重试
        else failed.push({ orgId: item.orgId, error: `revive race: ${result.reason}` })
      } catch (error) {
        failed.push({ orgId: item.orgId, error: error instanceof Error ? error.message : String(error) })
      }
      continue
    }
    try {
      await driver.transaction(async () => {
        await insertDefaultBindingIntent(driver, {
          orgId: item.orgId,
          nexusDeploymentId: input.nexusDeploymentId,
          now: Date.now(),
        })
      })
      created.push(item.orgId)
    } catch (error) {
      // 可重入的关键：已存在（并发/前次部分完成）不视为失败
      const message = error instanceof Error ? error.message : String(error)
      if (/UNIQUE/i.test(message)) {
        skipped.push(item.orgId)
      } else {
        failed.push({ orgId: item.orgId, error: message })
      }
    }
  }
  return { created, revived, skipped, failed }
}
