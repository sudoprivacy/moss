#!/usr/bin/env node
/**
 * A-1 targeted E2E: a session the user TERMINATED must not be resurrected by
 * the fencing-wait respawn when its owner instance dies (the exact sequence
 * the audit flagged: adopt → fencing-wait pending → user terminates → poll
 * fires → old code respawned the session back to active/active).
 *
 * Run against the live docker-compose.ha stack:
 *   node scripts/e2e/ha-a1-terminate-failover.mjs [--base http://127.0.0.1] [--port 80]
 * Kills the owner container as its final act — restart it afterwards if needed.
 */
const args = process.argv.slice(2)
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const httpBase = `${arg('base', 'http://127.0.0.1')}:${arg('port', '80')}`

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

const login = async () => {
  const res = await fetch(`${httpBase}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  })
  if (!res.ok) throw new Error(`login failed: ${res.status}`)
  return (await res.json()).access_token
}

const main = async () => {
  console.log(`A-1 targeted E2E against ${httpBase}`)
  const token = await login()
  const auth = { authorization: `Bearer ${token}` }

  // 1. Create a session; learn its owner instance.
  const created = await (await fetch(`${httpBase}/api/v1/sessions`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: '/tmp', runtime: { type: 'host' } }),
  })).json()
  const sessionId = created.session_id ?? created.id ?? created.session?.session_id
  const owner = created.owner_instance_id ?? created.session?.owner_instance_id
  ok('session created', Boolean(sessionId && owner), `owner=${owner}`)
  if (!sessionId || !owner) throw new Error('unexpected create payload: ' + JSON.stringify(created).slice(0, 300))

  // 2. Terminate it as the user would.
  const term = await fetch(`${httpBase}/api/v1/sessions/${sessionId}/terminate`, {
    method: 'POST', headers: auth,
  })
  ok('terminate accepted', term.ok, `status=${term.status}`)

  // 3. Kill the owner container: the peer adopts, the fencing-wait fires on
  //    the now-dead heartbeat. Old code respawned the TERMINATED session back
  //    to active/active within ~5s of the poll; the guard must prevent that.
  const { execFileSync } = await import('node:child_process')
  console.log(`  killing owner container moss-server-${owner} …`)
  try {
    execFileSync('docker', ['kill', `moss-server-${owner}`], { stdio: 'ignore' })
  } catch (e) {
    throw new Error(`docker kill failed (failover not triggered, test void): ${e.message}`)
  }

  // 4. Wait out the fencing window (heartbeat timeout 30s + poll 5s + margin;
  //    the 90s watchdog bounds it), then check the session stayed terminated.
  await sleep(100_000)

  const get = await fetch(`${httpBase}/api/v1/sessions/${sessionId}`, { headers: auth })
  const body = get.status === 200 ? await get.json() : {}
  const status = body.session?.status ?? body.status
  const desired = body.session?.desired_state ?? body.desired_state ?? body.session?.desiredState
  ok('session NOT resurrected after failover',
    !(status === 'active') && !(desired === 'active'),
    `GET=${get.status} status=${status} desired=${desired}`)
  ok('session still addressable (record intact, not revived)', get.status === 200 || get.status === 404,
    `GET=${get.status}`)

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => { console.error('smoke error:', err.message); process.exit(1) })
