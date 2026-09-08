import { createHmac } from 'node:crypto'

export class DifyProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail: unknown,
  ) {
    super(`[Dify ${status}] ${message}`)
    this.name = 'DifyProviderError'
  }
}

export interface DifyHttpAdapterOptions {
  baseUrl: string
  systemToken?: string
  provisionSecret?: string
  fetchImpl?: typeof fetch
  streamTimeoutMs?: number
}

export interface DifyFileInput {
  user: string
  fileName: string
  contentType: string
  bytes: Uint8Array | ArrayBuffer | Blob
}

export interface DifyMultipartInput {
  fields?: Record<string, string>
  file: Omit<DifyFileInput, 'user'>
}

type JsonMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT'

export class DifyHttpAdapter {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly streamTimeoutMs: number

  constructor(private readonly options: DifyHttpAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.streamTimeoutMs = options.streamTimeoutMs ?? 330_000
  }

  async provisionTenant(input: { enterpriseCode: string; enterpriseName?: string }): Promise<{
    dify_tenant_id: string
    system_account_id: string
    service_api_key: string
  }> {
    const secret = this.requireCredential(this.options.provisionSecret, 'DIFY_SYSTEM_SECRET')
    const body = JSON.stringify({
      enterprise_code: input.enterpriseCode,
      enterprise_name: input.enterpriseName || input.enterpriseCode,
    })
    const response = await this.fetchImpl(`${this.baseUrl}/sudowork/system/tenants`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sudowork-Signature': createHmac('sha256', secret).update(body).digest('hex'),
      },
      body,
    })
    return await this.requireJson(response, 'tenant provisioning failed') as {
      dify_tenant_id: string
      system_account_id: string
      service_api_key: string
    }
  }

  async systemJson(
    tenantId: string,
    method: JsonMethod,
    path: string,
    body?: Record<string, unknown>,
    actorAccountId?: string,
  ): Promise<unknown> {
    const token = this.requireCredential(this.options.systemToken, 'DIFY_SYSTEM_TOKEN')
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'X-Sudowork-Tenant': tenantId,
    }
    if (actorAccountId) headers['X-Sudowork-Actor'] = actorAccountId
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const response = await this.fetchImpl(this.url(path), {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    })
    return await this.requireJson(response, `${method} ${path} failed`)
  }

  async serviceJson(
    apiKey: string,
    method: JsonMethod,
    path: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
    errorMessage?: string,
  ): Promise<unknown> {
    const response = await this.fetchImpl(this.url(path), {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
    if (response.status === 204) return null
    return await this.requireJson(response, errorMessage ?? `${method} ${path} failed`)
  }

  async serviceRaw(
    apiKey: string,
    method: JsonMethod,
    path: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const response = await this.fetchImpl(this.url(path), {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
    return response
  }

  streamChat(apiKey: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    return this.serviceRaw(
      apiKey,
      'POST',
      '/v1/chat-messages',
      { ...body, response_mode: 'streaming' },
      this.streamSignal(signal),
    )
  }

  async uploadServiceFile(apiKey: string, path: string, input: DifyFileInput): Promise<unknown> {
    const form = new FormData()
    const blob = input.bytes instanceof Blob
      ? input.bytes
      : new Blob([input.bytes instanceof ArrayBuffer ? input.bytes : Buffer.from(input.bytes)], { type: input.contentType })
    form.append('file', blob, input.fileName)
    form.append('user', input.user)
    const response = await this.fetchImpl(this.url(path), {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form,
    })
    return await this.requireJson(response, `file upload ${path} failed`)
  }

  async serviceMultipart(
    apiKey: string,
    path: string,
    input: DifyMultipartInput,
    errorMessage?: string,
  ): Promise<unknown> {
    const form = new FormData()
    for (const [key, value] of Object.entries(input.fields ?? {})) form.append(key, value)
    const blob = input.file.bytes instanceof Blob
      ? input.file.bytes
      : new Blob([
        input.file.bytes instanceof ArrayBuffer
          ? input.file.bytes
          : Buffer.from(input.file.bytes),
      ], { type: input.file.contentType })
    form.append('file', blob, input.file.fileName)
    const response = await this.fetchImpl(this.url(path), {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form,
    })
    return await this.requireJson(response, errorMessage ?? `multipart request ${path} failed`)
  }

  private streamSignal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.streamTimeoutMs)
    return signal ? AbortSignal.any([signal, timeout]) : timeout
  }

  private url(path: string): string {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
  }

  private requireCredential(value: string | undefined, name: string): string {
    if (!value) throw new Error(`${name} not configured`)
    return value
  }

  private async requireJson(response: Response, message: string): Promise<unknown> {
    const detail = await readResponseBody(response)
    if (!response.ok) throw new DifyProviderError(response.status, message, detail)
    return detail
  }

}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { raw: text }
  }
}
