// Mock backend for cabin local testing.
//
// It simulates the customer's internal services:
// - passenger-info HTTP API
// - hardware status query API
// - hardware control API
// - flight-data WebSocket subscription at /infra/ws
//
// Useful env vars:
//   MOCK_PORT=49250
//   MOCK_PHASES=7,16,16,2,3,5
//   MOCK_PHASE_INTERVAL_MS=1000

import http from 'node:http'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.MOCK_PORT || 49250)
const PHASES = String(process.env.MOCK_PHASES || '7,16')
  .split(',')
  .map(value => Number.parseInt(value.trim(), 10))
  .filter(Number.isFinite)
const PHASE_INTERVAL_MS = Number(process.env.MOCK_PHASE_INTERVAL_MS || 1000)

const controlLog = []
const wsClients = new Set()

const seatState = new Map([
  ['A', {
    posture: { position: '20' },
    tray: { tray_state: 'opened', tray_flipped: 'false' },
    safety: { presence: 'true', seatbelt: 'false', wireless_charging: 'false', safe_to_move: 'true' },
    comfort: { ventilation_level: '0', heating_level: '0', massage_level: '0' },
    reading_light: { on: 'false', pwm: '0' },
  }],
  ['B', {
    posture: { position: '0' },
    tray: { tray_state: 'closed', tray_flipped: 'false' },
    safety: { presence: 'true', seatbelt: 'true', wireless_charging: 'false', safe_to_move: 'true' },
    comfort: { ventilation_level: '0', heating_level: '0', massage_level: '0' },
    reading_light: { on: 'false', pwm: '0' },
  }],
])

const cabinState = {
  glass_state: { left_gray: '0', right_gray: '0' },
  ceiling_state: { on: 'false', r: '0', g: '0', b: '0', brightness: '50', obj: '0', preset: 'normal' },
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

function ensureSeat(seatNo) {
  if (!seatState.has(seatNo)) {
    seatState.set(seatNo, {
      posture: { position: '0' },
      tray: { tray_state: 'closed', tray_flipped: 'false' },
      safety: { presence: 'true', seatbelt: 'true', wireless_charging: 'false', safe_to_move: 'true' },
      comfort: { ventilation_level: '0', heating_level: '0', massage_level: '0' },
      reading_light: { on: 'false', pwm: '0' },
    })
  }
  return seatState.get(seatNo)
}

function flightDataMessage(phase) {
  return JSON.stringify({
    type: 'flight_data',
    content: JSON.stringify({
      mavpacktype: 'CE25_AUTO_GUIDE_DATA',
      afcs_status_data: [1, 1, 0, 0, 0, 0, 1, phase, 1],
      control_mode: 1,
      current_leg_index: 5,
      id: 1021,
      Time: new Date().toISOString().replace('T', ' ').replace('Z', '').slice(0, 23),
    }),
  })
}

function broadcastPhase(phase) {
  const payload = flightDataMessage(phase)
  for (const ws of wsClients) {
    if (ws.readyState === ws.OPEN) ws.send(payload)
  }
  process.stderr.write(`[mock-ws] phase=${phase} clients=${wsClients.size}\n`)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`)

  if (req.method === 'POST' && url.pathname === '/admin-api/cabin/tablet-passenger-info/current') {
    await readBody(req)
    return json(res, 200, {
      code: 0,
      msg: 'ok',
      data: {
        flightId: 'AUTO',
        flightDate: new Date().toISOString().slice(0, 10),
        flightNo: 'CA1234',
        seatNo: 'A',
        passenger: { displayName: '张先生', gender: 'male', seatNo: 'A', language: 'zh' },
      },
    })
  }

  if (req.method === 'GET' && url.pathname === '/admin-api/tcp/hardware/status') {
    const target = url.searchParams.get('target') || 'A'
    const key = url.searchParams.get('key') || ''
    const data = target === 'cabin'
      ? cabinState[key] || {}
      : ensureSeat(target)[key] || {}
    return json(res, 200, {
      code: 0,
      msg: '',
      data: {
        aircraftNo: 'B-WITHFLIGHT-01',
        target,
        key,
        data,
        lastUpdateTime: Date.now(),
      },
    })
  }

  if (req.method === 'POST' && url.pathname.startsWith('/admin-api/tcp-client/cmd/')) {
    await readBody(req)
    const seatNo = url.searchParams.get('seatNo') || 'A'
    const state = ensureSeat(seatNo)
    if (url.pathname === '/admin-api/tcp-client/cmd/seat/cushion') {
      state.posture.position = url.searchParams.get('position') || '0'
    }
    if (url.pathname === '/admin-api/tcp-client/cmd/seat/tray/close') {
      state.tray.tray_state = 'closed'
      state.tray.tray_flipped = 'false'
    }
    const entry = {
      at: new Date().toISOString(),
      path: url.pathname,
      params: Object.fromEntries(url.searchParams.entries()),
    }
    controlLog.push(entry)
    process.stderr.write(`[mock-control] ${entry.path} ${JSON.stringify(entry.params)}\n`)
    return json(res, 200, { code: 0, msg: '', data: '指令下发成功' })
  }

  if (req.method === 'POST' && url.pathname === '/_mock/phase') {
    const body = await readBody(req)
    let phase = Number.parseInt(url.searchParams.get('phase') || '', 10)
    if (!Number.isFinite(phase) && body) {
      try {
        phase = Number.parseInt(String(JSON.parse(body).phase), 10)
      } catch {}
    }
    if (!Number.isFinite(phase)) return json(res, 400, { ok: false, msg: 'phase is required' })
    broadcastPhase(phase)
    return json(res, 200, { ok: true, phase })
  }

  if (req.method === 'GET' && url.pathname === '/_mock/control-log') {
    return json(res, 200, { count: controlLog.length, entries: controlLog })
  }
  if (req.method === 'POST' && url.pathname === '/_mock/control-log/reset') {
    controlLog.length = 0
    return json(res, 200, { ok: true })
  }
  if (req.method === 'GET' && url.pathname === '/_mock/state') {
    return json(res, 200, {
      seats: Object.fromEntries(seatState.entries()),
      cabin: cabinState,
    })
  }

  json(res, 404, { code: 404, msg: 'not found', path: url.pathname })
})

const wss = new WebSocketServer({ noServer: true })

wss.on('connection', ws => {
  wsClients.add(ws)
  process.stderr.write(`[mock-ws] client connected clients=${wsClients.size}\n`)
  ws.on('close', () => {
    wsClients.delete(ws)
    process.stderr.write(`[mock-ws] client closed clients=${wsClients.size}\n`)
  })
  let index = 0
  const timer = setInterval(() => {
    if (index >= PHASES.length) {
      clearInterval(timer)
      return
    }
    ws.send(flightDataMessage(PHASES[index]))
    process.stderr.write(`[mock-ws] phase=${PHASES[index]}\n`)
    index += 1
  }, PHASE_INTERVAL_MS)
  timer.unref?.()
})

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`)
  if (url.pathname !== '/infra/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit('connection', ws, req)
  })
})

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`[mock-backend] listening on http://127.0.0.1:${PORT}\n`)
  process.stderr.write(`[mock-backend] websocket ws://127.0.0.1:${PORT}/infra/ws phases=${PHASES.join(',')}\n`)
})
