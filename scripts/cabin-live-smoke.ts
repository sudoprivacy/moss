/** Real model smoke; all context, device and broadcast requests terminate locally.
 * Run with Bun. Required: CABIN_SMOKE_LLM_URL, CABIN_SMOKE_TTS_URL,
 * CABIN_SMOKE_LLM_MODEL, CABIN_SMOKE_TTS_MODEL. Uses no production app config.
 */
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { createCabinApi } from '../src/server/cabin/api.js'
import { serverFileConfigSchema } from '../src/server/types.js'
import type { ServerConfig } from '../src/server/types.js'
import type { RuntimeService } from '../src/server/runtimeService.js'

const required = (key: string) => { const value = process.env[key]; if (!value) throw new Error(`Missing ${key}`); return value }
const llmUrl = required('CABIN_SMOKE_LLM_URL')
const ttsUrl = required('CABIN_SMOKE_TTS_URL')
const llmModel = required('CABIN_SMOKE_LLM_MODEL')
const ttsModel = required('CABIN_SMOKE_TTS_MODEL')
const maskedPassenger = process.env.CABIN_SMOKE_MASKED_NAME === '1'
const dialogueMode = process.env.CABIN_SMOKE_DIALOGUE_MODE ?? 'compact'
if (!['compact', 'assistant-context', 'assistant-short'].includes(dialogueMode)) throw new Error('Unsupported smoke dialogue mode')
for (const endpoint of [llmUrl, ttsUrl]) {
  const url = new URL(endpoint)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Smoke endpoints must use localhost SSH forwards')
}
const rootDir = await mkdtemp(join(tmpdir(), 'cabin-live-smoke-'))
const db = new Database(':memory:')
let broadcasts = 0, controls = 0, statusQueries = 0, orderCalls = 0
const hashes: string[] = []
const mock = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url!, 'http://localhost')
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks)
    let data: unknown
    if (url.pathname.endsWith('/get-seat-context')) {
      data = { code: 0, data: { aircraftNo: 'B-SMOKE', seatNo: '01A', flightId: 'SMOKE',
        ...(maskedPassenger ? { passengerName: 'XX', passengerGender: 'male' } : process.env.CABIN_SMOKE_DIALOGUE_MODE ? { passengerName: '林', passengerGender: 'female' } : {}),
        flight: { flightNo: 'SMOKE', flightDate: '2026-11-24' },
        passenger: { passengerRef: 'SMOKE', language: 'zh-CN' }, tabletAccessToken: 'local-smoke-only' } }
    } else if (url.pathname.endsWith('/audio-seat')) {
      const form = await new Response(body, { headers: { 'content-type': String(req.headers['content-type']) } }).formData()
      const file = form.get('file') as File
      hashes.push(createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex'))
      broadcasts++
      data = { code: 0, data: { requestId: `smoke-${broadcasts}`, matchedCount: 1, sentCount: 1 } }
    } else if (url.pathname.endsWith('/hardware/status')) {
      statusQueries++
      data = { code: 0, data: { data: statusQueries === 1 ? { position: 40 } : {} } }
    } else if (url.pathname.includes('/service-order/')) {
      orderCalls++; data = { code: 0, data: [] }
    } else if (url.pathname.startsWith('/admin-api/')) {
      controls++; data = { code: 0, data: true }
    } else { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data))
  } catch { res.writeHead(500); res.end() }
})
const listen = (server: http.Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => {
  const address = server.address() as { port: number }; resolve(`http://127.0.0.1:${address.port}`)
}))
let cabin: http.Server | undefined
try {
  const mockUrl = await listen(mock)
  const settings = serverFileConfigSchema().parse({ cabin: {
    enabled: true, contextMode: 'seat', dialogueMode, assistantName: process.env.CABIN_ASSISTANT_NAME, createMossSession: true,
    shortRulesPrewarm: process.env.CABIN_SMOKE_PREWARM === '1',
    passengerInfoUrl: `${mockUrl}/admin-api/cabin/tablet-login/get-seat-context`,
    controlBaseUrl: mockUrl, broadcastApiBaseUrl: mockUrl, broadcastApiKey: 'local-mock',
    broadcastEnabled: true, conversationSeatAudioEnabled: true,
    llmBaseUrl: llmUrl, llmModel, ttsUrl, ttsModel,
    ttsGeneration: { seed: 42, maxTokens: 1024 }, ttsDeterministicRequired: true,
    automationEnabled: false, healthReportEnabled: false, logEnabled: false,
  } }).cabin
  let agentCreations = 0
  const runtime = { store: { db }, authService: { listAllOrganizations: () => ({ organizations: [{ id: 'smoke' }] }) },
    createSession: () => { agentCreations++; throw new Error('Compact mode must not create Agent') } } as unknown as RuntimeService
  const api = createCabinApi({ config: { rootDir, cabin: settings } as ServerConfig, runtime })
  await api.prepareShortDialogue()
  if (controls || statusQueries || orderCalls || broadcasts || agentCreations) throw new Error('Prewarm side effect')
  cabin = http.createServer(async (req, res) => {
    if (!await api.handle(req, res, new URL(req.url!, 'http://localhost').pathname)) { res.writeHead(404); res.end() }
  })
  const cabinUrl = await listen(cabin)
  const outcomes: Array<Record<string, unknown>> = []
  const comparisonTurns = process.env.CABIN_SMOKE_DIALOGUE_MODE ? ['您怎么称呼我？', '眼睛快睁不开了，想眯一会儿', '需要'] : []
  const massageTurns = dialogueMode === 'assistant-short' ? ['坐久了腰背有点僵，想舒服一点', '不用了，先保持这样', '坐久了腰背有点僵，想舒服一点', '取消可乐订单'] : []
  for (const text of ['你好', '你好。', '你是谁？', '帮我调整至办公模式。', '请查看当前座椅角度。', '请再查看当前座椅角度。', '不要打开阅读灯', '你好，请介绍一下你的功能', ...comparisonTurns, ...massageTurns]) {
    const before = { controls, broadcasts, orderCalls }, started = performance.now()
    const response = await fetch(`${cabinUrl}/v1/ai-chat/send`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cabin-aircraft-no': 'B-SMOKE', 'x-cabin-seat-no': '01A' },
      body: JSON.stringify({ content: text, source: 'text' }), signal: AbortSignal.timeout(60000) })
    if (!response.ok) throw new Error(`Smoke HTTP ${response.status}`)
    const reader = response.body!.getReader(), decoder = new TextDecoder()
    let stream = '', firstDeltaMs: number | undefined
    for (;;) {
      const next = await reader.read(); if (next.done) break
      stream += decoder.decode(next.value, { stream: true })
      if (firstDeltaMs === undefined && stream.includes('event: delta')) firstDeltaMs = Math.round(performance.now() - started)
    }
    if (!stream.includes('event: done') || stream.includes('event: error') || !stream.includes('"status":"sent"')) throw new Error(`Smoke incomplete: ${stream}`)
    const events = stream.split(/\n\n/).filter(Boolean).map(block => ({
      event: block.match(/^event: (.+)$/m)?.[1], data: JSON.parse(block.match(/^data: (.+)$/m)?.[1] ?? '{}'),
    }))
    const reply = events.filter(event => event.event === 'delta').map(event => event.data.content).join('')
    if (maskedPassenger && reply.includes('XX')) throw new Error('Masked passenger placeholder was spoken')
    if (text === '请查看当前座椅角度。' && !reply.includes('40%')) throw new Error('Status changed the actual protocol value')
    if (text === '请再查看当前座椅角度。' && !reply.includes('暂未获取')) throw new Error('Empty status was hallucinated')
    if (text.startsWith('不要') && controls !== before.controls) throw new Error('Negative request executed control')
    if (text === comparisonTurns[1] && controls !== before.controls) throw new Error('Suggestion executed before confirmation')
    if (dialogueMode !== 'compact' && text === comparisonTurns[2] && controls !== before.controls + 1) throw new Error('Confirmation failed to dispatch exactly once')
    if (text === massageTurns[0] && (!reply.includes('按摩') || controls !== before.controls)) throw new Error('Expected pending massage offer')
    if (text === massageTurns[1] && (!reply.includes('没有执行') || orderCalls !== before.orderCalls || controls !== before.controls)) throw new Error('Decline routed incorrectly')
    if (text === massageTurns[3] && (orderCalls === before.orderCalls || controls !== before.controls)) throw new Error('Explicit order cancellation lost')
    outcomes.push({ input: text, first_delta_ms: firstDeltaMs, done_ms: Math.round(performance.now() - started), reply,
      audio_ready_ms: events.find(event => event.event === 'done')?.data.audio_playback?.elapsed_ms,
      mock_order_calls: orderCalls - before.orderCalls, mock_device_calls: controls - before.controls, mock_broadcasts: broadcasts - before.broadcasts, uploaded_sha256: hashes.at(-1) })
    console.error(JSON.stringify(outcomes.at(-1)))
  }
  if (agentCreations || hashes[0] !== hashes[1]) throw new Error('Agent/cache invariant failed')
  console.log(JSON.stringify({ dialogue_mode: dialogueMode, real_models: true, real_device_calls: 0, agent_creations: agentCreations, outcomes }, null, 2))
} finally {
  for (const server of [cabin, mock]) if (server?.listening) {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  }
  db.close(); await rm(rootDir, { recursive: true, force: true })
}
