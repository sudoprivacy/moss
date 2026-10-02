import assert from 'node:assert/strict'
import { test } from 'node:test'
import { copyToClipboard } from '../lib/clipboard'

async function withBrowser(
  options: { clipboard?: 'available' | 'denied'; dialog?: boolean; copy?: 'false' | 'throw' } = {},
  check: (state: { modern: string[]; copied: string[]; containers: string[]; removed: number; restored: number }) => Promise<void>,
) {
  const descriptors = ['navigator', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  const state = { modern: [] as string[], copied: [] as string[], containers: [] as string[], removed: 0, restored: 0 }
  const container = (name: string) => ({ appendChild: () => state.containers.push(name) })
  const textarea = { value: '', readOnly: false, style: { cssText: '' }, focus: () => {}, select: () => {}, remove: () => { state.removed += 1 } }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    clipboard: options.clipboard ? { writeText: async (text: string) => {
      state.modern.push(text)
      if (options.clipboard === 'denied') throw new Error('Not allowed')
    } } : undefined,
  } })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    activeElement: { closest: () => options.dialog ? container('dialog') : null, focus: () => { state.restored += 1 } },
    body: container('body'),
    createElement: () => textarea,
    execCommand: (command: string) => {
      assert.equal(command, 'copy')
      state.copied.push(textarea.value)
      if (options.copy === 'throw') throw new Error('Copy unsupported')
      return options.copy !== 'false'
    },
  } })
  try {
    await check(state)
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('uses modern clipboard without allocating a fallback element', async () => {
  await withBrowser({ clipboard: 'available' }, async state => {
    await copyToClipboard('fixture')
    assert.deepEqual(state.modern, ['fixture'])
    assert.deepEqual(state.containers, [])
  })
})

test('HTTP fallback stays inside the dialog and restores focus', async () => {
  await withBrowser({ dialog: true }, async state => {
    await copyToClipboard('fixture')
    assert.deepEqual(state.copied, ['fixture'])
    assert.deepEqual(state.containers, ['dialog'])
    assert.equal(state.removed, 1)
    assert.equal(state.restored, 1)
  })
})

test('falls back after Clipboard API permission rejection', async () => {
  await withBrowser({ clipboard: 'denied', dialog: true }, async state => {
    await copyToClipboard('fixture')
    assert.deepEqual(state.modern, ['fixture'])
    assert.deepEqual(state.copied, ['fixture'])
    assert.deepEqual(state.containers, ['dialog'])
  })
})

test('outside dialogs the fallback uses the document body', async () => {
  await withBrowser({}, async state => {
    await copyToClipboard('fixture')
    assert.deepEqual(state.containers, ['body'])
  })
})

for (const copy of ['false', 'throw'] as const) {
  test(`failed fallback (${copy}) rejects and always removes selected text`, async () => {
    await withBrowser({ copy, dialog: true }, async state => {
      await assert.rejects(copyToClipboard('fixture'))
      assert.equal(state.removed, 1)
      assert.equal(state.restored, 1)
    })
  })
}
