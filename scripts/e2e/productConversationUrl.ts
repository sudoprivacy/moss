import assert from 'node:assert/strict'

/** Bind the operator's token to the configured product origin and session. */
export function assertProductConversationUrl(value: string, localBaseUrl: string,
  publicBaseUrl: string | undefined, sessionId: string, routeCookieName = 'moss_route'): void {
  const target = new URL(value)
  assert(!target.username && !target.password && !target.hash, 'Refuse credentials or a fragment in the product WebSocket URL')
  const bases = [localBaseUrl, ...(publicBaseUrl ? [publicBaseUrl] : [])].map(value => {
    const base = new URL(value)
    assert(!base.username && !base.password && !base.search && !base.hash, 'Use an explicit product base URL without credentials or query data')
    assert(base.protocol === 'https:' || (base.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)), 'Public product connections require TLS')
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
    base.pathname = base.pathname.replace(/\/+$/, '') + `/ws/sessions/${encodeURIComponent(sessionId)}`
    return base
  })
  assert(bases.some(base => target.origin === base.origin && target.pathname === base.pathname),
    'Refuse a WebSocket outside the configured product origin or original session')
  assert([...target.searchParams.keys()].every(key => key === routeCookieName) &&
    target.searchParams.getAll(routeCookieName).length <= 1, 'Refuse unexpected product WebSocket query data')
}
