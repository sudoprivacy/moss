import type { IdentityActor } from '../identity/organizationIdentityService.js'
import type { VisibilityFilter } from '../visibilityFilter.js'
import { DifyProviderError, type DifyHttpAdapter } from './difyHttpAdapter.js'
import type { DifyEnhancementContext } from './difyConnectionService.js'

type EnhancementMode = 'agent-chat' | 'workflow' | 'rag-only'

export type EnhancementEvent =
  | { kind: 'progress'; step: string; nodeId?: string; nodeType?: string }
  | { kind: 'result'; text: string; mode: 'agent-chat' | 'workflow' | 'dataset'; elapsedMs: number; citations?: unknown[] }
  | { kind: 'error'; message: string; status?: number }

interface EnhancementContextResolver {
  describeEnhancement(
    actor: IdentityActor,
    assistantId: string,
    visibility: VisibilityFilter,
  ): { enabled: boolean; mode: EnhancementMode | null }
  resolveEnhancementContext(
    actor: IdentityActor,
    assistantId: string,
    visibility: VisibilityFilter,
  ): Promise<DifyEnhancementContext>
}

interface InvokeInput {
  actor: IdentityActor
  visibility: VisibilityFilter
  assistantId: string
  query: string
  conversationId?: string
  startedAt?: number
}

export class DifyEnhancementService {
  private readonly clock: () => number

  constructor(private readonly options: {
    adapter: DifyHttpAdapter
    connections: EnhancementContextResolver
    clock?: () => number
  }) {
    this.clock = options.clock ?? Date.now
  }

  describe(input: Omit<InvokeInput, 'query' | 'conversationId' | 'startedAt'>) {
    return this.options.connections.describeEnhancement(input.actor, input.assistantId, input.visibility)
  }

  async invokeBlocking(input: InvokeInput): Promise<{
    text: string
    mode: 'agent-chat' | 'workflow' | 'dataset'
    elapsedMs: number
    raw?: unknown
  }> {
    const startedAt = input.startedAt ?? this.clock()
    const context = await this.options.connections.resolveEnhancementContext(
      input.actor, input.assistantId, input.visibility,
    )
    if (context.mode === 'workflow') {
      if (!context.appApiKey) throw new DifyProviderError(500, 'binding missing app_api_key - re-create the assistant', null)
      const raw = await this.options.adapter.serviceJson(context.appApiKey, 'POST', '/v1/workflows/run', {
        inputs: { query: input.query }, user: context.endUserId, response_mode: 'blocking',
      })
      const outputs = objectValue(objectValue(raw).data).outputs
      return {
        text: flattenWorkflowOutputs(objectValue(outputs)),
        mode: 'workflow',
        elapsedMs: this.clock() - startedAt,
        raw,
      }
    }
    if (context.mode === 'rag-only') {
      const text = await this.retrievePassages(context, input.query)
      return { text, mode: 'dataset', elapsedMs: this.clock() - startedAt }
    }
    if (context.mode === 'agent-chat') {
      if (!context.appApiKey) throw new DifyProviderError(500, 'binding missing app_api_key - re-create the assistant', null)
      let answer = ''
      for await (const event of this.agentChatEvents(context, input, startedAt)) {
        if (event.kind === 'result') answer = event.text
        if (event.kind === 'error') throw new DifyProviderError(event.status ?? 500, event.message, null)
      }
      return { text: answer, mode: 'agent-chat', elapsedMs: this.clock() - startedAt }
    }
    throw new DifyProviderError(404, 'assistant has no Dify enhancement and no datasets attached', null)
  }

  async *invokeStreaming(input: InvokeInput): AsyncGenerator<EnhancementEvent, void, void> {
    const startedAt = input.startedAt ?? this.clock()
    let context: DifyEnhancementContext
    try {
      context = await this.options.connections.resolveEnhancementContext(
        input.actor, input.assistantId, input.visibility,
      )
    } catch (error) {
      yield providerErrorEvent(error)
      return
    }
    if (context.mode === 'workflow') {
      if (!context.appApiKey) {
        yield { kind: 'error', message: 'binding missing app_api_key - re-create the assistant', status: 500 }
        return
      }
      let upstream: Response
      try {
        upstream = await this.options.adapter.serviceRaw(context.appApiKey, 'POST', '/v1/workflows/run', {
          inputs: { query: input.query }, user: context.endUserId, response_mode: 'streaming',
        })
      } catch (error) {
        yield { kind: 'error', message: `upstream connect failed: ${message(error)}` }
        return
      }
      if (!upstream.ok || !upstream.body) {
        yield { kind: 'error', message: await upstream.text().catch(() => '') || `workflow upstream ${upstream.status}`, status: upstream.status }
        return
      }
      let resultEmitted = false
      for await (const payload of readSseJson(upstream.body)) {
        if (payload.event === 'node_started') {
          const data = objectValue(payload.data)
          yield {
            kind: 'progress',
            step: stringValue(data.title) || stringValue(data.node_type) || 'step',
            ...(stringValue(data.node_id) ? { nodeId: stringValue(data.node_id) } : {}),
            ...(stringValue(data.node_type) ? { nodeType: stringValue(data.node_type) } : {}),
          }
        } else if (payload.event === 'workflow_finished') {
          const outputs = objectValue(objectValue(payload.data).outputs)
          yield { kind: 'result', text: flattenWorkflowOutputs(outputs), mode: 'workflow', elapsedMs: this.clock() - startedAt }
          resultEmitted = true
        } else if (payload.event === 'error') {
          yield { kind: 'error', message: stringValue(payload.message) || stringValue(objectValue(payload.data).error) || 'workflow error' }
        }
      }
      if (!resultEmitted) yield { kind: 'error', message: 'workflow stream ended without result' }
      return
    }
    if (context.mode === 'agent-chat') {
      yield* this.agentChatEvents(context, input, startedAt)
      return
    }
    try {
      const result = await this.invokeBlocking({ ...input, startedAt })
      yield { kind: 'result', text: result.text, mode: result.mode, elapsedMs: result.elapsedMs }
    } catch (error) {
      yield providerErrorEvent(error)
    }
  }

  private async *agentChatEvents(
    context: DifyEnhancementContext,
    input: InvokeInput,
    startedAt: number,
  ): AsyncGenerator<EnhancementEvent, void, void> {
    let upstream: Response
    try {
      upstream = await this.options.adapter.streamChat(context.appApiKey!, {
        query: input.query,
        conversation_id: input.conversationId ?? '',
        inputs: {},
        user: context.endUserId,
      })
    } catch (error) {
      yield { kind: 'error', message: `upstream connect failed: ${message(error)}` }
      return
    }
    if (!upstream.ok || !upstream.body) {
      yield { kind: 'error', message: await upstream.text().catch(() => '') || `chat upstream ${upstream.status}`, status: upstream.status }
      return
    }
    let answer = ''
    let resultEmitted = false
    for await (const payload of readSseJson(upstream.body)) {
      if (payload.event === 'message' || payload.event === 'agent_message') answer += stringValue(payload.answer)
      if (payload.event === 'message_end') {
        yield { kind: 'result', text: answer, mode: 'agent-chat', elapsedMs: this.clock() - startedAt }
        resultEmitted = true
      }
      if (payload.event === 'error') {
        yield { kind: 'error', message: stringValue(payload.message) || 'agent chat error' }
        return
      }
    }
    if (!resultEmitted) yield { kind: 'result', text: answer, mode: 'agent-chat', elapsedMs: this.clock() - startedAt }
  }

  private async retrievePassages(context: DifyEnhancementContext, query: string): Promise<string> {
    const results = await Promise.all(context.datasetIds.map(async datasetId => {
      try {
        return await this.options.adapter.serviceJson(
          context.apiKey, 'POST', `/v1/datasets/${encodeURIComponent(datasetId)}/retrieve`,
          {
            query,
            retrieval_model: {
              search_method: 'semantic_search', top_k: 5, reranking_enable: false,
              score_threshold_enabled: true, score_threshold: 0.3,
            },
          },
        )
      } catch {
        return null
      }
    }))
    const passages: string[] = []
    for (const result of results) {
      const records = objectValue(result).records
      if (!Array.isArray(records)) continue
      for (const record of records) {
        const content = stringValue(objectValue(objectValue(record).segment).content).trim()
        if (content) passages.push(content)
      }
    }
    return passages.join('\n\n---\n\n')
  }
}

async function* readSseJson(stream: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    let separator = buffer.indexOf('\n\n')
    while (separator >= 0) {
      const frame = buffer.slice(0, separator)
      buffer = buffer.slice(separator + 2)
      separator = buffer.indexOf('\n\n')
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
      if (!data || data === '[DONE]') continue
      try {
        const parsed = JSON.parse(data) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) yield parsed as Record<string, unknown>
      } catch {
        // Ignore malformed upstream frames like the legacy service.
      }
    }
    if (done) break
  }
}

function flattenWorkflowOutputs(outputs: Record<string, unknown>): string {
  for (const key of ['text', 'answer', 'result', 'output']) {
    if (typeof outputs[key] === 'string') return outputs[key]
  }
  for (const key of ['result', 'output']) {
    if (!Array.isArray(outputs[key])) continue
    const chunks = (outputs[key] as unknown[]).flatMap(item => {
      const value = objectValue(item)
      const text = [value.content, value.text, value.body].find(candidate => typeof candidate === 'string' && candidate.trim())
      return typeof text === 'string' ? [text.trim()] : []
    })
    if (chunks.length > 0) return chunks.join('\n\n---\n\n')
  }
  try {
    return JSON.stringify(outputs, null, 2)
  } catch {
    return String(outputs)
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function providerErrorEvent(error: unknown): EnhancementEvent {
  return error instanceof DifyProviderError
    ? { kind: 'error', message: error.message, status: error.status }
    : { kind: 'error', message: message(error) }
}
