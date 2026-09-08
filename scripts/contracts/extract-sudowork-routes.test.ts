import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extractHonoRoutes,
  manifestsMatchIgnoringGeneratedAt,
} from './extract-sudowork-routes.js'

const temporaryRoots: string[] = []

function createFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'moss-route-contract-'))
  temporaryRoots.push(root)
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(root, relativePath)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('extractHonoRoutes', () => {
  it('composes direct and nested Hono route paths', () => {
    const root = createFixture({
      'src/index.ts': `
        import { Hono } from 'hono'
        import { users } from './users.js'
        const app = new Hono()
        app.get('/healthz', () => undefined)
        app.route('/api/v1/users', users)
        export default app
      `,
      'src/users.ts': `
        import { Hono } from 'hono'
        export const users = new Hono()
        users.get('/', () => undefined)
        users.post('/:id/reset', () => undefined)
      `,
    })

    expect(extractHonoRoutes(root, 'src/index.ts')).toEqual([
      expect.objectContaining({ method: 'GET', path: '/api/v1/users/' }),
      expect.objectContaining({ method: 'POST', path: '/api/v1/users/:id/reset' }),
      expect.objectContaining({ method: 'GET', path: '/healthz' }),
    ])
  })

  it('expands the same child router mounted under two prefixes', () => {
    const root = createFixture({
      'src/index.ts': `
        import { Hono } from 'hono'
        import routes from './routes.js'
        const app = new Hono()
        app.route('/api/v1/crash', routes.crash)
        app.route('/api/v1/qms/crash', routes.crash)
        export default app
      `,
      'src/routes.ts': `
        import { Hono } from 'hono'
        const crash = new Hono()
        crash.post('/reports', () => undefined)
        export default { crash }
      `,
    })

    expect(extractHonoRoutes(root, 'src/index.ts').map((route) => route.path)).toEqual([
      '/api/v1/crash/reports',
      '/api/v1/qms/crash/reports',
    ])
  })

  it('fails when a Hono route path cannot be resolved statically', () => {
    const root = createFixture({
      'src/index.ts': `
        import { Hono } from 'hono'
        const app = new Hono()
        const path = process.env.ROUTE_PATH
        app.get(path, () => undefined)
        export default app
      `,
    })

    expect(() => extractHonoRoutes(root, 'src/index.ts')).toThrow(
      'Cannot statically resolve Hono route path',
    )
  })
})

describe('manifestsMatchIgnoringGeneratedAt', () => {
  it('allows only the generation timestamp to differ', () => {
    const base = {
      schema_version: 1,
      source_commit: 'abc',
      generated_at: 'first',
      routes: [{ method: 'GET', path: '/api/v1/users' }],
    }
    expect(manifestsMatchIgnoringGeneratedAt(base, { ...base, generated_at: 'second' })).toBe(true)
    expect(manifestsMatchIgnoringGeneratedAt(base, {
      ...base,
      generated_at: 'second',
      routes: [{ method: 'POST', path: '/api/v1/users' }],
    })).toBe(false)
  })
})
