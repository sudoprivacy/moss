import type { DbDriver } from '../db/driver.js'
import { HIGH_SCORE_THRESHOLD } from './leadService.js'
import { ParkRepository } from './parkRepository.js'

/** Leader dashboard aggregation (plan 2.3): pure SQL, model-free. Numbers come
 *  from the business tables only — the model never rewrites them (§12.10). */
export class MetricsService {
  private readonly repo: ParkRepository
  constructor(private readonly driver: DbDriver) {
    this.repo = new ParkRepository(driver)
  }

  async getMetrics(parkOrgId: string): Promise<{
    funnel: Record<string, number>
    lead_status: Record<string, number>
    high_score_leads: Array<{ lead_id: string; enterprise_org_id: string; score: number; status: string }>
    totals: { enterprises: number; inquiries: number; leads: number }
  }> {
    const [funnelRows, leadStatus, highScore, totals] = await Promise.all([
      this.driver.all<{ lifecycle: string; n: number }>(
        `SELECT lifecycle, COUNT(*) AS n FROM park_enterprise_bindings WHERE park_org_id = ? GROUP BY lifecycle`, [parkOrgId],
      ),
      this.repo.countLeadsByStatus(parkOrgId),
      this.repo.listHighScoreLeads(parkOrgId, HIGH_SCORE_THRESHOLD),
      this.driver.get<{ enterprises: number; inquiries: number; leads: number }>(`
        SELECT
          (SELECT COUNT(*) FROM enterprise_profiles WHERE park_org_id = ?) AS enterprises,
          (SELECT COUNT(*) FROM inquiries WHERE park_org_id = ?) AS inquiries,
          (SELECT COUNT(*) FROM leads WHERE park_org_id = ?) AS leads
      `, [parkOrgId, parkOrgId, parkOrgId]),
    ])

    const funnel: Record<string, number> = { prospect: 0, active: 0, exiting: 0, exited: 0 }
    for (const row of funnelRows) funnel[String(row.lifecycle)] = Number(row.n)

    return {
      funnel,
      lead_status: leadStatus,
      high_score_leads: highScore.map(lead => ({
        lead_id: lead.leadId,
        enterprise_org_id: lead.enterpriseOrgId,
        score: lead.score ?? 0,
        status: lead.status,
      })),
      totals: {
        enterprises: Number(totals?.enterprises ?? 0),
        inquiries: Number(totals?.inquiries ?? 0),
        leads: Number(totals?.leads ?? 0),
      },
    }
  }
}
