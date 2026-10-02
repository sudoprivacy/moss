export interface QmsConfigInput {
  enabled?: boolean
  apiKeyHeader?: string
  queueFlushIntervalMs?: number
  queueBatchSize?: number
  queueMaxItems?: number
  queueMaxBytes?: number
  queueRetryIntervalMs?: number
  queueDrainTimeoutMs?: number
  perfRetentionDays?: number
  conversationRetentionDays?: number
}

export interface QmsSecretEnvironment {
  QMS_ENABLED?: string
  QMS_DEFAULT_API_KEY?: string
  QMS_API_KEY?: string
  QMS_LARK_WEBHOOK_URL?: string
  QMS_SMTP_URL?: string
}

export interface QmsRuntimeConfig {
  enabled: boolean
  apiKeyHeader: string
  queue: {
    flushIntervalMs: number
    batchSize: number
    maxItems: number
    maxBytes: number
    retryIntervalMs: number
    drainTimeoutMs: number
  }
  retention: {
    perfDays: number
    conversationDays: number
    crashDays: number
    aggregateDays: number
  }
  secrets: {
    apiKey?: string
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

export function resolveQmsConfig(
  input: QmsConfigInput,
  secrets: QmsSecretEnvironment = process.env as QmsSecretEnvironment,
  options: { validateSecrets?: boolean; dbBackend?: 'sqlite' | 'postgres' } = {},
): QmsRuntimeConfig {
  const enabled = secrets.QMS_ENABLED === undefined ? input.enabled ?? (options.dbBackend === 'postgres') : secrets.QMS_ENABLED === 'true'
  const apiKey = secrets.QMS_API_KEY?.trim() || secrets.QMS_DEFAULT_API_KEY?.trim()
  const missing: string[] = []

  if (enabled && options.validateSecrets !== false) {
    if (!apiKey) missing.push('QMS_API_KEY')
  }
  if (missing.length > 0) {
    throw new QmsConfigurationError(`Missing required QMS secrets: ${missing.join(', ')}`, missing)
  }

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
      maxItems: positiveInteger(input.queueMaxItems, 10_000, 'QMS memory queue capacity'),
      maxBytes: positiveInteger(input.queueMaxBytes, 16 * 1024 * 1024, 'QMS memory queue byte capacity'),
      retryIntervalMs: positiveInteger(input.queueRetryIntervalMs, 1_000, 'QMS queue retry interval'),
      drainTimeoutMs: positiveInteger(input.queueDrainTimeoutMs, 15_000, 'QMS queue drain timeout'),
    },
    retention: {
      perfDays: positiveInteger(input.perfRetentionDays, 90, 'QMS performance retention'),
      conversationDays: positiveInteger(input.conversationRetentionDays, 180, 'QMS conversation retention'),
      crashDays: 90,
      aggregateDays: 365,
    },
    secrets: {
      apiKey: apiKey || undefined,
      larkWebhookUrl: secrets.QMS_LARK_WEBHOOK_URL?.trim() || undefined,
      smtpUrl: secrets.QMS_SMTP_URL?.trim() || undefined,
    },
  }
}

export function assertQmsRuntimeConfig(config: QmsRuntimeConfig): void {
  if (!config.enabled) return
  const missing: string[] = []
  if (!config.secrets.apiKey?.trim()) missing.push('QMS_API_KEY')
  if (missing.length > 0) {
    throw new QmsConfigurationError(`Missing required QMS secrets: ${missing.join(', ')}`, missing)
  }
}
