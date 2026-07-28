#!/usr/bin/env node

const STATUS_KEYS = new Set([
  'posture',
  'tray',
  'safety',
  'comfort',
  'reading_light',
  'glass_state',
  'ceiling_state',
])

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
  console.log(JSON.stringify({ ok: false, mode: 'status_query', error: message }))
  process.exitCode = 1
}

const args = parseArgs(process.argv.slice(2))
const targetType = String(args['target-type'] || args.target || '').trim()
const statusKey = String(args['status-key'] || args.key || '').trim()

if (targetType !== 'seat' && targetType !== 'cabin') {
  fail('target-type must be seat or cabin')
} else if (!STATUS_KEYS.has(statusKey)) {
  fail(`unsupported status-key: ${statusKey}`)
} else if (targetType === 'seat' && !String(args['seat-no'] || '').trim()) {
  fail('seat-no is required for seat status')
} else {
  console.log(JSON.stringify({
    ok: true,
    mode: 'status_query',
    tool: 'cabin.hardware.status',
    target_type: targetType,
    status_key: statusKey,
    seat_no: String(args['seat-no'] || '').trim() || undefined,
  }))
}
