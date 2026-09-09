import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { getRequestListener, type FetchCallback } from '@hono/node-server'
import { createCompatibilityRouteMatcher } from './routeInventory.js'
import {
  mapMossOperationsPath,
  MOSS_OPERATIONS_LEGACY_ROUTES,
} from './sharedOperationalRoutes.js'

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
    void options.mossHandler(request, response)
  }
}
