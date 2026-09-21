/**
 * existing Org backfill（§8.7 七入口之一 / §10.4）：
 * 为存量无 default binding 的 Org 生成 binding plan，经批准后分批写入
 * binding + outbox（与在线入口同一张表、同一条 reconciler 收敛路径）。
 *
 * 语义要点：
 *  - 只输出 plan/dry-run 报告，不自动认领（§10.2/§10.4——报告先行）；
 *  - 候选 zone_id 由政策生成（zoneIdPolicy，不用 display name、不假定
 *    org_id == zone_id），collision（候选已被他 Org 占用）在 plan 中显式
 *    报告为 blocked，不静默改写；
 *  - apply 可重入：已有 default binding 的 Org 跳过；写入走与在线入口
 *    相同的 insertDefaultBindingIntent（同表同约束）；
 *  - Nexus unavailable 不影响本地写入（行保持 pending，§10.4）。
 */
import type { DbDriver } from '../../db/driver.js'
import { insertDefaultBindingIntent } from './bindingRepository.js'
import { defaultZoneIdCandidate } from './zoneIdPolicy.js'

export interface OrgBackfillPlanItem {
  orgId: string
  orgName: string
  candidateZoneId: string
  status: 'would-create' | 'already-bound' | 'collision'
  collisionWith?: string
}

export interface OrgBackfillReport {
  total: number
  wouldCreate: number
  alreadyBound: number
  collisions: number
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
  // 当前 deployment 下已被 binding 占用的 zone_id（collision 检测）
  const takenZones = new Map<string, string>()
  const boundOrgs = new Set<string>()
  const rows = await driver.all(
    `SELECT org_id, zone_id FROM org_zone_bindings
     WHERE nexus_deployment_id = ? AND desired_state = 'bound'`,
    [input.nexusDeploymentId],
  )
  for (const row of rows) {
    takenZones.set(String(row.zone_id), String(row.org_id))
    boundOrgs.add(String(row.org_id))
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
    const candidate = defaultZoneIdCandidate(orgId)
    const owner = takenZones.get(candidate)
    if (owner !== undefined) {
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
    alreadyBound: items.filter((i) => i.status === 'already-bound').length,
    collisions: items.filter((i) => i.status === 'collision').length,
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
): Promise<{ created: string[]; skipped: string[]; failed: Array<{ orgId: string; error: string }> }> {
  const plan = await planOrgZoneBackfill(driver, input)
  const created: string[] = []
  const skipped: string[] = []
  const failed: Array<{ orgId: string; error: string }> = []
  const batch = plan.items.filter((i) => i.status === 'would-create').slice(0, input.batchSize ?? 100)
  for (const item of batch) {
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
  return { created, skipped, failed }
}
