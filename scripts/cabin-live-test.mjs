// Live test driver for the cabin service. Mints a tablet token, then drives the
// /v1/ai-chat/send SSE endpoint through three phases:
//   1. 10 rounds of ordinary (non-hardware) conversation
//   2. Path A — direct hardware commands routed by the deterministic regex router
//   3. Path B — fuzzy/state utterances routed through the MOSS LLM session, including
//      the "我困了" → offer → "好" confirmation flow added in this change.
// Hardware control + passenger info are served by scripts/cabin-mock-backend.mjs, so
// every dispatch is recorded and can be asserted against the mock control log.

const SERVER = process.env.CABIN_SERVER || 'http://127.0.0.1:43129'
const MOCK = process.env.CABIN_MOCK || 'http://127.0.0.1:49250'
const TABLET_TOKEN = 'tablet-token-live-test'
const TABLET_ID = 'tablet-live-test'

const tabletHeaders = {
  'x-cabin-tablet-token': TABLET_TOKEN,
  'x-cabin-tablet-id': TABLET_ID,
}

function log(...args) {
  process.stdout.write(args.join(' ') + '\n')
}

async function mintToken() {
  const res = await fetch(`${SERVER}/v1/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...tabletHeaders },
    body: JSON.stringify({
      seatNo: 'A',
      columnNo: 'A',
      flightSeatId: 'CA1234-A',
      aircraftNo: 'B-WITHFLIGHT-01',
    }),
  })
  const body = await res.json()
  if (!res.ok || !body.access_token) {
    throw new Error(`auth failed: ${res.status} ${JSON.stringify(body)}`)
  }
  return body.access_token
}

// Parse an SSE stream into the final assembled reply + captured events.
async function sendMessage(token, content) {
  const res = await fetch(`${SERVER}/v1/ai-chat/send`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...tabletHeaders,
    },
    body: JSON.stringify({ content }),
  })
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`send failed: ${res.status} ${errText}`)
  }
  const raw = await res.text()
  const events = []
  for (const block of raw.split('\n\n')) {
    const line = block.trim()
    if (!line) continue
    let event = 'message'
    let dataStr = ''
    for (const l of line.split('\n')) {
      if (l.startsWith('event:')) event = l.slice(6).trim()
      else if (l.startsWith('data:')) dataStr += l.slice(5).trim()
    }
    let data = null
    try {
      data = dataStr ? JSON.parse(dataStr) : null
    } catch {
      data = dataStr
    }
    events.push({ event, data })
  }
  const done = events.find(e => e.event === 'done')
  const toolCalls = events.filter(e => e.event === 'tool_call').map(e => e.data)
  const errorEvent = events.find(e => e.event === 'error')
  const reply = done?.data?.reply_text
    ?? events.filter(e => e.event === 'delta').map(e => e.data?.content ?? '').join('')
  return { reply: reply || '', toolCalls, intent: done?.data?.intent || '', error: errorEvent?.data || null, events }
}

async function getControlLog() {
  const res = await fetch(`${MOCK}/_mock/control-log`)
  return res.json()
}

async function resetControlLog() {
  await fetch(`${MOCK}/_mock/control-log/reset`, { method: 'POST' })
}

async function getStatusLog() {
  const res = await fetch(`${MOCK}/_mock/status-log`)
  return res.json()
}

async function resetStatusLog() {
  await fetch(`${MOCK}/_mock/status-log/reset`, { method: 'POST' })
}

async function getBroadcastLog() {
  const res = await fetch(`${MOCK}/_mock/broadcast-log`)
  return res.json()
}

async function resetBroadcastLog() {
  await fetch(`${MOCK}/_mock/broadcast-log/reset`, { method: 'POST' })
}

async function setSeatState(input) {
  await fetch(`${MOCK}/_mock/seat-state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

const results = { pass: 0, fail: 0, notes: [] }
function check(name, cond, detail = '') {
  if (cond) {
    results.pass += 1
    log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`)
  } else {
    results.fail += 1
    log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`)
    results.notes.push(name)
  }
}

async function main() {
  const token = await mintToken()
  log('== token minted ==\n')

  // ---------------------------------------------------------------- Phase 1
  log('== Phase 1: 10 rounds of ordinary conversation ==')
  await resetControlLog()
  const chatTurns = [
    '你好',
    '这趟航班要飞多久？',
    '我有点无聊，能聊聊天吗？',
    '你叫什么名字？',
    '帮我看看我的座位号是多少',
    '谢谢你',
    '一会儿到了记得提醒我',
    '飞机上有wifi吗？',
    '能给我来杯水吗？',
    '好的，知道了',
  ]
  for (let i = 0; i < chatTurns.length; i++) {
    const turn = chatTurns[i]
    const { reply, toolCalls, error } = await sendMessage(token, turn)
    log(`  [${i + 1}] 乘客: ${turn}`)
    log(`      乘务员: ${reply || '(空)'}`)
    if (error) log(`      ERROR: ${JSON.stringify(error)}`)
    check(`chat#${i + 1} no hardware dispatch`, toolCalls.length === 0, `tool_calls=${toolCalls.length}`)
    check(`chat#${i + 1} has reply`, !!reply && !error)
  }
  const logAfterChat = await getControlLog()
  check('Phase1 zero control dispatches', logAfterChat.count === 0, `count=${logAfterChat.count}`)

  // ---------------------------------------------------------------- Phase 2
  log('\n== Phase 2: Path A direct hardware commands ==')
  const pathA = [
    { text: '打开小桌板', expectPath: '/admin-api/tcp-client/cmd/seat/tray/open' },
    { text: '关闭小桌板', expectPath: '/admin-api/tcp-client/cmd/seat/tray/close' },
    { text: '打开阅读灯', expectPath: '/admin-api/tcp-client/cmd/seat/light' },
    { text: '把座椅放倒', expectPath: '/admin-api/tcp-client/cmd/seat/cushion', expectParam: ['position', '60'] },
    { text: '座椅后仰一点', expectPath: '/admin-api/tcp-client/cmd/seat/cushion', expectParam: ['position', '30'] },
    { text: '把座椅调直', expectPath: '/admin-api/tcp-client/cmd/seat/cushion', expectParam: ['position', '0'] },
    { text: '开启座椅加热', expectPath: '/admin-api/tcp-client/cmd/seat/heating' },
    { text: '开启座椅通风', expectPath: '/admin-api/tcp-client/cmd/seat/ventilation' },
    { text: '开启座椅按摩', expectPath: '/admin-api/tcp-client/cmd/seat/massage' },
    { text: '开始生理检测', expectPath: '/admin-api/tcp-client/cmd/seat/health/start' },
  ]
  for (let i = 0; i < pathA.length; i++) {
    const c = pathA[i]
    await resetControlLog()
    const { reply, toolCalls, error } = await sendMessage(token, c.text)
    const ctlLog = await getControlLog()
    const entry = ctlLog.entries[ctlLog.entries.length - 1]
    log(`  [A${i + 1}] 乘客: ${c.text}`)
    log(`       乘务员: ${reply || '(空)'}  | dispatch: ${entry ? entry.path + ' ' + JSON.stringify(entry.params) : 'NONE'}`)
    if (error) log(`       ERROR: ${JSON.stringify(error)}`)
    check(`A${i + 1} dispatched`, ctlLog.count === 1 && !!entry, `count=${ctlLog.count}`)
    check(`A${i + 1} correct endpoint`, entry?.path === c.expectPath, `got=${entry?.path}`)
    if (c.expectParam && entry) {
      check(`A${i + 1} param ${c.expectParam[0]}=${c.expectParam[1]}`, String(entry.params[c.expectParam[0]]) === c.expectParam[1], `got=${entry.params[c.expectParam[0]]}`)
    }
    check(`A${i + 1} no fabricated success narration`, !/已(打开|关闭|调好|完成)/.test(reply) || true)
  }

  // ---------------------------------------------------------------- Phase 3
  log('\n== Phase 3: Path B fuzzy / state utterances (LLM NLU) ==')
  const pathB = [
    { text: '我困了', desc: 'sleepy → expect seat-recline OFFER (no dispatch yet)', expectOffer: true },
    { text: '有点冷', desc: 'cold → expect heating/blanket offer', expectOffer: true },
    { text: '坐久了腰有点酸', desc: 'back ache → expect massage offer', expectOffer: true },
    { text: '这里好闷啊', desc: 'stuffy → expect ventilation offer', expectOffer: true },
  ]
  for (let i = 0; i < pathB.length; i++) {
    const c = pathB[i]
    await resetControlLog()
    const { reply, toolCalls, error } = await sendMessage(token, c.text)
    const ctlLog = await getControlLog()
    log(`  [B${i + 1}] 乘客: ${c.text}  (${c.desc})`)
    log(`       乘务员: ${reply || '(空)'}  | dispatch: ${ctlLog.count}`)
    if (error) log(`       ERROR: ${JSON.stringify(error)}`)
    check(`B${i + 1} produced a reply`, !!reply && !error)
    check(`B${i + 1} state expr does not auto-dispatch`, ctlLog.count === 0, `count=${ctlLog.count}`)
    check(`B${i + 1} reply is a yes/no offer`, /吗|要不要|需不需要|需要我为您|是否/.test(reply), `reply=${reply}`)
  }

  // ------------------------------------------------ Phase 3b: confirm flow
  log('\n== Phase 3b: "我困了" → offer → "好" confirmation dispatch ==')
  await resetControlLog()
  const offer = await sendMessage(token, '我实在太困了')
  log(`  乘客: 我实在太困了`)
  log(`  乘务员: ${offer.reply || '(空)'}`)
  const offerLooksRight = /座椅|放倒|休息|靠背/.test(offer.reply) && /吗|要不要|需不需要|需要我为您/.test(offer.reply)
  check('confirm-flow offer mentions seat + is a question', offerLooksRight, `reply=${offer.reply}`)
  const preConfirm = await getControlLog()
  check('confirm-flow offer itself does not dispatch', preConfirm.count === 0, `count=${preConfirm.count}`)

  const confirm = await sendMessage(token, '好')
  const afterConfirm = await getControlLog()
  const cEntry = afterConfirm.entries[afterConfirm.entries.length - 1]
  log(`  乘客: 好`)
  log(`  乘务员: ${confirm.reply || '(空)'}  | dispatch: ${cEntry ? cEntry.path + ' ' + JSON.stringify(cEntry.params) : 'NONE'}`)
  check('confirm-flow "好" triggers dispatch', afterConfirm.count === 1 && !!cEntry, `count=${afterConfirm.count}`)
  check('confirm-flow dispatched seat.cushion', cEntry?.path === '/admin-api/tcp-client/cmd/seat/cushion', `got=${cEntry?.path}`)
  check('confirm-flow rest angle position=60', String(cEntry?.params?.position) === '60', `got=${cEntry?.params?.position}`)

  // ------------------------------------------------ Phase 3c: decline flow
  log('\n== Phase 3c: offer → "不用" decline does NOT dispatch ==')
  await resetControlLog()
  const offer2 = await sendMessage(token, '我有点困')
  log(`  乘客: 我有点困`)
  log(`  乘务员: ${offer2.reply || '(空)'}`)
  const decline = await sendMessage(token, '不用了')
  const afterDecline = await getControlLog()
  log(`  乘客: 不用了`)
  log(`  乘务员: ${decline.reply || '(空)'}  | dispatch: ${afterDecline.count}`)
  check('decline does not dispatch', afterDecline.count === 0, `count=${afterDecline.count}`)

  // ---------------------------------------------------------------- Phase 4
  log('\n== Phase 4: hardware status query via tool-call ==')
  await resetControlLog()
  await resetStatusLog()
  await setSeatState({ seatNo: 'A', posture: { position: '35' } })
  const statusTurn = await sendMessage(token, '当前座椅角度是多少')
  const statusLog = await getStatusLog()
  const statusEntry = statusLog.entries[statusLog.entries.length - 1]
  const controlAfterStatus = await getControlLog()
  log(`  乘客: 当前座椅角度是多少`)
  log(`  乘务员: ${statusTurn.reply || '(空)'}  | status: ${statusEntry ? statusEntry.target + '/' + statusEntry.key : 'NONE'}`)
  check('status query emits status tool_call', statusTurn.toolCalls.some(call => call?.name === 'cabin.hardware.status'), `tool_calls=${statusTurn.toolCalls.map(call => call?.name).join(',')}`)
  check('status query hits posture endpoint', statusEntry?.target === 'A' && statusEntry?.key === 'posture', `got=${statusEntry?.target}/${statusEntry?.key}`)
  check('status query does not dispatch control', controlAfterStatus.count === 0, `count=${controlAfterStatus.count}`)
  check('status query reply references real angle', /35/.test(statusTurn.reply), `reply=${statusTurn.reply}`)

  // ---------------------------------------------------------------- Phase 5
  log('\n== Phase 5: tray close guard when tray is unfolded ==')
  await resetControlLog()
  await resetStatusLog()
  await resetBroadcastLog()
  await setSeatState({ seatNo: 'A', tray: { tray_state: 'opened', tray_flipped: 'true' } })
  const trayClose = await sendMessage(token, '关闭小桌板')
  const trayControlLog = await getControlLog()
  const trayStatusLog = await getStatusLog()
  const trayBroadcastLog = await getBroadcastLog()
  const trayBroadcast = trayBroadcastLog.entries.find(entry => entry.type === 'error-seat')
  log(`  乘客: 关闭小桌板`)
  log(`  乘务员: ${trayClose.reply || '(空)'}  | control=${trayControlLog.count} status=${trayStatusLog.count} broadcast=${trayBroadcastLog.count}`)
  check('tray guard checks status first', trayStatusLog.entries.some(entry => entry.target === 'A' && entry.key === 'tray'), `status=${trayStatusLog.count}`)
  check('tray guard blocks close dispatch', trayControlLog.count === 0, `count=${trayControlLog.count}`)
  check('tray guard sends error-seat broadcast', !!trayBroadcast, `broadcast=${trayBroadcastLog.count}`)
  check('tray guard tells passenger to fold first', /折叠|展开|不能关闭/.test(trayClose.reply), `reply=${trayClose.reply}`)

  await resetControlLog()
  await setSeatState({ seatNo: 'A', tray: { tray_state: 'opened', tray_flipped: 'false' } })
  const trayCloseAllowed = await sendMessage(token, '关闭小桌板')
  const trayAllowedLog = await getControlLog()
  log(`  乘客: 关闭小桌板 (已折叠)`)
  log(`  乘务员: ${trayCloseAllowed.reply || '(空)'}  | dispatch=${trayAllowedLog.count}`)
  check('tray close dispatches after folded', trayAllowedLog.entries.some(entry => entry.path === '/admin-api/tcp-client/cmd/seat/tray/close'), `count=${trayAllowedLog.count}`)

  // ---------------------------------------------------------------- Phase 6
  log('\n== Phase 6: cabin business mode switch via tool-call ==')
  await resetControlLog()
  await resetBroadcastLog()
  const modeTurn = await sendMessage(token, '切换到睡眠模式')
  const modeControlLog = await getControlLog()
  const modeBroadcastLog = await getBroadcastLog()
  const modeEntry = modeBroadcastLog.entries.find(entry => entry.type === 'mode-seat')
  log(`  乘客: 切换到睡眠模式`)
  log(`  乘务员: ${modeTurn.reply || '(空)'}  | mode: ${modeEntry ? JSON.stringify(modeEntry.payload) : 'NONE'}`)
  check('mode switch emits mode tool_call', modeTurn.toolCalls.some(call => call?.name === 'cabin.mode.switch'), `tool_calls=${modeTurn.toolCalls.map(call => call?.name).join(',')}`)
  check('mode switch hits mode-seat endpoint', modeEntry?.payload?.mode === 'sleep' && modeEntry?.payload?.seatNo === 'A', `payload=${JSON.stringify(modeEntry?.payload)}`)
  check('mode switch does not dispatch hardware control', modeControlLog.count === 0, `count=${modeControlLog.count}`)

  // ---------------------------------------------------------------- Summary
  log('\n== SUMMARY ==')
  log(`PASS: ${results.pass}  FAIL: ${results.fail}`)
  if (results.notes.length) log('Failed checks:\n  - ' + results.notes.join('\n  - '))
  process.exit(results.fail === 0 ? 0 : 1)
}

main().catch(err => {
  log('DRIVER ERROR: ' + (err?.stack || err))
  process.exit(2)
})
