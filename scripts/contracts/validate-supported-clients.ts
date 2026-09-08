import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js'
import schema from '../../contracts/sudowork/supported-clients.schema.json'

export type ClientPlatform = 'darwin' | 'win32' | 'linux'
export type ClientArchitecture = 'arm64' | 'x64'
export type ClientAuthProfile =
  | 'password'
  | 'sms'
  | 'cas'
  | 'login_by_config'
  | 'refresh_token'
  | 'oauth2'

export type SupportedClient = {
  product_version: string
  git_ref: string
  commit: string
  channel: 'stable' | 'nightly' | 'private' | 'development'
  targets: Array<{ platform: ClientPlatform; architecture: ClientArchitecture }>
  auth_profiles: ClientAuthProfile[]
  capabilities: Array<'local' | 'cloud' | 'dify' | 'cron' | 'channel'>
  support_status: 'candidate' | 'supported' | 'unsupported'
}

export type SupportedClientsDocument = {
  schema_version: 1
  policy_status: 'candidate' | 'confirmed'
  clients: SupportedClient[]
}

const validateSchema = new Ajv2020({ allErrors: true, strict: false }).compile(schema)

function dottedPath(instancePath: string): string {
  return instancePath
    .split('/')
    .filter(Boolean)
    .map((part, index) => (/^\d+$/.test(part) ? `[${part}]` : `${index === 0 ? '' : '.'}${part}`))
    .join('')
}

function formatSchemaError(error: ErrorObject, input: unknown): string {
  const path = dottedPath(error.instancePath)
  if (error.keyword === 'minLength') {
    return `${path} must be a non-empty string`
  }
  if (error.keyword === 'minItems') {
    return `${path} must contain at least one value`
  }
  if (error.keyword === 'enum') {
    const parts = error.instancePath.split('/').filter(Boolean)
    let value: unknown = input
    for (const part of parts) {
      value = Array.isArray(value)
        ? value[Number(part)]
        : value && typeof value === 'object'
          ? (value as Record<string, unknown>)[part]
          : undefined
    }
    return `${path} has unsupported value: ${String(value)}`
  }
  if (error.keyword === 'required') {
    const missing = String(error.params.missingProperty)
    return `${path ? `${path}.` : ''}${missing} is required`
  }
  return `${path || 'document'} ${error.message ?? 'is invalid'}`
}

export function validateSupportedClients(input: unknown): string[] {
  const errors: string[] = []
  if (!validateSchema(input)) {
    errors.push(...(validateSchema.errors ?? []).map((error) => formatSchemaError(error, input)))
    return errors
  }

  const document = input as SupportedClientsDocument
  const coverage = new Set<string>()
  for (const client of document.clients) {
    for (const target of client.targets) {
      const key = `${client.git_ref}/${target.platform}/${target.architecture}`
      if (coverage.has(key)) {
        errors.push(`duplicate client coverage: ${key}`)
      }
      coverage.add(key)
    }
  }

  if (
    document.policy_status === 'confirmed' &&
    document.clients.some((client) => client.support_status === 'candidate')
  ) {
    errors.push('confirmed policy cannot contain candidate clients')
  }
  return errors
}

if (import.meta.main) {
  const matrixPath = fileURLToPath(
    new URL('../../contracts/sudowork/supported-clients.json', import.meta.url),
  )
  const document = JSON.parse(readFileSync(matrixPath, 'utf8')) as unknown
  const errors = validateSupportedClients(document)
  if (errors.length > 0) {
    for (const error of errors) console.error(`[clients-contract] ${error}`)
    process.exit(1)
  }

  const matrix = document as SupportedClientsDocument
  console.log(
    `[clients-contract] valid; policy_status=${matrix.policy_status}; clients=${matrix.clients.length}`,
  )
}
