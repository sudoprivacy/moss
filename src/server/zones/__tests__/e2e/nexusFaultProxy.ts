import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface NexusFaultProxy {
  baseUrl: string
  failNextDeprovision: (zoneId: string) => void
  failOperationLookup: (operationId: string) => void
  dropNextZoneCreate: () => void
  zoneCreateAttempts: () => Array<{ key: string; operationId: string | null; status: number }>
  stop: () => Promise<void>
}

/**
 * Transparent test-only Nexus proxy. Real traffic is forwarded unchanged;
 * one explicitly armed deprovision request can return a structured 503 so
 * the Moss HTTP adapter is exercised without replacing the successful real
 * Nexus path with mocks.
 */
export async function startNexusFaultProxy(upstreamBaseUrl: string): Promise<NexusFaultProxy> {
  let failZoneId: string | null = null
  let failedOperationId: string | null = null
  let dropZoneCreate = false
  const createAttempts: Array<{ key: string; operationId: string | null; status: number }> = []
  const server = createServer(async (request, response) => {
    const url = request.url ?? '/'
    const isZoneCreate = request.method === 'POST' && url === '/v2/zones'
    const shouldDrop = isZoneCreate && dropZoneCreate
    if (shouldDrop) dropZoneCreate = false
    const match = request.method === 'DELETE'
      ? url.match(/^\/v2\/zones\/([^/?]+)$/)
      : null
    const zoneId = match ? decodeURIComponent(match[1]) : null
    if (
      zoneId
      && zoneId === failZoneId
      && request.headers['x-nexus-confirm-zone'] === zoneId
    ) {
      failZoneId = null
      response.statusCode = 503
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({
        detail: {
          code: 'ZONE_RUNTIME_UNAVAILABLE',
          message: 'injected Nexus runtime outage',
          retryable: true,
        },
      }))
      return
    }

    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const headers = new Headers()
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || ['host', 'connection', 'content-length'].includes(name)) continue
        if (Array.isArray(value)) {
          for (const item of value) headers.append(name, item)
        } else {
          headers.set(name, value)
        }
      }
      const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined
      const upstream = await fetch(`${upstreamBaseUrl}${url}`, {
        method: request.method,
        headers,
        body,
      })
      let responseBody = Buffer.from(await upstream.arrayBuffer())
      if (isZoneCreate) {
        let operationId: string | null = null
        try { operationId = (JSON.parse(responseBody.toString('utf8')) as { operation_id?: string }).operation_id ?? null } catch { /* error body */ }
        createAttempts.push({ key: String(request.headers['idempotency-key'] ?? ''), operationId, status: upstream.status })
      }
      if (shouldDrop) {
        response.destroy()
        return
      }
      const operationMatch = request.method === 'GET' ? url.match(/^\/v2\/zone-operations\/([^/?]+)$/) : null
      if (operationMatch && decodeURIComponent(operationMatch[1]) === failedOperationId && upstream.ok) {
        failedOperationId = null
        const operation = JSON.parse(responseBody.toString('utf8')) as Record<string, unknown>
        responseBody = Buffer.from(JSON.stringify({ ...operation, state: 'failed', error: { code: 'INJECTED_OPERATION_FAILURE', message: 'injected operation lookup failure', retryable: false } }))
      }
      response.statusCode = upstream.status
      upstream.headers.forEach((value, name) => {
        if (!['connection', 'content-length', 'transfer-encoding'].includes(name)) {
          response.setHeader(name, value)
        }
      })
      response.end(responseBody)
    } catch (error) {
      response.statusCode = 502
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({
        detail: { code: 'PROXY_UPSTREAM_FAILED', message: String(error), retryable: true },
      }))
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    failNextDeprovision: (zoneId: string) => { failZoneId = zoneId },
    failOperationLookup: (operationId: string) => { failedOperationId = operationId },
    dropNextZoneCreate: () => { dropZoneCreate = true },
    zoneCreateAttempts: () => [...createAttempts],
    stop: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}
