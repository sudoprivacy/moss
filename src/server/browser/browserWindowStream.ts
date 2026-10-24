import WebSocket, { type RawData } from 'ws'
import { HttpError } from '../httpError.js'
import type { BrowserBinding } from './browserGateway.js'

/** Only the trusted host can open the worker's bound, read-only RFB endpoint. */
export function connectWorkerWindowStream(
  endpoint: string, token: string, binding: BrowserBinding, controller: string,
  action: Record<string, unknown>,
): Promise<WebSocket> {
  const url = new URL('window-stream', endpoint.endsWith('/') ? endpoint : endpoint + '/')
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return new Promise((resolve, reject) => {
    const upstream = new WebSocket(url, ['binary'], {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-ADB-Browser-Context': encodeURIComponent(JSON.stringify({ binding, controller,
          viewerId: action.viewerId, controlEpoch: action.controlEpoch, targetEpoch: action.targetEpoch })),
      },
      followRedirects: false, handshakeTimeout: 10_000,
      maxPayload: 16 * 1024 * 1024, perMessageDeflate: false,
    })
    upstream.once('open', () => resolve(upstream))
    upstream.once('error', () => reject(new HttpError(503, 'browser_window_stream_unavailable')))
    upstream.once('unexpected-response', (_request, response) => {
      response.resume()
      reject(new HttpError([400, 403, 409, 503].includes(response.statusCode ?? 0) ? response.statusCode! : 502,
        'browser_window_stream_unavailable'))
      upstream.terminate()
    })
  })
}

function bytes(data: RawData): Buffer {
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
}

/** Forward RFB with bounded queues and current authorization in both directions.
 *
 * The worker enforces read-only RFB at x11vnc. Pointer/keyboard/clipboard writes
 * remain on the epoch/lease-checked browser action API. This bridge never
 * reconnects, obtains control or replays a message after uncertain delivery.
 */
export function bridgeBrowserWindowStream(
  client: WebSocket, upstream: WebSocket, verify: () => Promise<boolean>,
): void {
  let isClosed = false
  let checking: Promise<boolean> | null = null
  const check = (): Promise<boolean> => {
    checking ??= Promise.resolve().then(verify).catch(() => false).finally(() => { checking = null })
    return checking
  }
  const close = (code: number, reason: string): void => {
    if (isClosed) return
    isClosed = true
    clearInterval(timer)
    clearInterval(heartbeat)
    for (const socket of [client, upstream]) {
      if (socket.readyState === socket.OPEN) socket.close(code, reason)
      else if (socket.readyState === socket.CONNECTING) socket.terminate()
    }
  }
  const pipe = (source: WebSocket, target: WebSocket): void => {
    let pendingFrames = 0
    let pendingBytes = 0
    let queue = Promise.resolve()
    source.on('message', (raw, isBinary) => {
      if (isClosed) return
      if (!isBinary) { close(1003, 'Binary browser stream required'); return }
      const data = bytes(raw)
      pendingBytes += data.length
      if (++pendingFrames > 64 || pendingBytes > 16 * 1024 * 1024) {
        close(1009, 'Browser stream queue exceeded'); return
      }
      queue = queue.then(async () => {
        if (isClosed) return
        if (!await check()) { close(1008, 'Browser permission revoked'); return }
        if (isClosed || target.readyState !== target.OPEN) return
        await new Promise<void>((resolve, reject) => {
          target.send(data, { binary: true }, error => error ? reject(error) : resolve())
        })
      }).catch(() => close(1011, 'Browser stream disconnected')).finally(() => {
        pendingFrames--
        pendingBytes -= data.length
      })
    })
    source.once('close', () => close(1000, 'Browser stream disconnected'))
    source.once('error', () => close(1011, 'Browser stream disconnected'))
  }
  // Quiet viewers must lose access too; no input message is required to revoke.
  const timer = setInterval(() => {
    void check().then(isAllowed => { if (!isAllowed) close(1008, 'Browser permission revoked') })
  }, 5000)
  const heartbeat = setInterval(() => {
    for (const socket of [client, upstream]) if (socket.readyState === socket.OPEN) socket.ping()
  }, 20_000)
  timer.unref()
  heartbeat.unref()
  pipe(client, upstream)
  pipe(upstream, client)
}
