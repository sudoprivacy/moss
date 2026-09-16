import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { extractQmsContract } from './extract-sudowork-qms-api.js'

const expectedSourceCommit = '311636c7bbfa4fa1c655aa8bd5c7e898f565f263'
const sourceRoot = process.env.SUDOWORK_SERVER_ROOT
const routesPath = resolve('contracts/sudowork/routes.json')
const sourceSkipReason = (() => {
  if (!sourceRoot) return 'Set SUDOWORK_SERVER_ROOT to a pinned sudowork-server checkout to run source extraction tests'
  if (!existsSync(sourceRoot)) return `SUDOWORK_SERVER_ROOT does not exist: ${sourceRoot}`
  const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim()
  return sourceHead === expectedSourceCommit
    ? ''
    : `SUDOWORK_SERVER_ROOT must be at ${expectedSourceCommit}, found ${sourceHead}`
})()
const sourceTest = sourceSkipReason ? test.skip : test

describe('Sudowork QMS contract extractor', () => {
  sourceTest('freezes all 72 mounted QMS routes from the pinned source commit', () => {
    expect(sourceRoot).toBeTruthy()
    const contract = extractQmsContract(sourceRoot!, routesPath)

    expect(contract.routes).toHaveLength(72)
    expect(contract.source_commit).toBe(expectedSourceCommit)
    expect(contract.routes.filter(route => route.source_file === 'src/qms/routes/crash.ts')).toHaveLength(28)
    expect(contract.routes.some(route => route.path === '/api/v1/crash/events')).toBe(true)
    expect(contract.routes.some(route => route.path === '/api/v1/qms/crash/events')).toBe(true)
  })

  sourceTest('records actual authentication and hybrid encryption behavior', () => {
    expect(sourceRoot).toBeTruthy()
    const contract = extractQmsContract(sourceRoot!, routesPath)
    const byKey = new Map(contract.routes.map(route => [`${route.method} ${route.path}`, route]))

    expect(byKey.get('POST /api/v1/telemetry/batch')).toMatchObject({
      authentication: 'api_key',
      encryption: 'hybrid_optional',
      tenant_scope: 'ingestion_required',
      side_effects: ['telemetry_enqueue'],
    })
    expect(byKey.get('POST /api/v1/crash/events/batch')).toMatchObject({
      authentication: 'api_key',
      encryption: 'hybrid_optional',
      side_effects: ['crash_write'],
    })
    expect(byKey.get('GET /api/v1/qms/system/health')).toMatchObject({
      authentication: 'jwt',
      tenant_scope: 'administrator',
    })
  })

  sourceTest('classifies every route without silently accepting an unknown QMS route', () => {
    expect(sourceRoot).toBeTruthy()
    const contract = extractQmsContract(sourceRoot!, routesPath)

    expect(contract.routes.every(route => route.request_kind && route.response_kind)).toBe(true)
    expect(contract.routes.every(route => Array.isArray(route.side_effects))).toBe(true)
    expect(contract.routes.filter(route => route.authentication === 'api_key')).toHaveLength(9)
    expect(contract.routes.filter(route => route.authentication === 'jwt')).toHaveLength(63)
  })
})
