import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { WorkAdmission } from '@sudo/user-runtime'
import { MossActionExecutor } from '../channels/gateway/MossActionExecutor.js'
import { mossImFixture, mossImMessage } from './testing/mossIm.fixture.js'
import type { RuntimeService } from './runtimeService.js'
import type { SessionCreateInput } from './types.js'
import type { PluginManager } from '../channels/gateway/PluginManager.js'
import type { SessionManager } from '../channels/core/SessionManager.js'
import type { PairingService } from '../channels/pairing/PairingService.js'
import type { DirectConnectStore } from './db.js'
import type { BasePlugin } from '../channels/plugins/BasePlugin.js'
import { ResourceAccessError } from './catalog/resourceError.js'
import { toUnifiedIncomingMessage } from '../channels/plugins/lark/LarkAdapter.js'

type LarkMessageEvent = Extract<Parameters<typeof toUnifiedIncomingMessage>[0], { event?: { message?: unknown } }>

async function fixture() {
  const f = await mossImFixture()
  const sessions = new Map<string, SessionCreateInput & { sessionId: string; status: string; desiredState: string }>()
  const created: SessionCreateInput[] = []
  const inputs: Array<{ sessionId: string; text: string }> = []
  const sends: Array<{ chat: string; text: string }> = []
  const sockets: Array<EventEmitter & { isInputExpired?: boolean }> = []
  let isConnectBlocked = false
  let isReceiving = true
  let isActivityWriteFailed = false
  let isReplySuppressed = false
  let onThinking: (() => Promise<void>) | undefined
  const runtime = {
    workAdmission: new WorkAdmission(),
    createSession: async (input: SessionCreateInput) => {
      created.push(input)
      const sessionId = `session-${created.length}`
      sessions.set(sessionId, { ...input, sessionId, status: 'active', desiredState: 'active' })
      return { sessionId }
    },
    getSessionSnapshot: async (sessionId: string) => sessions.get(sessionId) ?? null,
    requireSessionAgentAccess: async (session: SessionCreateInput) => {
      const member = await f.access.requireUser(session.orgId, session.userId)
      if (member.role !== session.role) throw new ResourceAccessError(403, 'Changed owner role')
    },
    connectInternalChannel: async (sessionId: string) => {
      if (isConnectBlocked) throw new Error('Temporary connection failure')
      const socket = Object.assign(new EventEmitter(), { destroyed: false, isInputExpired: false,
        destroy() { socket.destroyed = true; socket.emit('close') },
        write(value: string) {
          if (socket.isInputExpired) { socket.destroy(); throw new Error('Internal channel credential expired') }
          inputs.push({ sessionId, text: JSON.parse(value).data })
          if (isReplySuppressed) return true
          setTimeout(() => {
            for (const frame of [{ type: 'assistant', content: 'Member reply' }, { type: 'result' }]) {
              socket.emit('data', Buffer.from(JSON.stringify({ type: 'stdout', line: JSON.stringify(frame) }) + '\n'))
            }
          }, 5)
          return true
        } })
      sockets.push(socket)
      return socket
    },
  }
  const store = { getSession: async (id: string) => sessions.get(id) ?? null,
    touchSessionActivity: async () => { if (isActivityWriteFailed) throw new Error('Activity write result unavailable') } }
  const plugin = {
    getBotInfo: () => ({ id: 'cli_testMoss' }),
    sendMessage: async (chat: string, msg: { text: string }) => {
      sends.push({ chat, text: msg.text })
      if (msg.text.includes('Thinking') && onThinking) await onThinking()
      return `reply-${sends.length}`
    },
    editMessage: async (chat: string, _id: string, msg: { text: string }) => { sends.push({ chat, text: msg.text }); return true },
  } as unknown as BasePlugin
  const executor = () => new MossActionExecutor({ getInstanceKey: () => 'lark-qa:owner',
    requireCurrentReceiver: async () => { if (!isReceiving) throw new Error('Receiver lease lost') } } as unknown as PluginManager,
    {} as SessionManager, {} as PairingService, runtime as unknown as RuntimeService, store as unknown as DirectConnectStore, undefined, f.service)
  const deliver = async (instance: MossActionExecutor, sender: string, id: string, text = 'hello') => {
    const message = mossImMessage(sender, id)
    message.content.text = text
    await instance.getMessageHandler()(message, plugin)
  }
  const deliverMentioned = async (instance: MossActionExecutor, id: string, text: string, mentions = [
    { key: '@_user_1', id: { open_id: 'ou_receiver' }, name: 'Moss renamed' },
  ]) => {
    const raw = mossImMessage('feishu-alice', id).raw as LarkMessageEvent
    Object.assign(raw.event!.message!, { message_type: 'text', content: JSON.stringify({ text }), mentions })
    const message = toUnifiedIncomingMessage(raw)!
    await instance.getMessageHandler()(message, plugin)
  }
  return { ...f, sessions, created, inputs, sends, sockets, executor, deliver, deliverMentioned,
    blockConnection: () => { isConnectBlocked = true }, stopReceiving: () => { isReceiving = false },
    failActivityWrite: () => { isActivityWriteFailed = true }, suppressReply: () => { isReplySuppressed = true },
    expireChannels: () => { sockets.forEach(socket => { socket.isInputExpired = true }) },
    beforeInput: (hook: () => Promise<void>) => { onThinking = hook } }
}

void test('unbound group sender receives only a private proof and duplicate delivery never creates a model session', async () => {
  const f = await fixture()
  try {
    const executor = f.executor()
    await f.deliver(executor, 'feishu-alice', 'unbound')
    const privateMessage = f.sends.find(message => message.chat === 'feishu-alice')!
    const code = privateMessage.text.match(/[A-Za-z0-9_-]{32}/)![0]
    assert(!f.sends.filter(message => message.chat === 'chat-group').some(message => message.text.includes(code)))
    assert.equal(f.created.length, 0)
    await f.deliver(executor, 'feishu-alice', 'unbound')
    assert.equal(f.sends.filter(message => message.chat === 'feishu-alice').length, 1)
    await f.service.bind(f.auth('alice'), code)
    await f.deliver(executor, 'feishu-alice', 'bound')
    assert.equal(f.created[0]!.userId, 'alice')
    assert.equal(f.inputs.length, 1)
  } finally { f.sockets.forEach(socket => socket.emit('close')); f.raw.close() }
})

void test('real Lark mention conversion routes new/resume without model input and retains the owner boundary', async () => {
  const f = await fixture()
  try {
    for (const id of ['alice', 'bob']) await f.service.bind(f.auth(id), (await f.service.issueChallenge(f.connection, `feishu-${id}`))!)
    const executor = f.executor()
    await f.deliver(executor, 'feishu-alice', 'alice-initial')
    await f.deliver(executor, 'feishu-bob', 'bob-initial')
    const alice = (await f.service.resolve(f.connection, 'feishu-alice'))!
    const bob = (await f.service.resolve(f.connection, 'feishu-bob'))!
    const old = (await f.service.pointer(alice, 'chat-group'))!
    const inputCount = f.inputs.length
    await f.deliverMentioned(executor, 'mentioned-new', '  @_user_1\n/new ')
    assert.equal(f.created.length, 3)
    assert.notEqual(await f.service.pointer(alice, 'chat-group'), old)
    assert(f.sessions.has(old), 'new retains the previous conversation')
    assert.equal(f.inputs.length, inputCount, 'a mentioned command must never reach the model')
    await f.deliverMentioned(executor, 'mentioned-resume', `@_user_1 /resume ${old}`)
    assert.equal(await f.service.pointer(alice, 'chat-group'), old)
    await f.deliverMentioned(executor, 'mentioned-foreign', `@_user_1 /resume ${await f.service.pointer(bob, 'chat-group')}`)
    assert.equal(await f.service.pointer(alice, 'chat-group'), old)
    assert.equal(f.inputs.length, inputCount, 'resume and denied cross-owner resume send no model input')
    await f.deliverMentioned(executor, 'mentioned-chat', '@_user_1 hello')
    assert.equal(f.inputs.at(-1)!.text.trim(), '@Moss renamed hello')
    await f.deliverMentioned(executor, 'literal-name', '@Moss renamed /new', [])
    assert.equal(f.created.length, 3, 'a display name alone cannot be mistaken for a routing mention')
    await f.deliverMentioned(executor, 'embedded-mention', 'Please explain @_user_1 /new')
    assert.equal(f.created.length, 3, 'a command inside ordinary text stays ordinary text')
  } finally { f.sockets.forEach(socket => socket.emit('close')); f.raw.close() }
})

void test('Lark command normalization uses structured leading mentions and leaves ordinary text intact', () => {
  const mentions = [
    { key: '@_user_1', id: { open_id: 'ou_first' }, name: 'First name' },
    { key: '@_user_2', id: { open_id: 'ou_second' }, name: 'Second name' },
  ]
  for (const [text, expected] of [
    ['@_user_1 @_user_2 /new', '/new'],
    ['@_user_1\n/resume own-session', '/resume own-session'],
    ['@_user_1suffix /new', '@First namesuffix /new'],
    ['@First name /new', '@First name /new'],
    ['Explain @_user_1 /new', 'Explain @First name /new'],
    ['@_user_1 hello @_user_2', '@First name hello @Second name'],
    ['@_user_1', '@First name'],
    ['/new', '/new'],
  ]) {
    const raw = mossImMessage().raw as LarkMessageEvent
    Object.assign(raw.event!.message!, { message_type: 'text', content: JSON.stringify({ text }), mentions })
    assert.equal(toUnifiedIncomingMessage(raw)!.content.text, expected)
  }
})

void test('same-group members retain separate owner sessions through restart, new/resume and reconnect failure', async () => {
  const f = await fixture()
  try {
    for (const id of ['alice', 'bob']) await f.service.bind(f.auth(id), (await f.service.issueChallenge(f.connection, `feishu-${id}`))!)
    const first = f.executor()
    await Promise.all([f.deliver(first, 'feishu-alice', 'a1'), f.deliver(first, 'feishu-bob', 'b1')])
    assert.deepEqual(f.created.map(input => input.userId).sort(), ['alice', 'bob'])
    assert(f.created.every(input => input.role === 'user' && !input.scopes.includes('*') && !input.scopes.includes('sessions:attach:any')))
    const alice = (await f.service.resolve(f.connection, 'feishu-alice'))!
    const old = (await f.service.pointer(alice, 'chat-group'))!
    const restarted = f.executor()
    await f.deliver(restarted, 'feishu-alice', 'a2')
    assert.equal(f.created.length, 2)
    assert.equal(f.inputs.at(-1)!.sessionId, old)
    await f.deliver(restarted, 'feishu-alice', 'a3', '/new')
    assert.equal(f.created.length, 3)
    assert(f.sessions.has(old), 'new never deletes or terminates the old conversation')
    const inputCount = f.inputs.length
    await f.deliver(restarted, 'feishu-alice', 'a4', `/resume ${old}`)
    assert.equal(f.inputs.length, inputCount, 'resume never forwards old history or new model input')
    assert.equal(await f.service.pointer(alice, 'chat-group'), old)
    const bob = (await f.service.resolve(f.connection, 'feishu-bob'))!
    await f.deliver(restarted, 'feishu-alice', 'foreign-resume', `/resume ${await f.service.pointer(bob, 'chat-group')}`)
    assert.equal(await f.service.pointer(alice, 'chat-group'), old)
    f.blockConnection()
    await f.deliver(f.executor(), 'feishu-alice', 'failed-reconnect')
    assert.equal(f.created.length, 3, 'a reconnect failure must preserve the existing Session')
    assert.equal(await f.service.pointer(alice, 'chat-group'), old)
    await f.access.setAccess(f.auth('owner'), 'alice', false)
    await f.deliver(restarted, 'feishu-alice', 'revoked')
    assert.equal(f.inputs.length, inputCount)
    await f.deliver(f.executor(), 'feishu-alice', 'a1')
    assert.equal(f.inputs.length, inputCount, 'duplicate input remains claimed after a fresh executor')
    f.stopReceiving()
    await f.deliver(restarted, 'feishu-bob', 'after-receiver-stop')
    assert.equal(f.inputs.length, inputCount, 'retired receiver cannot dispatch another member input')
  } finally { f.sockets.forEach(socket => socket.emit('close')); f.raw.close() }
})

void test('a timed-out member reply remains unknown and never tells the human to repeat an operation', async (t) => {
  const f = await fixture()
  try {
    await f.service.bind(f.auth('alice'), (await f.service.issueChallenge(f.connection, 'feishu-alice'))!)
    f.suppressReply()
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const delivery = f.deliver(f.executor(), 'feishu-alice', 'unknown-timeout')
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(f.inputs.length, 1)
    t.mock.timers.tick(5 * 60 * 1000)
    await delivery
    const receipt = await f.db.driver.get('SELECT status FROM moss_im_deliveries WHERE message_id = ?', ['unknown-timeout'])
    assert.equal(receipt!.status, 'unknown')
    assert.match(f.sends.at(-1)!.text, /结果尚未确认/)
    assert.match(f.sends.at(-1)!.text, /不要重复发送操作指令/)
    assert(!f.sends.at(-1)!.text.includes('Please try again'))
    assert.equal(f.inputs.length, 1, 'a timeout never replays the input')
  } finally { t.mock.timers.reset(); f.sockets.forEach(socket => socket.emit('close')); f.raw.close() }
})

void test('an idle member conversation obtains fresh internal credentials before its next input without replacing history', async () => {
  const f = await fixture()
  try {
    await f.service.bind(f.auth('alice'), (await f.service.issueChallenge(f.connection, 'feishu-alice'))!)
    const executor = f.executor()
    await f.deliver(executor, 'feishu-alice', 'before-idle')
    const originalSession = f.inputs[0]!.sessionId
    f.expireChannels()
    await f.deliver(executor, 'feishu-alice', 'after-idle')
    assert.equal(f.sockets.length, 2, 'each new turn has a newly authenticated internal channel')
    assert.equal(f.created.length, 1, 'renewing transport cannot replace the durable conversation')
    assert.equal(f.inputs.length, 2)
    assert.equal(f.inputs[1]!.sessionId, originalSession)
    assert(f.sends.at(-1)!.text.includes('Member reply'))
  } finally { f.sockets.forEach(socket => socket.emit('close')); f.raw.close() }
})

void test('the installed promise chain serializes three queued messages and preserves the lock until its last successor', async () => {
  const f = await fixture()
  try {
    const executor = f.executor()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const order: number[] = []
    const first = executor['withConversationLock']('same', async () => { order.push(1); await gate; order.push(2) })
    const second = executor['withConversationLock']('same', async () => { order.push(3); await Promise.resolve(); order.push(4) })
    const third = executor['withConversationLock']('same', async () => { order.push(5) })
    await Promise.resolve(); await Promise.resolve()
    assert.deepEqual(order, [1])
    release()
    await Promise.all([first, second, third])
    assert.deepEqual(order, [1, 2, 3, 4, 5])
  } finally { f.raw.close() }
})

void test('late revocation sends no input, while unknown post-dispatch outcomes warn against repeated operations', async () => {
  for (const outcome of ['revoked', 'unknown', 'receipt-unavailable']) {
    const f = await fixture()
    try {
      await f.service.bind(f.auth('alice'), (await f.service.issueChallenge(f.connection, 'feishu-alice'))!)
      const executor = f.executor()
      if (outcome === 'revoked') f.beforeInput(() => f.access.setAccess(f.auth('owner'), 'alice', false).then(() => {}))
      else f.failActivityWrite()
      if (outcome === 'receipt-unavailable') {
        const original = f.service.delivery.bind(f.service)
        f.service.delivery = async (...args) => {
          if (args[2] !== 'dispatching') throw new Error('Final receipt write unavailable')
          return original(...args)
        }
      }
      await f.deliver(executor, 'feishu-alice', 'boundary-outcome')
      const receipt = await f.db.driver.get('SELECT status FROM moss_im_deliveries WHERE message_id = ?', ['boundary-outcome'])
      assert.equal(receipt!.status, outcome === 'receipt-unavailable' ? 'dispatching' : outcome === 'unknown' ? 'unknown' : 'failed')
      assert.equal(f.inputs.length, outcome === 'revoked' ? 0 : 1)
      if (outcome !== 'revoked') assert(f.sends.some(message => message.text.includes('不要重复发送操作指令')))
      else assert([...executor['channelSessions'].values()].every(state => !state.isProcessing))
      await f.deliver(f.executor(), 'feishu-alice', 'boundary-outcome')
      assert.equal(f.inputs.length, outcome === 'revoked' ? 0 : 1, 'no failure state automatically replays input')
    } finally { f.sockets.forEach(socket => socket.emit('close')); f.raw.close() }
  }
})
