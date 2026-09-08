import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { getRequestListener, type FetchCallback } from '@hono/node-server'

export interface HostDispatchOptions {
  sudoworkHosts: readonly string[]
  sudoworkFetch: FetchCallback
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
  const trustedHosts = new Set(options.sudoworkHosts.map((host) => host.toLowerCase()))
  const sudoworkHandler = getRequestListener(options.sudoworkFetch)

  return (request, response) => {
    const hostname = canonicalHostname(request.headers.host)
    if (hostname && trustedHosts.has(hostname)) {
      void sudoworkHandler(request, response)
      return
    }
    void options.mossHandler(request, response)
  }
}
