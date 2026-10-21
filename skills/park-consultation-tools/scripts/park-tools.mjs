#!/usr/bin/env node
/**
 * Park consultation tool CLI (园区咨询工具). Runs inside the scode session
 * container: reads SESSION_TOKEN + MOSS_SERVER_URL from the environment and
 * calls the agent-facing park endpoints. Organization/park context is derived
 * server-side from the session token — never passed as arguments.
 */
const BASE = (process.env.MOSS_SERVER_URL || 'http://127.0.0.1:3000').replace(/\/$/, '')
const TOKEN = process.env.SESSION_TOKEN

if (!TOKEN) {
  console.error('park-tools: SESSION_TOKEN is not set (must run inside a moss session container)')
  process.exit(1)
}

const COMMANDS = {
  'policy.search': { method: 'GET', path: (args) => `/api/v1/agent/park/policies/search?q=${encodeURIComponent(String(args.q ?? ''))}` },
  'inquiry.append': { method: 'POST', path: () => '/api/v1/agent/park/inquiries' },
  'lead.propose': { method: 'POST', path: () => '/api/v1/agent/park/leads/propose' },
  'service-catalog.read': { method: 'GET', path: () => '/api/v1/agent/park/service-catalog' },
  'park-profile.read': { method: 'GET', path: () => '/api/v1/agent/park/profile' },
}

const [command, rawArgs] = process.argv.slice(2)
const spec = COMMANDS[command]
if (!spec) {
  console.error(`park-tools: unknown command "${command}". Known: ${Object.keys(COMMANDS).join(', ')}`)
  process.exit(1)
}

let args = {}
if (rawArgs) {
  try {
    args = JSON.parse(rawArgs)
  } catch (err) {
    console.error(`park-tools: arguments must be valid JSON — ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
}

let url = `${BASE}${spec.path(args)}`
let body
if (spec.method === 'POST') {
  body = JSON.stringify(args)
}

try {
  const response = await fetch(url, {
    method: spec.method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body,
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = { raw: text }
  }
  if (!response.ok) {
    console.error(`park-tools: ${command} failed (${response.status}): ${JSON.stringify(parsed)}`)
    process.exit(2)
  }
  console.log(JSON.stringify(parsed, null, 2))
} catch (err) {
  console.error(`park-tools: request failed — ${err instanceof Error ? err.message : err}`)
  process.exit(3)
}
