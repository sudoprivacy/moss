#!/usr/bin/env node

const MODE_LABELS = {
  office: '办公模式',
  relax: '放松模式',
  sleep: '睡眠模式',
  personal: '个人模式',
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

function fail(message) {
  console.log(JSON.stringify({ ok: false, mode: 'mode_switch', error: message }))
  process.exitCode = 1
}

const args = parseArgs(process.argv.slice(2))
const cabinMode = String(args.mode || args['cabin-mode'] || '').trim()
const title = String(args.title || MODE_LABELS[cabinMode] || '').trim()

if (!Object.hasOwn(MODE_LABELS, cabinMode)) {
  fail(`unsupported mode: ${cabinMode}`)
} else if (!String(args['seat-no'] || '').trim()) {
  fail('seat-no is required')
} else if (!String(args['aircraft-no'] || '').trim()) {
  fail('aircraft-no is required')
} else {
  console.log(JSON.stringify({
    ok: true,
    mode: 'mode_switch',
    tool: 'cabin.mode.switch',
    cabin_mode: cabinMode,
    title,
    aircraft_no: String(args['aircraft-no']).trim(),
    seat_no: String(args['seat-no']).trim(),
  }))
}
