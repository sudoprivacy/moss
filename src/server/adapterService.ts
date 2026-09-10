/**
 * Adapter Service — 多用户 IM Adapter 配置管理
 *
 * 每个用户可以独立配置 Telegram 和飞书 Bot 凭据。
 * 配置存储在 SQLite DB 中，敏感字段读取时脱敏。
 */

import type { DbDriver } from './db/driver.js'

export type PairedUser = {
  userId: string | number
  displayName: string
  pairedAt: number
}

export type AdapterConfigRow = {
  id: string
  orgId: string
  userId: string
  platform: 'telegram' | 'feishu'
  configJson: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export type TelegramPartialConfig = {
  botToken?: string
  allowedUsers?: number[]
  pairedUsers?: PairedUser[]
  defaultWorkDir?: string
}

export type FeishuPartialConfig = {
  appId?: string
  appSecret?: string
  encryptKey?: string
  verificationToken?: string
  allowedUsers?: string[]
  pairedUsers?: PairedUser[]
  defaultWorkDir?: string
  streamingCard?: boolean
}

type PlatformConfig = TelegramPartialConfig | FeishuPartialConfig

function maskSecret(value: string | undefined): string | undefined {
  if (!value) return value
  if (value.length <= 4) return '****'
  return '****' + value.slice(-4)
}

function isMasked(value: string | undefined): boolean {
  return !!value && value.startsWith('****')
}

function deepMerge(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...current }
  for (const key of Object.keys(patch)) {
    if (
      patch[key] !== null &&
      typeof patch[key] === 'object' &&
      !Array.isArray(patch[key]) &&
      typeof current[key] === 'object' &&
      current[key] !== null &&
      !Array.isArray(current[key])
    ) {
      result[key] = deepMerge(current[key] as Record<string, unknown>, patch[key] as Record<string, unknown>)
    } else {
      result[key] = patch[key]
    }
  }
  return result
}

export class AdapterService {
  constructor(private readonly driver: DbDriver) {
    // sqlite exec runs synchronously under the hood, so fire-and-forget keeps
    // the constructor synchronous (pg builds its schema via pg_schema.ts).
    if (this.driver.kind === 'sqlite') void this.driver.exec(`
      CREATE TABLE IF NOT EXISTS adapter_configs (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        platform TEXT NOT NULL CHECK(platform IN ('telegram', 'feishu')),
        config_json TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS adapter_configs_user_platform_idx
        ON adapter_configs (org_id, user_id, platform);
    `)
  }

  /** Get config for a specific user+platform, returns null if not found */
  async get(orgId: string, userId: string, platform: 'telegram' | 'feishu'): Promise<PlatformConfig | null> {
    const row = await this.driver.get<{ config_json: string }>(
      'SELECT config_json FROM adapter_configs WHERE org_id = ? AND user_id = ? AND platform = ?',
      [orgId, userId, platform],
    )

    if (!row) return null
    return JSON.parse(row.config_json) as PlatformConfig
  }

  /** Get masked config for API responses (secrets hidden) */
  async getMasked(orgId: string, userId: string, platform: 'telegram' | 'feishu'): Promise<PlatformConfig | null> {
    const config = await this.get(orgId, userId, platform)
    if (!config) return null
    return this.maskConfig(config, platform)
  }

  /** Get all adapter configs for an org */
  async listByOrg(orgId: string): Promise<AdapterConfigRow[]> {
    return this.driver.all<AdapterConfigRow>(
      'SELECT id, org_id, user_id, platform, config_json, enabled, created_at, updated_at FROM adapter_configs WHERE org_id = ? ORDER BY user_id, platform',
      [orgId],
    )
  }

  /** Get all adapter configs for a user */
  async listByUser(orgId: string, userId: string): Promise<AdapterConfigRow[]> {
    return this.driver.all<AdapterConfigRow>(
      'SELECT id, org_id, user_id, platform, config_json, enabled, created_at, updated_at FROM adapter_configs WHERE org_id = ? AND user_id = ? ORDER BY platform',
      [orgId, userId],
    )
  }

  /** Upsert config for a user+platform */
  async upsert(orgId: string, userId: string, platform: 'telegram' | 'feishu', patch: PlatformConfig): Promise<PlatformConfig> {
    const now = Date.now()
    const existing = await this.get(orgId, userId, platform)
    const current = existing ?? {}
    const rawCurrent = current as Record<string, unknown>

    // Preserve masked secrets: if the patch contains masked values, keep the originals
    const rawPatch = { ...patch } as Record<string, unknown>
    if (platform === 'telegram') {
      const p = rawPatch as Record<string, unknown>
      if (isMasked(p.botToken as string | undefined)) {
        p.botToken = (rawCurrent as Record<string, unknown>).botToken
      }
    } else {
      const p = rawPatch as Record<string, unknown>
      if (isMasked(p.appSecret as string | undefined)) {
        p.appSecret = (rawCurrent as Record<string, unknown>).appSecret
      }
      if (isMasked(p.encryptKey as string | undefined)) {
        p.encryptKey = (rawCurrent as Record<string, unknown>).encryptKey
      }
      if (isMasked(p.verificationToken as string | undefined)) {
        p.verificationToken = (rawCurrent as Record<string, unknown>).verificationToken
      }
    }

    const merged = deepMerge(rawCurrent, rawPatch) as PlatformConfig
    const configJson = JSON.stringify(merged)

    await this.driver.run(`
      INSERT INTO adapter_configs (id, org_id, user_id, platform, config_json, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(org_id, user_id, platform) DO UPDATE SET
        config_json = excluded.config_json,
        updated_at = excluded.updated_at
    `, [`${orgId}_${userId}_${platform}`, orgId, userId, platform, configJson, now, now])

    return merged
  }

  /** Delete config for a user+platform */
  async delete(orgId: string, userId: string, platform: 'telegram' | 'feishu'): Promise<boolean> {
    const changes = await this.driver.run(
      'DELETE FROM adapter_configs WHERE org_id = ? AND user_id = ? AND platform = ?',
      [orgId, userId, platform],
    )
    return changes > 0
  }

  /** Set enabled status */
  async setEnabled(orgId: string, userId: string, platform: 'telegram' | 'feishu', enabled: boolean): Promise<boolean> {
    const changes = await this.driver.run(
      'UPDATE adapter_configs SET enabled = ?, updated_at = ? WHERE org_id = ? AND user_id = ? AND platform = ?',
      [enabled ? 1 : 0, Date.now(), orgId, userId, platform],
    )
    return changes > 0
  }

  private maskConfig(config: PlatformConfig, platform: 'telegram' | 'feishu'): PlatformConfig {
    if (platform === 'telegram') {
      const tg = { ...config as TelegramPartialConfig }
      if (tg.botToken) tg.botToken = maskSecret(tg.botToken)
      return tg
    }
    const fs = { ...config as FeishuPartialConfig }
    if (fs.appSecret) fs.appSecret = maskSecret(fs.appSecret)
    if (fs.encryptKey) fs.encryptKey = maskSecret(fs.encryptKey)
    if (fs.verificationToken) fs.verificationToken = maskSecret(fs.verificationToken)
    return fs
  }
}