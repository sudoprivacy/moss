export interface QmsConfigInput {
  enabled?: boolean
  apiKeyHeader?: string
  queueFlushIntervalMs?: number
  queueBatchSize?: number
  perfRetentionDays?: number
  conversationRetentionDays?: number
  encryptionRequired?: boolean
}

export interface QmsSecretEnvironment {
  QMS_POSTGRES_URL?: string
  QMS_REDIS_URL?: string
  QMS_API_KEY?: string
  QMS_TELEMETRY_PRIVATE_KEY?: string
  QMS_TELEMETRY_PUBLIC_KEY?: string
  QMS_LARK_WEBHOOK_URL?: string
  QMS_SMTP_URL?: string
}

export interface QmsRuntimeConfig {
  enabled: boolean
  apiKeyHeader: string
  queue: {
    flushIntervalMs: number
    batchSize: number
    visibilityTimeoutMs: number
  }
  retention: {
    perfDays: number
    conversationDays: number
    crashDays: number
    aggregateDays: number
  }
  encryptionRequired: boolean
  secrets: {
    postgresUrl?: string
    redisUrl?: string
    apiKey?: string
    privateKeyPem?: string
    publicKeyPem?: string
    larkWebhookUrl?: string
    smtpUrl?: string
  }
}

export class QmsConfigurationError extends Error {
  constructor(message: string, readonly missing: string[] = []) {
    super(message)
    this.name = 'QmsConfigurationError'
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new QmsConfigurationError(`${name} must be a positive integer`)
  }
  return resolved
}

function assertPostgresUrlIsSafe(value: string | undefined): void {
  if (!value) return
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new QmsConfigurationError('QMS_POSTGRES_URL must be a valid URL')
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new QmsConfigurationError('QMS_POSTGRES_URL must use postgres:// or postgresql://')
  }
  if (parsed.username === 'postgres' && parsed.password === 'postgres') {
    throw new QmsConfigurationError('QMS uses unsafe legacy PostgreSQL credentials')
  }
}

export function resolveQmsConfig(
  input: QmsConfigInput,
  secrets: QmsSecretEnvironment = process.env as QmsSecretEnvironment,
  options: { validateSecrets?: boolean } = {},
): QmsRuntimeConfig {
  const enabled = input.enabled ?? false
  const encryptionRequired = input.encryptionRequired ?? false
  const missing: string[] = []

  if (enabled && options.validateSecrets !== false) {
    if (!secrets.QMS_POSTGRES_URL?.trim()) missing.push('QMS_POSTGRES_URL')
    if (!secrets.QMS_REDIS_URL?.trim()) missing.push('QMS_REDIS_URL')
    if (!secrets.QMS_API_KEY?.trim()) missing.push('QMS_API_KEY')
    if (encryptionRequired && !secrets.QMS_TELEMETRY_PRIVATE_KEY?.trim()) {
      missing.push('QMS_TELEMETRY_PRIVATE_KEY')
    }
    if (encryptionRequired && !secrets.QMS_TELEMETRY_PUBLIC_KEY?.trim()) {
      missing.push('QMS_TELEMETRY_PUBLIC_KEY')
    }
  }
  if (missing.length > 0) {
    throw new QmsConfigurationError(`Missing required QMS secrets: ${missing.join(', ')}`, missing)
  }

  assertPostgresUrlIsSafe(secrets.QMS_POSTGRES_URL)
  const apiKeyHeader = input.apiKeyHeader?.trim() || 'X-API-Key'
  if (!/^[A-Za-z0-9-]+$/.test(apiKeyHeader)) {
    throw new QmsConfigurationError('QMS API key header contains invalid characters')
  }

  return {
    enabled,
    apiKeyHeader,
    queue: {
      flushIntervalMs: positiveInteger(input.queueFlushIntervalMs, 3_000, 'QMS queue flush interval'),
      batchSize: positiveInteger(input.queueBatchSize, 50, 'QMS queue batch size'),
      visibilityTimeoutMs: 60_000,
    },
    retention: {
      perfDays: positiveInteger(input.perfRetentionDays, 90, 'QMS performance retention'),
      conversationDays: positiveInteger(input.conversationRetentionDays, 180, 'QMS conversation retention'),
      crashDays: 90,
      aggregateDays: 365,
    },
    encryptionRequired,
    secrets: {
      postgresUrl: secrets.QMS_POSTGRES_URL?.trim() || undefined,
      redisUrl: secrets.QMS_REDIS_URL?.trim() || undefined,
      apiKey: secrets.QMS_API_KEY?.trim() || undefined,
      privateKeyPem: secrets.QMS_TELEMETRY_PRIVATE_KEY?.trim() || undefined,
      publicKeyPem: secrets.QMS_TELEMETRY_PUBLIC_KEY?.trim() || undefined,
      larkWebhookUrl: secrets.QMS_LARK_WEBHOOK_URL?.trim() || undefined,
      smtpUrl: secrets.QMS_SMTP_URL?.trim() || undefined,
    },
  }
}

export function assertQmsRuntimeConfig(config: QmsRuntimeConfig): void {
  if (!config.enabled) return
  const missing: string[] = []
  if (!config.secrets.postgresUrl?.trim()) missing.push('QMS_POSTGRES_URL')
  if (!config.secrets.redisUrl?.trim()) missing.push('QMS_REDIS_URL')
  if (!config.secrets.apiKey?.trim()) missing.push('QMS_API_KEY')
  if (config.encryptionRequired && !config.secrets.privateKeyPem?.trim()) missing.push('QMS_TELEMETRY_PRIVATE_KEY')
  if (config.encryptionRequired && !config.secrets.publicKeyPem?.trim()) missing.push('QMS_TELEMETRY_PUBLIC_KEY')
  if (missing.length > 0) {
    throw new QmsConfigurationError(`Missing required QMS secrets: ${missing.join(', ')}`, missing)
  }
  assertPostgresUrlIsSafe(config.secrets.postgresUrl)
}
