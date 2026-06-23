import http from 'http'
import { URL } from 'url'

const port = Number(process.env.CABIN_MOCK_PORT || 48082)
const calls = []

function json(res, status, data) {
  const payload = JSON.stringify(data)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise(resolve => {
    let body = ''
    req.on('data', chunk => {
      body += chunk
    })
    req.on('end', () => resolve(body))
  })
}

function wavBuffer() {
  const sampleRate = 8000
  const seconds = 0.2
  const samples = Math.floor(sampleRate * seconds)
  const dataSize = samples * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  return buf
}

function passengerInfo() {
  return {
    code: 0,
    msg: '',
    data: {
      flight: {
        flightId: 2,
        flightNo: 'CA8888',
        flightDate: '2026-06-05',
        departureAirport: 'PEK',
        arrivalAirport: 'SHA',
        scheduledDepartureTime: '2026-06-05 14:14:01',
        scheduledArrivalTime: '2026-07-05 15:14:01',
        flightPhase: 'boarding',
      },
      passenger: {
        passengerRef: 'REF-01B-2',
        displayName: '刘淑芬',
        englishFirstName: 'LIU',
        englishLastName: 'SHUFEN',
        gender: 'FEMALE',
        flightCount: 2,
        lastAmbientMode: '{"mode":"sleep","brightness":35}',
        memberLevel: 'SILVER',
        language: 'zh-CN',
        mealPreference: '标准餐',
        specialServiceTags: '',
      },
    },
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`)
  const body = await readBody(req)
  calls.push({
    time: new Date().toISOString(),
    method: req.method,
    path: url.pathname,
    search: url.search,
    tabletToken: req.headers['tablet-token'] || req.headers['x-cabin-tablet-token'] || '',
    authorization: req.headers.authorization || '',
    body,
  })

  if (req.method === 'GET' && url.pathname === '/calls') {
    return json(res, 200, calls.slice(-100))
  }

  if (req.method === 'POST' && url.pathname === '/admin-api/cabin/tablet-passenger-info/current') {
    return json(res, 200, passengerInfo())
  }

  if (req.method === 'POST' && url.pathname === '/v1/audio/speech') {
    const audio = wavBuffer()
    res.writeHead(200, {
      'content-type': 'audio/wav',
      'content-length': audio.length,
    })
    return res.end(audio)
  }

  const controlMatch = url.pathname.match(/^\/admin-api\/tcp-client\/cmd\/(seat[^/]+)\/(cushion|light)$/)
  if (req.method === 'POST' && controlMatch) {
    const [, seatSide, command] = controlMatch
    const seatNo = url.searchParams.get('seatNo') || ''
    const position = url.searchParams.get('position')
    const on = url.searchParams.get('on')
    const pwm = url.searchParams.get('pwm')
    return json(res, 200, {
      code: 0,
      msg: '',
      data: {
        status: 'completed',
        code: 0,
        message: 'ok',
        command,
        seatSide,
        seatNo,
        position,
        on,
        pwm,
      },
    })
  }

  if (req.method === 'POST' && url.pathname === '/admin-api/cabin/service-task/create') {
    let task = {}
    try {
      task = body ? JSON.parse(body) : {}
    } catch {
      task = { rawBody: body }
    }
    return json(res, 200, {
      code: 0,
      msg: '',
      data: {
        status: 'created',
        taskId: `mock-task-${Date.now()}`,
        ...task,
      },
    })
  }

  return json(res, 404, {
    code: 404,
    msg: `mock endpoint not found: ${req.method} ${url.pathname}`,
    data: null,
  })
})

server.listen(port, '0.0.0.0', () => {
  console.log(`Cabin mock server listening on 0.0.0.0:${port}`)
  console.log('Passenger mock data: 刘淑芬 / REF-01B-2 / CA8888 / 2026-06-05')
  console.log('Control mock endpoints: seat cushion, seat light, service task, TTS wav')
})
