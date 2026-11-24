import { afterEach, describe, expect, it } from 'bun:test'
import { languageNames } from '../language.js'
import type { SpokenLanguage } from '../commandLanguage.js'
import http from 'http'
import { connect, type Socket } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { DatabaseSync } from 'node:sqlite'

import { createCabinApi } from '../api.js'
import { buildConversationKey } from '../auth.js'
import { CabinStore } from '../store.js'
import type { CabinPassengerContext } from '../types.js'
import type { RuntimeService } from '../../runtimeService.js'
import type { ServerConfig } from '../../types.js'

const servers: http.Server[] = []

afterEach(async () => {
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  servers.length = 0
})

function listen(server: http.Server): Promise<string> {
  servers.push(server)
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Unexpected server address')
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

async function readJsonRequest(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

function createConfig(baseUrl: string): ServerConfig {
  return {
    rootDir: '/tmp/moss-cabin-seat-context-test',
    workspace: '/tmp/moss-cabin-seat-context-test/workspace',
    defaultRuntime: 'host',
    cabin: {
      enabled: true,
      contextMode: 'seat',
      tokenSecret: 'unused-in-seat-mode',
      tokenTtlSeconds: 7200,
      passengerInfoPrivacyLevel: 2,
      passengerInfoUrl: `${baseUrl}/admin-api/cabin/tablet-login/get-seat-context`,
      passengerInfoAuth: 'test1',
      asrUrl: `${baseUrl}/asr`,
      asrModel: 'asr',
      ttsUrl: `${baseUrl}/tts`,
      ttsModel: 'tts',
      ttsVoice: 'voice',
      ttsLanguage: 'zh',
      llmBaseUrl: `${baseUrl}/v1`,
      llmModel: 'llm',
      controlBaseUrl: baseUrl,
      controlTimeoutMs: 1_000,
      automationEnabled: false,
      healthReportEnabled: true,
      healthReportCollectSeconds: 30,
      healthReportMinSamples: 1,
      assistantName: 'cabin-ai-flight-attendant',
      createMossSession: false,
      replyTimeoutMs: 45_000,
      sessionRecoveryEnabled: true,
      sessionRecoveryMaxAttempts: 1,
      contextReplayTurns: 20,
      flightStateDemoEnabled: false,
      logEnabled: false,
    },
  } as unknown as ServerConfig
}

async function startCabinServer(baseUrl: string, overrides: Partial<ServerConfig['cabin']> = {}): Promise<{
  cabinBaseUrl: string
  db: DatabaseSync
}> {
  const db = new Database(':memory:') as unknown as DatabaseSync
  const runtime = {
    store: { db },
    authService: { listAllOrganizations: () => ({ organizations: [{ id: 'org-1' }] }) },
  } as unknown as RuntimeService
  const config = createConfig(baseUrl)
  Object.assign(config.cabin, overrides)
  const api = createCabinApi({ config, runtime })
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname
    const handled = await api.handle(req, res, pathname)
    if (!handled) {
      res.writeHead(404)
      res.end()
    }
  })
  return { cabinBaseUrl: await listen(server), db }
}

const seatHeaders = {
  'x-cabin-aircraft-no': 'B-WITHFLIGHT-01',
  'x-cabin-seat-no': '01A',
}

describe('cabin seat context mode', () => {
  it('never turns compact free text into a receipt or inferred tool event, including a real negative-command failure', async () => {
    let modelReply = ''
    let modelCalls = 0
    let hardwareCalls = 0
    const upstream = http.createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://localhost')
      res.setHeader('content-type', 'application/json')
      if (url.pathname.endsWith('get-seat-context')) {
        return res.end(JSON.stringify({ code: 0, data: { flightId: '1', flightDate: '2026-11-24', seatNo: '01A', tabletId: 'pad', passengerRef: 'p' } }))
      }
      if (url.pathname.endsWith('/chat/completions')) {
        modelCalls++
        return res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: modelReply } }] }))
      }
      hardwareCalls++
      res.writeHead(500)
      res.end()
    })
    const base = await listen(upstream)
    for (const conversationLanguageMode of ['legacy', 'enabled'] as const) {
      const { cabinBaseUrl, db } = await startCabinServer(base, {
        conversationLanguageMode, createMossSession: true, controlBaseUrl: undefined,
        conversationSeatAudioEnabled: false,
      })
      // No runtime.createSession is provided: compact must not create a runner.
      for (const [text, reply, expected] of [
        ['不要打开阅读灯', '好的，已为您关闭阅读灯。', '没有执行设备操作。'],
        ['请调整一下灯光', '已将阅读灯打开。', '没有执行设备操作。'],
        ['请调整一下灯光', '此工具无法执行操作。', '此工具无法执行操作。'],
        ['请调整一下灯光', '您想调亮还是调暗阅读灯？', '您想调亮还是调暗阅读灯？'],
      ]) {
        modelReply = reply!
        const result = await fetch(`${cabinBaseUrl}/v1/ai-chat/send`, {
          method: 'POST', headers: { ...seatHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({ content: text, source: 'text' }),
        })
        expect(result.status).toBe(200)
        const events = (await result.text()).trim().split(/\n\n+/).map(chunk => ({
          event: chunk.match(/^event:\s*(.+)$/m)?.[1],
          data: JSON.parse(chunk.match(/^data:\s*(.+)$/m)?.[1] || '{}'),
        }))
        expect(events.map(event => event.event)).toEqual(['start', 'delta', 'done'])
        expect(events.find(event => event.event === 'delta')?.data.content).toBe(expected)
        expect(events.at(-1)?.data.reply_text).toBe(expected)
        expect(events.at(-1)?.data.slots).toEqual({})
        const stored = db.prepare("SELECT content, tool_calls_json FROM cabin_messages WHERE role='assistant' ORDER BY rowid DESC LIMIT 1").get() as { content: string; tool_calls_json: string | null }
        expect(stored.content).toBe(expected)
        expect(stored.tool_calls_json).toBeNull()
      }
    }
    // Enabled language routing rejects the negative request before the model;
    // legacy mode exercises the exact free-text failure observed in the smoke.
    expect(modelCalls).toBe(7)
    expect(hardwareCalls).toBe(0)
  })

  it('records four independent HTTP arrivals before the bodies finish and joins each to its error response', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'moss-cabin-ingress-'))
    const logFile = join(directory, 'cabin.jsonl')
    const sockets: Socket[] = []
    type Entry = { type: string; path: string; request_id: string; status?: number; details?: { phase?: string; upstream_request_id?: string; content_length?: number } }
    const waitForRows = async (type: string, count: number) => {
      for (let attempt = 0; attempt < 150; attempt++) {
        const log = await readFile(logFile, 'utf8').catch(() => '')
        const rows: Entry[] = log.split('\n').slice(0, -1).map(line => JSON.parse(line))
        if (rows.filter(row => row.type === type).length >= count) return rows
        await Bun.sleep(10)
      }
      throw new Error(`Missing ${count} ${type} records`)
    }
    try {
      const { cabinBaseUrl } = await startCabinServer('http://127.0.0.1:1', { logEnabled: true, logFile })
      const upstream = 'c96c4564-a24a-4c6d-8c7f-fbf90f437f35'
      const body = '{"ignored":"private-body"}'
      const replies = Array.from({ length: 4 }, () => {
        const socket = connect(Number(new URL(cabinBaseUrl).port), '127.0.0.1')
        sockets.push(socket)
        socket.setEncoding('utf8')
        const response = new Promise<string>((resolve, reject) => {
          let reply = ''
          socket.on('data', chunk => { reply += chunk })
          socket.on('end', () => resolve(reply))
          socket.on('error', reject)
        })
        socket.write(['POST /v1/ai-chat/send?private-query HTTP/1.1', 'Host: localhost', 'Connection: close',
          `X-Request-Id: ${upstream}`, 'Authorization: Bearer private-token', 'X-Cabin-Aircraft-No: test', 'X-Cabin-Seat-No: A',
          'Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`, '', body.slice(0, 1)].join('\r\n'))
        return response
      })
      const early = await waitForRows('inbound_start', 4)
      expect(early).toHaveLength(4)
      const ids = early.map(row => row.request_id).sort()
      expect(new Set(ids).size).toBe(4)
      for (const row of early) {
        expect(row.request_id).not.toBe(upstream)
        expect(row).toMatchObject({ type: 'inbound_start', method: 'POST', path: '/v1/ai-chat/send', details: { phase: 'request.accepted', upstream_request_id: upstream, content_length: body.length } })
        expect(row.status).toBeUndefined()
      }
      for (const socket of sockets) socket.write(body.slice(1))
      const responseIds = (await Promise.all(replies)).map(reply => {
        expect(reply).toContain('MISSING_CONTENT')
        return /^x-request-id:\s*([^\r\n]+)/im.exec(reply)?.[1]
      })
      expect(responseIds.sort()).toEqual(ids)
      const dynamic = await fetch(`${cabinBaseUrl}/v1/health-reports/private-path`, { headers: { 'x-request-id': 'private-invalid-id' } })
      await dynamic.text()
      const other = await fetch(`${cabinBaseUrl}/v1/not-a-cabin-route`)
      expect(other.status).toBe(404)
      const final = await waitForRows('inbound', 5)
      const chats = final.filter(row => row.path === '/v1/ai-chat/send')
      expect(chats.filter(row => row.type === 'inbound_start')).toHaveLength(4)
      expect(chats.filter(row => row.type === 'inbound' && row.status === 400).map(row => row.request_id).sort()).toEqual(ids)
      const otherStarts = final.filter(row => row.type === 'inbound_start' && row.path !== '/v1/ai-chat/send')
      expect(otherStarts.map(row => row.path)).toEqual(['/v1/health-reports/:id'])
      expect(JSON.stringify(final.filter(row => row.type === 'inbound_start'))).not.toContain('private-')
    } finally {
      for (const socket of sockets) socket.destroy()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('correlates ASR, an order receipt and SSE writes without logging turn text in stages', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'moss-cabin-trace-'))
    const logFile = join(directory, 'cabin.jsonl')
    const content = '请给我一杯可乐'
    let orders = 0
    const upstream = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/asr') return res.end(JSON.stringify({ text: content }))
      if (req.url?.endsWith('/service-order/create')) { orders++; return res.end(JSON.stringify({ code: 0, data: 321 })) }
      res.end(JSON.stringify({ code: 0, data: { tabletId: 'pad', flightId: '1', flightDate: '2026-11-20', tabletAccessToken: 'private-fixture-token', passenger: { passengerRef: 'p' } } }))
    })
    try {
      const base = await listen(upstream)
      const { cabinBaseUrl } = await startCabinServer(base, { logFile, logEnabled: true, conversationLanguageMode: 'legacy' })
      const body = new FormData(); body.set('audio', new Blob(['audio-fixture']), 'test.wav')
      const voice = await fetch(`${cabinBaseUrl}/v1/voice/query`, { method: 'POST', headers: seatHeaders, body })
      expect((await voice.json()).text).toBe(content)
      const chat = await fetch(`${cabinBaseUrl}/v1/ai-chat/send`, { method: 'POST', headers: { ...seatHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ content }) })
      expect(await chat.text()).toContain('event: done')
      expect(orders).toBe(1)
      type Row = { type: string; request_id: string; upstream?: string; details: { phase: string; text_ref?: string; order_id?: string } }
      let rows: Row[] = []
      for (let tries = 0; tries < 100; tries++) {
        const text = await readFile(logFile, 'utf8').catch(() => '')
        rows = text.split('\n').slice(0, -1).map(line => JSON.parse(line) as Row)
        if (rows.filter(row => row.type === 'inbound').length === 2 && rows.some(row => row.details?.phase === 'sse.done') && rows.some(row => row.details?.phase === 'order.receipt')) break
        await Bun.sleep(10)
      }
      for (const [response, upstream] of [[voice, 'asr'], [chat, 'service-order']] as const) {
        const chain = rows.filter(row => row.request_id === response.headers.get('x-request-id'))
        expect(chain.filter(row => row.type === 'inbound_start')).toHaveLength(1)
        expect(chain.filter(row => row.type === 'outbound' && row.upstream === upstream)).toHaveLength(1)
        expect(chain.filter(row => row.type === 'inbound')).toHaveLength(1)
      }
      const stages = rows.filter(row => row.type === 'stage')
      const forChat = stages.filter(row => row.request_id === chat.headers.get('x-request-id'))
      expect(forChat.filter(row => row.details.phase === 'sse.first_text')).toHaveLength(1)
      expect(forChat.find(row => row.details.phase === 'order.receipt')?.details.order_id).toBe('321')
      const ref = stages.find(row => row.request_id === voice.headers.get('x-request-id') && row.details.phase === 'asr.ready')?.details.text_ref
      expect(ref).toMatch(/^[a-f0-9]{24}$/)
      expect(forChat.find(row => row.details.phase === 'chat.ready')?.details.text_ref).toBe(ref)
      expect(JSON.stringify(stages)).not.toContain(content)
      expect(JSON.stringify(stages)).not.toContain('private-fixture-token')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('can shadow real labels without changing the legacy voice response', async () => {
    const upstream = http.createServer((req,res) => {
      res.setHeader('content-type','application/json')
      if (req.url === '/asr') return res.end(JSON.stringify({text:'Guten Tag',language:['German']}))
      res.end(JSON.stringify({code:0,data:{flightId:'1',flightDate:'2026-11-20',tabletId:'pad',passenger:{passengerRef:'p',language:'zh-CN'}}}))
    })
    const base = await listen(upstream)
    for (const mode of ['shadow','legacy'] as const) {
      const {cabinBaseUrl,db} = await startCabinServer(base,{conversationLanguageMode:mode})
      const form = new FormData(); form.set('audio',new Blob(['test']),'test.wav')
      const result = await fetch(`${cabinBaseUrl}/v1/voice/query`,{method:'POST',headers:seatHeaders,body:form})
      expect(await result.json()).toMatchObject({language:'zh',text:'Guten Tag'})
      const rows = db.prepare('SELECT language FROM cabin_language_hints').all()
      expect(rows).toEqual(mode === 'shadow' ? [{language:'de'}] : [])
    }
  })
  it('switches languages with default settings on the unchanged two-request contract without calling a model for direct commands', async () => {
    const turns: Array<[SpokenLanguage, string]> = [
      ['zh','请打开阅读灯'], ['de','Schalten Sie die Leselampe ein.'], ['ja','読書灯をつけてください。'], ['zh','关闭阅读灯'],
      ['en','Turn on the reading light.'], ['fr','Allumez la liseuse.'], ['it','Accendi la luce di lettura.'],
      ['es','Enciende la luz de lectura.'], ['pt','Acenda a luz de leitura.'], ['ko','독서등을 켜 주세요.'], ['ru','Включите лампу для чтения.'],
    ]
    let recording: Record<string, unknown> = {}
    let businessCode = 0
    let ttsFails = false
    let ttsGate: Promise<void> | undefined
    let statusData: Record<string, unknown> = { on:false }
    let llmText = 'Bonjour !'
    const controls: string[] = [], audio: Record<string,unknown>[] = [], pushes: string[] = [], prompts: string[] = [], formats: string[] = [], statusReads: string[] = []
    const modelContexts: unknown[] = []
    const upstream = http.createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://localhost')
      res.setHeader('content-type','application/json')
      if (url.pathname.endsWith('get-seat-context')) return res.end(JSON.stringify({ code:0, data:{ flightId:'1', flightDate:'2026-11-20', seatNo:'01A', tabletId:'pad', passenger:{ passengerRef:'p',language:'zh-CN' } } }))
      if (url.pathname === '/asr') {
        const parts: Buffer[] = []; for await (const part of req) parts.push(part)
        const form = await new Response(Buffer.concat(parts), { headers:{ 'content-type':req.headers['content-type']! } }).formData()
        formats.push(`${form.get('response_format')}:${form.get('language')}`)
        return res.end(JSON.stringify(recording))
      }
      if (url.pathname.includes('/cmd/')) { controls.push(url.pathname); return res.end(JSON.stringify({code:businessCode})) }
      if (url.pathname === '/admin-api/tcp/hardware/status') { statusReads.push(url.pathname); return res.end(JSON.stringify({code:0,data:{data:statusData}})) }
      if (url.pathname === '/tts') {
        await ttsGate
        audio.push(await readJsonRequest(req)); res.writeHead(ttsFails ? 503 : 200,{'content-type':'audio/wav'}); return res.end('RIFF-test')
      }
      if (url.pathname.endsWith('/audio-seat')) { pushes.push(url.pathname); return res.end(JSON.stringify({code:0,data:{sentCount:1,matchedCount:1}})) }
      if (url.pathname.endsWith('/chat/completions')) {
        const body = await readJsonRequest(req); prompts.push((body.messages as Array<{content:string}>)[0]!.content)
        modelContexts.push(JSON.parse((body.messages as Array<{content:string}>)[1]!.content))
        return res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:llmText}}]}))
      }
      res.writeHead(404); res.end()
    })
    const base = await listen(upstream)
    const { cabinBaseUrl, db } = await startCabinServer(base, { conversationSeatAudioEnabled:true,
      broadcastApiBaseUrl:base, broadcastEnabled:true, broadcastApiKey:'test' })
    const asr = async () => {
      const form = new FormData(); form.set('audio', new Blob(['test']), 'test.wav')
      const result = await fetch(`${cabinBaseUrl}/v1/voice/query`, {method:'POST',headers:seatHeaders,body:form})
      return result.json()
    }
    const chat = async (content: string, language?: string) => {
      const result = await fetch(`${cabinBaseUrl}/v1/ai-chat/send`, {method:'POST',headers:{...seatHeaders,'content-type':'application/json'},body:JSON.stringify({content,language})})
      const events = (await result.text()).split('\n\n').filter(block => block.startsWith('event:')).map(block => {
        const [event,data] = block.split('\n'); return {event:event!.slice(7),data:JSON.parse(data!.slice(6))}
      })
      const done = events.find(item => item.event === 'done')?.data
      expect(done).toBeDefined()
      expect(events.filter(item => item.event === 'delta').map(item => item.data.content).join('')).toBe(done.reply_text)
      const stored = db.prepare("SELECT content FROM cabin_messages WHERE role='assistant' ORDER BY rowid DESC LIMIT 1").get() as {content:string}
      expect(stored.content).toBe(done.reply_text)
      return done
    }
    for (const [code,text] of turns) {
      recording = {text,language:[languageNames[code]],segments:[{language:languageNames[code]}]}
      const transcription = await asr(); expect(transcription.language).toBe(code)
      const done = await chat(transcription.text)
      expect(done.slots.execution_status).toBe('dispatched'); expect(done.audio_playback.status).toBe('sent')
      expect(audio.at(-1)).toMatchObject({input:done.reply_text,lang_code:languageNames[code],voice:'Vivian'})
      if (code !== 'zh' && code !== 'ja') expect(done.reply_text).not.toMatch(/\p{Script=Han}/u)
    }
    expect(controls).toHaveLength(turns.length); expect(audio).toHaveLength(turns.length); expect(pushes).toHaveLength(turns.length)
    expect(formats).toEqual(turns.map(()=>'verbose_json:null')); expect(prompts).toHaveLength(0)
    businessCode = 123; ttsFails = true
    const failed = await chat('Schalte die Leselampe ein.', 'de')
    expect(failed.slots.execution_status).toBe('failed'); expect(failed.reply_text).toContain('fehlgeschlagen'); expect(failed.audio_playback.status).toBe('failed')
    ttsFails = false
    expect((await chat('Schalte die Leselampe nicht ein.', 'de')).reply_text).toContain('kein Gerätebefehl')
    expect((await chat('Is the reading light on?', 'en')).reply_text).toBe('The reading light is off.')
    statusData = {}; const blocked = await chat('テーブルを閉じてください。','ja'); expect(blocked.slots.execution_status).toBe('blocked'); expect(blocked.reply_text).toContain('確認できない')
    expect(statusReads).toHaveLength(2); expect(controls).toHaveLength(turns.length+1); expect(prompts).toHaveLength(0)
    recording = {text:'42',language:['French']}; await asr()
    expect((await chat('42','zh')).reply_text).toBe('Bonjour !')
    expect(modelContexts.at(-1)).toMatchObject({ cabin_context: { reply_language: 'fr' } })
    recording = {text:'What can you do?'}; expect((await asr()).language).toBe('unknown')
    llmText = '收到，我会为您处理。'; expect((await chat('What can you do?','zh')).reply_text).toBe('Please clarify your request.')
    const before = audio.length; recording = {text:'สวัสดี',language:['Thai']}; await asr(); llmText = 'สวัสดีครับ'
    const thai = await chat('สวัสดี'); expect(thai.reply_text).toBe(llmText); expect(thai.audio_playback.status).toBe('skipped'); expect(audio).toHaveLength(before)
    businessCode = 0
    const beforeOffer = controls.length
    await chat('Set seat heating to level 8.','en'); expect(controls).toHaveLength(beforeOffer)
    expect((await chat('我有点冷')).reply_text).toContain('座椅加热吗')
    recording = {text:'Ja',language:['German']}; await asr()
    const confirmed = await chat('Ja'); expect(confirmed.slots.command).toBe('seat.heating'); expect(confirmed.reply_text).toContain('Sitzheizung')
    await chat('Ja','de'); expect(controls.length).toBe(beforeOffer+1)
    await chat('Wenn es dunkel wird, schalte das Leselicht ein.','de'); expect(controls.length).toBe(beforeOffer+1)
    let release!: () => void
    ttsGate = new Promise<void>(resolve => { release = resolve })
    try {
      const response = await fetch(`${cabinBaseUrl}/v1/ai-chat/send`, {method:'POST',headers:{...seatHeaders,'content-type':'application/json'},body:JSON.stringify({content:'Turn off the reading light.'}),signal:AbortSignal.timeout(2000)})
      const reader = response.body!.getReader(); const decoder = new TextDecoder(); let sse = ''
      while (!sse.includes('event: delta')) {
        const part = await reader.read(); if (part.done) break; sse += decoder.decode(part.value,{stream:true})
      }
      expect(sse).toContain('turn off your reading light'); expect(sse).not.toContain('event: done')
      release()
      for (;;) { const part = await reader.read(); if (part.done) break; sse += decoder.decode(part.value,{stream:true}) }
      expect(sse.match(/event: delta/g)).toHaveLength(1); expect(sse.match(/event: done/g)).toHaveLength(1)
    } finally { release(); ttsGate = undefined }
    recording = {text:' '}; expect((await asr()).code).toBe('ASR_NO_SPEECH')
  })
  it('uses UE aircraft and seat headers across the complete local workflow', async () => {
    const contextRequests: Array<{
      method: string
      aircraftNo: string | null
      seatNo: string | null
      query: string
      authorization: string | undefined
      contentType: string | undefined
      tabletToken: string | undefined
    }> = []
    const controlTargets: string[] = []
    const upstream = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost')
      if (url.pathname === '/admin-api/cabin/tablet-login/get-seat-context') {
        const body = await readJsonRequest(req)
        contextRequests.push({
          method: req.method || '',
          aircraftNo: typeof body.aircraftNo === 'string' ? body.aircraftNo : null,
          seatNo: typeof body.seatNo === 'string' ? body.seatNo : null,
          query: url.search,
          authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
          contentType: typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : undefined,
          tabletToken: typeof req.headers['x-cabin-tablet-token'] === 'string'
            ? req.headers['x-cabin-tablet-token']
            : undefined,
        })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          code: 0,
          msg: '',
          data: {
            bindingId: 3936,
            tabletId: 'PAX-PAD-001',
            tabletType: 'passenger',
            aircraftId: 2,
            aircraftNo: 'SHOULD-NOT-OVERRIDE-HEADER',
            aircraftSeatId: 20,
            seatNo: 'SHOULD-NOT-OVERRIDE-HEADER',
            columnNo: 'A',
            contextStatus: 'IGNORED',
            flightId: 2,
            flightSeatId: 20,
            flight: {
              flightId: 2,
              flightNo: 'CA8888',
              flightDate: '2026-06-05',
            },
            passenger: {
              passengerRef: 'REF-01A-2',
              displayName: '  ',
              gender: 'MALE',
              language: 'zh-CN',
            },
            tabletAccessToken: 'must-not-be-used',
          },
        }))
        return
      }
      if (url.pathname === '/asr') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ text: '请帮我打开阅读灯' }))
        return
      }
      if (url.pathname === '/tts') {
        res.writeHead(200, { 'content-type': 'audio/wav' })
        res.end(Buffer.from('RIFF....WAVE'))
        return
      }
      if (url.pathname === '/admin-api/tcp-client/cmd/seat/light') {
        controlTargets.push(url.searchParams.get('seatNo') || '')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 0, msg: '' }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    const upstreamBaseUrl = await listen(upstream)
    const { cabinBaseUrl, db } = await startCabinServer(upstreamBaseUrl)

    const authResponse = await fetch(`${cabinBaseUrl}/v1/auth/token`, { method: 'POST' })
    expect(authResponse.status).toBe(404)
    expect(await authResponse.json()).toMatchObject({ code: 'AUTH_TOKEN_DISABLED' })

    const form = new FormData()
    form.set('audio', new Blob([Buffer.from('RIFF....WAVE')], { type: 'audio/wav' }), 'passenger.wav')
    form.set('language', 'auto')
    const voiceResponse = await fetch(`${cabinBaseUrl}/v1/voice/query`, {
      method: 'POST',
      headers: seatHeaders,
      body: form,
    })
    expect(voiceResponse.status).toBe(200)
    expect(await voiceResponse.json()).toMatchObject({
      status: 'ok',
      seat_id: '01A',
      language: 'unknown',
      text: '请帮我打开阅读灯',
    })

    const chatResponse = await fetch(`${cabinBaseUrl}/v1/ai-chat/send`, {
      method: 'POST',
      headers: { ...seatHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ content: '请帮我打开阅读灯', source: 'voice', language: 'zh' }),
    })
    expect(chatResponse.status).toBe(200)
    expect(await chatResponse.text()).toContain('event: done')
    expect(controlTargets).toEqual(['01A'])

    const historyResponse = await fetch(`${cabinBaseUrl}/v1/ai-chat/history?limit=10`, {
      headers: seatHeaders,
    })
    expect(historyResponse.status).toBe(200)
    const history = await historyResponse.json() as { messages: unknown[] }
    expect(history.messages.length).toBeGreaterThanOrEqual(2)

    const speechResponse = await fetch(`${cabinBaseUrl}/v1/tts/speech`, {
      method: 'POST',
      headers: { ...seatHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '已为您打开阅读灯。' }),
    })
    expect(speechResponse.status).toBe(200)
    expect(speechResponse.headers.get('content-type')).toBe('audio/wav')

    const startResponse = await fetch(`${cabinBaseUrl}/v1/health-reports/start`, {
      method: 'POST',
      headers: { ...seatHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ language: 'zh' }),
    })
    expect(startResponse.status).toBe(200)
    const started = await startResponse.json() as { report_id: string; seat_no: string }
    expect(started.seat_no).toBe('01A')

    const reportResponse = await fetch(`${cabinBaseUrl}/v1/health-reports/${started.report_id}`, {
      headers: seatHeaders,
    })
    expect(reportResponse.status).toBe(200)
    expect(await reportResponse.json()).toMatchObject({
      report_id: started.report_id,
      report_status: 'collecting',
      seat_no: '01A',
    })

    const resetResponse = await fetch(`${cabinBaseUrl}/v1/ai-chat/reset`, {
      method: 'POST',
      headers: seatHeaders,
    })
    expect(resetResponse.status).toBe(200)
    expect(await resetResponse.json()).toEqual({ status: 'ok', cleared: true })

    expect(contextRequests.length).toBeGreaterThanOrEqual(7)
    expect(contextRequests).toEqual(contextRequests.map(() => ({
      method: 'POST',
      aircraftNo: 'B-WITHFLIGHT-01',
      seatNo: '01A',
      query: '',
      authorization: 'test1',
      contentType: 'application/json',
      tabletToken: undefined,
    })))

    const seats = new CabinStore(db).listManagedSeats()
    expect(seats).toHaveLength(1)
    expect(seats[0]).toMatchObject({
      aircraftNo: 'B-WITHFLIGHT-01',
      flightId: '2',
      flightDate: '2026-06-05',
      seatNo: '01A',
      tabletId: 'PAX-PAD-001',
    })
  })

  it('returns explicit seat header and upstream response errors', async () => {
    const upstream = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost')
      if (url.pathname !== '/admin-api/cabin/tablet-login/get-seat-context') {
        res.writeHead(404)
        res.end()
        return
      }
      const body = await readJsonRequest(req)
      const seatNo = typeof body.seatNo === 'string' ? body.seatNo : undefined
      res.writeHead(200, { 'content-type': 'application/json' })
      if (seatNo === 'REJECT') {
        res.end(JSON.stringify({ code: 41001, msg: 'seat is not bound', data: null }))
        return
      }
      res.end(JSON.stringify({
        code: 0,
        data: {
          flightId: 2,
          flight: { flightDate: '2026-06-05' },
          passenger: {},
        },
      }))
    })
    const upstreamBaseUrl = await listen(upstream)
    const { cabinBaseUrl } = await startCabinServer(upstreamBaseUrl)

    const missingHeaderResponse = await fetch(`${cabinBaseUrl}/v1/ai-chat/history`, {
      headers: { 'x-cabin-aircraft-no': 'B-WITHFLIGHT-01' },
    })
    expect(missingHeaderResponse.status).toBe(400)
    expect(await missingHeaderResponse.json()).toMatchObject({ code: 'MISSING_SEAT_NO' })

    const rejectedResponse = await fetch(`${cabinBaseUrl}/v1/ai-chat/history`, {
      headers: { ...seatHeaders, 'x-cabin-seat-no': 'REJECT' },
    })
    expect(rejectedResponse.status).toBe(502)
    expect(await rejectedResponse.json()).toMatchObject({
      code: 'SEAT_CONTEXT_FAILED',
      message: 'seat is not bound',
    })

    const invalidResponse = await fetch(`${cabinBaseUrl}/v1/ai-chat/history`, {
      headers: { ...seatHeaders, 'x-cabin-seat-no': 'INVALID' },
    })
    expect(invalidResponse.status).toBe(502)
    expect(await invalidResponse.json()).toMatchObject({
      code: 'SEAT_CONTEXT_INVALID',
      message: 'Seat context response missing passengerRef',
    })
  })

  it('keeps 16 concurrent tablet seats and conversations isolated', async () => {
    const seenSeats: string[] = []
    const upstream = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost')
      if (url.pathname !== '/admin-api/cabin/tablet-login/get-seat-context') {
        res.writeHead(404)
        res.end()
        return
      }
      const body = await readJsonRequest(req)
      const seatNo = typeof body.seatNo === 'string' ? body.seatNo : ''
      seenSeats.push(seatNo)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        code: 0,
        data: {
          tabletId: `PAD-${seatNo}`,
          seatNo: 'IGNORED',
          flightId: 2,
          flight: { flightDate: '2026-06-05' },
          passenger: { passengerRef: `REF-${seatNo}-2`, language: 'zh-CN' },
        },
      }))
    })
    const upstreamBaseUrl = await listen(upstream)
    const { cabinBaseUrl, db } = await startCabinServer(upstreamBaseUrl)
    const seats = Array.from({ length: 16 }, (_, index) => `SEAT-${String(index + 1).padStart(2, '0')}`)

    const responses = await Promise.all(seats.map(seatNo => fetch(`${cabinBaseUrl}/v1/ai-chat/history?limit=1`, {
      headers: {
        'x-cabin-aircraft-no': 'B-WITHFLIGHT-01',
        'x-cabin-seat-no': seatNo,
      },
    })))
    expect(responses.map(response => response.status)).toEqual(seats.map(() => 200))
    expect(seenSeats.sort()).toEqual([...seats].sort())

    const managedSeats = new CabinStore(db).listManagedSeats()
    expect(managedSeats).toHaveLength(16)
    expect(managedSeats.map(seat => seat.seatNo).sort()).toEqual([...seats].sort())
    const conversationCount = db.prepare('SELECT COUNT(*) AS count FROM cabin_conversations').get() as { count: number }
    expect(conversationCount.count).toBe(16)
  })

  it('isolates seat-mode conversations by aircraft, flight date, seat, and passenger', () => {
    const base: CabinPassengerContext = {
      contextMode: 'seat',
      aircraftNo: 'B-WITHFLIGHT-01',
      flightId: '2',
      flightDate: '2026-06-05',
      seatId: 'A',
      passengerRef: 'REF-A-2',
      tabletId: 'PAX-PAD-001',
    }
    const key = buildConversationKey(base)
    expect(buildConversationKey({ ...base })).toBe(key)
    expect(buildConversationKey({ ...base, aircraftNo: 'B-WITHFLIGHT-02' })).not.toBe(key)
    expect(buildConversationKey({ ...base, flightDate: '2026-06-06' })).not.toBe(key)
    expect(buildConversationKey({ ...base, seatId: 'B' })).not.toBe(key)
    expect(buildConversationKey({ ...base, passengerRef: 'REF-B-2' })).not.toBe(key)

    const legacy = { ...base, contextMode: 'tablet-token' as const }
    expect(buildConversationKey({ ...legacy, seatId: 'B' })).toBe(buildConversationKey(legacy))
  })
})
