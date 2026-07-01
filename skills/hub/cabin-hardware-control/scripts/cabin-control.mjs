#!/usr/bin/env node

import { setTimeout as delay } from 'timers/promises'
import { mkdir, appendFile } from 'fs/promises'
import { dirname } from 'path'

const COMMANDS = {
  'seat.cushion': {
    device: 'seat',
    action: 'position',
    path: '/admin-api/tcp-client/cmd/seat/cushion',
    params: [
      { name: 'seatNo', arg: 'seat-no', required: true, type: 'seat' },
      { name: 'position', arg: 'position', required: true, type: 'int', min: 0, max: 100 },
    ],
    label: args => `座椅位置调整到 ${args.position}%`,
  },
  'seat.ventilation': {
    device: 'seat',
    action: 'ventilation',
    path: '/admin-api/tcp-client/cmd/seat/ventilation',
    params: [
      { name: 'seatNo', arg: 'seat-no', required: true, type: 'seat' },
      { name: 'level', arg: 'level', required: true, type: 'int', min: 0, max: 10 },
    ],
    label: args => `座椅通风调整到 ${args.level} 档`,
  },
  'seat.heating': {
    device: 'seat',
    action: 'heating',
    path: '/admin-api/tcp-client/cmd/seat/heating',
    params: [
      { name: 'seatNo', arg: 'seat-no', required: true, type: 'seat' },
      { name: 'level', arg: 'level', required: true, type: 'int', min: 0, max: 10 },
    ],
    label: args => `座椅加热调整到 ${args.level} 档`,
  },
  'seat.massage': {
    device: 'seat',
    action: 'massage',
    path: '/admin-api/tcp-client/cmd/seat/massage',
    params: [
      { name: 'seatNo', arg: 'seat-no', required: true, type: 'seat' },
      { name: 'level', arg: 'level', required: true, type: 'int', min: 0, max: 10 },
    ],
    label: args => `座椅按摩调整到 ${args.level} 档`,
  },
  'seat.tray.open': {
    device: 'tray',
    action: 'open',
    path: '/admin-api/tcp-client/cmd/seat/tray/open',
    params: [
      { name: 'seatNo', arg: 'seat-no', required: true, type: 'seat' },
    ],
    label: () => '打开小桌板',
  },
  'seat.tray.close': {
    device: 'tray',
    action: 'close',
    path: '/admin-api/tcp-client/cmd/seat/tray/close',
    params: [
      { name: 'seatNo', arg: 'seat-no', required: true, type: 'seat' },
    ],
    label: () => '关闭小桌板',
  },
  'seat.light': {
    device: 'reading_light',
    action: 'switch',
    path: '/admin-api/tcp-client/cmd/seat/light',
    params: [
      { name: 'seatNo', arg: 'seat-no', required: true, type: 'seat' },
      { name: 'on', arg: 'on', required: true, type: 'bool' },
      { name: 'pwm', arg: 'pwm', required: false, type: 'int', min: 0, max: 1000 },
    ],
    label: args => `${args.on ? '打开' : '关闭'}阅读灯`,
  },
  'seat.light.brightness': {
    device: 'reading_light',
    action: 'brightness',
    path: '/admin-api/tcp-client/cmd/seat/light/brightness',
    params: [
      { name: 'seatNo', arg: 'seat-no', required: true, type: 'seat' },
      { name: 'pwm', arg: 'pwm', required: true, type: 'int', min: 0, max: 1000 },
    ],
    label: args => `阅读灯亮度调整到 ${args.pwm}`,
  },
  'seat.health.start': {
    device: 'health',
    action: 'start',
    path: '/admin-api/tcp-client/cmd/seat/health/start',
    params: [
      { name: 'seatNo', arg: 'seat-no', required: true, type: 'seat' },
    ],
    label: () => '启动生理检测采集',
  },
  'seat.health.stop': {
    device: 'health',
    action: 'stop',
    path: '/admin-api/tcp-client/cmd/seat/health/stop',
    params: [
      { name: 'seatNo', arg: 'seat-no', required: true, type: 'seat' },
    ],
    label: () => '停止生理检测采集',
  },
  'cabin.ceiling.color': {
    device: 'ceiling_light',
    action: 'color',
    path: '/admin-api/tcp-client/cmd/cabin/ceiling/color',
    params: [
      { name: 'seatNo', arg: 'seat-no', required: true, type: 'seat' },
      { name: 'r', arg: 'r', required: true, type: 'int', min: 0, max: 255 },
      { name: 'g', arg: 'g', required: true, type: 'int', min: 0, max: 255 },
      { name: 'b', arg: 'b', required: true, type: 'int', min: 0, max: 255 },
      { name: 'brightness', arg: 'brightness', required: true, type: 'int', min: 0, max: 100 },
    ],
    label: args => `客舱顶灯颜色调整为 RGB(${args.r}, ${args.g}, ${args.b})，亮度 ${args.brightness}%`,
  },
  'cabin.ceiling.light': {
    device: 'ceiling_light',
    action: 'switch',
    path: '/admin-api/tcp-client/cmd/cabin/ceiling/light',
    params: [
      { name: 'seatNo', arg: 'seat-no', required: true, type: 'seat' },
      { name: 'on', arg: 'on', required: true, type: 'bool' },
    ],
    label: args => `${args.on ? '打开' : '关闭'}客舱顶灯`,
  },
  'cabin.scene': {
    device: 'cabin_scene',
    action: 'set',
    path: '/admin-api/tcp-client/cmd/cabin/scene',
    params: [
      { name: 'seatNo', arg: 'seat-no', required: true, type: 'seat' },
      { name: 'preset', arg: 'preset', required: true, type: 'token' },
    ],
    label: args => `切换至 ${args.preset} 客舱场景`,
  },
  'cabin.scene.clear': {
    device: 'cabin_scene',
    action: 'clear',
    path: '/admin-api/tcp-client/cmd/cabin/scene/clear',
    params: [
      { name: 'seatNo', arg: 'seat-no', required: true, type: 'seat' },
    ],
    label: () => '清除客舱场景',
  },
}

const LEGACY_COMMANDS = {
  'tray:open': 'seat.tray.open',
  'tray:close': 'seat.tray.close',
  'seat.recline': 'seat.cushion',
  'seat.backrest': 'seat.cushion',
  'seat.position': 'seat.cushion',
  'seat.light.on': 'seat.light',
  'seat.light.off': 'seat.light',
  'seat.health': 'seat.health.start',
  'cabin.scene.none': 'cabin.scene.clear',
  'cabin.scene.clear.none': 'cabin.scene.clear',
}

const COLOR_ALIASES = {
  blue: { r: 0, g: 0, b: 255 },
  蓝: { r: 0, g: 0, b: 255 },
  蓝色: { r: 0, g: 0, b: 255 },
  red: { r: 255, g: 0, b: 0 },
  红: { r: 255, g: 0, b: 0 },
  红色: { r: 255, g: 0, b: 0 },
  green: { r: 0, g: 255, b: 0 },
  绿: { r: 0, g: 255, b: 0 },
  绿色: { r: 0, g: 255, b: 0 },
  white: { r: 255, g: 255, b: 255 },
  白: { r: 255, g: 255, b: 255 },
  白色: { r: 255, g: 255, b: 255 },
  warm: { r: 255, g: 180, b: 80 },
  暖: { r: 255, g: 180, b: 80 },
  暖色: { r: 255, g: 180, b: 80 },
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (!item.startsWith('--')) continue
    const key = item.slice(2)
    const value = argv[i + 1]
    if (value && !value.startsWith('--')) {
      args[key] = value
      i += 1
    } else {
      args[key] = 'true'
    }
  }
  return args
}

function tokenizeCommand(value) {
  const tokens = []
  let current = ''
  let quote = ''

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]
    if (quote) {
      if (char === quote) {
        quote = ''
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += char
  }

  if (current) tokens.push(current)
  return tokens
}

function expandEmbeddedCommandArgs(args) {
  const command = String(args.command ?? '').trim()
  if (!command || !/\s/.test(command)) return args

  const tokens = tokenizeCommand(command)
  if (tokens.length <= 1) return args

  const [commandName, ...embeddedArgv] = tokens
  const embeddedArgs = parseArgs(embeddedArgv)
  return {
    ...embeddedArgs,
    ...args,
    command: commandName,
  }
}

function normalizeArgs(args) {
  const normalized = expandEmbeddedCommandArgs({ ...args })
  const command = String(normalized.command ?? '').trim()

  if (normalized.on === undefined) {
    if (/\.on$/i.test(command)) normalized.on = 'true'
    if (/\.off$/i.test(command)) normalized.on = 'false'
  }

  const sceneCommandMatch = command.match(/^cabin\.scene\.([A-Za-z0-9_.:-]+)$/i)
  if (sceneCommandMatch) {
    const preset = sceneCommandMatch[1]
    if (['clear', 'none', 'off'].includes(preset.toLowerCase())) {
      normalized.command = 'cabin.scene.clear'
    } else {
      normalized.command = 'cabin.scene'
      normalized.preset ??= preset
    }
  }

  if (normalized.action && normalized.on === undefined) {
    const action = String(normalized.action).trim().toLowerCase()
    if (['on', 'open', 'true', '1', '打开', '开启'].includes(action)) normalized.on = 'true'
    if (['off', 'close', 'false', '0', '关闭', '关'].includes(action)) normalized.on = 'false'
  }

  if (normalized.position === undefined) {
    if (normalized.percent !== undefined) normalized.position = normalized.percent
    if (normalized.angle !== undefined) normalized.position = normalized.angle
    if (normalized.value !== undefined) normalized.position = normalized.value
  }

  if (normalized.preset === undefined) {
    if (normalized.scene !== undefined) normalized.preset = normalized.scene
    if (normalized.mode !== undefined) normalized.preset = normalized.mode
  }

  const preset = String(normalized.preset ?? '').trim().toLowerCase()
  if (['none', 'clear', 'off', '关闭', '清除', '取消'].includes(preset)) {
    normalized.command = 'cabin.scene.clear'
  }

  const color = String(normalized.color ?? '').trim().toLowerCase()
  const colorRgb = COLOR_ALIASES[color]
  if (colorRgb) {
    normalized.r ??= String(colorRgb.r)
    normalized.g ??= String(colorRgb.g)
    normalized.b ??= String(colorRgb.b)
  }

  return normalized
}

function fail(code, message, extra = {}) {
  console.log(JSON.stringify({
    ok: false,
    code,
    message,
    ...extra,
  }))
  process.exitCode = 1
}

function normalizeBaseUrl(value) {
  const trimmed = String(value || '').trim()
  return trimmed.replace(/\/+$/, '')
}

function parseBool(name, value) {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true
  if (['false', '0', 'no', 'off'].includes(normalized)) return false
  throw new Error(`${name} must be true or false`)
}

function parseIntRange(name, value, min, max) {
  const normalized = String(value ?? '').trim()
  if (!/^-?\d+$/.test(normalized)) {
    throw new Error(`${name} must be an integer`)
  }
  const parsed = Number.parseInt(normalized, 10)
  if (parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}`)
  }
  return parsed
}

function parseSafeToken(name, value, pattern) {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) {
    throw new Error(`${name} is required`)
  }
  if (!pattern.test(trimmed)) {
    throw new Error(`${name} contains unsupported characters`)
  }
  return trimmed
}

function parseParam(spec, args) {
  const value = args[spec.arg]
  if ((value === undefined || value === '') && spec.required) {
    throw new Error(`${spec.arg} is required`)
  }
  if (value === undefined || value === '') return undefined

  if (spec.type === 'bool') return parseBool(spec.arg, value)
  if (spec.type === 'int') return parseIntRange(spec.arg, value, spec.min, spec.max)
  if (spec.type === 'seat') return parseSafeToken(spec.arg, value, /^[A-Za-z0-9_-]+$/)
  return parseSafeToken(spec.arg, value, /^[A-Za-z0-9_.:-]+$/)
}

function resolveCommand(args) {
  const explicit = String(args.command || '').trim()
  if (explicit) {
    if (explicit === 'cabin.ceiling.light' && (
      args.r !== undefined ||
      args.g !== undefined ||
      args.b !== undefined ||
      args.color !== undefined
    )) {
      return 'cabin.ceiling.color'
    }
    return LEGACY_COMMANDS[explicit] || explicit
  }

  const legacyKey = `${String(args.device || '').trim().toLowerCase()}:${String(args.action || '').trim().toLowerCase()}`
  return LEGACY_COMMANDS[legacyKey] || ''
}

function buildPassengerReplyHint(executionStatus, label) {
  if (executionStatus === 'dispatched') {
    return `已为您下发${label}的指令，请稍候。`
  }
  return `${label}的指令下发失败，请稍后再试。`
}

function normalizePayload(bodyText) {
  if (!bodyText.trim()) return null
  try {
    return JSON.parse(bodyText)
  } catch {
    return { raw: bodyText.slice(0, 1000) }
  }
}

function sanitizeUrl(value) {
  try {
    const url = new URL(value)
    for (const key of Array.from(url.searchParams.keys())) {
      if (/token|authorization|auth|key|secret|password/i.test(key)) {
        url.searchParams.set(key, '[redacted]')
      }
    }
    return url.toString()
  } catch {
    return String(value)
  }
}

function logCabinHardware(event) {
  const file = String(process.env.CABIN_LOG_FILE || '/app/data/logs/cabin.jsonl').trim()
  if (!file) return
  const payload = {
    time: new Date().toISOString(),
    level: event.ok === false ? 'error' : 'info',
    type: 'outbound',
    upstream: 'hardware-control',
    method: 'POST',
    request_id: process.env.CABIN_REQUEST_ID || undefined,
    seat_no: event.seatNo,
    command: event.command,
    url: event.url ? sanitizeUrl(event.url) : undefined,
    status: event.status,
    ok: event.ok,
    elapsed_ms: event.elapsedMs,
    error_message: event.errorMessage,
  }
  void mkdir(dirname(file), { recursive: true })
    .then(() => appendFile(file, `${JSON.stringify(payload)}\n`, 'utf8'))
    .catch(() => {})
}

async function main() {
  const args = normalizeArgs(parseArgs(process.argv.slice(2)))
  if (args.help || args.h) {
    console.log(JSON.stringify({
      ok: true,
      commands: Object.keys(COMMANDS),
    }))
    return
  }

  const baseUrl = normalizeBaseUrl(process.env.CABIN_CONTROL_BASE_URL)
  if (!baseUrl) {
    fail('CONFIG_MISSING', 'CABIN_CONTROL_BASE_URL is not configured')
    return
  }

  const commandName = resolveCommand(args)
  const command = COMMANDS[commandName]
  if (!command) {
    fail('UNSUPPORTED_COMMAND', `Unsupported command: ${commandName || '(empty)'}`, {
      supported_commands: Object.keys(COMMANDS),
    })
    return
  }

  const parsedArgs = {}
  const url = new URL(`${baseUrl}${command.path}`)
  try {
    for (const spec of command.params) {
      const value = parseParam(spec, args)
      if (value === undefined) continue
      parsedArgs[spec.arg.replace(/-/g, '_')] = value
      url.searchParams.set(spec.name, String(value))
    }
  } catch (error) {
    fail('INVALID_ARGUMENT', error instanceof Error ? error.message : String(error), {
      command: commandName,
    })
    return
  }

  const timeoutMs = Number.parseInt(process.env.CABIN_CONTROL_TIMEOUT_MS || '10000', 10)
  const controller = new AbortController()
  const timeout = delay(Number.isFinite(timeoutMs) ? timeoutMs : 10000, null, {
    signal: controller.signal,
  }).then(() => {
    controller.abort(new Error('Request timeout'))
  }).catch(() => {})

  const headers = {}
  const auth = String(process.env.CABIN_CONTROL_AUTH || '').trim()
  if (auth) headers.Authorization = auth

  let response
  let bodyText = ''
  const startedAt = Date.now()
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      signal: controller.signal,
    })
    bodyText = await response.text()
  } catch (error) {
    logCabinHardware({
      command: commandName,
      seatNo: parsedArgs.seat_no,
      url: url.toString(),
      ok: false,
      elapsedMs: Date.now() - startedAt,
      errorMessage: error instanceof Error ? error.message : String(error),
    })
    fail('REQUEST_FAILED', error instanceof Error ? error.message : String(error), {
      command: commandName,
      device: command.device,
      action: command.action,
      ...parsedArgs,
    })
    return
  } finally {
    controller.abort()
    await timeout
  }

  const payload = normalizePayload(bodyText)
  const businessCode = payload && typeof payload === 'object' ? payload.code : undefined
  const responseData = payload && typeof payload === 'object' && 'data' in payload ? payload.data : null
  const businessMessage = payload && typeof payload === 'object'
    ? (typeof payload.message === 'string' ? payload.message : typeof payload.msg === 'string' ? payload.msg : undefined)
    : undefined
  const ok = response.ok && (businessCode === 0 || businessCode === '0')
  const executionStatus = ok ? 'dispatched' : 'failed'
  const label = command.label(parsedArgs)

  logCabinHardware({
    command: commandName,
    seatNo: parsedArgs.seat_no,
    url: url.toString(),
    status: response.status,
    ok,
    elapsedMs: Date.now() - startedAt,
  })

  console.log(JSON.stringify({
    ok,
    execution_status: executionStatus,
    passenger_reply_hint: buildPassengerReplyHint(executionStatus, label),
    command: commandName,
    device: command.device,
    action: command.action,
    ...parsedArgs,
    http_status: response.status,
    code: businessCode,
    message: businessMessage || response.statusText,
    data: responseData,
  }))

  if (!ok) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  fail('UNEXPECTED_ERROR', error instanceof Error ? error.message : String(error))
})
