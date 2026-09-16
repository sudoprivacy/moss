import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, test } from 'node:test'
import { extractDifyContract } from './extract-sudowork-dify-api.js'

const expectedSourceCommit = '311636c7bbfa4fa1c655aa8bd5c7e898f565f263'
const sourceRoot = process.env.SUDOWORK_SERVER_ROOT
const routesPath = resolve('contracts/sudowork/routes.json')
const sourceSkipReason = (() => {
  if (!sourceRoot) return 'Set SUDOWORK_SERVER_ROOT to a pinned sudowork-server checkout to run source extraction tests'
  if (!existsSync(sourceRoot)) return `SUDOWORK_SERVER_ROOT does not exist: ${sourceRoot}`
  const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim()
  return sourceHead === expectedSourceCommit
    ? false
    : `SUDOWORK_SERVER_ROOT must be at ${expectedSourceCommit}, found ${sourceHead}`
})()
const sourceTest = sourceSkipReason ? test.skip : test

describe('Sudowork Dify contract extractor', () => {
  sourceTest('freezes all 45 Dify routes from the pinned source commit', () => {
    assert(sourceRoot)
    const contract = extractDifyContract(sourceRoot, routesPath)

    assert.equal(contract.source_commit, expectedSourceCommit)
    assert.equal(contract.routes.length, 45)
    assert.equal(new Set(contract.routes.map(route => `${route.method} ${route.path}`)).size, 45)
    assert(contract.routes.some(route => route.path === '/api/v1/agents/visible'))
    assert(contract.routes.some(route => route.path === '/api/v1/admin/datasets/:datasetId/retrieve'))
  })

  sourceTest('classifies streaming, binary, multipart, redirect and external write behavior', () => {
    assert(sourceRoot)
    const contract = extractDifyContract(sourceRoot, routesPath)
    const byKey = new Map(contract.routes.map(route => [`${route.method} ${route.path}`, route]))

    assert.equal(byKey.get('POST /api/v1/agents/:assistantId/chat')?.response_kind, 'sse')
    assert.equal(byKey.get('POST /api/v1/agents/:assistantId/text-to-audio')?.response_kind, 'binary')
    assert.equal(byKey.get('POST /api/v1/agents/:assistantId/files')?.request_kind, 'multipart')
    assert.equal(byKey.get('GET /api/v1/admin/dify/sso')?.response_kind, 'redirect_or_html')
    assert.deepEqual(byKey.get('POST /api/v1/admin/dify/binding/provision')?.side_effects, ['dify_provision'])
    assert.deepEqual(byKey.get('DELETE /api/v1/admin/datasets/:datasetId')?.side_effects, ['dify_dataset_write'])
  })

  sourceTest('records authentication and refuses any route without an explicit definition', () => {
    assert(sourceRoot)
    const contract = extractDifyContract(sourceRoot, routesPath)
    assert(contract.routes.filter(route => route.authentication === 'user').length >= 18)
    assert(contract.routes.filter(route => route.authentication === 'admin').length >= 27)
    assert(contract.routes.every(route => route.success_contract.length > 0))
  })
})
