import { describe, expect, it } from 'bun:test'
import {
  extractHardwareToolResult,
  extractHardwareCommandSpec,
  extractHardwareCommandFromToolUse,
  lineHasToolUse,
} from '../service.js'

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

describe('extractHardwareCommandSpec', () => {
  it('parses an emit-mode command payload from a tool_result', () => {
    const emit = JSON.stringify({
      ok: true,
      mode: 'emit',
      command: 'seat.light',
      seat_no: 'A',
      params: { on: true, pwm: 800 },
    })
    expect(extractHardwareCommandSpec(userEnvelope(emit))).toEqual({
      command: 'seat.light',
      params: { on: true, pwm: 800 },
      seatNo: 'A',
    })
  })

  it('parses a no-param command payload', () => {
    const emit = JSON.stringify({ ok: true, mode: 'emit', command: 'seat.tray.open', seat_no: 'B', params: {} })
    expect(extractHardwareCommandSpec(userEnvelope(emit))).toEqual({
      command: 'seat.tray.open',
      params: {},
      seatNo: 'B',
    })
  })

  it('ignores execute-mode dispatch results (no mode:emit)', () => {
    const executeResult = JSON.stringify({ ok: true, execution_status: 'dispatched', command: 'seat.tray.open' })
    expect(extractHardwareCommandSpec(userEnvelope(executeResult))).toBeNull()
  })

  it('ignores non-emit and non-JSON lines', () => {
    expect(extractHardwareCommandSpec(userEnvelope('unrelated output'))).toBeNull()
    expect(extractHardwareCommandSpec(userEnvelope(JSON.stringify({ mode: 'other', command: 'seat.light' })))).toBeNull()
    expect(extractHardwareCommandSpec('not json')).toBeNull()
  })

  it('drops non-primitive param values', () => {
    const emit = JSON.stringify({
      ok: true,
      mode: 'emit',
      command: 'seat.cushion',
      seat_no: 'A',
      params: { position: 30, nested: { x: 1 } },
    })
    expect(extractHardwareCommandSpec(userEnvelope(emit))).toEqual({
      command: 'seat.cushion',
      params: { position: 30 },
      seatNo: 'A',
    })
  })
})

describe('extractHardwareCommandFromToolUse', () => {
  // Mirrors the real scode ACP event: the model emits the bash tool_use with a
  // stringified JSON input carrying the shell command (with backslash line-continuations
  // and quoted values), and never waits for the tool_result.
  it('parses the emit command straight from a top-level bash tool_use event', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      name: 'bash',
      tool_use_id: 'toolu_01',
      input: JSON.stringify({
        command:
          'node .nexus/sudocode/skills/cabin-hardware-control/scripts/cabin-control.mjs \\\n  --command seat.cushion \\\n  --seat-no "01A" \\\n  --column-no "A" \\\n  --position 60',
        dangerouslyDisableSandbox: true,
      }),
    })
    expect(extractHardwareCommandFromToolUse(line)).toEqual({
      command: 'seat.cushion',
      params: { position: '60' },
      seatNo: '01A',
    })
  })

  it('parses a bash tool_use nested in an assistant message content array', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '好的' },
          {
            type: 'tool_use',
            name: 'Bash',
            input: { command: 'node scripts/cabin-control.mjs --command seat.tray.open --seat-no 01A' },
          },
        ],
      },
    })
    expect(extractHardwareCommandFromToolUse(line)).toEqual({
      command: 'seat.tray.open',
      params: {},
      seatNo: '01A',
    })
  })

  it('captures on/pwm flags and drops seat identity flags', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      name: 'bash',
      input: { command: 'node cabin-control.mjs --command seat.light --seat-no 01A --on true --pwm 800' },
    })
    expect(extractHardwareCommandFromToolUse(line)).toEqual({
      command: 'seat.light',
      params: { on: 'true', pwm: '800' },
      seatNo: '01A',
    })
  })

  it('ignores the Skill tool_use and other non-bash tools', () => {
    const skill = JSON.stringify({ type: 'tool_use', name: 'Skill', input: '{"skill":"cabin-hardware-control"}' })
    expect(extractHardwareCommandFromToolUse(skill)).toBeNull()
  })

  it('ignores bash commands that do not invoke cabin-control', () => {
    const line = JSON.stringify({ type: 'tool_use', name: 'bash', input: { command: 'ls -la /tmp' } })
    expect(extractHardwareCommandFromToolUse(line)).toBeNull()
  })

  it('returns null when the command flag is missing', () => {
    const line = JSON.stringify({ type: 'tool_use', name: 'bash', input: { command: 'node cabin-control.mjs --seat-no 01A' } })
    expect(extractHardwareCommandFromToolUse(line)).toBeNull()
  })

  it('returns null for non-JSON and non-tool_use lines', () => {
    expect(extractHardwareCommandFromToolUse('not json')).toBeNull()
    expect(extractHardwareCommandFromToolUse(JSON.stringify({ type: 'assistant', message: { content: 'hi' } }))).toBeNull()
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
