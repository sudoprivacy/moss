/**
 * In-memory secrets store for environments where Nexus is not available.
 * This is a fallback implementation that stores secrets in memory.
 * Data is lost on server restart - suitable for development/testing only.
 */

export interface StoredSecret {
  namespace: string
  key: string
  value: string | null
  status: 'active' | 'disabled'
  version: number
  deleted_at: number | null
}

export class InMemorySecretsStore {
  private secrets: Map<string, StoredSecret> = new Map()
  private readonly defaultSubject: string = 'system:moss'

  private makeKey(namespace: string, key: string): string {
    return `${namespace}:${key}`
  }

  async putSecret(namespace: string, key: string, value: string, subject?: string): Promise<void> {
    const k = this.makeKey(namespace, key)
    const existing = this.secrets.get(k)

    if (existing && existing.deleted_at !== null) {
      // Restore soft-deleted secret
      existing.value = value
      existing.deleted_at = null
      existing.status = 'active'
      existing.version += 1
    } else if (existing) {
      // Update existing
      existing.value = value
      existing.version += 1
    } else {
      // Create new
      this.secrets.set(k, {
        namespace,
        key,
        value,
        status: 'active',
        version: 1,
        deleted_at: null,
      })
    }
  }

  async getSecret(namespace: string, key: string, subject?: string): Promise<{ value: string | null; status: string; version: number } | null> {
    const k = this.makeKey(namespace, key)
    const secret = this.secrets.get(k)

    if (!secret || secret.deleted_at !== null) {
      return null
    }

    return {
      value: secret.value,
      status: secret.status,
      version: secret.version,
    }
  }

  async deleteSecret(namespace: string, key: string, subject?: string): Promise<void> {
    const k = this.makeKey(namespace, key)
    const secret = this.secrets.get(k)

    if (secret) {
      // Soft delete
      secret.deleted_at = Date.now()
    }
  }

  async enableSecret(namespace: string, key: string, subject?: string): Promise<void> {
    const k = this.makeKey(namespace, key)
    const secret = this.secrets.get(k)

    if (secret) {
      secret.status = 'active'
    }
  }

  async disableSecret(namespace: string, key: string, subject?: string): Promise<void> {
    const k = this.makeKey(namespace, key)
    const secret = this.secrets.get(k)

    if (secret) {
      secret.status = 'disabled'
    }
  }

  async listSecrets(namespace?: string, subject?: string): Promise<Array<{
    namespace: string
    key: string
    value: string | null
    status: string
    version: number
  }>> {
    const results: Array<{
      namespace: string
      key: string
      value: string | null
      status: string
      version: number
    }> = []

    for (const secret of this.secrets.values()) {
      // Skip soft-deleted secrets
      if (secret.deleted_at !== null) continue

      // Filter by namespace if provided
      if (namespace && secret.namespace !== namespace) continue

      results.push({
        namespace: secret.namespace,
        key: secret.key,
        value: secret.value,
        status: secret.status,
        version: secret.version,
      })
    }

    return results
  }
}
