import type { IdentityActor } from '../identity/organizationIdentityService.js'
import type { VisibilityFilter } from '../visibilityFilter.js'
import type { DifyRuntimeContext } from './difyConnectionService.js'
import type { DifyFileInput, DifyHttpAdapter } from './difyHttpAdapter.js'

interface DifyRuntimeContextResolver {
  resolveRuntimeContext(
    actor: IdentityActor,
    assistantId: string,
    visibility: VisibilityFilter,
  ): Promise<DifyRuntimeContext>
}

interface RuntimeInput {
  actor: IdentityActor
  assistantId: string
  visibility: VisibilityFilter
}

export class DifyRuntimeService {
  constructor(private readonly options: {
    adapter: DifyHttpAdapter
    connections: DifyRuntimeContextResolver
  }) {}

  async chat(input: RuntimeInput & {
    query: string
    conversationId?: string
    inputs?: Record<string, unknown>
    files?: unknown[]
    autoGenerateName?: boolean
    signal?: AbortSignal
  }): Promise<Response> {
    const context = await this.context(input)
    return this.options.adapter.streamChat(context.apiKey, {
      query: input.query,
      conversation_id: input.conversationId ?? '',
      inputs: input.inputs ?? {},
      files: input.files ?? [],
      user: context.endUserId,
      auto_generate_name: input.autoGenerateName ?? true,
    }, input.signal)
  }

  async stopChat(input: RuntimeInput & { taskId: string }): Promise<unknown> {
    const context = await this.context(input)
    return this.options.adapter.serviceJson(
      context.apiKey, 'POST', `/v1/chat-messages/${encodeURIComponent(input.taskId)}/stop`,
      { user: context.endUserId },
    )
  }

  async listConversations(input: RuntimeInput & {
    lastId?: string
    limit?: number
    sortBy?: 'created_at' | '-created_at' | 'updated_at' | '-updated_at'
  }): Promise<unknown> {
    const context = await this.context(input)
    return this.options.adapter.serviceJson(context.apiKey, 'GET', `/v1/conversations${queryString({
      user: context.endUserId,
      last_id: input.lastId,
      limit: input.limit ?? 20,
      sort_by: input.sortBy ?? '-updated_at',
    })}`)
  }

  async renameConversation(input: RuntimeInput & {
    conversationId: string
    name?: string
    autoGenerate?: boolean
  }): Promise<unknown> {
    const context = await this.context(input)
    return this.options.adapter.serviceJson(
      context.apiKey, 'POST', `/v1/conversations/${encodeURIComponent(input.conversationId)}/name`,
      { user: context.endUserId, name: input.name ?? null, auto_generate: input.autoGenerate ?? false },
    )
  }

  async deleteConversation(input: RuntimeInput & { conversationId: string }): Promise<void> {
    const context = await this.context(input)
    await this.options.adapter.serviceJson(
      context.apiKey, 'DELETE', `/v1/conversations/${encodeURIComponent(input.conversationId)}`,
      { user: context.endUserId },
    )
  }

  async listMessages(input: RuntimeInput & {
    conversationId: string
    firstId?: string
    limit?: number
  }): Promise<unknown> {
    const context = await this.context(input)
    return this.options.adapter.serviceJson(context.apiKey, 'GET', `/v1/messages${queryString({
      conversation_id: input.conversationId,
      user: context.endUserId,
      first_id: input.firstId,
      limit: input.limit ?? 20,
    })}`)
  }

  async feedback(input: RuntimeInput & {
    messageId: string
    rating: 'like' | 'dislike' | null
    content?: string
  }): Promise<unknown> {
    const context = await this.context(input)
    return this.options.adapter.serviceJson(
      context.apiKey, 'POST', `/v1/messages/${encodeURIComponent(input.messageId)}/feedbacks`,
      { user: context.endUserId, rating: input.rating, content: input.content ?? null },
    )
  }

  async suggested(input: RuntimeInput & { messageId: string }): Promise<unknown> {
    const context = await this.context(input)
    return this.options.adapter.serviceJson(
      context.apiKey, 'GET',
      `/v1/messages/${encodeURIComponent(input.messageId)}/suggested${queryString({ user: context.endUserId })}`,
    )
  }

  async parameters(input: RuntimeInput): Promise<unknown> {
    const context = await this.context(input)
    return this.options.adapter.serviceJson(context.apiKey, 'GET', '/v1/parameters')
  }

  async meta(input: RuntimeInput): Promise<unknown> {
    const context = await this.context(input)
    return this.options.adapter.serviceJson(context.apiKey, 'GET', '/v1/meta')
  }

  async uploadFile(input: RuntimeInput & Omit<DifyFileInput, 'user'>): Promise<unknown> {
    const context = await this.context(input)
    return this.options.adapter.uploadServiceFile(context.apiKey, '/v1/files/upload', {
      user: context.endUserId,
      fileName: input.fileName,
      contentType: input.contentType,
      bytes: input.bytes,
    })
  }

  async audioToText(input: RuntimeInput & Omit<DifyFileInput, 'user'>): Promise<unknown> {
    const context = await this.context(input)
    return this.options.adapter.uploadServiceFile(context.apiKey, '/v1/audio-to-text', {
      user: context.endUserId,
      fileName: input.fileName,
      contentType: input.contentType,
      bytes: input.bytes,
    })
  }

  async textToAudio(input: RuntimeInput & {
    messageId?: string
    text?: string
    voice?: string
    streaming?: boolean
  }): Promise<Response> {
    const context = await this.context(input)
    return this.options.adapter.serviceRaw(context.apiKey, 'POST', '/v1/text-to-audio', {
      user: context.endUserId,
      message_id: input.messageId ?? null,
      text: input.text ?? null,
      voice: input.voice ?? null,
      streaming: input.streaming ?? false,
    })
  }

  private context(input: RuntimeInput): Promise<DifyRuntimeContext> {
    return this.options.connections.resolveRuntimeContext(input.actor, input.assistantId, input.visibility)
  }
}

function queryString(values: Record<string, string | number | null | undefined>): string {
  const parameters = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue
    parameters.set(key, String(value))
  }
  const value = parameters.toString()
  return value ? `?${value}` : ''
}
