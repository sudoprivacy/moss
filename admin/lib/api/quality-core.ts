import type { OperationsHttpClient } from './operations-core'

export type QualityRecord = Record<string, unknown>
export type QualityQuery = Record<string, string | number | boolean | undefined>
export interface QualityResponse<T = unknown> {
  success?: boolean
  data: T
  events?: QualityRecord[]
  total?: number
  message?: string
  error?: string | { message?: string }
}

/** QMS keeps its own envelope; failed operations can also arrive with HTTP 200. */
export function createQualityApi(
  client: OperationsHttpClient,
  scope: 'organization' | 'platform',
  defaults: QualityQuery = {},
) {
  function path(resource: string, query: QualityQuery = {}) {
    const params = new URLSearchParams({ scope })
    for (const [key, value] of Object.entries({ ...defaults, ...query }))
      if (value !== undefined && value !== '') params.set(key, String(value))
    return `/api/moss/v1/operations/qms/${resource}?${params}`
  }
  async function result<T>(pending: Promise<unknown>): Promise<QualityResponse<T>> {
    const response = (await pending) as QualityResponse<T>
    if (response.success === false) {
      throw new Error(
        typeof response.error === 'string'
          ? response.error
          : response.error?.message || response.message || '质量管理请求失败',
      )
    }
    return response
  }
  return {
    get: <T = unknown>(resource: string, query?: QualityQuery) =>
      result<T>(client.get(path(resource, query))),
    post: <T = unknown>(resource: string, body?: unknown) => result<T>(client.post(path(resource), body)),
    put: <T = unknown>(resource: string, body: unknown) => result<T>(client.put(path(resource), body)),
    delete: (resource: string) => result(client.delete(path(resource))),
  }
}
