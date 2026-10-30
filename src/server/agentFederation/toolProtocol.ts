import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import { mcpJsonTransport, type RouterRequest } from './provider/routerTransport.js'
import { contentDigest } from './provider/protocol.js'

export interface ToolConnection {
  endpoint: string
  headers: Record<string, string>
  allowedAddresses?: readonly string[]
  timeoutMs: number
}
export interface ToolDescriptor { protocol: string; tool: Tool; digest: string }
export function toolFailure(code: string, status = 409): never { throw new ExternalProviderError(status, code) }

/** A reviewed, bounded scalar-object profile. Complex schemas require an explicit new profile. */
export function validateToolArguments(schema: Tool['inputSchema'], value?: unknown): void {
  const keys = ['type', 'properties', 'required', 'additionalProperties', 'description', 'title', '$schema']
  if (schema.type !== 'object' || Object.keys(schema).some(k => !keys.includes(k)) || schema.additionalProperties !== false
    || !schema.properties || typeof schema.properties !== 'object' || Object.keys(schema.properties).length > 32
    || (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(k => typeof k !== 'string' || !Object.hasOwn(schema.properties!, k))))) toolFailure('TOOL_SCHEMA_UNSUPPORTED')
  for (const [key, raw] of Object.entries(schema.properties)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || !raw || typeof raw !== 'object' || Array.isArray(raw)) toolFailure('TOOL_SCHEMA_UNSUPPORTED')
    const field = raw as Record<string, unknown>
    if (!['string', 'number', 'integer', 'boolean'].includes(String(field.type))
      || Object.keys(field).some(k => !['type', 'description', 'title', 'enum', 'maxLength', 'minLength', 'minimum', 'maximum'].includes(k))) toolFailure('TOOL_SCHEMA_UNSUPPORTED')
    for (const n of ['maxLength', 'minLength', 'minimum', 'maximum']) if (field[n] !== undefined && (typeof field[n] !== 'number' || !Number.isFinite(field[n]))) toolFailure('TOOL_SCHEMA_UNSUPPORTED')
    if (field.enum !== undefined && (!Array.isArray(field.enum) || !field.enum.length || field.enum.length > 64 || field.enum.some(v => !['string', 'number', 'boolean'].includes(typeof v)))) toolFailure('TOOL_SCHEMA_UNSUPPORTED')
  }
  if (value === undefined) return
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 32000) toolFailure('INVALID_TOOL_ARGUMENTS', 400)
  const args = value as Record<string, unknown>
  if (Object.keys(args).some(k => !Object.hasOwn(schema.properties!, k)) || schema.required?.some(k => !Object.hasOwn(args, k))) toolFailure('INVALID_TOOL_ARGUMENTS', 400)
  for (const [key, item] of Object.entries(args)) {
    const f = schema.properties[key] as Record<string, unknown>
    if ((f.type === 'integer' ? !Number.isSafeInteger(item) : typeof item !== f.type)
      || (typeof item === 'string' && (item.length > Math.min(Number(f.maxLength ?? 8192), 8192) || item.length < Number(f.minLength ?? 0)))
      || (typeof item === 'number' && (!Number.isFinite(item) || item < Number(f.minimum ?? -Number.MAX_VALUE) || item > Number(f.maximum ?? Number.MAX_VALUE)))
      || (Array.isArray(f.enum) && !f.enum.includes(item))) toolFailure('INVALID_TOOL_ARGUMENTS', 400)
  }
}

/** Explicit descriptor profile; its metadata is covered by the reviewed digest. */
export function validateReviewedToolArguments(tool: Tool, value?: unknown): void {
  const profile = tool._meta?.['moss/input-profile']
  if (profile === undefined) return validateToolArguments(tool.inputSchema, value)
  if (profile !== 'bounded-record-v1') toolFailure('TOOL_INPUT_PROFILE_UNSUPPORTED')
  const schema = tool.inputSchema
  if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) toolFailure('TOOL_SCHEMA_UNSUPPORTED')
  const properties: NonNullable<Tool['inputSchema']['properties']> = Object.create(null), records = new Set<string>()
  for (const [key, raw] of Object.entries(schema.properties)) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as Record<string, unknown>).type === 'object') {
      const field = raw as Record<string, unknown>
      if (Object.keys(field).some(name => !['type', 'description', 'title', 'additionalProperties', 'propertyNames'].includes(name))
        || !field.additionalProperties || typeof field.additionalProperties !== 'object' || Array.isArray(field.additionalProperties)
        || Object.keys(field.additionalProperties).length !== 0) toolFailure('TOOL_SCHEMA_UNSUPPORTED')
      if (field.propertyNames !== undefined && (!field.propertyNames || typeof field.propertyNames !== 'object'
        || Array.isArray(field.propertyNames) || Object.keys(field.propertyNames).length !== 1
        || (field.propertyNames as Record<string, unknown>).type !== 'string')) toolFailure('TOOL_SCHEMA_UNSUPPORTED')
      records.add(key)
      properties[key] = { type: 'boolean' }
    } else properties[key] = raw
  }
  // Retain the exact scalar schema rules, required keys and closed root object.
  const surrogate = { ...schema, properties }
  validateToolArguments(surrogate)
  if (value === undefined) return
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
    && [Object.prototype, null].includes(Object.getPrototypeOf(item))
  let nodes = 0
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 256 || depth > 6) toolFailure('INVALID_TOOL_ARGUMENTS', 400)
    if (item === null || typeof item === 'boolean') return
    if (typeof item === 'string' && item.length <= 8192) return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (Array.isArray(item)) {
      if (item.length > 100) toolFailure('INVALID_TOOL_ARGUMENTS', 400)
      for (const child of item) visit(child, depth + 1)
      return
    }
    if (!object(item) || Object.keys(item).length > 32) toolFailure('INVALID_TOOL_ARGUMENTS', 400)
    for (const [key, child] of Object.entries(item)) {
      if (!key.length || key.length > 128 || /[\u0000-\u001f\u007f]/.test(key)
        || ['__proto__', 'prototype', 'constructor'].includes(key)) toolFailure('INVALID_TOOL_ARGUMENTS', 400)
      visit(child, depth + 1)
    }
  }
  if (!object(value)) toolFailure('INVALID_TOOL_ARGUMENTS', 400)
  visit(value, 0)
  if (Buffer.byteLength(JSON.stringify(value)) > 32000) toolFailure('INVALID_TOOL_ARGUMENTS', 400)
  const scalar: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (records.has(key)) {
      if (!object(item)) toolFailure('INVALID_TOOL_ARGUMENTS', 400)
      scalar[key] = true
    } else scalar[key] = item
  }
  validateToolArguments(surrogate, scalar)
}

/** Official SDK with a pinned JSON HTTP transport. No downstream execution credentials. */
export class ToolProtocol {
  readonly client = new Client({ name: 'moss-task-tool-gateway', version: '1.0.0' })
  private readonly transport: StreamableHTTPClientTransport
  constructor(readonly config: ToolConnection, readonly signal: AbortSignal, request?: RouterRequest) {
    const wire = request ?? mcpJsonTransport(config.endpoint, { allowedAddresses: config.allowedAddresses })
    const headers = new Headers(config.headers)
    for (const name of headers.keys()) if (['host', 'connection', 'content-length', 'transfer-encoding', 'mcp-session-id', 'mcp-protocol-version', 'traceparent'].includes(name)) toolFailure('TOOL_CREDENTIAL_HEADERS_INVALID', 503)
    this.transport = new StreamableHTTPClientTransport(new URL(config.endpoint), {
      requestInit: { headers, redirect: 'error' },
      fetch: (url, init) => wire(url, { ...init, redirect: 'error', signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) }),
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    })
  }
  async connect() {
    await this.client.connect(this.transport, { timeout: this.config.timeoutMs, signal: this.signal })
    if (!['2025-06-18', '2025-11-25'].includes(this.transport.protocolVersion ?? '')) toolFailure('TOOL_PROTOCOL_UNSUPPORTED')
  }
  async descriptors(): Promise<ToolDescriptor[]> {
    const descriptors: ToolDescriptor[] = [], cursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < 10; page++) {
      const result = await this.client.listTools(cursor ? { cursor } : {}, { timeout: this.config.timeoutMs, signal: this.signal })
      if (result.tools.length + descriptors.length > 200) toolFailure('TOOL_DISCOVERY_LIMIT')
      for (const tool of result.tools) {
        if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(tool.name) || descriptors.some(d => d.tool.name === tool.name)) toolFailure('TOOL_DESCRIPTOR_INVALID')
        if (Buffer.byteLength(JSON.stringify(tool)) > 64000) toolFailure('TOOL_DESCRIPTOR_INVALID')
        const protocol = this.transport.protocolVersion!
        descriptors.push({ protocol, tool, digest: contentDigest({ protocol, tool }) })
      }
      if (!result.nextCursor) return descriptors
      if (result.nextCursor.length > 1000 || cursors.has(result.nextCursor)) toolFailure('TOOL_DISCOVERY_LIMIT')
      cursor = result.nextCursor; cursors.add(cursor)
    }
    return toolFailure('TOOL_DISCOVERY_LIMIT')
  }
  async call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const result = await this.client.callTool({ name, arguments: args }, undefined, { timeout: this.config.timeoutMs, signal: this.signal })
    if (!Array.isArray(result.content) || result.content.length > 128 || result.content.some(part => part.type !== 'text' || typeof part.text !== 'string')
      || Buffer.byteLength(JSON.stringify(result)) > 128000) toolFailure('TOOL_OUTPUT_UNSUPPORTED', 502)
    // Only bounded text is returned; remote links and structured payloads require a separate profile.
    return { content: result.content, ...(result.isError === true ? { isError: true } : {}) } as CallToolResult
  }
  async close() {
    // Ending a transport is not cancellation of an already accepted remote operation.
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([this.transport.terminateSession().catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, 1000) })]) }
    finally { if (timer) clearTimeout(timer); await this.client.close().catch(() => {}) }
  }
}
