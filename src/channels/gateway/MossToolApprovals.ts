import type { MossImRoute } from '../../server/mossImIdentity.js'

export interface MossToolPermission {
  type: 'control_request'
  session_id: string
  request_id: string
  request: { subtype: 'can_use_tool'; tool_name: string; rawInput: unknown
    options: Array<{ kind: string; optionId: string }> }
}

export interface PendingMossToolApproval {
  route: MossImRoute
  chatId: string
  sessionId: string
  event: MossToolPermission
  expiresAt: number
  timer?: ReturnType<typeof setTimeout>
  onExpire?: () => void
}

/** Pending confirmations are scoped to one verified human and one live turn. */
export class MossToolApprovals {
  private readonly pending = new Map<string, PendingMossToolApproval>()

  constructor(private readonly now: () => number = Date.now) {}

  offer(route: MossImRoute, chatId: string, sessionId: string, value: unknown, onExpire?: () => void): PendingMossToolApproval | null {
    const event = value as MossToolPermission | null
    const request = event?.request
    if (event?.type !== 'control_request' || event.session_id !== sessionId ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(event.request_id ?? '') ||
        request?.subtype !== 'can_use_tool' || !/^[a-zA-Z0-9_/-]{1,100}$/.test(request.tool_name ?? '') ||
        !Array.isArray(request.options) ||
        !request.options.some(option => option.kind === 'allow_once' && typeof option.optionId === 'string') ||
        JSON.stringify(request.rawInput ?? null).length > 6000) return null
    for (const [id, item] of this.pending) if (item.expiresAt <= this.now()) this.expire(id, item)
    if (this.pending.has(event.request_id) || this.pending.size >= 256) return null
    const item: PendingMossToolApproval = { route, chatId, sessionId, event, expiresAt: this.now() + 120_000, onExpire }
    this.pending.set(event.request_id, item)
    if (onExpire) {
      item.timer = setTimeout(() => this.expire(event.request_id, item), 120_000)
      item.timer.unref()
    }
    return item
  }

  consume(route: MossImRoute, requestId: string): PendingMossToolApproval | null {
    const item = this.pending.get(requestId)
    if (!item) return null
    if (item.expiresAt <= this.now()) { this.expire(requestId, item); return null }
    const expected = item.route
    if (route.userId !== expected.userId || route.senderId !== expected.senderId ||
        route.agentRef !== expected.agentRef || route.bindingId !== expected.bindingId ||
        route.connection.scope !== expected.connection.scope) return null
    this.pending.delete(requestId)
    clearTimeout(item.timer)
    return item
  }

  has(requestId: string): boolean { return this.pending.has(requestId) }

  clearSession(sessionId: string): void {
    for (const [id, item] of this.pending) if (item.sessionId === sessionId) {
      this.pending.delete(id)
      clearTimeout(item.timer)
    }
  }

  private expire(requestId: string, item: PendingMossToolApproval): void {
    if (this.pending.get(requestId) !== item) return
    this.pending.delete(requestId)
    clearTimeout(item.timer)
    item.onExpire?.()
  }
}

/** JSON escapes keep untrusted tool parameters inside the private code block. */
export function mossToolApprovalNotice(item: PendingMossToolApproval): string {
  let argumentsValue = item.event.request.rawInput ?? null
  if (typeof argumentsValue === 'string') {
    try { argumentsValue = JSON.parse(argumentsValue) }
    catch { /* Preserve the complete original value if it is not JSON. */ }
  }
  const input = JSON.stringify(argumentsValue, null, 2)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/`/g, '\\u0060')
  return `Moss 工具确认（2 分钟内有效，只允许这一次）\n工具：${item.event.request.tool_name}\n会话：${item.sessionId}\n参数（JSON）：\n\`\`\`\n${input}\n\`\`\`\n` +
    `确认后请在本私聊回复：\n/approve ${item.event.request_id}\n拒绝请回复：\n/deny ${item.event.request_id}\n不要在群里发送确认命令。`
}
