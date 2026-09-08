export type DifyDataset = Record<string, unknown> & { id: string; name: string }
export type DifyDocument = Record<string, unknown> & { id: string; name?: string }

export type DifyDatasetsHttpClient = {
  get(path: string): Promise<unknown>
  post(path: string, body?: unknown): Promise<unknown>
  patch(path: string, body?: unknown): Promise<unknown>
  delete(path: string): Promise<unknown>
}

function query(path: string, values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== '') params.set(key, String(value))
  const suffix = params.toString()
  return suffix ? `${path}?${suffix}` : path
}

export function createDifyDatasetsApi(client: DifyDatasetsHttpClient) {
  return {
    list(enterpriseId: number, input: { page?: number; limit?: number; keyword?: string } = {}) { return client.get(query('/api/v1/admin/datasets', { enterprise_id: enterpriseId, ...input })) as Promise<{ success: boolean; data: unknown }> },
    get(enterpriseId: number, datasetId: string) { return client.get(query(`/api/v1/admin/datasets/${encodeURIComponent(datasetId)}`, { enterprise_id: enterpriseId })) as Promise<{ success: boolean; data: DifyDataset }> },
    create(enterpriseId: number, input: { name: string; description?: string; indexingTechnique?: string; permission?: string }) { return client.post('/api/v1/admin/datasets', { enterprise_id: enterpriseId, name: input.name, ...(input.description ? { description: input.description } : {}), ...(input.indexingTechnique ? { indexing_technique: input.indexingTechnique } : {}), ...(input.permission ? { permission: input.permission } : {}) }) as Promise<{ success: boolean; data: DifyDataset }> },
    update(enterpriseId: number, datasetId: string, input: { name?: string; description?: string; permission?: string }) { return client.patch(`/api/v1/admin/datasets/${encodeURIComponent(datasetId)}`, { enterprise_id: enterpriseId, ...input }) as Promise<{ success: boolean; data: DifyDataset }> },
    delete(enterpriseId: number, datasetId: string) { return client.delete(query(`/api/v1/admin/datasets/${encodeURIComponent(datasetId)}`, { enterprise_id: enterpriseId })) as Promise<{ success: boolean }> },
    listDocuments(enterpriseId: number, datasetId: string, input: { page?: number; limit?: number; keyword?: string } = {}) { return client.get(query(`/api/v1/admin/datasets/${encodeURIComponent(datasetId)}/documents`, { enterprise_id: enterpriseId, ...input })) as Promise<{ success: boolean; data: unknown }> },
    createTextDocument(enterpriseId: number, datasetId: string, input: { name: string; text: string; indexingTechnique?: string }) { return client.post(`/api/v1/admin/datasets/${encodeURIComponent(datasetId)}/documents`, { enterprise_id: enterpriseId, name: input.name, text: input.text, ...(input.indexingTechnique ? { indexing_technique: input.indexingTechnique } : {}) }) as Promise<{ success: boolean; data: DifyDocument }> },
    createFileDocument(enterpriseId: number, datasetId: string, input: FormData) { const form = new FormData(); for (const [key, value] of input.entries()) form.append(key, value); form.set('enterprise_id', String(enterpriseId)); return client.post(`/api/v1/admin/datasets/${encodeURIComponent(datasetId)}/documents`, form) as Promise<{ success: boolean; data: DifyDocument }> },
    deleteDocument(enterpriseId: number, datasetId: string, documentId: string) { return client.delete(query(`/api/v1/admin/datasets/${encodeURIComponent(datasetId)}/documents/${encodeURIComponent(documentId)}`, { enterprise_id: enterpriseId })) as Promise<{ success: boolean }> },
    retrieve(enterpriseId: number, datasetId: string, value: string) { return client.post(`/api/v1/admin/datasets/${encodeURIComponent(datasetId)}/retrieve`, { enterprise_id: enterpriseId, query: value }) as Promise<{ success: boolean; data: unknown }> },
    getStudioLink(enterpriseId: number, next = '/datasets') { return client.get(query('/api/v1/admin/dify/sso', { enterprise_id: enterpriseId, next })) as Promise<{ success: boolean; data: { url?: string } }> },
  }
}
