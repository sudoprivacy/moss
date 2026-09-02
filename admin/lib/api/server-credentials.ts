import { authClient } from './client'

/** server.json 侧凭据字段的分组（与服务端 SERVER_CREDENTIAL_FIELDS 一致）。 */
export type ServerCredentialGroup = 'hub' | 'wikiIndex' | 'cabin'

/** GET /api/v1/server-credentials 的单项：脱敏展示，不返回明文。 */
export interface ServerCredentialItem {
  /** Nexus key，如 server.cabin-llm-api-key */
  key: string
  group: ServerCredentialGroup
  /** 原 server.json 中的字段路径，如 cabin.llmApiKey */
  path: string
  /** 是否已设置 */
  set: boolean
  /** 脱敏值：长值显示尾 4 位（****abcd），短值仅 ****；未设置为 null */
  masked: string | null
}

export interface ServerCredentialsResponse {
  items: ServerCredentialItem[]
}

export interface UpdateServerCredentialResponse {
  ok: boolean
  key: string
  /** 提交的是脱敏占位（**** 开头）时为 true，表示服务端未做实际修改 */
  ignored?: boolean
  set?: boolean
  masked?: string | null
}

export function getServerCredentials(): Promise<ServerCredentialsResponse> {
  return authClient.get<ServerCredentialsResponse>('/api/v1/server-credentials')
}

/** 编辑单个字段：value 为空串表示清空（服务端 deleteSecret）。 */
export function updateServerCredential(
  key: string,
  value: string,
): Promise<UpdateServerCredentialResponse> {
  return authClient.put<UpdateServerCredentialResponse>(
    '/api/v1/server-credentials',
    { key, value },
  )
}
