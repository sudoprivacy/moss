import fs from 'node:fs/promises'
import path from 'node:path'
import type { DirectConnectStore } from '../db.js'
import type { EnterpriseRecord } from '../types.js'
import { getSystemSettings } from '../systemSettings.js'

type EnterpriseBrandingPatch = Partial<
  Omit<EnterpriseRecord, 'id' | 'created_at' | 'updated_at'>
>

type ClientFacingPolicy = {
  clientShowToolCalls?: unknown
  workspaceUploadLimitBytes?: unknown
}

export function createEnterpriseApi(
  db: DirectConnectStore,
  runtimeDir: string,
  options: {
    cabinEnabled?: boolean
    getClientCronEnabled?: (orgId: string) => boolean
    setClientCronEnabled?: (orgId: string, enabled: boolean) => void
    getClientPolicy?: (orgId: string) => ClientFacingPolicy
    putClientPolicy?: (orgId: string, patch: ClientFacingPolicy, updatedBy: string) => void
  } = {},
) {
  function enterpriseLogoDir(orgId: string): string {
    return orgId === 'default'
      ? path.join(runtimeDir, 'uploads', 'enterprise')
      : path.join(runtimeDir, 'uploads', 'enterprise', encodeURIComponent(orgId))
  }

  const getEffectivePolicy = async (orgId = 'default') => {
    const requestedOrgId = orgId.trim() || 'default'
    const enterprise = await db.getEnterprise(requestedOrgId === 'default' ? undefined : requestedOrgId)
    const systemSettings = getSystemSettings()
    const policy = requestedOrgId !== 'default' && options.getClientPolicy
      ? options.getClientPolicy(requestedOrgId)
      : {}
    return {
      clientCronEnabled: requestedOrgId !== 'default' && options.getClientCronEnabled
        ? options.getClientCronEnabled(requestedOrgId)
        : enterprise.client_cron_enabled ?? systemSettings.clientCronEnabled,
      clientShowToolCalls: typeof policy.clientShowToolCalls === 'boolean'
        ? policy.clientShowToolCalls
        : enterprise.client_show_tool_calls ?? systemSettings.clientShowToolCalls,
      workspaceUploadLimitBytes: normalizeUploadLimit(
        policy.workspaceUploadLimitBytes ?? enterprise.workspace_upload_limit_bytes,
        systemSettings.workspaceUploadLimitBytes,
      ),
    }
  }

  const api = {
    /**
     * Get enterprise configuration. Branding fields come from the enterprises
     * table; client-facing policy fields are resolved from organization scope
     * first and fall back to deployment defaults from settings.json.
     */
    getConfig: async (orgId?: string) => {
      try {
        const requestedOrgId = orgId?.trim() || ''
        const enterprise = await db.getEnterprise(requestedOrgId || undefined)
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

        const policy = await getEffectivePolicy(requestedOrgId || 'default')
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
     * Update enterprise configuration. Branding columns persist to the
     * enterprises table; client-facing policy fields are routed to organization
     * policy hooks when available and fall back to settings.json for legacy
     * embeddings. Any other key is ignored.
     */
    updateConfig: async (
      ...args:
        | [orgId: string, patch: unknown, updatedBy?: string]
        | [patch: unknown, orgId?: string]
    ) => {
      try {
        const [first, second, third] = args
        const usesOrgFirst = typeof first === 'string' && args.length > 1
        const orgId = usesOrgFirst
          ? first
          : typeof second === 'string' && second.trim()
            ? second
            : 'default'
        const patch = usesOrgFirst ? second : first
        const updatedBy = typeof third === 'string' && third.trim() ? third : orgId

        if (patch && typeof patch === 'object') {
          const patchRecord = patch as Record<string, unknown>
          const {
            client_cron_enabled,
            client_show_tool_calls,
            workspace_upload_limit_bytes,
          } = patchRecord
          const nextClientCronEnabled = client_cron_enabled === undefined
            ? undefined
            : parseBoolean(client_cron_enabled, 'client_cron_enabled')
          const nextClientShowToolCalls = client_show_tool_calls === undefined
            ? undefined
            : parseBoolean(client_show_tool_calls, 'client_show_tool_calls')
          const nextWorkspaceUploadLimitBytes = workspace_upload_limit_bytes === undefined
            ? undefined
            : parseUploadLimit(workspace_upload_limit_bytes)

          const policyPatch: ClientFacingPolicy = {}
          const dbPolicyPatch: EnterpriseBrandingPatch = {}
          if (nextClientCronEnabled !== undefined) {
            if (options.setClientCronEnabled) {
              options.setClientCronEnabled(orgId, nextClientCronEnabled)
            } else {
              dbPolicyPatch.client_cron_enabled = nextClientCronEnabled
            }
          }
          if (nextClientShowToolCalls !== undefined) {
            if (options.putClientPolicy) {
              policyPatch.clientShowToolCalls = nextClientShowToolCalls
            } else {
              dbPolicyPatch.client_show_tool_calls = nextClientShowToolCalls
            }
          }
          if (nextWorkspaceUploadLimitBytes !== undefined) {
            if (options.putClientPolicy) {
              policyPatch.workspaceUploadLimitBytes = nextWorkspaceUploadLimitBytes
            } else {
              dbPolicyPatch.workspace_upload_limit_bytes = nextWorkspaceUploadLimitBytes
            }
          }
          if (Object.keys(policyPatch).length > 0 && options.putClientPolicy) {
            options.putClientPolicy(orgId, policyPatch, updatedBy)
          }

          // Whitelist the actual `enterprises` columns so read-only /
          // settings-sourced fields in the round-tripped config can't reach SQL.
          const ENTERPRISE_COLUMNS = [
            'logo', 'app_name', 'top_name', 'about_name',
            'app_company_name', 'login_desp',
          ] as const
          const dbPatch: EnterpriseBrandingPatch = {}
          Object.assign(dbPatch, dbPolicyPatch)
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

function normalizeUploadLimit(value: unknown, fallback?: number): number {
  const limit = typeof value === 'number' ? value : Number.NaN
  if (Number.isSafeInteger(limit) && limit >= 1 && limit <= 1024 * 1024 * 1024) return limit
  return fallback ?? getSystemSettings().workspaceUploadLimitBytes
}

function parseUploadLimit(value: unknown): number {
  const limit = typeof value === 'number' ? value : Number.NaN
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024 * 1024 * 1024) {
    throw new Error('workspace_upload_limit_bytes must be an integer between 1 and 1073741824')
  }
  return limit
}

function parseBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value === 'boolean') return value
  if (value === 0 || value === 1) return value === 1
  throw new Error(`${fieldName} must be a boolean`)
}
