/** Convert either database row shape into the generated owner-side wire model. */
import { API_VERSION, KIND, safeParse, type OrgZoneBinding } from '../generated/org-zone-binding.gen.js'
import type { OrgZoneBindingRow } from './bindingRepository.js'

export function rowToOrgZoneBinding(row: Record<string, unknown> | OrgZoneBindingRow): OrgZoneBinding {
  const source = row as Record<string, unknown>
  const id = String(source.binding_id)
  try {
    const value = {
      api_version: API_VERSION,
      kind: KIND,
      binding_id: id,
      org_id: String(source.org_id),
      nexus_deployment_id: String(source.nexus_deployment_id),
      zone_id: String(source.zone_id),
      purpose: String(source.purpose),
      is_default: Number(source.is_default) !== 0,
      desired_capabilities: JSON.parse(String(source.desired_capabilities)) as unknown,
      ...(source.resource_prefixes == null ? {} : { resource_prefixes: JSON.parse(String(source.resource_prefixes)) as unknown }),
      desired_state: String(source.desired_state),
      sync_status: String(source.sync_status),
      ...(source.nexus_grant_id == null ? {} : { nexus_grant_id: String(source.nexus_grant_id) }),
      ...(source.nexus_operation_id == null ? {} : { nexus_operation_id: String(source.nexus_operation_id) }),
      generation: Number(source.generation),
      ...(source.last_error_code == null ? {} : { last_error_code: String(source.last_error_code) }),
      created_at: new Date(Number(source.created_at)).toISOString(),
      updated_at: new Date(Number(source.updated_at)).toISOString(),
    }
    const parsed = safeParse(value)
    if (!parsed.ok) throw new Error(parsed.errors.join('; '))
    return parsed.value
  } catch (error) {
    throw new Error(`invalid OrgZoneBinding row ${id}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
