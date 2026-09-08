import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { getRequestListener, type FetchCallback } from '@hono/node-server'
import { createCompatibilityRouteMatcher } from './routeInventory.js'

export interface HostDispatchOptions {
  sudoworkHosts: readonly string[]
  sudoworkFetch: FetchCallback
  sudoworkRoutes: readonly { method: string; path: string }[]
  sharedSudoworkRoutes?: readonly { method: string; path: string }[]
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
  const trustedHosts = new Set(options.sudoworkHosts.map(host => host.toLowerCase()))
  const sudoworkHandler = getRequestListener(options.sudoworkFetch)
  const isSudoworkRoute = createCompatibilityRouteMatcher(options.sudoworkRoutes)
  const isSharedSudoworkRoute = createCompatibilityRouteMatcher(options.sharedSudoworkRoutes ?? [])
  return (request, response) => {
    const hostname = canonicalHostname(request.headers.host)
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    const registeredCompatibilityRoute = isSudoworkRoute(request.method, pathname)
    const legacyHostRoute = hostname && trustedHosts.has(hostname) && registeredCompatibilityRoute
    const sharedOperationalRoute = registeredCompatibilityRoute
      && isSharedSudoworkRoute(request.method, pathname)
    if (legacyHostRoute || sharedOperationalRoute) {
      void sudoworkHandler(request, response)
      return
    }
    void options.mossHandler(request, response)
  }
}
