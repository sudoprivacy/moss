import type { SecretsApi } from '../api/secrets.js'
import type { BrowserPrincipal } from '../browser/browserGateway.js'

const keys = ['shareone_key', 'api_key', 'X-API-Key'] as const
const unavailable = () => new Error('Existing ShareOne credentials are temporarily unavailable')

/** Reuse the current user's existing Vault namespace and compatibility aliases. */
export function createUserShareoneCredentials(
  api: Pick<SecretsApi, 'getUserSecret' | 'putUserSecret' | 'deleteUserSecret'>,
  owner: BrowserPrincipal,
  authorize: () => Promise<void>,
) {
  if (!owner.orgId || !owner.userId) throw new Error('ShareOne credentials require the current authenticated owner')
  // Capture the trusted owner once; neither the review page nor an input may retarget it.
  const orgId = owner.orgId, userId = owner.userId
  const namespace = `user:${userId}:shareone`
  return {
    getKey: async (): Promise<string | null> => {
      await authorize()
      for (const key of keys) {
        const response = await api.getUserSecret(orgId, userId, namespace, key).catch(() => { throw unavailable() })
        await authorize()
        if (!response.success) {
          if (response.error?.code === 'not_found') continue
          throw unavailable()
        }
        const value = 'data' in response ? response.data?.value?.trim() : null
        if (value) return value
      }
      return null
    },
    setKey: async (value: string | null): Promise<void> => {
      await authorize()
      if (value !== null) {
        const response = await api.putUserSecret(orgId, userId, namespace, keys[0], value).catch(() => { throw unavailable() })
        if (!response.success) throw unavailable()
        await authorize()
      } else {
        for (const key of keys) {
          await authorize()
          const response = await api.deleteUserSecret(orgId, userId, namespace, key).catch(() => { throw unavailable() })
          if (!response.success && response.error?.code !== 'not_found') throw unavailable()
          await authorize()
        }
      }
    },
  }
}
