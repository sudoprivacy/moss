import type { ConfigKey } from '../configStore/configStore.js'
import type { SudoworkInfrastructureConfig } from '../api/compat/sudowork/systemConfigService.js'

type Environment = Record<string, string | undefined>

export interface BillingRuntimeConfig {
  enabled: true
  testMode: boolean
  merchantCode: string
  merchantPrivateKey: string
  fuiouPublicKey: string
  baseUrl?: string
  refundUrl?: string
  timeoutMs: number
  sudorouterBaseUrl: string
  sudorouterApiToken: string
  sudorouterAdminUserId: string
  sudorouterTimeoutMs: number
}

export interface SudorouterRuntimeConfig {
  baseUrl: string
  apiToken: string
  adminUserId: string
  timeoutMs: number
  initialQuota: number
  modelServiceUrl: string
  modelsApiUrl: string
}

export function resolveSudorouterRuntimeConfig(input: {
  infrastructure: SudoworkInfrastructureConfig['billing']['sudorouter']
  environment: Environment
  getSecret(key: ConfigKey): string | undefined
}): SudorouterRuntimeConfig | null {
  const baseUrl = input.environment.SUDOROUTER_BASE_URL || input.infrastructure.baseUrl
  const apiToken = input.environment.SUDOROUTER_API_TOKEN
    || input.getSecret('server.sudorouter-api-token')
  if (!baseUrl && !apiToken) return null
  return {
    baseUrl: required(baseUrl, 'SUDOROUTER_BASE_URL'),
    apiToken: required(apiToken, 'SUDOROUTER_API_TOKEN'),
    adminUserId: input.environment.SUDOROUTER_ADMIN_USER_ID || input.infrastructure.adminUserId,
    timeoutMs: positiveInteger(
      input.environment.SUDOROUTER_TIMEOUT_MS,
      input.infrastructure.timeoutMs,
    ),
    initialQuota: nonNegativeInteger(
      input.environment.USER_INITIAL_QUOTA,
      input.infrastructure.initialQuota,
    ),
    modelServiceUrl: (
      input.environment.SUDOROUTER_MODEL_SERVICE_URL || input.infrastructure.modelServiceUrl
    ).replace(/\/+$/, ''),
    modelsApiUrl: (
      input.environment.SUDOROUTER_MODELS_API_URL || input.infrastructure.modelsApiUrl
    ).replace(/\/+$/, ''),
  }
}

export function resolveBillingRuntimeConfig(input: {
  infrastructure: SudoworkInfrastructureConfig['billing']
  environment: Environment
  getSecret(key: ConfigKey): string | undefined
  readFile(path: string): string
}): BillingRuntimeConfig | null {
  const { environment, infrastructure } = input
  const enabled = environment.SUDOWORK_BILLING_ENABLED === undefined
    ? infrastructure.enabled
    : environment.SUDOWORK_BILLING_ENABLED === 'true'
  if (!enabled) return null

  const testMode = environment.FUIOU_TEST_MODE === undefined
    ? infrastructure.fuiou.testMode
    : environment.FUIOU_TEST_MODE === 'true'
  const merchantCode = required(
    environment.FUIOU_MERCHANT_CODE || infrastructure.fuiou.merchantCode,
    'FUIOU_MERCHANT_CODE',
  )
  const merchantPrivateKey = required(
    keyValue('FUIOU_MERCHANT_PRIVATE_KEY', 'server.fuiou-merchant-private-key', input),
    'FUIOU_MERCHANT_PRIVATE_KEY',
  )
  const fuiouPublicKey = required(
    keyValue('FUIOU_PUBLIC_KEY', 'server.fuiou-public-key', input),
    'FUIOU_PUBLIC_KEY',
  )
  const sudorouter = resolveSudorouterRuntimeConfig({
    infrastructure: infrastructure.sudorouter,
    environment,
    getSecret: input.getSecret,
  })
  if (!sudorouter) throw new Error('Sudowork Billing requires SUDOROUTER_BASE_URL')

  return {
    enabled: true,
    testMode,
    merchantCode,
    merchantPrivateKey,
    fuiouPublicKey,
    baseUrl: environment[testMode ? 'FUIOU_TEST_API_URL' : 'FUIOU_PROD_API_URL']
      || infrastructure.fuiou[testMode ? 'testApiUrl' : 'prodApiUrl'],
    refundUrl: environment[testMode ? 'FUIOU_TEST_REFUND_URL' : 'FUIOU_PROD_REFUND_URL']
      || infrastructure.fuiou[testMode ? 'testRefundUrl' : 'prodRefundUrl'],
    timeoutMs: positiveInteger(environment.FUIOU_TIMEOUT_MS, infrastructure.fuiou.timeoutMs),
    sudorouterBaseUrl: sudorouter.baseUrl,
    sudorouterApiToken: sudorouter.apiToken,
    sudorouterAdminUserId: sudorouter.adminUserId,
    sudorouterTimeoutMs: sudorouter.timeoutMs,
  }
}

function keyValue(
  prefix: 'FUIOU_MERCHANT_PRIVATE_KEY' | 'FUIOU_PUBLIC_KEY',
  nexusKey: ConfigKey,
  input: {
    environment: Environment
    getSecret(key: ConfigKey): string | undefined
    readFile(path: string): string
  },
): string | undefined {
  const file = input.environment[`${prefix}_FILE`]?.trim()
  if (file) return input.readFile(file)
  const encoded = input.environment[`${prefix}_BASE64`]?.trim()
  if (encoded) return Buffer.from(encoded, 'base64').toString('utf8')
  return input.environment[prefix]?.trim() || input.getSecret(nexusKey)
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim()
  if (!normalized) throw new Error(`Sudowork Billing requires ${name}`)
  return normalized
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Sudowork Billing timeout must be a positive integer: ${value}`)
  }
  return parsed
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Sudowork initial quota must be a non-negative integer: ${value}`)
  }
  return parsed
}
