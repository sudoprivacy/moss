import type WebSocket from 'ws'
import type { RawData } from 'ws'

export interface SessionSocketAuthorization {
  verify(): Promise<boolean>
  onMessage(data: RawData): void
  isManagement: boolean
}

/** Recheck established session grants before forwarding each ordered frame. */
export function attachSessionSocketAuthorization(ws: WebSocket, access: SessionSocketAuthorization): void {
  let messages = Promise.resolve()
  let isChecking = false
  let queuedFrames = 0
  const refuse = (): void => {
    if (ws.readyState === ws.OPEN) ws.close(1008, 'Session permission revoked')
  }
  ws.on('message', data => {
    if (++queuedFrames > 64) { ws.close(1009, 'Too many pending session frames'); return }
    messages = messages.then(async () => {
      if (ws.readyState !== ws.OPEN) return
      if (!await access.verify()) { refuse(); return }
      if (ws.readyState === ws.OPEN) access.onMessage(data)
    }).catch(refuse).finally(() => { queuedFrames-- })
  })
  const timer = access.isManagement ? setInterval(() => {
    if (isChecking || ws.readyState !== ws.OPEN) return
    isChecking = true
    void access.verify().then(isAllowed => {
      if (!isAllowed) refuse()
    }).catch(refuse).finally(() => { isChecking = false })
  }, 5000) : undefined
  timer?.unref()
  // A quiet model turn can exceed the public proxy's idle budget. Protocol
  // frames keep both Desktop and WebUI subscriptions alive without changing
  // the application stream or replaying a user message.
  const heartbeat = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping()
  }, 20_000)
  heartbeat.unref()
  const cleanup = (): void => { clearInterval(timer); clearInterval(heartbeat) }
  ws.once('close', cleanup)
  ws.once('error', cleanup)
}
