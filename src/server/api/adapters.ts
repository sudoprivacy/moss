/**
 * Adapters API — 多用户 IM Adapter 配置与进程管理
 *
 * GET    /api/v1/adapters?userId=xxx         → 获取当前/指定用户的配置（脱敏）
 * PUT    /api/v1/adapters/:platform          → 更新当前用户的配置
 * GET    /api/v1/adapters/processes           → 获取进程状态列表
 * POST   /api/v1/adapters/:platform/start     → 启动 Bot 进程
 * POST   /api/v1/adapters/:platform/stop      → 停止 Bot 进程
 * DELETE /api/v1/adapters/:platform           → 删除配置
 */

import { AdapterService } from '../adapterService.js'
import type { DatabaseSync } from 'node:sqlite'

const ALLOWED_PLATFORMS = new Set(['telegram', 'feishu'])

export function createAdaptersApi(db: DatabaseSync) {
  const adapterService = new AdapterService(db)

  return {
    /**
     * GET /api/v1/adapters
     * Query params: userId (optional, admin only - defaults to auth user)
     * Returns masked config for the user's telegram and feishu adapters
     */
    list: (orgId: string, userId: string): object => {
      const rows = adapterService.listByUser(orgId, userId)
      const result: Record<string, unknown> = {}
      for (const row of rows) {
        const config = JSON.parse(row.config_json) as Record<string, unknown>
        // Mask secrets
        if (row.platform === 'telegram') {
          if (typeof config.botToken === 'string') {
            config.botToken = config.botToken.length > 4
              ? '****' + config.botToken.slice(-4)
              : '****'
          }
        } else if (row.platform === 'feishu') {
          for (const key of ['appSecret', 'encryptKey', 'verificationToken']) {
            if (typeof config[key] === 'string') {
              config[key] = config[key].length > 4 ? '****' + (config[key] as string).slice(-4) : '****'
            }
          }
        }
        result[row.platform] = { ...config, enabled: Boolean(row.enabled) }
      }
      return result
    },

    /**
     * List all adapter configs across all users (admin only)
     */
    listAll: (orgId: string): object[] => {
      const rows = adapterService.listByOrg(orgId)
      return rows.map((row) => ({
        id: row.id,
        orgId: row.orgId,
        userId: row.userId,
        platform: row.platform,
        enabled: Boolean(row.enabled),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        // Don't expose secrets in list view
      }))
    },

    /**
     * PUT /api/v1/adapters/:platform
     * Upsert config for a specific platform
     */
    upsert: (orgId: string, userId: string, platform: string, patch: Record<string, unknown>): object => {
      if (!ALLOWED_PLATFORMS.has(platform)) {
        return { error: 'BAD_REQUEST', message: `Invalid platform: ${platform}. Must be "telegram" or "feishu"` }
      }
      const config = adapterService.upsert(orgId, userId, platform as 'telegram' | 'feishu', patch as any)
      // Return masked version
      const masked = adapterService.getMasked(orgId, userId, platform as 'telegram' | 'feishu')
      return { platform, config: masked }
    },

    /**
     * DELETE /api/v1/adapters/:platform
     */
    remove: (orgId: string, userId: string, platform: string): { ok: boolean } | { error: string; message: string } => {
      if (!ALLOWED_PLATFORMS.has(platform)) {
        return { error: 'BAD_REQUEST', message: `Invalid platform: ${platform}` }
      }
      const deleted = adapterService.delete(orgId, userId, platform as 'telegram' | 'feishu')
      return { ok: deleted }
    },
  }
}

export type AdaptersApi = ReturnType<typeof createAdaptersApi>