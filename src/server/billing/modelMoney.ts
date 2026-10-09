/** Model credit is USD; Router quota is the authoritative integer unit. */
export const QUOTA_PER_USD = 500_000
export const USD_MICROS = 1_000_000

export function requireInteger(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer >= ${minimum}`)
  }
  return value
}

function checked(value: bigint): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new Error('Amount exceeds the supported range')
  return number
}

/** Inputs are decimal strings, never floats or legacy points. */
export function parseUsd(value: unknown, allowZero = true): number {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value)) {
    throw new Error('USD amount must be a decimal string with at most two decimal places')
  }
  const [whole, fraction = ''] = value.split('.')
  const micros = checked(BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(2, '0')) * 10_000n)
  if (!allowZero && micros === 0) throw new Error('USD amount must be positive')
  return micros
}

export function usdMicrosToQuota(micros: number, quotaPerUsd = QUOTA_PER_USD): number {
  requireInteger(micros, 'USD micros')
  requireInteger(quotaPerUsd, 'quota per USD', 1)
  const numerator = BigInt(micros) * BigInt(quotaPerUsd)
  if (numerator % 1_000_000n) throw new Error('USD amount cannot be represented exactly in quota')
  return checked(numerator / 1_000_000n)
}

export function quotaToUsd(quota: number, quotaPerUsd = QUOTA_PER_USD): string {
  requireInteger(quota, 'quota', -Number.MAX_SAFE_INTEGER)
  requireInteger(quotaPerUsd, 'quota per USD', 1)
  const numerator = BigInt(quota) * 1_000_000n
  if (numerator % BigInt(quotaPerUsd)) throw new Error('Quota cannot be represented in USD micro units')
  return formatUsdMicros(checked(numerator / BigInt(quotaPerUsd)))
}

export function formatUsdMicros(micros: number): string {
  requireInteger(micros, 'USD micros', -Number.MAX_SAFE_INTEGER)
  const amount = BigInt(micros < 0 ? -micros : micros)
  const decimal = (amount % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0')
  return `${micros < 0 ? '-' : ''}${amount / 1_000_000n}.${decimal}`
}

/** Freeze this once at order creation. Do not reverse-convert the rounded fen. */
export function payableCnyFen(purchaseUsdMicros: number, cnyPerUsdMicros: number): number {
  requireInteger(purchaseUsdMicros, 'purchase USD micros', 1)
  requireInteger(cnyPerUsdMicros, 'exchange rate micros', 1)
  return checked((BigInt(purchaseUsdMicros) * BigInt(cnyPerUsdMicros) + 5_000_000_000n) / 10_000_000_000n)
}
