import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDifyDatasetsApi } from './dify-datasets-core.js'

test('Dify Dataset client 保持旧 JSON 与 multipart 协议', async () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const api = createDifyDatasetsApi({
    get: async path => { calls.push({ method: 'GET', path }); return {} },
    post: async (path, body) => { calls.push({ method: 'POST', path, body }); return {} },
    patch: async (path, body) => { calls.push({ method: 'PATCH', path, body }); return {} },
    delete: async path => { calls.push({ method: 'DELETE', path }); return {} },
  })
  await api.list(9, { page: 2, limit: 20, keyword: '知识' })
  await api.create(9, { name: '知识库', indexingTechnique: 'high_quality' })
  await api.update(9, 'ds/1', { name: '新名称' })
  await api.listDocuments(9, 'ds/1', { page: 1, limit: 50 })
  await api.createTextDocument(9, 'ds/1', { name: '说明', text: '内容' })
  const form = new FormData(); form.set('file', new File(['bytes'], 'guide.txt'))
  await api.createFileDocument(9, 'ds/1', form)
  await api.retrieve(9, 'ds/1', '查询')
  await api.deleteDocument(9, 'ds/1', 'doc/1')
  await api.delete(9, 'ds/1')
  await api.getStudioLink(9, '/datasets')

  assert.equal(calls[0]?.path, '/api/v1/admin/datasets?enterprise_id=9&page=2&limit=20&keyword=%E7%9F%A5%E8%AF%86')
  assert.deepEqual(calls[1], { method: 'POST', path: '/api/v1/admin/datasets', body: { enterprise_id: 9, name: '知识库', indexing_technique: 'high_quality' } })
  assert.deepEqual(calls[2], { method: 'PATCH', path: '/api/v1/admin/datasets/ds%2F1', body: { enterprise_id: 9, name: '新名称' } })
  const uploaded = calls[5]?.body as FormData
  assert.equal(uploaded.get('enterprise_id'), '9')
  assert(uploaded.get('file') instanceof File)
  assert.equal(calls[6]?.path, '/api/v1/admin/datasets/ds%2F1/retrieve')
  assert.equal(calls[7]?.path, '/api/v1/admin/datasets/ds%2F1/documents/doc%2F1?enterprise_id=9')
  assert.equal(calls[8]?.path, '/api/v1/admin/datasets/ds%2F1?enterprise_id=9')
  assert.equal(calls[9]?.path, '/api/v1/admin/dify/sso?enterprise_id=9&next=%2Fdatasets')
})
