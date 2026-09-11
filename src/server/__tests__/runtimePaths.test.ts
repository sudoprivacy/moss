// Runs under Node: `tsx --test`. Covers the win32 attach-pipe naming after the
// HA fix (8-2): the Windows named pipe must carry the instanceId so two
// instances on one host never bind the same pipe for the same attempt.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getAttachPath } from '../runtimePaths.js'
import type { ServerConfig } from '../types.js'

// The win32 branch only executes on win32; skip the assertions elsewhere so
// this file is a no-op (not a failure) on Linux/macOS CI.
const win32 = process.platform === 'win32'

describe('getAttachPath win32 instance isolation', () => {
  it('embeds the instanceId in the pipe name', { skip: !win32 }, () => {
    const path = getAttachPath({ instanceId: 'inst-a' } as ServerConfig, 's1', 0)
    assert.ok(
      path.startsWith('\\\\.\\pipe\\moss-inst-a-session-'),
      `expected instance-scoped pipe name, got ${path}`,
    )
  })

  it('gives different pipe names for different instanceIds (same attempt)', { skip: !win32 }, () => {
    const a = getAttachPath({ instanceId: 'inst-a' } as ServerConfig, 's1', 0)
    const b = getAttachPath({ instanceId: 'inst-b' } as ServerConfig, 's1', 0)
    assert.notEqual(a, b)
  })

  it('sanitizes illegal characters in instanceId', { skip: !win32 }, () => {
    const path = getAttachPath({ instanceId: 'a/b:c.d' } as ServerConfig, 's1', 0)
    assert.ok(
      path.includes('moss-a_b_c_d-session-'),
      `expected sanitized instance segment, got ${path}`,
    )
  })

  it("falls back to 'default' when instanceId is absent", { skip: !win32 }, () => {
    const path = getAttachPath({} as ServerConfig, 's1', 0)
    assert.ok(
      path.startsWith('\\\\.\\pipe\\moss-default-session-'),
      `expected default instance segment, got ${path}`,
    )
  })
})
