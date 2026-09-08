import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { createSudoworkCompatibilityApp } from './app.js'
import { compareSudoworkRouteInventory } from './routeInventory.js'

interface RouteManifest {
  routes: Array<{ method: string; path: string }>
}

describe('Sudowork compatibility implementation inventory', () => {
  test('registers every frozen legacy route and only approved additions', () => {
    const inert = {} as never
    const app = createSudoworkCompatibilityApp({
      identity: inert,
      administration: inert,
      catalog: inert,
      configuration: inert,
      managedImages: inert,
      systemConfiguration: inert,
      billing: inert,
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
    const manifest = JSON.parse(
      readFileSync(new URL('../../../../../contracts/sudowork/routes.json', import.meta.url), 'utf8'),
    ) as RouteManifest
    const { missing, unapproved } = compareSudoworkRouteInventory(manifest.routes, app.routes)

    assert.deepEqual(missing, [])
    assert.deepEqual(unapproved, [])
  })
})
