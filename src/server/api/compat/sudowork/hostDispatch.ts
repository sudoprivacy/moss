import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import { createCompatibilityRouteMatcher } from './routeInventory.js'
import {
  mapMossOperationsPath,
  MOSS_OPERATIONS_LEGACY_ROUTES,
} from './sharedOperationalRoutes.js'

type FetchCallback = (request: Request) => Response | Promise<Response>

export interface HostDispatchOptions {
  sudoworkHosts?: readonly string[]
  sudoworkFetch?: FetchCallback
  sudoworkRoutes?: readonly { method: string; path: string }[]
  mossOperationsFetch?: FetchCallback
  mossHandler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
}

function canonicalHostname(hostHeader: string | undefined): string | undefined {
  if (!hostHeader || hostHeader.includes(',') || /[\s/@]/.test(hostHeader)) return undefined
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

export function createHostDispatch(options: HostDispatchOptions): RequestListener {
  const trustedHosts = new Set((options.sudoworkHosts ?? []).map(host => host.toLowerCase()))
  const sudoworkHandler = options.sudoworkFetch
    ? getRequestListener(options.sudoworkFetch)
    : null
  const mossOperationsHandler = options.mossOperationsFetch
    ? getRequestListener(options.mossOperationsFetch)
    : null
  const isSudoworkRoute = createCompatibilityRouteMatcher(options.sudoworkRoutes ?? [])
  const isMossOperationsRoute = createCompatibilityRouteMatcher(MOSS_OPERATIONS_LEGACY_ROUTES)
  return (request, response) => {
    const hostname = canonicalHostname(request.headers.host)
    const url = new URL(request.url ?? '/', 'http://localhost')
    const pathname = url.pathname
    const mappedOperationsPath = mapMossOperationsPath(pathname)
    if (
      mappedOperationsPath
      && mossOperationsHandler
      && isMossOperationsRoute(request.method, mappedOperationsPath)
    ) {
      request.url = `${mappedOperationsPath}${url.search}`
      void mossOperationsHandler(request, response)
      return
    }
    const registeredCompatibilityRoute = isSudoworkRoute(request.method, pathname)
    const legacyHostRoute = hostname && trustedHosts.has(hostname) && registeredCompatibilityRoute
    if (legacyHostRoute && sudoworkHandler) {
      void sudoworkHandler(request, response)
      return
    }
    // mossHandler 是巨型 async 路由，任何路由逃逸的异常（例如 404
    // AuthServiceError——2026-09-21 P0 E2E 实证：PATCH /api/v1/users/:id 对
    // 不存在用户抛 404）在此前被 void 丢弃 → unhandledRejection → node 24
    // 默认击穿整个进程（一个 4xx 请求即可打死 server）。此处兜底转 500；
    // 响应已开始时只能记录并断开连接。
    void Promise.resolve(options.mossHandler(request, response)).catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: 'internal server error' }))
      } else {
        response.destroy()
      }
      if (typeof (error as { stack?: string })?.stack === 'string') {
        process.stderr.write(`[hostDispatch] unhandled route error: ${(error as Error).stack}\n`)
      } else {
        process.stderr.write(`[hostDispatch] unhandled route error: ${String(error)}\n`)
      }
    })
  }
}
