import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface NexusFaultProxy {
  baseUrl: string
  failNextDeprovision: (zoneId: string) => void
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
  const server = createServer(async (request, response) => {
    const url = request.url ?? '/'
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
      response.statusCode = upstream.status
      upstream.headers.forEach((value, name) => {
        if (!['connection', 'content-length', 'transfer-encoding'].includes(name)) {
          response.setHeader(name, value)
        }
      })
      response.end(Buffer.from(await upstream.arrayBuffer()))
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
    stop: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}
