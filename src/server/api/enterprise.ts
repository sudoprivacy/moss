import fs from 'node:fs/promises'
import path from 'node:path'
import type { DirectConnectStore } from '../db.js'
import { getSystemSettings, updateSystemSettings } from '../systemSettings.js'

export function createEnterpriseApi(db: DirectConnectStore, runtimeDir: string) {
  const api = {
    /**
     * Get enterprise configuration. Branding fields come from the DB
     * (enterprises table); client_cron_enabled is sourced from settings.json
     * (clientCronEnabled) — the source of truth for the client cron toggle.
     */
    getConfig: async () => {
      try {
        const enterprise = db.getEnterprise()
        let logoBase64: string | null = null

        if (enterprise.logo) {
          const logoPath = path.join(runtimeDir, 'uploads', 'enterprise', enterprise.logo)
          try {
            const buffer = await fs.readFile(logoPath)
            const ext = path.extname(enterprise.logo).slice(1) || 'png'
            const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`
            logoBase64 = `data:${mimeType};base64,${buffer.toString('base64')}`
          } catch (err) {
            // Logo file not found or unreadable, return null as requested
            console.error(`Failed to read enterprise logo at ${logoPath}:`, err)
            logoBase64 = null
          }
        }

        return {
          success: true,
          data: {
            ...enterprise,
            logo: logoBase64,
            client_cron_enabled: getSystemSettings().clientCronEnabled,
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
     * Update enterprise configuration. Branding fields persist to the DB;
     * client_cron_enabled is routed to settings.json (clientCronEnabled).
     */
    updateConfig: async (patch: any) => {
      try {
        if (patch && typeof patch === 'object' && 'client_cron_enabled' in patch) {
          const { client_cron_enabled, ...rest } = patch
          if (client_cron_enabled !== undefined) {
            updateSystemSettings({ clientCronEnabled: Boolean(client_cron_enabled) })
          }
          if (Object.keys(rest).length > 0) {
            db.updateEnterprise(rest)
          }
        } else {
          db.updateEnterprise(patch)
        }
        return await api.getConfig()
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
