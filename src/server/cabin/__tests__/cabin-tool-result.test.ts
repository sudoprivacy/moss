import { describe, expect, it } from 'bun:test'
import { extractHardwareToolResult, lineHasToolUse, mentionsHardwareActionClaim } from '../service.js'

function userEnvelope(toolResultText: string): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', content: [{ type: 'text', text: toolResultText }] },
      ],
    },
  })
}

describe('extractHardwareToolResult', () => {
  it('parses a successful hardware dispatch with its passenger reply hint', () => {
    const mjsOutput = JSON.stringify({
      ok: true,
      execution_status: 'dispatched',
      passenger_reply_hint: '已为您下发打开小桌板的指令，请稍候。',
      command: 'seat.tray.open',
      code: 0,
    })
    const result = extractHardwareToolResult(userEnvelope(mjsOutput))
    expect(result).toEqual({
      ok: true,
      passengerReplyHint: '已为您下发打开小桌板的指令，请稍候。',
      command: 'seat.tray.open',
      executionStatus: 'dispatched',
      httpStatus: undefined,
    })
  })

  it('parses a failed dispatch with its command and http status', () => {
    const mjsOutput = JSON.stringify({ ok: false, execution_status: 'failed', command: 'seat.light', http_status: 500, code: 500 })
    expect(extractHardwareToolResult(userEnvelope(mjsOutput))).toEqual({
      ok: false,
      passengerReplyHint: undefined,
      command: 'seat.light',
      executionStatus: 'failed',
      httpStatus: 500,
    })
  })

  it('handles a string tool_result payload', () => {
    const mjsOutput = JSON.stringify({ ok: true, execution_status: 'dispatched' })
    const envelope = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content: mjsOutput }] },
    })
    expect(extractHardwareToolResult(envelope)).toEqual({
      ok: true,
      passengerReplyHint: undefined,
      command: undefined,
      executionStatus: 'dispatched',
      httpStatus: undefined,
    })
  })

  it('ignores assistant events', () => {
    const envelope = JSON.stringify({ type: 'assistant', message: { content: 'hello' } })
    expect(extractHardwareToolResult(envelope)).toBeNull()
  })

  it('ignores tool_result output that is not the hardware payload', () => {
    expect(extractHardwareToolResult(userEnvelope('some unrelated command output'))).toBeNull()
    expect(extractHardwareToolResult(userEnvelope(JSON.stringify({ foo: 'bar' })))).toBeNull()
  })

  it('returns null for non-JSON lines', () => {
    expect(extractHardwareToolResult('not json')).toBeNull()
  })
})

describe('mentionsHardwareActionClaim', () => {
  it('flags fabricated dispatch/completion wording', () => {
    expect(mentionsHardwareActionClaim('已为您下发打开阅读灯的指令，请稍候。')).toBe(true)
    expect(mentionsHardwareActionClaim('好的，已为您打开阅读灯。')).toBe(true)
    expect(mentionsHardwareActionClaim('阅读灯已关闭。')).toBe(true)
    expect(mentionsHardwareActionClaim('座椅已调好啦。')).toBe(true)
    expect(mentionsHardwareActionClaim('正在为您调节亮度。')).toBe(true)
  })

  it('does not flag non-committal or clarifying replies', () => {
    expect(mentionsHardwareActionClaim('收到，我这就为您处理。')).toBe(false)
    expect(mentionsHardwareActionClaim('请问您需要调节到多亮呢？')).toBe(false)
    expect(mentionsHardwareActionClaim('阅读灯已经是开着的哦。')).toBe(false)
    expect(mentionsHardwareActionClaim('')).toBe(false)
  })
})

describe('lineHasToolUse', () => {
  it('detects a top-level tool_use event', () => {
    expect(lineHasToolUse(JSON.stringify({ type: 'tool_use', name: 'Bash', input: {} }))).toBe(true)
  })

  it('detects a tool_use block nested in an assistant message', () => {
    const envelope = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '好的' }, { type: 'tool_use', name: 'Bash', input: {} }] },
    })
    expect(lineHasToolUse(envelope)).toBe(true)
  })

  it('returns false for assistant text-only, user, and non-JSON lines', () => {
    expect(lineHasToolUse(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }))).toBe(false)
    expect(lineHasToolUse(JSON.stringify({ type: 'user', message: { content: 'hi' } }))).toBe(false)
    expect(lineHasToolUse('not json')).toBe(false)
  })
})
