import { describe, expect, it } from 'bun:test'
import { createQualityApi } from '../lib/api/quality-core'
import { qualityDateRange, qualityConfigValues } from '../src/qms-operations'
import { buildSudoworkConfigPatch } from '../src/sudowork-settings'

describe('quality operations', () => {
  it('preserves query filters and applies explicit data scope', async () => {
    const calls: string[] = []
    const api = createQualityApi(
      {
        get: async (path) => {
          calls.push(path)
          return { success: true, data: [] }
        },
        put: async () => ({}),
        post: async () => ({}),
        delete: async () => ({}),
      },
      'platform',
    )
    await api.get('user-stats/turns', { start_time: 100, end_time: 200, offset: 25, tenant_id: 'TENANT-A' })
    expect(calls[0]).toBe(
      '/api/moss/v1/operations/qms/user-stats/turns?scope=platform&start_time=100&end_time=200&offset=25&tenant_id=TENANT-A',
    )
  })
  it('surfaces failed aggregation even when transport succeeded', async () => {
    const api = createQualityApi(
      {
        get: async () => ({}),
        put: async () => ({}),
        post: async () => ({ success: false, message: '聚合失败' }),
        delete: async () => ({}),
      },
      'organization',
    )
    await expect(api.post('system/aggregation/run')).rejects.toThrow('聚合失败')
  })
  it('uses exclusive next midnight and rejects inverted date ranges', () => {
    const range = qualityDateRange('2026-09-01', '2026-09-01')
    expect(range.start_time).toBe(new Date('2026-09-01T00:00:00').getTime())
    expect(range.end_time).toBe(new Date('2026-09-02T00:00:00').getTime())
    expect(() => qualityDateRange('2026-09-02', '2026-09-01')).toThrow()
  })
  it('edits system configuration rows by their real keys, never array indexes', () => {
    expect(qualityConfigValues([{ key: 'retention_days', value: '90' }])).toEqual({ retention_days: '90' })
    expect(
      buildSudoworkConfigPatch(
        { product_improvement: { enabled: 1, baseurl: 'https://moss.test' }, login_method: 0 },
        new Set(['product_improvement']),
      ),
    ).toEqual({ product_improvement: { enabled: 1, baseurl: 'https://moss.test' } })
  })
})
