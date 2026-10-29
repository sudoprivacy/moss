import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'

// Events carry no asset details. Each refresh rechecks the caller's visibility.
const events = new EventEmitter()
events.setMaxListeners(0)
export function notifyCatalogPublished(orgId: string): void {
  events.emit('published', orgId)
}
export function connectCatalogEvents(res: ServerResponse, orgId: string): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
  const refresh = (changedOrg: string) => {
    if (changedOrg === orgId && !res.destroyed) res.write('event: catalog.changed\ndata: {}\n\n')
  }
  events.on('published', refresh)
  refresh(orgId)
  const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n') }, 15_000)
  // Reconnect periodically so token expiry and membership changes are rechecked.
  const expiry = setTimeout(() => res.end(), 50_000)
  res.once('close', () => { clearInterval(heartbeat); clearTimeout(expiry); events.off('published', refresh) })
}
