import type { Context, Hono } from 'hono'
import { DifyDomainError } from '../../../dify/difyConnectionService.js'
import { DifyProviderError } from '../../../dify/difyHttpAdapter.js'
import type { DifyRuntimeService } from '../../../dify/difyRuntimeService.js'
import type { DifyEnhancementService } from '../../../dify/difyEnhancementService.js'
import type { IdentityActor } from '../../../identity/organizationIdentityService.js'
import type { VisibilityFilter } from '../../../visibilityFilter.js'

interface DifyRuntimeRouteOptions {
  runtime: DifyRuntimeService
  enhancement: DifyEnhancementService
  getActor: (authorization: string | undefined) => IdentityActor | null
  buildVisibility: (actor: IdentityActor) => VisibilityFilter
  upstreamBaseUrl: string
}

type RuntimeRequestContext = {
  actor: IdentityActor
  visibility: VisibilityFilter
  assistantId: string
}

export function registerSudoworkDifyRuntimeRoutes(app: Hono, options: DifyRuntimeRouteOptions): void {
  const requestContext = (context: Context): RuntimeRequestContext | Response => {
    const actor = options.getActor(context.req.header('Authorization'))
    if (!actor) return context.json({ success: false, msg: '未授权，请先登录' }, 401)
    return {
      actor,
      visibility: options.buildVisibility(actor),
      assistantId: context.req.param('assistantId') ?? '',
    }
  }

  app.get('/api/v1/agents/:assistantId/enhancement', context => {
    const runtime = requestContext(context)
    if (runtime instanceof Response) return runtime
    try {
      return context.json({ success: true, data: options.enhancement.describe(runtime) })
    } catch (error) {
      return runtimeError(context, error)
    }
  })

  app.post('/api/v1/agents/:assistantId/enhancement/invoke', async context => {
    const runtime = requestContext(context)
    if (runtime instanceof Response) return runtime
    const body = await context.req.json<Record<string, unknown>>().catch(() => null)
    if (!body || typeof body.query !== 'string' || body.query.length === 0) return failure(context, 400, 'query is required')
    try {
      const data = await options.enhancement.invokeBlocking({
        ...runtime, query: body.query, conversationId: stringOrUndefined(body.conversation_id),
      })
      return context.json({ success: true, data })
    } catch (error) {
      return runtimeError(context, error)
    }
  })

  app.post('/api/v1/agents/:assistantId/enhancement/invoke-stream', async context => {
    const runtime = requestContext(context)
    if (runtime instanceof Response) return runtime
    const body = await context.req.json<Record<string, unknown>>().catch(() => null)
    if (!body || typeof body.query !== 'string' || body.query.length === 0) return failure(context, 400, 'query is required')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          const encoder = new TextEncoder()
          try {
            for await (const event of options.enhancement.invokeStreaming({
              ...runtime, query: body.query as string, conversationId: stringOrUndefined(body.conversation_id),
            })) {
              controller.enqueue(encoder.encode(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`))
            }
          } catch (error) {
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ message: errorMessage(error) })}\n\n`))
          } finally {
            controller.close()
          }
        })()
      },
    })
    return new Response(stream, { status: 200, headers: streamHeaders(options.upstreamBaseUrl) })
  })

  app.post('/api/v1/agents/:assistantId/chat', async context => {
    const runtime = requestContext(context)
    if (runtime instanceof Response) return runtime
    const body = await context.req.json<Record<string, unknown>>().catch(() => null)
    if (!body || typeof body.query !== 'string' || body.query.length === 0) return failure(context, 400, 'query is required')
    let upstream: Response
    try {
      upstream = await options.runtime.chat({
        ...runtime,
        query: body.query,
        conversationId: stringOrUndefined(body.conversation_id),
        inputs: objectOrUndefined(body.inputs),
        files: Array.isArray(body.files) ? body.files : undefined,
        autoGenerateName: typeof body.auto_generate_name === 'boolean' ? body.auto_generate_name : undefined,
        signal: context.req.raw.signal,
      })
    } catch (error) {
      if (error instanceof DifyDomainError) return failure(context, error.status, error.message)
      return failure(context, 502, `upstream connect failed: ${errorMessage(error)}`)
    }
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '')
      return context.json(
        { success: false, status: upstream.status, msg: text || 'dify upstream error' },
        (upstream.status || 502) as 400,
      )
    }
    return new Response(upstream.body, {
      status: 200,
      headers: streamHeaders(options.upstreamBaseUrl),
    })
  })

  app.post('/api/v1/agents/:assistantId/chat/:taskId/stop', context => jsonOperation(context, requestContext, async runtime =>
    options.runtime.stopChat({ ...runtime, taskId: context.req.param('taskId') })))

  app.get('/api/v1/agents/:assistantId/conversations', context => jsonOperation(context, requestContext, async runtime =>
    options.runtime.listConversations({
      ...runtime,
      lastId: context.req.query('last_id') || undefined,
      limit: optionalNumber(context.req.query('limit')),
      sortBy: context.req.query('sort_by') as 'created_at' | '-created_at' | 'updated_at' | '-updated_at' | undefined,
    })))

  app.patch('/api/v1/agents/:assistantId/conversations/:conversationId', async context => {
    const body = await context.req.json<Record<string, unknown>>().catch(() => null)
    return jsonOperation(context, requestContext, async runtime => options.runtime.renameConversation({
      ...runtime,
      conversationId: context.req.param('conversationId'),
      name: stringOrUndefined(body?.name),
      autoGenerate: typeof body?.auto_generate === 'boolean' ? body.auto_generate : undefined,
    }))
  })

  app.delete('/api/v1/agents/:assistantId/conversations/:conversationId', async context => {
    const runtime = requestContext(context)
    if (runtime instanceof Response) return runtime
    try {
      await options.runtime.deleteConversation({ ...runtime, conversationId: context.req.param('conversationId') })
      return context.json({ success: true })
    } catch (error) {
      return runtimeError(context, error)
    }
  })

  app.get('/api/v1/agents/:assistantId/conversations/:conversationId/messages', context =>
    jsonOperation(context, requestContext, async runtime => options.runtime.listMessages({
      ...runtime,
      conversationId: context.req.param('conversationId'),
      firstId: context.req.query('first_id') || undefined,
      limit: optionalNumber(context.req.query('limit')),
    })))

  app.post('/api/v1/agents/:assistantId/messages/:messageId/feedback', async context => {
    const runtime = requestContext(context)
    if (runtime instanceof Response) return runtime
    const body = await context.req.json<Record<string, unknown>>().catch(() => null)
    if (!body) return failure(context, 400, 'body is required')
    try {
      const data = await options.runtime.feedback({
        ...runtime,
        messageId: context.req.param('messageId'),
        rating: body.rating === 'like' || body.rating === 'dislike' ? body.rating : null,
        content: stringOrUndefined(body.content),
      })
      return context.json({ success: true, data })
    } catch (error) {
      return runtimeError(context, error)
    }
  })

  app.get('/api/v1/agents/:assistantId/messages/:messageId/suggested', context =>
    jsonOperation(context, requestContext, async runtime => options.runtime.suggested({
      ...runtime, messageId: context.req.param('messageId'),
    })))

  app.get('/api/v1/agents/:assistantId/parameters', context =>
    jsonOperation(context, requestContext, runtime => options.runtime.parameters(runtime)))

  app.get('/api/v1/agents/:assistantId/meta', context =>
    jsonOperation(context, requestContext, runtime => options.runtime.meta(runtime)))

  app.post('/api/v1/agents/:assistantId/files', context => multipartOperation(
    context,
    requestContext,
    (runtime, file) => options.runtime.uploadFile({
      ...runtime, fileName: file.name, contentType: file.type || 'application/octet-stream', bytes: file,
    }),
  ))

  app.post('/api/v1/agents/:assistantId/audio-to-text', context => multipartOperation(
    context,
    requestContext,
    (runtime, file) => options.runtime.audioToText({
      ...runtime, fileName: file.name, contentType: file.type || 'audio/mpeg', bytes: file,
    }),
  ))

  app.post('/api/v1/agents/:assistantId/text-to-audio', async context => {
    const runtime = requestContext(context)
    if (runtime instanceof Response) return runtime
    const body = await context.req.json<Record<string, unknown>>().catch(() => null)
    if (!body || (!body.message_id && !body.text)) return failure(context, 400, 'message_id or text is required')
    try {
      const upstream = await options.runtime.textToAudio({
        ...runtime,
        messageId: stringOrUndefined(body.message_id),
        text: stringOrUndefined(body.text),
        voice: stringOrUndefined(body.voice),
        streaming: typeof body.streaming === 'boolean' ? body.streaming : undefined,
      })
      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text().catch(() => '')
        return context.json(
          { success: false, status: upstream.status, msg: text || 'text-to-audio failed' },
          (upstream.status || 502) as 400,
        )
      }
      return new Response(upstream.body, {
        status: 200,
        headers: {
          'Content-Type': upstream.headers.get('Content-Type') || 'audio/mpeg',
          'Cache-Control': 'no-cache, no-transform',
        },
      })
    } catch (error) {
      return runtimeError(context, error)
    }
  })
}

async function jsonOperation(
  context: Context,
  resolve: (context: Context) => RuntimeRequestContext | Response,
  operation: (runtime: RuntimeRequestContext) => Promise<unknown>,
): Promise<Response> {
  const runtime = resolve(context)
  if (runtime instanceof Response) return runtime
  try {
    return context.json({ success: true, data: await operation(runtime) })
  } catch (error) {
    return runtimeError(context, error)
  }
}

async function multipartOperation(
  context: Context,
  resolve: (context: Context) => RuntimeRequestContext | Response,
  operation: (runtime: RuntimeRequestContext, file: File) => Promise<unknown>,
): Promise<Response> {
  const runtime = resolve(context)
  if (runtime instanceof Response) return runtime
  const form = await context.req.formData().catch(() => null)
  if (!form) return failure(context, 400, 'expected multipart/form-data')
  const file = form.get('file')
  if (!(file instanceof File)) return failure(context, 400, "field 'file' is required")
  try {
    return context.json({ success: true, data: await operation(runtime, file) })
  } catch (error) {
    return runtimeError(context, error)
  }
}

function runtimeError(context: Context, error: unknown): Response {
  if (error instanceof DifyDomainError) return failure(context, error.status, error.message)
  if (error instanceof DifyProviderError) {
    return context.json({
      success: false, msg: error.message, status: error.status, detail: error.detail,
    }, (error.status || 502) as 400)
  }
  return failure(context, 502, errorMessage(error))
}

function failure(context: Context, status: number, msg: string): Response {
  return context.json({ success: false, msg }, status as 400)
}

function streamHeaders(upstreamBaseUrl: string): Record<string, string> {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Dify-Upstream': upstreamBaseUrl,
  }
}

function optionalNumber(value: string | undefined): number | undefined {
  return value ? Number(value) : undefined
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
