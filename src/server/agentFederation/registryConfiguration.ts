import { readFileSync, statSync } from 'node:fs'
import { ProductRegistryClient, type RegistryClientOptions } from './registryClient.js'
import { ExternalProviderError } from '../externalProviders/policy.js'

/** Infrastructure configuration only; Agent registration and publication stay in the admin UI. */
export function registryFromEnvironment(): ProductRegistryClient | undefined {
  const path = process.env.MOSS_AGENT_REGISTRY_CONFIG_FILE
  if (!path) return undefined
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Omit<RegistryClientOptions, 'token' | 'request'> & { tokenFile: string }
    if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['endpoint', 'publicKeys', 'organizations', 'tokenFile'].includes(key))
      || typeof value.tokenFile !== 'string' || (statSync(value.tokenFile).mode & 0o077)) throw new Error('invalid infrastructure configuration')
    const token = readFileSync(value.tokenFile, 'utf8').trim()
    return new ProductRegistryClient({ endpoint: value.endpoint, organizations: value.organizations, publicKeys: value.publicKeys, token })
  } catch { throw new ExternalProviderError(500, 'REGISTRY_CONFIGURATION_INVALID') }
}
