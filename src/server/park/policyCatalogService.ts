import type { DbDriver, SqlRow } from '../db/driver.js'
import { ParkRepository } from './parkRepository.js'

/**
 * Enterprise-side catalog (plan 2.3): service catalog from park settings
 * metadata and the full display payload of the assigned park assistant.
 * Enterprise users cannot reach agent-templates for another org's assistant,
 * so this endpoint is the single source of display fields.
 */

export type ServiceCatalogItem = {
  name: string
  description?: string
}

export type ParkAssistantInfo = {
  assistant_id: string
  name: string
  display_name: string
  description: string | null
  avatar: string | null
  emoji: string | null
  enabled_wikis: string[]
}

export class PolicyCatalogService {
  private readonly repo: ParkRepository

  constructor(private readonly driver: DbDriver) {
    this.repo = new ParkRepository(driver)
  }

  async getServiceCatalog(parkOrgId: string): Promise<{ version: string; items: ServiceCatalogItem[] }> {
    const profile = await this.repo.getOrgProfile(parkOrgId)
    const raw = profile?.metadataJson
    if (!raw) return { version: '0', items: [] }
    try {
      const parsed = JSON.parse(raw) as {
        service_catalog?: ServiceCatalogItem[]
        service_catalog_version?: string
      }
      const items = Array.isArray(parsed.service_catalog)
        ? parsed.service_catalog.filter(item => item && typeof item.name === 'string')
        : []
      return { version: parsed.service_catalog_version ?? '0', items }
    } catch {
      return { version: '0', items: [] }
    }
  }

  async getAssignedAssistants(enterpriseOrgId: string): Promise<ParkAssistantInfo[]> {
    const assignments = await this.repo.listAssignmentsByEnterprise(enterpriseOrgId)
    const out: ParkAssistantInfo[] = []
    for (const assignment of assignments) {
      const row = await this.driver.get<SqlRow>(`
        SELECT id, name, display_name, description, avatar, emoji, enabled_wikis
        FROM tenant_assistants WHERE id = ? AND org_id = ? AND status = 'approved'
      `, [assignment.assistantId, assignment.parkOrgId])
      if (!row) continue
      out.push({
        assistant_id: String(row.id),
        name: String(row.name),
        display_name: row.display_name == null ? String(row.name) : String(row.display_name),
        description: row.description == null ? null : String(row.description),
        avatar: row.avatar == null ? null : String(row.avatar),
        emoji: row.emoji == null ? null : String(row.emoji),
        enabled_wikis: parseStringArray(row.enabled_wikis),
      })
    }
    return out
  }
}

function parseStringArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}
