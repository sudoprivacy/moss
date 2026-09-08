import { readFileSync } from 'node:fs'
import { createSudoworkCompatibilityApp } from '../../src/server/api/compat/sudowork/app.js'
import { compareSudoworkRouteInventory } from '../../src/server/api/compat/sudowork/routeInventory.js'

interface RouteManifest {
  routes: Array<{ method: string; path: string }>
}

const inert = {} as never
const app = createSudoworkCompatibilityApp({
  identity: inert,
  administration: inert,
  catalog: inert,
  configuration: inert,
  managedImages: inert,
  systemConfiguration: inert,
  billing: inert,
  legacyUsage: inert,
  legacyAdministration: inert,
  difyRuntime: inert,
  difyEnhancement: inert,
  difyDataset: inert,
  difyAdministration: inert,
  resolveEnterpriseAlias: () => null,
  buildVisibility: inert,
  cas: inert,
  sms: inert,
  qms: inert,
})
const manifest = JSON.parse(readFileSync('contracts/sudowork/routes.json', 'utf8')) as RouteManifest
const difference = compareSudoworkRouteInventory(manifest.routes, app.routes)

if (difference.missing.length || difference.unapproved.length) {
  console.error(JSON.stringify(difference, null, 2))
  process.exit(1)
}

console.log(`Sudowork compatibility implementation routes verified: ${manifest.routes.length}`)
