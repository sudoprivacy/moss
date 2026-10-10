import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { waitForFixtureReady } from './fixtureReady.js'

function start(script: string) {
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', errors = ''
  child.stdout.on('data', bytes => { output += bytes.toString() })
  child.stderr.on('data', bytes => { errors += bytes.toString() })
  return { child, getLogs: () => ({ output, errors }) }
}

void test('fixture readiness handles fragmented output and removes only its own listeners', { timeout: 5_000 }, async t => {
  const { child, getLogs } = start("process.stdout.write('FIXTURE:');setTimeout(()=>process.stdout.write('4321\\n'),20);setInterval(()=>{},1000)")
  try {
    assert.equal(await waitForFixtureReady(child, /FIXTURE:(\d+)\n/, getLogs, t.signal), 4321)
    assert.equal(child.stdout.listenerCount('data'), 1)
    assert.equal(child.listenerCount('close'), 0)
    assert.equal(child.listenerCount('error'), 0)
  } finally {
    const closed = once(child, 'close')
    child.kill()
    await closed
  }
})

void test('fixture startup failure reports drained stderr', { timeout: 5_000 }, async t => {
  const { child, getLogs } = start("process.stderr.write('BOOT_FAILED');process.exitCode=7")
  await assert.rejects(waitForFixtureReady(child, /FIXTURE:(\d+)\n/, getLogs, t.signal), /7.*BOOT_FAILED/)
  assert.equal(child.stdout.listenerCount('data'), 1)
})

void test('parent cancellation ends startup waiting and releases listeners', { timeout: 5_000 }, async () => {
  const { child, getLogs } = start('setInterval(()=>{},1000)')
  const controller = new AbortController()
  const pending = waitForFixtureReady(child, /FIXTURE:(\d+)\n/, getLogs, controller.signal)
  try {
    controller.abort(new Error('parent deadline'))
    await assert.rejects(pending, error => error instanceof Error && error.cause === controller.signal.reason)
    assert.equal(child.stdout.listenerCount('data'), 1)
    assert.equal(child.listenerCount('close'), 0)
  } finally {
    const closed = once(child, 'close')
    child.kill()
    await closed
  }
})
