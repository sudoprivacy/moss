import { describe, expect, it } from 'bun:test'
import {
  extractRegisteredHonoRoutes,
  extractHubClientContract,
  missingHubRoutes,
  type HubClientSource,
} from './extract-sudowork-hub-client-api.js'

const client: HubClientSource = {
  productVersion: 'fixture',
  commit: 'fixture-commit',
  files: {
    'src/skillHub.ts': `
      async function list(cursor, tenantId) {
        const params = new URLSearchParams()
        params.set('cursor', cursor)
        params.set('tenant_id', tenantId)
        return fetch(\`https://hub.test/api/skills/cursor?\${params}\`, {
          headers: { Authorization: 'token' },
        })
      }

      async function upload(file) {
        const formData = new FormData()
        formData.append('name', 'writer')
        appendOptionalFormValue(formData, 'description', 'Writes prose')
        formData.append('skill_file', file)
        const uploadUrl = \`https://hub.test/api/skills\`
        return fetch(uploadUrl, {
          method: 'POST',
          headers: { Authorization: 'token' },
          body: formData,
        })
      }

      async function page() {
        const params = new URLSearchParams({ page: '1', size: '20', query: '', category: '' })
        return fetch(\`https://hub.test/api/skills?\${params}\`, {
          headers: { Authorization: 'token' },
        })
      }

      async function detail(skillId) {
        const url = \`https://hub.test/api/skills/\${skillId}\`
        return fetch(url, { headers: { Authorization: 'token' } })
      }

      async function detailByShortId(id) {
        return fetch(\`https://hub.test/api/skills/\${id}\`, {
          headers: { Authorization: 'token' },
        })
      }

      app.get('/api/categories', async () => ({ local: true }))

      function download(latestVersion) {
        const parsedUrl = new URL(latestVersion.source_url)
        const alternateUrl = latestVersion.sourceUrl
        return https.get(latestVersion.source_url, {
          headers: { Authorization: 'token' },
        }, (response) => {
          if (response.statusCode === 301 || response.statusCode === 302) download(response.headers.location)
        })
      }
    `,
  },
}

describe('extractHubClientContract', () => {
  it('从客户端源码提取 method、path、查询参数、multipart 字段和鉴权', () => {
    const contract = extractHubClientContract([client])

    expect(contract.routes.map((route) => ({
      method: route.method,
      path: route.path,
      query_parameters: route.query_parameters,
      multipart_fields: route.multipart_fields,
      authorization_header: route.authorization_header,
    }))).toEqual([
      {
        method: 'GET',
        path: '/api/skills',
        query_parameters: ['category', 'page', 'query', 'size'],
        multipart_fields: [],
        authorization_header: true,
      },
      {
        method: 'GET',
        path: '/api/skills/cursor',
        query_parameters: ['cursor', 'tenant_id'],
        multipart_fields: [],
        authorization_header: true,
      },
      {
        method: 'GET',
        path: '/api/skills/:skillId',
        query_parameters: [],
        multipart_fields: [],
        authorization_header: true,
      },
      {
        method: 'POST',
        path: '/api/skills',
        query_parameters: [],
        multipart_fields: ['description', 'name', 'skill_file'],
        authorization_header: true,
      },
    ])
  })

  it('冻结响应 source_url 的绝对 URL、鉴权和重定向下载约束', () => {
    const contract = extractHubClientContract([client])

    expect(contract.artifact_download).toEqual({
      method: 'GET',
      source_fields: ['sourceUrl', 'source_url'],
      requires_absolute_url: true,
      authorization_header_observed: true,
      followed_redirect_statuses: [301, 302],
    })
  })
})

describe('missingHubRoutes', () => {
  it('报告客户端使用但 Moss 未注册的 method/path', () => {
    const contract = extractHubClientContract([client])

    expect(missingHubRoutes(contract, [
      { method: 'GET', path: '/api/skills/cursor' },
      { method: 'GET', path: '/api/skills/:skillId' },
      { method: 'POST', path: '/api/skills' },
    ])).toEqual(['GET /api/skills'])
  })

  it('从 Moss 兼容 Adapter 源码提取已注册路由并忽略注释', () => {
    expect(extractRegisteredHonoRoutes(`
      // app.get('/api/not-real', handler)
      app.get('/api/skills', handler)
      app.get('/api/skills/:skillId', handler)
      app.post('/api/skills', handler)
    `)).toEqual([
      { method: 'GET', path: '/api/skills' },
      { method: 'GET', path: '/api/skills/:skillId' },
      { method: 'POST', path: '/api/skills' },
    ])
  })
})
