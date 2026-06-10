import { describe, expect, it } from 'bun:test'
import { PerKeyMutex } from '../runtime/perKeyMutex.js'

describe('PerKeyMutex', () => {
  it('serializes tasks for the same key', async () => {
    const mutex = new PerKeyMutex()
    const trace: string[] = []

    const a = mutex.run('k', async () => {
      trace.push('a-start')
      await new Promise(r => setTimeout(r, 30))
      trace.push('a-end')
      return 1
    })
    const b = mutex.run('k', async () => {
      trace.push('b-start')
      await new Promise(r => setTimeout(r, 5))
      trace.push('b-end')
      return 2
    })
    const c = mutex.run('k', async () => {
      trace.push('c-start')
      return 3
    })

    const [ra, rb, rc] = await Promise.all([a, b, c])
    expect(ra).toBe(1)
    expect(rb).toBe(2)
    expect(rc).toBe(3)
    expect(trace).toEqual(['a-start', 'a-end', 'b-start', 'b-end', 'c-start'])
  })

  it('runs different keys concurrently', async () => {
    const mutex = new PerKeyMutex()
    const order: string[] = []
    const slow = mutex.run('slow', async () => {
      order.push('slow-start')
      await new Promise(r => setTimeout(r, 30))
      order.push('slow-end')
    })
    const fast = mutex.run('fast', async () => {
      order.push('fast-start')
      await new Promise(r => setTimeout(r, 1))
      order.push('fast-end')
    })
    await Promise.all([slow, fast])
    // Both started before slow ended -> not serialized cross-key.
    expect(order.indexOf('fast-end')).toBeLessThan(order.indexOf('slow-end'))
    expect(order.indexOf('fast-start')).toBeLessThan(order.indexOf('slow-end'))
  })

  it('does not poison the queue when a task throws', async () => {
    const mutex = new PerKeyMutex()
    const order: string[] = []
    const failing = mutex.run('k', async () => {
      order.push('boom')
      throw new Error('boom')
    })
    const ok = mutex.run('k', async () => {
      order.push('ok')
      return 'ok'
    })

    await expect(failing).rejects.toThrow('boom')
    await expect(ok).resolves.toBe('ok')
    expect(order).toEqual(['boom', 'ok'])
  })

  it('handles 100 concurrent same-key tasks deterministically', async () => {
    const mutex = new PerKeyMutex()
    let counter = 0
    let maxConcurrent = 0
    let running = 0
    const tasks = Array.from({ length: 100 }, (_, i) =>
      mutex.run('k', async () => {
        running += 1
        maxConcurrent = Math.max(maxConcurrent, running)
        await new Promise(r => setTimeout(r, 1))
        counter += 1
        running -= 1
        return i
      }),
    )
    const results = await Promise.all(tasks)
    expect(counter).toBe(100)
    expect(maxConcurrent).toBe(1)
    expect(results).toEqual(Array.from({ length: 100 }, (_, i) => i))
  })
})
