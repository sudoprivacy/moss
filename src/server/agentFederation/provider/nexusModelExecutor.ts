import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { NexusVfsClient, type NexusVfsTlsConfig } from '@nexus-ai-fs/vfs-client'
import { AgentProtocolError } from './protocol.js'
import { modelAnswer, modelRequestBody, type ModelExecutor, type NexusModelTarget } from './runtime.js'

export interface NexusModelConfig {
  endpoint: string
  model_mounts: string[]
  tls: NexusVfsTlsConfig
  authToken?: string
}
type ModelClient = Pick<NexusVfsClient, 'write' | 'streamReadAt' | 'close'>
const LIMIT = 2 * 1024 * 1024
const unconfirmed = () => new AgentProtocolError(502, 'MODEL_EXECUTION_UNCONFIRMED')

/** A route is configuration, not evidence of a content gate or user delegation. */
export function nexusModelTargets(config: NexusModelConfig): NexusModelTarget[] {
  const endpoint = new URL(config.endpoint)
  if (endpoint.protocol !== 'https:' || endpoint.origin !== config.endpoint
    || !config.tls?.ca || !config.tls.cert || !config.tls.key
    || !Array.isArray(config.model_mounts) || !config.model_mounts.length
    || config.model_mounts.some(m => typeof m !== 'string' || m.length > 200 || !/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(m))
    || (config.authToken !== undefined && (typeof config.authToken !== 'string' || config.authToken.length > 4096 || /[\r\n]/.test(config.authToken)))) {
    throw new AgentProtocolError(400, 'INVALID_NEXUS_MODEL_CONFIGURATION')
  }
  return config.model_mounts.map(model_mount => ({ nexus_endpoint: config.endpoint, model_mount }))
}

/** The existing VFS wire's structured NOT_FOUND, only before the reply opens. */
function replyNotCreated(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  try { return JSON.parse(error.message)?.code === -32007 } catch { return false }
}

/**
 * Uses llm_mount's HTTP exchange v1, not its ambiguous legacy text/done frames.
 * Each run owns one channel so abort/close cannot cancel a different run.
 * The durable claim is the dispatch fence; a lost write acknowledgement is never retried.
 */
export function nexusModelExecutor(config: NexusModelConfig, createClient?: () => ModelClient): ModelExecutor {
  const targets = nexusModelTargets(config)
  const authToken = config.authToken ?? ''
  const endpoint = config.endpoint
  // Snapshot TLS bytes before serving. Rotation requires a controlled restart.
  const pem = (value: Buffer | string) => typeof value === 'string' ? readFileSync(value) : Buffer.from(value)
  const tls = createClient ? config.tls : { ...config.tls, ca: pem(config.tls.ca), cert: pem(config.tls.cert), key: pem(config.tls.key) }
  const options = { tls, maxReceiveMessageBytes: LIMIT + 65536, connectTimeoutMs: 5000, blockingReadMarginMs: 1000 }
  const open = createClient ?? (() => new NexusVfsClient(endpoint, options))
  if (!createClient) open().close() // Invalid/missing PEM must fail startup, not the first accepted run.
  return async (agent, history, query, signal, context) => {
    const d = agent.definition
    if (!context?.clientId || !context.providerRunId || !targets.some(t => t.nexus_endpoint === d.nexus_endpoint && t.model_mount === d.model_mount)) throw new AgentProtocolError(403, 'MODEL_EGRESS_DENIED')
    if (signal.aborted) throw new AgentProtocolError(503, 'MODEL_EGRESS_UNAVAILABLE')
    const stem = createHash('sha256').update(JSON.stringify([context.clientId, context.providerRunId])).digest('hex')
    const prompt = `${d.model_mount}/run-${stem}.prompt`, reply = `${d.model_mount}/run-${stem}.reply`
    const body = Buffer.from(JSON.stringify({ nexus_http: { version: 1, path: 'chat/completions', headers: {} }, body: modelRequestBody(agent, history, query) }))
    if (body.length > LIMIT) throw new AgentProtocolError(403, 'MODEL_EGRESS_DENIED')
    const client = open()
    const abort = () => client.close()
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      await client.write(prompt, body, authToken)
      let offset = '0', status: number | undefined, size = 0, records = 0
      const chunks: Buffer[] = []
      while (!signal.aborted) {
        let frame
        try { frame = await client.streamReadAt(reply, offset, authToken, { blocking: true, timeoutMs: 1000 }) }
        catch (error) {
          if (offset === '0' && replyNotCreated(error)) { await delay(50, undefined, { signal }); continue }
          throw error
        }
        if (!/^\d{1,20}$/.test(frame.nextOffset) || BigInt(frame.nextOffset) < BigInt(offset)) throw unconfirmed()
        if (!frame.data.length) {
          if (frame.nextOffset !== offset) throw unconfirmed()
          await delay(25, undefined, { signal }); continue
        }
        if (frame.nextOffset === offset || ++records > 32768) throw unconfirmed()
        offset = frame.nextOffset
        size += frame.data.length
        if (size > LIMIT) throw unconfirmed()
        if (frame.data[0] === 0) {
          if (status === undefined) throw unconfirmed()
          chunks.push(frame.data.subarray(1)); continue
        }
        const control = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame.data))
        if (control?.type === 'response' && control.version === 1 && status === undefined && records === 1
          && Number.isInteger(control.status) && control.status >= 200 && control.status <= 599) {
          status = control.status
          // Only a JSON completion is supported. Refuse SSE or protocol drift.
          if (!/^application\/json(?:\s*;|$)/i.test(control.headers?.['content-type'] ?? '')) throw unconfirmed()
        } else if (control?.type === 'done' && status !== undefined && typeof control.session_hash === 'string' && control.session_hash.length > 0) {
          if (status < 200 || status >= 300) throw new AgentProtocolError(status, [400, 401, 403, 404, 422, 429].includes(status) ? 'MODEL_REQUEST_REJECTED' : 'MODEL_EXECUTION_UNCONFIRMED')
          let result: unknown
          try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
          catch { throw new AgentProtocolError(502, 'MODEL_OUTPUT_INVALID') }
          return modelAnswer(result)
        } else {
          // Error control frames contain no stable pre/post-dispatch receipt.
          // Neither their free text nor an RPC failure proves no model call happened.
          throw unconfirmed()
        }
      }
      throw unconfirmed()
    } catch (error) {
      if (error instanceof AgentProtocolError) throw error
      throw unconfirmed() // Never propagate raw VFS paths, model bodies or TLS diagnostics.
    } finally {
      signal.removeEventListener('abort', abort)
      client.close()
    }
  }
}
