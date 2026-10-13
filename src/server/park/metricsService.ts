import type { DbDriver } from '../db/driver.js'
import { HIGH_SCORE_THRESHOLD, LeadService } from './leadService.js'
import { ParkRepository } from './parkRepository.js'

/** Leader dashboard aggregation (plan 2.3): pure SQL, model-free. Numbers come
 *  from the business tables only — the model never rewrites them (§12.10). */
export class MetricsService {
  private readonly repo: ParkRepository
  private readonly leadService: LeadService

  constructor(driver: DbDriver) {
    this.repo = new ParkRepository(driver)
    this.leadService = new LeadService(driver)
  }

  async getMetrics(parkOrgId: string): Promise<{
    funnel: Record<string, number>
    lead_status: Record<string, number>
    high_score_leads: Array<{ lead_id: string; enterprise_org_id: string; score: number; status: string }>
    totals: { enterprises: number; inquiries: number; leads: number }
  }> {
    const [bindings, leadStatus, highScore, profiles, inquiries, leads] = await Promise.all([
      this.repo.listBindingsByPark(parkOrgId),
      this.repo.countLeadsByStatus(parkOrgId),
      this.repo.listHighScoreLeads(parkOrgId, HIGH_SCORE_THRESHOLD),
      this.repo.listEnterpriseProfiles(parkOrgId),
      this.repo.listInquiriesByPark(parkOrgId, 10_000),
      this.repo.listLeads(parkOrgId, {}, 10_000),
    ])

    const funnel: Record<string, number> = { prospect: 0, active: 0, exiting: 0, exited: 0 }
    for (const binding of bindings) funnel[binding.lifecycle] = (funnel[binding.lifecycle] ?? 0) + 1

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
        enterprises: profiles.length,
        inquiries: inquiries.length,
        leads: leads.length,
      },
    }
  }
}
