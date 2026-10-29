import type { DirectConnectStore } from '../db.js'
import type { McpAuthSecretsApi } from './authResolver.js'

/** IT-reviewed host access uses the existing organization-scoped system credential definitions. */
export function systemMcpAuthSecrets(store: DirectConnectStore,
  listSecrets: McpAuthSecretsApi['listSecrets'], org: string): McpAuthSecretsApi {
  return {
    getConfigItemByPinyin: async pinyin => {
      const row = await store.getConfigItemByPinyin(pinyin, org)
      if (!row || row.scope !== 'system' || Number(row.status) !== 1 || !['bearer', 'basic', 'header'].includes(String(row.scheme))) return null
      return { pinyin: String(row.pinyin), scheme: row.scheme as 'bearer' | 'basic' | 'header',
        bearer_prefix: row.bearer_prefix == null ? null : String(row.bearer_prefix),
        entries: (await store.getConfigEntries(Number(row.id))).map(entry => ({ config_key: String(entry.config_key) })) }
    },
    listSecrets,
  }
}
