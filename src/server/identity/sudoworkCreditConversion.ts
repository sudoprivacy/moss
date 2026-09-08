const LEGACY_QUOTA_PER_USD = 500_000
const LEGACY_POINTS_PER_QUOTA = 0.002

export function sudoworkQuotaToCreditUnits(quota: number): number {
  if (!Number.isFinite(quota) || quota < 0) throw new Error('Sudowork quota must be a non-negative number')
  const points = Math.round(quota * LEGACY_POINTS_PER_QUOTA)
  if (!Number.isSafeInteger(points)) throw new Error('Sudowork quota exceeds the supported range')
  return points
}

export function sudoworkUsdToCreditUnits(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) throw new Error('Sudowork USD quota must be a non-negative number')
  const quota = Math.round(usd * LEGACY_QUOTA_PER_USD)
  if (!Number.isSafeInteger(quota)) throw new Error('Sudowork USD quota exceeds the supported range')
  return sudoworkQuotaToCreditUnits(quota)
}
