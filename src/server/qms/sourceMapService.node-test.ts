import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SourceMapGenerator } from 'source-map-js'

import { SourceMapService, type QmsSourceMapRepository } from './sourceMapService.js'

function mapContent(): string {
  const generator = new SourceMapGenerator({ file: 'app.js' })
  generator.addMapping({
    generated: { line: 1, column: 0 },
    original: { line: 10, column: 2 },
    source: 'src/app.ts',
    name: 'boot',
  })
  return generator.toString()
}

describe('SourceMapService', () => {
  it('resolves maps by tenant, version, platform and generated file', async () => {
    const lookups: unknown[][] = []
    const repository: QmsSourceMapRepository = {
      find: async (...args) => {
        lookups.push(args)
        return mapContent()
      },
    }
    const service = new SourceMapService(repository)

    const result = await service.symbolicate({
      tenantId: 'tenant-a', version: '1.0.0', platform: 'darwin',
      stack: 'TypeError: boom\n    at boot (app.js:1:0)',
    })

    assert.deepEqual(lookups, [['tenant-a', '1.0.0', 'darwin', 'app.js']])
    assert.match(result, /at boot \(src\/app\.ts:10:2\)/)
  })

  it('preserves the original frame when no map or mapping exists', async () => {
    const service = new SourceMapService({ find: async () => null })
    const stack = 'TypeError: boom\n    at boot (app.js:1:0)'
    assert.equal(await service.symbolicate({ tenantId: 'tenant-a', version: '1', platform: 'linux', stack }), stack)
  })
})
