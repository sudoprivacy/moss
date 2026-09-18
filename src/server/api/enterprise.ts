import fs from 'node:fs/promises'
import path from 'node:path'
import type { DirectConnectStore } from '../db.js'
import type { EnterpriseRecord } from '../types.js'
import { getSystemSettings, updateSystemSettings } from '../systemSettings.js'

type EnterpriseBrandingPatch = Partial<
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

  const api = {
    /**
     * Get enterprise configuration. Branding fields come from the DB
     * (enterprises table); client_cron_enabled / client_show_tool_calls are
     * sourced from settings.json (clientCronEnabled / clientShowToolCalls) —
     * the source of truth for the client-facing toggles.
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

        const systemSettings = getSystemSettings()
        return {
          success: true,
          data: {
            ...enterprise,
            logo: logoBase64,
            client_cron_enabled: systemSettings.clientCronEnabled,
            client_show_tool_calls: systemSettings.clientShowToolCalls,
            workspace_upload_limit_bytes: systemSettings.workspaceUploadLimitBytes,
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
     * Update enterprise configuration. Only the branding columns persist to the
     * DB; the client toggles and workspace upload limit are routed to
     * settings.json (that's their source of truth in getConfig). Any other key
     * is ignored — getConfig returns settings-sourced fields (e.g.
     * workspace_upload_limit_bytes) that the client PATCHes back, and writing
     * those to `enterprises` would throw "no such column" and fail the save.
     */
    updateConfig: async (orgId: string, patch: unknown) => {
      try {
        if (patch && typeof patch === 'object') {
          const patchRecord = patch as Record<string, unknown>
          const {
            client_cron_enabled,
            client_show_tool_calls,
            workspace_upload_limit_bytes,
          } = patchRecord

          const settingsPatch: Record<string, unknown> = {}
          if (client_cron_enabled !== undefined) {
            settingsPatch.clientCronEnabled = Boolean(client_cron_enabled)
          }
          if (client_show_tool_calls !== undefined) {
            settingsPatch.clientShowToolCalls = Boolean(client_show_tool_calls)
          }
          if (workspace_upload_limit_bytes !== undefined) {
            settingsPatch.workspaceUploadLimitBytes = workspace_upload_limit_bytes
          }
          if (Object.keys(settingsPatch).length > 0) {
            await updateSystemSettings(settingsPatch)
          }

          // Whitelist the actual `enterprises` columns so read-only /
          // settings-sourced fields in the round-tripped config can't reach SQL.
          const ENTERPRISE_COLUMNS = [
            'logo', 'app_name', 'top_name', 'about_name',
            'app_company_name', 'login_desp', 'client_cron_enabled',
          ] as const
          const dbPatch: EnterpriseBrandingPatch = {}
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
  }

  return api
}

export type EnterpriseApi = ReturnType<typeof createEnterpriseApi>
