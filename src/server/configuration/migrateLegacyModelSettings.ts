import type { DatabaseSync } from 'node:sqlite'
import { getStoredProviderApiKeys } from '../modelProviders.js'
import { getOrganizationSystemSettings, getSystemSettings, updateOrganizationSystemSettings } from '../systemSettings.js'
import { OrganizationModelSettingsRepository } from './organizationModelSettingsRepository.js'

const MIGRATION_ID = 'legacy-platform-models-v1'

/** Transfer legacy credentials once to the deployment's existing default organization. */
export async function migrateLegacyModelSettings(db: DatabaseSync, defaultOrgId: string): Promise<void> {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organization_model_settings_migrations (
      migration_id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      completed_at INTEGER NOT NULL
    )
  `)
  if (db.prepare('SELECT 1 FROM organization_model_settings_migrations WHERE migration_id = ?').get(MIGRATION_ID)) return
  if (!db.prepare('SELECT 1 FROM organizations WHERE id = ?').get(defaultOrgId)) {
    throw new Error('Legacy model migration requires an existing default organization')
  }
  const repository = new OrganizationModelSettingsRepository(db)
  const organization = await getOrganizationSystemSettings(defaultOrgId, repository)
  const initialized = repository.has(defaultOrgId) || organization.apiKeyConfigured
    || organization.image.apiKeyConfigured || organization.modelProviders.some(provider => provider.apiKeyConfigured)
  if (!initialized) {
    const platform = getSystemSettings()
    const keys = getStoredProviderApiKeys()
    const apiKey = platform.apiKey || process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim() || ''
    if (apiKey || platform.image.apiKey || Object.keys(keys).length > 0) {
      await updateOrganizationSystemSettings(defaultOrgId, repository, {
        model: platform.model,
        url: platform.url,
        apiKey,
        defaultModelProviderId: platform.defaultModelProviderId,
        modelProviders: platform.modelProviders.map(provider => ({ ...provider, ...(keys[provider.id] ? { apiKey: keys[provider.id] } : {}) })),
        image: platform.image,
      }, 'migration:legacy-model-settings')
    }
  }
  // Record even an empty fresh install, so later platform writes cannot leak into an organization.
  db.prepare(`
    INSERT INTO organization_model_settings_migrations (migration_id, org_id, completed_at)
    VALUES (?, ?, ?) ON CONFLICT(migration_id) DO NOTHING
  `).run(MIGRATION_ID, defaultOrgId, Date.now())
}
