#!/usr/bin/env node
/**
 * E2E smoke for the LB/HA P0+P2 slice, run against a live docker-compose.ha
 * stack (see deploy/nginx/README-ha.md). Pure Node (fetch + ws) — no Electron:
 * client-side self-healing is validated separately on the desktop build.
 *
 * Usage:
 *   node scripts/e2e/ha-p0p2-smoke.mjs [--base http://127.0.0.1] [--port 80]
 *
 * Cases (see the HA plan's test table):
 *   1. /readyz 200 via LB (stack up)
 *   2. login → token
 *   3. create session (host runtime) → owner_instance_id/live + ws_url route
 *   4. WS via ws_url reaches the owner (hello arrives)
 *   5. map priority: forced route to the OTHER instance → deterministic 409
 *   6. mcp/events cross-instance: write via instance B, receive on LB SSE
 *   7. corp-app callback port via LB answers (404 for unknown id = routed)
 *   8. failover: kill the owner container → fencing → respawn → WS recovers
 */
import WebSocket from 'ws'

const args = process.argv.slice(2)
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const base = arg('base', 'http://127.0.0.1')
const port = arg('port', '80')
const httpBase = `${base}:${port}`
const wsBase = httpBase.replace(/^http/, 'ws')

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function waitFor(fn, timeoutMs, label) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn()
      if (v) return v
    } catch { /* retry */ }
    await sleep(1000)
  }
  throw new Error(`timeout waiting for ${label}`)
}

let passed = 0, failed = 0
const ok = (label, cond, detail = '') => {
  if (cond) { passed += 1; console.log(`  ✔ ${label}${detail ? ` — ${detail}` : ''}`) }
  else { failed += 1; console.error(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`) }
}

async function login() {
  const res = await fetch(`${httpBase}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  })
  if (!res.ok) throw new Error(`login failed: ${res.status}`)
  const data = await res.json()
  return data.access_token
}

/** Open a session WS; resolves on first message; rejects on handshake fail. */
function wsOnce(url, token, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } })
    const timer = setTimeout(() => { try { ws.terminate() } catch {}; reject(new Error('ws timeout')) }, timeoutMs)
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer)
      const err = new Error(`handshake ${res.statusCode}`)
      err.status = res.statusCode
      reject(err)
    })
    ws.on('error', err => { clearTimeout(timer); reject(err) })
    ws.on('message', data => {
      clearTimeout(timer)
      try { ws.terminate() } catch {}
      resolve(data.toString('utf8'))
    })
  })
}

async function main() {
  console.log(`HA P0+P2 smoke against ${httpBase}`)

  // 1. readyz via LB
  const readyz = await waitFor(async () => {
    const r = await fetch(`${httpBase}/readyz`)
    return r.ok ? r : null
  }, 120_000, '/readyz via LB')
  const readyBody = await readyz.json()
  ok('readyz 200 via LB', true, `instance_id=${readyBody.instance_id}`)

  // 2. login
  const token = await login()
  ok('login', Boolean(token))

  // 3. create session → owner metadata + route
  const created = await (await fetch(`${httpBase}/api/v1/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: '/tmp', runtime: { type: 'host' } }),
  })).json()
  ok('create returns owner metadata',
    typeof created.owner_instance_id === 'string' && created.owner_live === true,
    `owner=${created.owner_instance_id} live=${created.owner_live}`)
  ok('create ws_url carries route',
    /(\?|&)moss_route=/.test(created.ws_url || ''), created.ws_url)
  const owner = created.owner_instance_id
  const other = owner === 'a' ? 'b' : 'a'
  const sessionId = (created.ws_url.match(/\/ws\/sessions\/([^?]+)/) || [])[1]

  // 4. WS via ws_url reaches the owner (hello arrives)
  const hello = await wsOnce(created.ws_url, token)
  ok('WS via ws_url reaches owner (hello)', /"type":"hello"/.test(hello), hello.slice(0, 80))

  // 5. map priority: forced route to the OTHER live instance → 409 every time
  const forced = created.ws_url.replace(/([?&])moss_route=[^&]+/, `$1moss_route=${other}`)
  let conflicts = 0
  for (let i = 0; i < 3; i += 1) {
    try { await wsOnce(forced, token, 5_000) } catch (e) { if (e.status === 409) conflicts += 1 } await sleep(200)
  }
  ok('forced route to other instance → deterministic 409', conflicts === 3, `${conflicts}/3 got 409`)

  // 6. mcp/events cross-instance: write via the OTHER container, read via LB SSE
  const sse = await fetch(`${httpBase}/api/v1/mcp/events?token=${encodeURIComponent(token)}`)
  ok('mcp/events SSE open via LB', sse.ok && (sse.headers.get('content-type') || '').includes('event-stream'))
  const reader = sse.body.getReader()
  const sseEvents = []
  ;(async () => {
    try {
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2)
          const m = /^event: (\S+)/m.exec(frame)
          if (m) sseEvents.push(m[1])
        }
      }
    } catch { /* stream closed */ }
  })()
  await sleep(4_000) // let the poller seed this org's baseline
  // Direct write on the OTHER instance (docker exec + node fetch, admin API).
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)
  const writeOnOther = async () => {
    const script = `fetch('http://127.0.0.1:43127/api/v1/admin/mcp-servers', {method:'POST', headers:{authorization:'Bearer ${token}','content-type':'application/json'}, body: JSON.stringify({name:'e2e-${Date.now()}', scope:'user', mcp_type:'http', url:'http://127.0.0.1:1', owner_type:'org', owner_id:'', created_by:'e2e'})}).then(r=>r.status).catch(e=>String(e))`
    const { stdout } = await exec('docker', ['exec', `moss-server-${other}`, 'node', '-e', script])
    return stdout.trim()
  }
  const writeStatus = await writeOnOther().catch(e => String(e))
  const gotChanged = await waitFor(async () => sseEvents.includes('mcp.changed') ? true : null, 20_000, 'cross-instance mcp.changed')
  ok('cross-instance mcp.changed within poll window', Boolean(gotChanged), `remote write=${writeStatus}`)
  try { await reader.cancel() } catch {}

  // 7. corp-app callback entry via LB (unknown id → 404 = routed to the callback port)
  const cb = await fetch(`${base}:43128/api/v1/corp-apps/callback/nope`)
  ok('corp-app callback port routed via LB', cb.status === 404, `status=${cb.status}`)

  // 8. failover: kill the owner container → fencing → respawn → WS recovers
  console.log(`  killing owner container moss-server-${owner} …`)
  await exec('docker', ['kill', `moss-server-${owner}`]).catch(() => {})
  // A real client re-fetches session metadata to pick up the NEW owner's route
  // (P0-2 self-heal). The killed owner's route is dead, so reconnecting the same
  // ws_url can never recover — must re-GET to get the fresh ws_url.
  const recovered = await waitFor(async () => {
    try {
      const detail = await (await fetch(`${httpBase}/api/v1/sessions/${sessionId}`, {
        headers: { authorization: `Bearer ${token}` },
      })).json()
      if (!detail.ws_url) return null
      return await wsOnce(detail.ws_url, token, 5_000)
    } catch { return null }
  }, 150_000, 'WS recovery after owner kill')
  ok('failover → fencing → respawn → WS recovers', /"type":"hello"/.test(recovered || ''), (recovered || '').slice(0, 80))

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => { console.error('smoke error:', err); process.exit(1) })
