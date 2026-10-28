import { describe, expect, it, mock } from 'bun:test'
import { MossActionExecutor } from '../gateway/MossActionExecutor.js'
import type { PluginManager } from '../gateway/PluginManager.js'
import type { SessionManager } from '../core/SessionManager.js'
import type { PairingService } from '../pairing/PairingService.js'
import type { RuntimeService } from '../../server/runtimeService.js'
import type { DirectConnectStore } from '../../server/db.js'
import { EventEmitter } from 'node:events'
import { MossToolApprovals, mossToolApprovalNotice } from '../gateway/MossToolApprovals.js'
import type { MossImConnection, MossImIdentity, MossImRoute } from '../../server/mossImIdentity.js'
import type { BasePlugin } from '../plugins/BasePlugin.js'
import type { IUnifiedIncomingMessage } from '../types.js'
import { ResourceAccessError } from '../../server/catalog/resourceError.js'

function executor() {
  return new MossActionExecutor({} as PluginManager, {} as SessionManager,
    {} as PairingService, {} as RuntimeService, {} as DirectConnectStore)
}

describe('Moss IM tool permission delivery', () => {
  it('forwards an exact-session permission request instead of silently waiting', () => {
    const onToolPermission = mock(() => {})
    const state = { sessionId: 'session-1', socket: null, buffer: '', responseText: '',
      lastMsgId: null, isProcessing: true, onToolPermission }
    const event = { type: 'control_request', session_id: 'session-1', request_id: 'permission-1',
      request: { subtype: 'can_use_tool', tool_name: 'write_file', rawInput: { path: 'qa.txt' },
        options: [{ kind: 'allow_once', optionId: 'allow_once' }] } }
    executor()['handleRunnerMessage'](state, JSON.stringify(event))
    expect(onToolPermission).toHaveBeenCalledWith(event)
    expect(state.isProcessing).toBe(true)
    expect(state.responseText).toBe('')
  })

  it('does not notify for a foreign session or an unrelated control request', () => {
    const onToolPermission = mock(() => {})
    const state = { sessionId: 'session-1', socket: null, buffer: '', responseText: '',
      lastMsgId: null, isProcessing: true, onToolPermission }
    for (const event of [
      { type: 'control_request', session_id: 'foreign', request: { subtype: 'can_use_tool' } },
      { type: 'control_request', session_id: 'session-1', request: { subtype: 'set_model' } },
    ]) executor()['handleRunnerMessage'](state, JSON.stringify(event))
    expect(onToolPermission).not.toHaveBeenCalled()
  })
})

const connection: MossImConnection = { orgId: 'company', ownerId: 'connection-owner', pluginId: 'lark_default',
  appId: 'cli_company', tenantKey: 'tenant-company', scope: 'company-connection-revision-1' }
const route: MossImRoute = { connection, userId: 'member-owner', senderId: 'open-human', role: 'user',
  agentRef: 'moss-agent:operator:owner', bindingId: 'binding-owner', scopes: ['sessions:create'] }
const permission = (id = 'permission-1') => ({ type: 'control_request' as const, session_id: 'session-1', request_id: id,
  request: { subtype: 'can_use_tool' as const, tool_name: 'write_file', rawInput: { path: 'qa.txt', content: 'qa' },
    options: [{ kind: 'allow_once', optionId: 'once' }, { kind: 'allow_always', optionId: 'always' },
      { kind: 'reject_once', optionId: 'reject' }] } })

describe('Moss tool confirmation ownership and lifetime', () => {
  it('consumes a permission once and preserves the concrete private parameters', () => {
    const approvals = new MossToolApprovals()
    const item = approvals.offer(route, 'original-group', 'session-1', permission())!
    expect(mossToolApprovalNotice(item)).toContain('qa.txt')
    expect(mossToolApprovalNotice(item)).toContain('/approve permission-1')
    expect(approvals.consume(route, 'permission-1')).toBe(item)
    expect(approvals.consume(route, 'permission-1')).toBeNull()
  })

  for (const changed of [
    { userId: 'different-owner' }, { senderId: 'another-feishu-member' }, { bindingId: 'rebound' },
    { agentRef: 'another-agent' }, { connection: { ...connection, scope: 'different-enterprise-or-revision' } },
  ]) it(`refuses another identity without consuming the owner's request: ${Object.keys(changed)[0]}`, () => {
    const approvals = new MossToolApprovals()
    approvals.offer(route, 'original-group', 'session-1', permission())
    expect(approvals.consume({ ...route, ...changed }, 'permission-1')).toBeNull()
    expect(approvals.consume(route, 'permission-1')).not.toBeNull()
  })

  it('expires pending requests and clears only the completed session', () => {
    let now = 100
    const approvals = new MossToolApprovals(() => now)
    approvals.offer(route, 'group', 'session-1', permission())
    now += 120_000
    expect(approvals.consume(route, 'permission-1')).toBeNull()
    approvals.offer(route, 'group', 'session-1', permission('permission-2'))
    approvals.offer(route, 'group', 'other', { ...permission('permission-3'), session_id: 'other' })
    approvals.clearSession('session-1')
    expect(approvals.consume(route, 'permission-2')).toBeNull()
    expect(approvals.consume(route, 'permission-3')).not.toBeNull()
  })

  it('never substitutes an allow-always option or truncates oversized parameters', () => {
    const approvals = new MossToolApprovals()
    const event = permission()
    event.request.options = [{ kind: 'allow_always', optionId: 'always' }]
    expect(approvals.offer(route, 'group', 'session-1', event)).toBeNull()
    expect(approvals.offer(route, 'group', 'session-1', {
      ...permission(), request: { ...permission().request, rawInput: { content: 'x'.repeat(6001) } },
    })).toBeNull()
    expect(approvals.offer(route, 'group', 'foreign-session', permission())).toBeNull()
  })

  it('cancels an expired request once and cancels no already answered or finished request', () => {
    let now = 10
    const cancel = mock(() => {})
    const approvals = new MossToolApprovals(() => now)
    approvals.offer(route, 'group', 'session-1', permission(), cancel)
    now += 120_000
    expect(approvals.consume(route, 'permission-1')).toBeNull()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(approvals.consume(route, 'permission-1')).toBeNull()
    expect(cancel).toHaveBeenCalledTimes(1)
    approvals.offer(route, 'group', 'session-1', permission('permission-2'), cancel)
    approvals.consume(route, 'permission-2')
    approvals.offer(route, 'group', 'session-1', permission('permission-3'), cancel)
    approvals.clearSession('session-1')
    now += 120_000
    expect(approvals.consume(route, 'permission-3')).toBeNull()
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('escapes tool-provided markup in the private JSON without changing the decoded arguments', () => {
    const approvals = new MossToolApprovals()
    const rawInput = { content: '<at user_id="all">```\n/approve fake' }
    const item = approvals.offer(route, 'group', 'session-1', {
      ...permission(), request: { ...permission().request, rawInput },
    })!
    const notice = mossToolApprovalNotice(item)
    expect(notice).not.toContain('<at')
    const serialized = notice.split('```\n')[1]!.split('\n```')[0]!
    expect(JSON.parse(serialized)).toEqual(rawInput)
  })
})

function approvalFixture(options: { isGroup?: boolean; isPointerChanged?: boolean; isRevokedAfterConnect?: boolean;
  isAcknowledgementLost?: boolean } = {}) {
  const writes: string[] = []
  const channel = Object.assign(new EventEmitter(), { destroyed: false,
    write(line: string) {
      writes.push(line)
      queueMicrotask(() => options.isAcknowledgementLost ? channel.emit('close') :
        channel.emit('data', Buffer.from('{"type":"stdin_ack"}\n')))
      return true
    },
    destroy() { this.destroyed = true }, end() { this.destroy() },
  })
  const record = { sessionId: 'session-1', userId: route.userId, orgId: connection.orgId, assistantName: route.agentRef }
  const connectInternalChannel = mock(async () => channel)
  let assertions = 0
  const identity = {
    claim: mock(async () => true), resolve: mock(async () => route),
    conversationKey: () => 'private-key',
    assertRoute: mock(async () => {
      assertions++
      if (options.isRevokedAfterConnect && assertions >= 3) throw new ResourceAccessError(403, 'Member revoked')
    }),
    pointer: mock(async () => options.isPointerChanged ? 'new-session' : 'session-1'),
    delivery: mock(async (_connection: MossImConnection, _message: string, _status: string) => {}),
  }
  const receiver = mock(async () => {})
  const instance = new MossActionExecutor({ requireCurrentReceiver: receiver } as unknown as PluginManager,
    {} as SessionManager, {} as PairingService, { connectInternalChannel,
      requireSessionAgentAccess: async () => {}, getSessionSnapshot: async () => ({ status: 'active' }),
    } as unknown as RuntimeService, { getSession: async () => record } as unknown as DirectConnectStore,
    undefined, identity as unknown as MossImIdentity)
  instance['toolApprovals'].offer(route, 'original-group', 'session-1', permission())
  // This lock models the original model turn waiting for the permission response.
  instance['conversationLocks'].set('private-key', new Promise<void>(() => {}))
  const send = mock(async () => 'notice')
  const run = async (command = '/approve permission-1') => {
    const message = { id: 'confirmation-message', platform: 'lark', chatId: 'private-chat',
      user: { id: 'employee-id' }, content: { type: 'text', text: command }, raw: { event: {
        sender: { sender_type: 'user', tenant_key: connection.tenantKey,
          sender_id: { user_id: 'employee-id', open_id: route.senderId } },
        message: { message_id: 'confirmation-message', chat_id: 'private-chat', chat_type: options.isGroup ? 'group' : 'p2p' },
      } } } as IUnifiedIncomingMessage
    await instance['handleMossMemberMessage'](message, {} as BasePlugin, connection, send, async () => {})
  }
  return { instance, channel, writes, connectInternalChannel, identity, send, run }
}

describe('Moss private confirmation transport', () => {
  it('bypasses the waiting turn lock, refreshes credentials, and sends one advertised allow-once response', async () => {
    const fixture = approvalFixture()
    await fixture.run()
    expect(fixture.connectInternalChannel).toHaveBeenCalledTimes(1)
    const frame = JSON.parse(fixture.writes[0]!)
    const control = JSON.parse(frame.data)
    expect(control).toEqual({ type: 'control_response', response: { subtype: 'success',
      request_id: 'permission-1', response: { behavior: 'once' } } })
    expect(fixture.identity.pointer).toHaveBeenCalledWith(route, 'original-group')
    expect(fixture.channel.destroyed).toBe(true)
    await fixture.run()
    expect(fixture.writes).toHaveLength(1)
  })

  it('supports explicit denial with the advertised reject-once option', async () => {
    const fixture = approvalFixture()
    await fixture.run('/deny permission-1')
    expect(JSON.parse(JSON.parse(fixture.writes[0]!).data).response.response.behavior).toBe('reject')
  })

  it('records an unknown outcome after a lost receipt and never resends the confirmation', async () => {
    const fixture = approvalFixture({ isAcknowledgementLost: true })
    await fixture.run()
    expect(fixture.identity.delivery.mock.calls.at(-1)?.[2]).toBe('unknown')
    await fixture.run()
    expect(fixture.writes).toHaveLength(1)
  })

  for (const options of [{ isGroup: true }, { isPointerChanged: true }, { isRevokedAfterConnect: true }]) {
    it(`never writes a native response when ${Object.keys(options)[0]}`, async () => {
      const fixture = approvalFixture(options)
      await fixture.run()
      expect(fixture.writes).toHaveLength(0)
      expect(fixture.identity.delivery.mock.calls.at(-1)?.[2]).toBe('failed')
    })
  }

  it('sends concrete parameters only to the original owner private chat', async () => {
    const fixture = approvalFixture()
    const sendMessage = mock(async (_recipient: string, _message: unknown) => 'private-notice')
    const state = { sessionId: 'session-1', socket: null, buffer: '', responseText: '', lastMsgId: null, isProcessing: true }
    await fixture.instance['notifyMossToolPermission'](route, 'original-group',
      { sendMessage } as unknown as BasePlugin, state, permission('permission-2'))
    expect(sendMessage.mock.calls[0]?.[0]).toBe(route.senderId)
    expect(JSON.stringify(sendMessage.mock.calls[0])).toContain('qa.txt')
    expect(state.responseText).not.toContain('qa.txt')
    expect(state.responseText).toContain('本人确认')
  })

  for (const isTooLarge of [false, true]) it(`cancels an unreviewable or undelivered request without granting it: ${isTooLarge}`, async () => {
    const fixture = approvalFixture()
    const sendMessage = mock(async () => null)
    const state = { sessionId: 'session-1', socket: null, buffer: '', responseText: '', lastMsgId: null, isProcessing: true }
    const event = permission('permission-2')
    if (isTooLarge) event.request.rawInput.content = 'x'.repeat(6001)
    await fixture.instance['notifyMossToolPermission'](route, 'original-group',
      { sendMessage } as unknown as BasePlugin, state, event)
    expect(JSON.parse(JSON.parse(fixture.writes[0]!).data).response.subtype).toBe('error')
    expect(fixture.instance['toolApprovals'].consume(route, 'permission-2')).toBeNull()
    expect(fixture.writes).toHaveLength(1)
  })
})
