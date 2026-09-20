import fs from 'node:fs/promises'
import path from 'node:path'
import type { DirectConnectStore } from '../db.js'
import type { EnterpriseRecord } from '../types.js'
import { getSystemSettings } from '../systemSettings.js'

type EnterpriseConfigPatch = Partial<
  Omit<EnterpriseRecord, 'id' | 'created_at' | 'updated_at'>
>

export function createEnterpriseApi(
  db: DirectConnectStore,
  runtimeDir: string,
  options: { cabinEnabled?: boolean } = {},
) {
  function enterpriseLogoDir(orgId: string): string {
    return orgId === 'default'
      ? path.join(runtimeDir, 'uploads', 'enterprise')
      : path.join(runtimeDir, 'uploads', 'enterprise', encodeURIComponent(orgId))
  }

  const getEffectivePolicy = async (orgId = 'default') => {
    const enterprise = await db.getEnterprise(orgId)
    const systemSettings = getSystemSettings()
    return {
      clientCronEnabled:
        enterprise.client_cron_enabled ?? systemSettings.clientCronEnabled,
      clientShowToolCalls:
        enterprise.client_show_tool_calls ?? systemSettings.clientShowToolCalls,
      workspaceUploadLimitBytes:
        enterprise.workspace_upload_limit_bytes ?? systemSettings.workspaceUploadLimitBytes,
    }
  }

  const api = {
    /**
     * Get enterprise configuration. Branding fields come from the DB
     * (enterprises table). Organization policy overrides are stored on the same
     * row; null values inherit the legacy deployment-wide settings.json values.
     */
    getConfig: async (orgId?: string) => {
      try {
        const enterprise = await db.getEnterprise(orgId)
        let logoBase64: string | null = null

        if (enterprise.logo) {
          const logoPath = path.join(enterpriseLogoDir(enterprise.id), enterprise.logo)
          try {
            const buffer = await fs.readFile(logoPath)
            const ext = path.extname(enterprise.logo).slice(1) || 'png'
            const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`
            logoBase64 = `data:${mimeType};base64,${buffer.toString('base64')}`
          } catch (err) {
            // A tenant seeded from the legacy default can initially reference
            // its logo. Keep that deployment-level file readable until the
            // tenant uploads a replacement in its own directory.
            const legacyLogoPath = path.join(enterpriseLogoDir('default'), enterprise.logo)
            if (enterprise.id !== 'default') {
              try {
                const buffer = await fs.readFile(legacyLogoPath)
                const ext = path.extname(enterprise.logo).slice(1) || 'png'
                const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`
                logoBase64 = `data:${mimeType};base64,${buffer.toString('base64')}`
              } catch {
                console.error(`Failed to read enterprise logo at ${logoPath}:`, err)
              }
            } else {
              console.error(`Failed to read enterprise logo at ${logoPath}:`, err)
            }
          }
        }

        const policy = await getEffectivePolicy(orgId)
        return {
          success: true,
          data: {
            ...enterprise,
            logo: logoBase64,
            client_cron_enabled: policy.clientCronEnabled,
            client_show_tool_calls: policy.clientShowToolCalls,
            workspace_upload_limit_bytes: policy.workspaceUploadLimitBytes,
            cabin_enabled: options.cabinEnabled === true,
          },
        }
      } catch (err) {
        console.error('Failed to get enterprise config:', err)
        return {
          success: false,
          message: err instanceof Error ? err.message : String(err),
        }
      }
    },

    /**
     * Update one organization's configuration. Deployment settings remain the
     * fallback for organizations that have not saved an override.
     */
    updateConfig: async (
      ...args:
        | [orgId: string, patch: unknown]
        | [patch: unknown, orgId?: string]
    ) => {
      try {
        const [first, second] = args
        const usesOrgFirst = typeof first === 'string' && args.length > 1
        const orgId = usesOrgFirst
          ? first
          : typeof second === 'string' && second.trim()
            ? second
            : 'default'
        const patch = usesOrgFirst ? second : first

        if (patch && typeof patch === 'object') {
          const patchRecord = patch as Record<string, unknown>
          for (const key of ['client_cron_enabled', 'client_show_tool_calls'] as const) {
            if (patchRecord[key] !== undefined && typeof patchRecord[key] !== 'boolean') {
              throw new Error(`${key} must be a boolean`)
            }
          }
          if (
            patchRecord.workspace_upload_limit_bytes !== undefined &&
            (!Number.isInteger(patchRecord.workspace_upload_limit_bytes) ||
              Number(patchRecord.workspace_upload_limit_bytes) <= 0 ||
              Number(patchRecord.workspace_upload_limit_bytes) > 1024 * 1024 * 1024)
          ) {
            throw new Error('workspace_upload_limit_bytes must be an integer between 1 and 1073741824')
          }

          // Whitelist actual columns so round-tripped read-only fields cannot
          // reach dynamically constructed SQL.
          const ENTERPRISE_COLUMNS = [
            'logo', 'app_name', 'top_name', 'about_name',
            'app_company_name', 'login_desp', 'client_cron_enabled',
            'client_show_tool_calls', 'workspace_upload_limit_bytes',
          ] as const
          const dbPatch: EnterpriseConfigPatch = {}
          for (const col of ENTERPRISE_COLUMNS) {
            if (patchRecord[col] !== undefined) {
              ;(dbPatch as Record<string, unknown>)[col] = patchRecord[col]
            }
          }
          if (Object.keys(dbPatch).length > 0) {
            await db.updateEnterprise(orgId, dbPatch)
          }
        } else if (patch !== undefined && patch !== null) {
          throw new Error('Enterprise configuration patch must be an object')
        }
        return await api.getConfig(orgId)
      } catch (err) {
        console.error('Failed to update enterprise config:', err)
        return {
          success: false,
          message: err instanceof Error ? err.message : String(err),
        }
      }
    },

    getEffectivePolicy,
  }

  return api
}

export type EnterpriseApi = ReturnType<typeof createEnterpriseApi>
