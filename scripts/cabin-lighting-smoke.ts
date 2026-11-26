import http from 'node:http'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

const root = await mkdtemp(join(tmpdir(), 'cabin-light-test-'))
const model = process.env.CABIN_LIGHT_MODEL ?? 'mock'
const key = process.env.CABIN_LIGHT_MODEL_KEY
if (model !== 'mock' && !key) throw new Error('Set CABIN_LIGHT_MODEL_KEY for a live run')
process.env.MOSS_HOME = root
const assistant = 'cabin-ai-flight-attendant'
await mkdir(join(root,'assistants/system'),{recursive:true})
await cp(`assistants/${assistant}`,join(root,'assistants/system',assistant),{recursive:true})
await mkdir(join(root,'skills/hub'),{recursive:true})
for (const skill of ['cabin-mode-switch','cabin-hardware-status-query','cabin-hardware-control']) {
  await cp(`skills/hub/${skill}`,join(root,'skills/hub',skill),{recursive:true})
}
const { createCabinApi } = await import('../src/server/cabin/api.js')
const { CabinServices } = await import('../src/server/cabin/service.js')
const { CabinStore } = await import('../src/server/cabin/store.js')
const { serverFileConfigSchema } = await import('../src/server/types.js')
const db = new Database(':memory:')
let seat = '3B', partial = false, modeCode = 0, sentCount = 1
const calls: string[] = []
const air = 'B-SMOKE'
let asrText = '', stateObject = 6, stateAircraft = air, simulateTimeout = false, businessCode = 0
const lampState = {lightOpen:'0',r:'255',g:'180',b:'80',brightness:'101',preset:'1'}
let trackChanges = false
const mock = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req) {
  const url = new URL(req.url)
  if (url.pathname === '/asr') {
    calls.push('ASR synthetic transcript')
    return Response.json({text:asrText,language:'zh'})
  }
  if (url.pathname.endsWith('get-seat-context')) return Response.json({code:0,data:{aircraftNo:air,seatNo:seat,flightId:'SIM',flight:{flightNo:'SIM',flightDate:'2026-11-26'},passenger:{passengerRef:'SIM',language:'zh-CN'},tabletAccessToken:'synthetic'}})
  if (url.pathname === '/v1/chat/completions') {
    const body = await req.json()
    const text = body.messages.at(-1).content
    if (model !== 'mock') {
      const upstream = await fetch('https://napi.sudorouter.ai/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)})
      const payload = await upstream.json()
      const choice = payload.choices?.[0]
      calls.push(`LLM ${upstream.status} ${choice?.message?.tool_calls?.[0]?.function?.name ?? choice?.finish_reason ?? 'error'}`)
      return Response.json(payload,{status:upstream.status})
    }
    const tool = !body.tools ? undefined : /sleep mode|睡眠模式/.test(text) ? ['cabin_mode',{mode:'sleep'}] : text.includes('RGB') ? ['cabin_control',{command:'cabin.ceiling.color',params:{r:0,g:0,b:255,brightness:50}}] : /turn off|关闭氛围灯/.test(text) ? ['cabin_control',{command:'cabin.ceiling.light',params:{on:false}}] : /breathing|呼吸/.test(text) ? ['cabin_control',{command:'cabin.scene',params:{preset:'breath'}}] : /ceiling light|查询氛围灯/.test(text) ? ['cabin_status',{target_type:'cabin',status_key:'ceiling_state'}] : undefined
    calls.push(`LLM 200 ${tool?.[0] ?? 'stop'}`)
    return Response.json({choices:[tool ? {finish_reason:'tool_calls',message:{tool_calls:[{id:'mock',type:'function',function:{name:tool[0],arguments:JSON.stringify(tool[1])}}]}} : {finish_reason:'stop',message:{content:'可以查询本座灯色，也可以调整氛围灯。'}}]})
  }
  calls.push(`${req.method} ${url.pathname}${url.search}${req.method==='POST' && req.headers.get('content-type')?.includes('json') ? ' '+JSON.stringify(await req.json()) : ''}`)
  if (simulateTimeout) await Bun.sleep(450)
  if (url.pathname.endsWith('/state/cabin/light')) return Response.json({code:0,data:{aircraftNo:stateAircraft,light:partial ? {} : {obj:stateObject,...lampState}}})
  if (trackChanges && req.method === 'POST' && url.searchParams.get('seatNo') === '3B') {
    for (const key of ['r','g','b','brightness'] as const) if (url.searchParams.has(key)) lampState[key] = url.searchParams.get(key)!
    if (url.searchParams.has('on')) lampState.lightOpen = url.searchParams.get('on') === 'true' ? '1' : '0'
    if (url.searchParams.has('preset')) lampState.preset = String(['normal','breath','flow'].indexOf(url.searchParams.get('preset')!))
  }
  if (url.pathname.endsWith('/mode-seat')) return Response.json({code:modeCode,data:{matchedCount:sentCount,sentCount}},{status:modeCode||200})
  return Response.json({code:businessCode,data:businessCode ? null : '指令下发成功'})
}})
const base = `http://127.0.0.1:${mock.port}`
const settings = serverFileConfigSchema().parse({cabin:{enabled:true,dialogueMode:'assistant-short',assistantName:assistant,contextMode:'seat',conversationLanguageMode:'enabled',managedSeats:'3A,3B',passengerInfoUrl:`${base}/get-seat-context`,controlBaseUrl:base,broadcastApiBaseUrl:base,llmBaseUrl:base+'/v1',llmModel:model,conversationSeatAudioEnabled:false,broadcastEnabled:false,automationEnabled:false,logEnabled:false}}).cabin
settings.asrUrl = base + '/asr'
settings.controlTimeoutMs = 250
const api = createCabinApi({config:{rootDir:root,cabin:settings} as never,runtime:{store:{db}} as never})
const server = http.createServer(async (req,res) => { if (!await api.handle(req,res,req.url!)) res.end() })
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
const endpoint = `http://127.0.0.1:${(server.address() as {port:number}).port}/v1/ai-chat/send`
let failures = 0
async function turn(text: string, expected: string[], reply?: RegExp, clientId?: string, voice = false) {
  const start = performance.now()
  calls.length = 0
  const headers = new Headers({'x-cabin-seat-no':seat,'x-cabin-aircraft-no':air})
  if (clientId) headers.set('idempotency-key',clientId)
  const form = new FormData()
  if (voice) {
    asrText = text
    form.set('audio',new Blob(['synthetic'],{type:'audio/wav'}),'sample.wav')
    form.set('language','zh')
  } else headers.set('content-type','application/json')
  const response = await fetch(voice ? endpoint.replace('ai-chat','voice-chat') : endpoint,{method:'POST',headers,body:voice ? form : JSON.stringify({content:text,language:'zh'}),signal:AbortSignal.timeout(60000)})
  const stream = await response.text()
  const done = /event: done\s+data: ([^\n]+)/.exec(stream)
  const answer = done ? JSON.parse(done[1]!).reply_text : `HTTP ${response.status} ${stream.slice(0,120)}`
  const ok = !!done && calls.length===expected.length && expected.every((part,index)=>calls[index]!.includes(part)) && (!reply || reply.test(answer)) && !!answer && !/<(?:tool|cabin)_/i.test(answer)
  console.log(JSON.stringify({model,seat,text,source:voice?'voice':'text',reply:answer,calls:[...calls],done_ms:Math.round(performance.now()-start),pass:ok}))
  if (!ok) failures++
}
try {
  await api.prepareShortDialogue()
  for (const [index,label] of ['办公','放松','睡眠','个性'].entries()) await turn(`帮我进入${label}模式`,[`"mode":${index+1},"aircraftNo":"B-SMOKE","seatNo":"3B"`],/下发/)
  await turn('把氛围灯调成蓝色，亮度一半',['color?seatNo=3B&r=0&g=0&b=255&brightness=128'])
  await turn('关闭氛围灯',['light?seatNo=3B&on=false'])
  await turn('再打开',['light?seatNo=3B&on=true'])
  for (const [text,preset] of [['打开呼吸灯','breath'],['切换到流水灯','flow'],['恢复常亮','normal']]) await turn(text!,[`scene?seatNo=3B&preset=${preset}`])
  const read = '/state/cabin/light?aircraftNo=B-SMOKE&seatNo=3B'
  await turn('氛围灯现在开着吗？',[read],/已关闭/)
  await turn('氛围灯现在是什么灯效？',[read],/呼吸/)
  await turn('把氛围灯亮度调到40%',[read,'r=255&g=180&b=80&brightness=102'])
  await turn('把氛围灯调成蓝色',[read,'r=0&g=0&b=255&brightness=101'])
  partial=true
  await turn('氛围灯改成暖色',[read],/百分之多少/)
  await turn('换蓝色，还是一半',['r=0&g=0&b=255&brightness=128'])
  await turn('把氛围灯调到40%',[read],/什么颜色/)
  await turn('算了',[],/取消/)
  await turn('别开氛围灯',[])
  await turn('要是打开睡眠模式会怎样？',[])
  await turn('打开3A的氛围灯',[])
  await turn('把氛围灯调到130%',[])
  modeCode=429
  await turn('打开办公模式',['/mode-seat'],/频繁/)
  modeCode=0; sentCount=0
  await turn('打开办公模式',['/mode-seat'],/未确认送达/)
  seat='3C'; await turn('打开氛围灯',[]); seat='3B'; sentCount=1; partial=false
  await turn('把氛围灯亮度调到百分之四十',[read,'brightness=102'])
  await turn('把灯调暗点',[read,'brightness=77'])
  await turn('我喜欢蓝色氛围灯',[])
  await turn('把灯调暗点',[],/阅读灯还是氛围灯/)
  await turn('打开氛围灯然后关掉',[])
  await turn('打开全舱氛围灯',[])
  seat='99B'; await turn('打开氛围灯',[]); seat='3B'
  stateObject=5; await turn('氛围灯亮度多少？',[read],/读不到/); stateObject=6
  stateAircraft='B-OTHER'; await turn('把氛围灯调成蓝色',[read],/百分之多少/); stateAircraft=air
  await turn('50',['r=0&g=0&b=255&brightness=128'])
  await turn('关闭氛围灯',['ASR','light?seatNo=3B&on=false'],/下发/,'audio-turn-1',true)
  await turn('关闭氛围灯',['ASR'],/已收到/,'audio-turn-1',true)
  businessCode=500; await turn('关闭氛围灯',['light?seatNo=3B&on=false'],/失败/); businessCode=0
  simulateTimeout=true
  await turn('进入睡眠模式',['/mode-seat'],/尚未收到/)
  await turn('关闭氛围灯',['light?seatNo=3B&on=false'],/尚未收到/)
  simulateTimeout=false
  await turn('Could you switch to sleep mode?', ['LLM 200 cabin_mode','"mode":3'])
  await turn('Could you check the ceiling light status?', ['LLM 200 cabin_status',read],/is off/)
  await turn('Could you turn off the ambient light?', ['LLM 200 cabin_control','light?seatNo=3B&on=false'])
  await turn('Could you set the ambient light to RGB 0, 0, 255 at 50% brightness?', ['LLM 200 cabin_control','r=0&g=0&b=255&brightness=128'])
  await turn('Could you set the lighting scene to breathing?', ['LLM 200 cabin_control','scene?seatNo=3B&preset=breath'])
  await turn('请简短介绍你可以提供什么服务', ['LLM 200 stop'])
  trackChanges=true
  await turn('把氛围灯调成蓝色，亮度一半',['r=0&g=0&b=255&brightness=128'])
  await turn('关闭氛围灯',['light?seatNo=3B&on=false'])
  await turn('再打开',['light?seatNo=3B&on=true'])
  await turn('氛围灯现在开着吗？',[read],/已开启/)
  await turn('氛围灯现在是什么颜色？',[read],/蓝色/)
  await turn('氛围灯亮度多少？',[read],/50%/)
  await turn('把氛围灯切换到流水效果',['scene?seatNo=3B&preset=flow'])
  await turn('氛围灯现在是什么灯效？',[read],/流水/)
  const service = new CabinServices({config:settings,store:new CabinStore(db as never)})
  const modelCases = [
    ['帮我进入睡眠模式','cabin_mode','"mode":3'],
    ['关闭氛围灯','cabin_control','light?seatNo=3B&on=false'],
    ['将氛围灯设置为 RGB 0,0,255，亮度 50%','cabin_control','r=0&g=0&b=255&brightness=128'],
    ['请将场景设置为呼吸','cabin_control','scene?seatNo=3B&preset=breath'],
    ['查询氛围灯状态','cabin_status',read],
  ] as const
  for (const [text,tool,outbound] of modelCases) {
    calls.length = 0
    const start = performance.now()
    const result = await service.generateCompactReply({context:{tabletId:'SIM',aircraftNo:air,flightId:'SIM',flightDate:'2026-11-26',seatId:'3B',replyLanguage:'zh'},text,messages:[]}).catch(() => ({reply:'模型请求失败'}))
    const pass = calls.length === 2 && calls[0] === `LLM 200 ${tool}` && calls[1]!.includes(outbound) && (tool === 'cabin_status' ? /已关闭/.test(result.reply) : /下发/.test(result.reply))
    console.log(JSON.stringify({model,seat,text,source:'model-service',reply:result.reply,calls:[...calls],done_ms:Math.round(performance.now()-start),pass}))
    if (!pass) failures++
  }
} finally {
  mock.stop(true); server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); db.close(); await rm(root,{recursive:true,force:true})
}
process.exitCode = failures ? 1 : 0
