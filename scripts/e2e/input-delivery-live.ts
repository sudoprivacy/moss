/** Run with SCODE_TEST_BIN and SCODE_LIVE_AUTH_PROFILE against an installed live account. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createAcpBridgeHandle } from '../../src/server/backends/acpBridge.js'

assert(process.env.SCODE_TEST_BIN, 'SCODE_TEST_BIN must name the candidate executable')
const root = await mkdtemp(join(tmpdir(), 'moss-live-input-'))
const cwd = join(root, 'workspace')
const config = join(root, 'config')
const home = join(root, 'home')
const source = process.env.SCODE_LIVE_CONFIG_SOURCE || join(homedir(), '.nexus', 'sudocode')
await Promise.all([cwd, config, home].map(path => mkdir(path)))
await copyFile(join(source, 'sudocode.json'), join(config, 'sudocode.json'))
const settings = JSON.parse(await readFile(join(source, 'settings.json'), 'utf8').catch(() => '{}'))
if (process.env.SCODE_LIVE_AUTH_PROFILE) settings.auth_profile = process.env.SCODE_LIVE_AUTH_PROFILE
await writeFile(join(config, 'settings.json'), JSON.stringify(settings), { mode: 0o600 })
await writeFile(join(cwd, 'work.sh'), 'name=$1\nprintf started > "$name.started"\ni=0\nwhile [ ! -f "$name.release" ] && [ $i -lt 1200 ]; do\n printf x >> "$name.ticks"\n sleep 0.1\n i=$((i+1))\ndone\nprintf "MOSS_DONE_%s" "$name" > "$name.done"\n')
const model = process.env.SCODE_LIVE_MODEL || 'sonnet'
const childEnv = { ...process.env, HOME: home, SUDO_CODE_CONFIG_HOME: config, NO_COLOR: '1' }
delete childEnv.SCODE_GLOBAL_CONFIG_DIR
delete childEnv.SCODE_PROJECT_CONFIG_DIR
const child = spawn(resolve(process.env.SCODE_TEST_BIN), ['--auth', 'proxy', '--model', model, '--dangerously-skip-permissions', 'acp'], { cwd, env: childEnv })
const transcriptPath = join(root, 'transcript.jsonl')
const handle = createAcpBridgeHandle({ child, cwd, model, sessionId: 'live-input', transcriptPath,
  enabledSkillNames: [], runtime: { type: 'host', engine: 'scode', configDir: config } })
const events: any[] = []
let state: any = null
handle.onStdoutLine(line => {
  const event = JSON.parse(line)
  events.push(event)
  if (event.type === 'input_delivery_update' && event.update?.kind === 'state') state = event.update.state
})
const waitFor = async (predicate: () => boolean | Promise<boolean>, label: string) => {
  const deadline = Date.now() + 180_000
  while (!await predicate()) {
    assert(Date.now() < deadline, `Timed out: ${label}`)
    await delay(20)
  }
}
let sequence = 0
const control = async (action: Record<string, unknown>) => {
  const requestId = `live-${++sequence}`
  handle.writeStdin(JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'input', action } }))
  await waitFor(() => events.some(event => event.type === 'input_delivery_reply' && event.requestId === requestId), `receipt ${requestId}`)
  const response = events.find(event => event.type === 'input_delivery_reply' && event.requestId === requestId)
  assert.equal(response.error, undefined, response.error)
  assert.equal(response.isSupported, true)
  return response.receipt
}
const submit = (clientId: string, text: string, delivery = 'steer') => control({ action: 'submit', clientId, delivery, display: text, draft: { text }, content: [{ type: 'text', text }] })
const hasFile = (name: string) => readFile(join(cwd, name)).then(() => true, () => false)
const idle = () => waitFor(() => state?.running === false && state?.pending.length === 0, 'idle empty queue')
const start = async (name: string, background: boolean) => {
  const input = { command: `sh work.sh ${name}`, timeout: 180000, run_in_background: background }
  await submit(name, `Run Bash exactly once with these literal inputs: ${JSON.stringify(input)}. The test harness releases it. Do not modify the script or create the release file. If backgrounded, end the turn immediately and wait for its completion notification. Later queued input is FYI; keep the original work. Report the actual completed result briefly.`)
  await waitFor(() => hasFile(`${name}.started`), `${name} shell started`)
}
try {
  await control({ action: 'snapshot' })
  await start('foreground', false)
  await submit('reference', 'MOSS_REFERENCE: FYI only; continue the original task.', 'queue')
  const recalled = await control({ action: 'recall' })
  assert.equal(recalled.recalled.length, 1)
  assert.equal(recalled.recalled[0].clientId, 'reference')
  const item = recalled.recalled[0]
  await control({ action: 'submit', clientId: item.clientId, content: item.content, draft: item.draft, delivery: 'queue' })
  const flushed = await control({ action: 'flush_or_cancel' })
  assert.equal(flushed.cancelled, false)
  const ticks = (await readFile(join(cwd, 'foreground.ticks'))).length
  await delay(300)
  assert((await readFile(join(cwd, 'foreground.ticks'))).length > ticks, 'flush killed the foreground tool')
  await writeFile(join(cwd, 'foreground.release'), 'release')
  await waitFor(() => events.some(event => event.update?.kind === 'committed' && event.update.clientId === 'reference'), 'reference consumed')
  await idle()
  assert.equal(await readFile(join(cwd, 'foreground.done'), 'utf8'), 'MOSS_DONE_foreground')

  await start('background', true)
  await idle()
  await writeFile(join(cwd, 'background.release'), 'release')
  await waitFor(() => events.some(event => event.update?.kind === 'committed' && event.update.source === 'background'), 'background completion consumed without human input')
  await idle()
  assert.equal(await readFile(join(cwd, 'background.done'), 'utf8'), 'MOSS_DONE_background')

  await start('cancelled', false)
  await submit('retained', 'MOSS_AFTER_CANCEL: reply briefly; do not use any tools.', 'queue')
  handle.writeStdin(JSON.stringify({ type: 'control_request', request_id: 'cancel', request: { subtype: 'interrupt' } }))
  await waitFor(() => state?.running === false && state?.paused === true, 'cancellation pauses the queue')
  assert(state.pending.some((pending: any) => pending.clientId === 'retained'))
  assert.equal(await hasFile('cancelled.done'), false)
  await control({ action: 'flush' })
  await waitFor(() => events.some(event => event.update?.kind === 'committed' && event.update.clientId === 'retained'), 'explicit flush resumes retained input')
  await idle()
  await handle.destroy(true)
  const rows = (await readFile(transcriptPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(rows.filter(row => row.type === 'user' && row.uuid === 'reference').length, 1)
  assert.equal(rows.filter(row => row.type === 'user' && row.uuid === 'retained').length, 1)
  console.log('PASS: real Moss bridge → scode → live model; recall, flush, background wake, cancel/resume and transcript ownership')
} finally {
  await Promise.all(['foreground', 'background', 'cancelled'].map(name => writeFile(join(cwd, `${name}.release`), 'cleanup')))
  await handle.destroy(true)
  await rm(root, { recursive: true, force: true })
}
