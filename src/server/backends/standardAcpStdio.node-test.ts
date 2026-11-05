import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { StdioAcpTransport } from './acpTransport.js'
import { StandardAcpDriver } from './standardAcpDriver.js'

async function worker(profile: string, cwd: string, onChunk: () => void, finish = false) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/standard-acp-worker.mjs', import.meta.url)), profile, cwd, finish ? 'finish' : 'cancel'], {
    // No model key, provider account, operator home or login state is inherited.
    env: { PATH: process.env.PATH, HOME: cwd }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const exit = new Promise<void>((resolve, reject) => { child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Fixture exited ${code}`))); child.once('error', reject) })
  const driver = new StandardAcpDriver(new StdioAcpTransport(child, true), {
    onNotification: message => { if (message.method === 'session/update') onChunk() },
  })
  return { driver, stop: async () => { await driver.close(); await exit } }
}

for (const profile of ['plain', 'recoverable']) {
  void test(`account-free stdio ${profile} producer forwards literal input, streaming and cancellation`, { timeout: 10000 }, async t => {
    const cwd = await mkdtemp(join(tmpdir(), 'moss-standard-acp-'))
    const workers: Array<Awaited<ReturnType<typeof worker>>> = []
    t.after(async () => {
      try { for (const child of workers) await child.stop() }
      finally { await rm(cwd, { recursive: true, force: true }) }
    })
    let chunk!: () => void
    const update = new Promise<void>(resolve => { chunk = resolve })
    const first = await worker(profile, cwd, () => chunk()); workers.push(first)
    const { driver } = first
    const sessionId = await driver.open({ cwd })
    const text = 'Original task\n不改写、不加模型 🙂'
    const result = driver.prompt(sessionId, text)
    await update
    assert.deepEqual(JSON.parse(await readFile(join(cwd, 'literal-input.json'), 'utf8')), [{ type: 'text', text }])
    await driver.cancel(sessionId)
    assert.deepEqual(await result, { stopReason: 'cancelled' })
    assert.equal(driver.status(sessionId).pending, false)
    if (profile === 'recoverable') {
      await driver.close()
      const next = await worker(profile, cwd, () => {}, true); workers.push(next)
      const restored = next.driver
      assert.equal(await restored.open({ cwd, resumeSessionId: sessionId }), sessionId)
      assert.deepEqual(await restored.prompt(sessionId, 'Continue the controlled session'), { stopReason: 'end_turn' })
    }
  })
}
