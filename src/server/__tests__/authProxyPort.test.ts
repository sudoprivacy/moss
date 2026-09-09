import { afterEach, describe, expect, it } from 'bun:test'
import { AuthProxyServer } from '../authProxy/authProxyServer.js'

/**
 * The auth proxy's port used to be a constant, duplicated in a second module as
 * the URL handed to sessions. 12013 is not reserved for us — the Nexus vault
 * daemon defaults to the same port — so a machine running both had one of them
 * fail to start, with a symptom that points nowhere near the cause (a gRPC
 * client meeting an HTTP/1.x server).
 *
 * These pin the two properties that fix it: the port is configurable, and the
 * server reports the port it actually bound so callers derive the URL instead of
 * repeating the number.
 */

const started: AuthProxyServer[] = []

afterEach(async () => {
  while (started.length) await started.pop()!.stop().catch(() => {})
  delete process.env.MOSS_AUTH_PROXY_PORT
})

async function startOn(port?: string): Promise<AuthProxyServer> {
  if (port === undefined) delete process.env.MOSS_AUTH_PROXY_PORT
  else process.env.MOSS_AUTH_PROXY_PORT = port
  // The port is read at module load, so each case re-imports a fresh copy.
  const mod = await import(`../authProxy/authProxyServer.js?p=${port ?? 'default'}-${Date.now()}`)
  const server = new mod.AuthProxyServer() as AuthProxyServer
  await server.start()
  started.push(server)
  return server
}

describe('auth proxy port', () => {
  it('binds an ephemeral port when asked for 0, and reports it', async () => {
    const server = await startOn('0')
    // The whole point: callers read this instead of assuming 12013.
    expect(server.port).toBeGreaterThan(0)
    expect(server.port).not.toBe(12013)
  })

  it('honours an explicit port', async () => {
    const server = await startOn('0')
    const free = server.port
    await server.stop()
    started.pop()

    const pinned = await startOn(String(free))
    expect(pinned.port).toBe(free)
  })

  it('reports the bound port through /health, not the configured constant', async () => {
    const server = await startOn('0')
    const res = await fetch(`http://127.0.0.1:${server.port}/health`)
    const body = (await res.json()) as { status?: string; port?: number }
    expect(body.status).toBe('ok')
    expect(body.port).toBe(server.port)
  })

  it('fails with an actionable message when the port is taken', async () => {
    const first = await startOn('0')
    const taken = first.port

    let error: Error | null = null
    try {
      await startOn(String(taken))
    } catch (err) {
      error = err as Error
    }
    expect(error).not.toBeNull()
    // The old message named the port and nothing else, which left an operator
    // with no idea what to change or why the collision happened.
    expect(error!.message).toContain('MOSS_AUTH_PROXY_PORT')
    expect(error!.message).toContain('Nexus vault')
  })
})
