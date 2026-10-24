/** Shared real-product WebSocket journey. Preserve the deployed protocol and budgets. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'

export function productConversation(url: string, token: string, evidence: string, name: string) {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } })
  const events: any[] = []
  let resolveHello: (() => void) | undefined
  let rejectHello: ((error: Error) => void) | undefined
  const hello = new Promise<void>((resolve, reject) => { resolveHello = resolve; rejectHello = reject })
  let pending: { resolve(value: string): void, reject(error: Error): void, text: string } | undefined
  const fail = (error: Error) => { rejectHello?.(error); pending?.reject(error); pending = undefined }
  socket.on('error', fail)
  socket.on('close', () => { if (pending) fail(new Error('WebSocket closed during a live turn')) })
  socket.on('message', bytes => {
    try {
      const event = JSON.parse(bytes.toString())
      events.push(event)
      if (event.type === 'hello') resolveHello?.()
      if (event.type === 'error' || event.type === 'control_request') throw new Error(`Unexpected live event: ${event.type}`)
      if (event.type === 'assistant' && pending) {
        const content = event.message?.content
        pending.text += typeof content === 'string' ? content : Array.isArray(content)
          ? content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('') : ''
      }
      if (event.type === 'result' && pending) {
        assert.equal(event.status, 'success')
        pending.resolve(pending.text); pending = undefined
      }
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))) }
  })
  return {
    ready: () => Promise.race([hello, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('WebSocket hello timed out')), 30_000).unref())]),
    async turn(text: string) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await new Promise<string>((resolve, reject) => {
          assert(!pending)
          pending = { resolve, reject, text: '' }
          timer = setTimeout(() => fail(new Error('Live WebSocket turn timed out')), 180_000)
          socket.send(JSON.stringify({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: text } }))
        })
      } finally { clearTimeout(timer) }
    },
    close() {
      writeFileSync(join(evidence, `${name}.private.json`), JSON.stringify(events), { mode:0o600 })
      socket.close()
    },
  }
}
