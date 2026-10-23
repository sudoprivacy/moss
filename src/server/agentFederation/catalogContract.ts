import Ajv from 'ajv'
import schema from '../../../contracts/agent-catalog/v1alpha1/schema.json' with { type: 'json' }
import { ExternalProviderError } from '../externalProviders/policy.js'

const ajv = new Ajv({ allErrors: true, strict: false })
ajv.addSchema(schema)
export function validateCatalogDocument<T>(
  name: keyof typeof schema.definitions,
  value: T,
): T {
  const validator = ajv.getSchema(`${schema.$id}#/definitions/${name}`)!
  if (!validator(value))
    throw new ExternalProviderError(500, 'CATALOG_CONTRACT_INVALID')
  return value
}
