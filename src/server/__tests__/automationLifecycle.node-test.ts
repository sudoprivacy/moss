import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { AutomationLifecycle } from '../services/automation/AutomationLifecycle.js'

describe('企业自动化后台生命周期', () => {
  it('启动失败时按逆序停止已进入启动流程的模块', async () => {
    const calls: string[] = []
    const lifecycle = new AutomationLifecycle([
      {
        name: 'cron',
        async start() { calls.push('start:cron') },
        async stop() { calls.push('stop:cron') },
      },
      {
        name: 'event',
        async start() { calls.push('start:event') },
        async stop() { calls.push('stop:event') },
      },
      {
        name: 'channel',
        async start() {
          calls.push('start:channel')
          throw new Error('channel startup failed')
        },
        async stop() { calls.push('stop:channel') },
      },
    ])

    await assert.rejects(lifecycle.start(), /channel startup failed/)
    assert.deepEqual(calls, [
      'start:cron',
      'start:event',
      'start:channel',
      'stop:channel',
      'stop:event',
      'stop:cron',
    ])
  })

  it('并发调用 stop 只执行一次并等待正在停止的模块', async () => {
    const calls: string[] = []
    let releaseStop!: () => void
    const stopGate = new Promise<void>(resolve => { releaseStop = resolve })
    const lifecycle = new AutomationLifecycle([
      {
        name: 'cron',
        async start() { calls.push('start:cron') },
        async stop() {
          calls.push('stop:cron')
          await stopGate
        },
      },
      {
        name: 'event',
        async start() { calls.push('start:event') },
        async stop() { calls.push('stop:event') },
      },
    ])
    await lifecycle.start()

    const first = lifecycle.stop()
    const second = lifecycle.stop()
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(first, second)
    assert.deepEqual(calls, ['start:cron', 'start:event', 'stop:event', 'stop:cron'])
    releaseStop()
    await first
    assert.deepEqual(calls, ['start:cron', 'start:event', 'stop:event', 'stop:cron'])
  })
})
