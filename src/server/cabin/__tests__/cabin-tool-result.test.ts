import { describe, expect, it } from 'bun:test'
import { extractHardwareToolResult } from '../service.js'

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
