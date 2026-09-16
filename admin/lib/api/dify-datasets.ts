import { dcClient } from './client'
import { createDifyDatasetsApi } from './dify-datasets-core'

export type { DifyDataset, DifyDocument } from './dify-datasets-core'

export const difyDatasetsApi = createDifyDatasetsApi({
  get: path => dcClient.get(path),
  post: (path, body) => dcClient.post(path, body),
  patch: (path, body) => dcClient.patch(path, body),
  delete: path => dcClient.delete(path),
})
