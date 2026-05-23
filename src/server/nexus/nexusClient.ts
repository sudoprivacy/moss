import { randomUUID } from 'crypto'

export class NexusClient {
  private readonly baseUrl: string
  private readonly defaultSubject: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
    this.defaultSubject = 'system:moss'
  }

  private headers(subject?: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-Nexus-Subject': `user:${subject ?? this.defaultSubject}`,
    }
  }

  async putSecret(namespace: string, key: string, value: string, subject?: string): Promise<void> {
    const ns = encodeURIComponent(namespace)
    const k = encodeURIComponent(key)
    const res = await fetch(`${this.baseUrl}/api/v2/secrets/${ns}/${k}`, {
      method: 'PUT',
      headers: this.headers(subject),
      body: JSON.stringify({ value }),
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Nexus PUT ${namespace}/${key} failed: ${res.status} ${text}`)
    }
    // Nexus soft-deletes on DELETE; PUT on a soft-deleted secret updates the value
    // but leaves deleted_at set. Restore ensures the secret is readable.
    await fetch(`${this.baseUrl}/api/v2/secrets/${ns}/${k}/restore`, {
      method: 'POST',
      headers: this.headers(subject),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {})
  }

  async getSecret(namespace: string, key: string, subject?: string): Promise<{ value: string | null; status: string; version: number } | null> {
    const ns = encodeURIComponent(namespace)
    const k = encodeURIComponent(key)
    const res = await fetch(`${this.baseUrl}/api/v2/secrets/${ns}/${k}`, {
      headers: this.headers(subject),
      signal: AbortSignal.timeout(3000),
    })
    if (res.status === 404) return null
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Nexus GET ${namespace}/${key} failed: ${res.status} ${text}`)
    }
    return res.json() as Promise<{ value: string | null; status: string; version: number }>
  }

  async deleteSecret(namespace: string, key: string, subject?: string): Promise<void> {
    const ns = encodeURIComponent(namespace)
    const k = encodeURIComponent(key)
    const res = await fetch(`${this.baseUrl}/api/v2/secrets/${ns}/${k}`, {
      method: 'DELETE',
      headers: this.headers(subject),
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => '')
      throw new Error(`Nexus DELETE ${namespace}/${key} failed: ${res.status} ${text}`)
    }
  }

  async enableSecret(namespace: string, key: string, subject?: string): Promise<void> {
    const ns = encodeURIComponent(namespace)
    const k = encodeURIComponent(key)
    const res = await fetch(`${this.baseUrl}/api/v2/secrets/${ns}/${k}/enable`, {
      method: 'PUT',
      headers: this.headers(subject),
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Nexus ENABLE ${namespace}/${key} failed: ${res.status} ${text}`)
    }
  }

  async disableSecret(namespace: string, key: string, subject?: string): Promise<void> {
    const ns = encodeURIComponent(namespace)
    const k = encodeURIComponent(key)
    const res = await fetch(`${this.baseUrl}/api/v2/secrets/${ns}/${k}/disable`, {
      method: 'PUT',
      headers: this.headers(subject),
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Nexus DISABLE ${namespace}/${key} failed: ${res.status} ${text}`)
    }
  }

  async listSecrets(namespace?: string, subject?: string): Promise<Array<{
    namespace: string
    key: string
    value: string | null
    status: string
    version: number
  }>> {
    const params = new URLSearchParams()
    if (namespace) params.set('namespace', namespace)
    const res = await fetch(`${this.baseUrl}/api/v2/secrets?${params}`, {
      headers: this.headers(subject),
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Nexus LIST failed: ${res.status} ${text}`)
    }
    const body = await res.json() as { secrets?: Array<{ namespace: string; key: string; value: string | null; status: string; version: number }> }
    return body.secrets ?? []
  }
}
