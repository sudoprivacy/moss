import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

type RouteContract = { method: string; path: string; domain: string }

describe('企业自动化所有权边界', () => {
  it('旧 Sudowork Server 契约不包含本地 Cron、Trigger 或 Channel 服务端接口', () => {
    const contract = JSON.parse(readFileSync('contracts/sudowork/routes.json', 'utf8')) as {
      routes: RouteContract[]
    }
    const automationRoutes = contract.routes.filter(route =>
      !route.path.startsWith('/api/v1/qms/') && /\/(?:cron|triggers?|channels?)(?:\/|$)/i.test(route.path),
    )

    assert.deepEqual(automationRoutes, [])
  })

  it('企业自动化仅保留 Moss 原生入口', () => {
    const serverSource = readFileSync('src/server/server.ts', 'utf8')

    assert.match(serverSource, /\/api\/v1\/cron\/jobs/)
    assert.match(serverSource, /\/api\/v1\/triggers/)
    assert.match(serverSource, /\/api\/v1\/channels\/plugins/)
  })
})
