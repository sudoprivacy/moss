/**
 * 崩溃会话历史保留 / Crash-session history rescue
 *
 * A session that dies on its own (crashed runtime, lost container) is classified
 * 'replace' — its runtime cannot be reused or respawned. But its transcript is still on
 * disk: terminateSession only kills the process and flips status, and nothing in the
 * codebase ever deletes a transcript. Rotation and /restart already carry that history
 * into the successor; a crash was the one replace path that dropped it silently.
 *
 * These cover the policy that decides WHEN to rescue, and the seed builder that decides
 * WHAT gets carried over.
 */

import { describe, it, expect } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyMossSession } from '../../server/sessionRecovery.js'
import { buildTranscriptSeed } from '../gateway/transcriptSeed.js'
import type { SessionSnapshot } from '../../server/runtimeService.js'
import type { SessionStatus } from '../../server/types.js'

function snapshot(status: SessionStatus, desiredState: 'active' | 'ended' | 'terminated' = 'active'): SessionSnapshot {
  return {
    sessionId: 's1',
    status,
    desiredState,
    endedAt: null,
    currentAttemptId: null,
    attempt: null,
  } as SessionSnapshot
}

/**
 * The guard added to createRuntimeSession: on a 'replace' verdict, rescue history only
 * for a session that died on its own — never for a deliberate termination.
 */
function shouldRescue(status: SessionStatus): boolean {
  if (classifyMossSession(snapshot(status)) !== 'replace') return false
  return status === 'lost' || status === 'failed'
}

describe('crash rescue policy', () => {
  it('rescues history from a runtime that died on its own', () => {
    expect(shouldRescue('lost')).toBe(true)
    expect(shouldRescue('failed')).toBe(true)
  })

  it('does NOT rescue a deliberate termination', () => {
    // 'terminated' is what /agent writes when the user switches agent; that flow means to
    // start clean, and seeding it would undo the reset the user just asked for.
    expect(shouldRescue('terminated')).toBe(false)
  })

  it('leaves recoverable sessions alone — they replay the full transcript, not a summary', () => {
    // These never reach the rescue path: ensureSessionReady respawns them and ACP
    // session/load replays the whole transcript, which is strictly better than a seed.
    for (const status of ['active', 'detached', 'creating'] as SessionStatus[]) {
      expect(classifyMossSession(snapshot(status))).not.toBe('replace')
      expect(shouldRescue(status)).toBe(false)
    }
  })

  it('keeps the idle-recycle path on recover, not rescue', () => {
    // ended + desired=active is an idle recycle: respawn wanted, full transcript replayed.
    expect(classifyMossSession(snapshot('ended', 'active'))).toBe('recover')
    // ended + desired=ended is a natural retirement — replaced, and not a crash, so no seed.
    expect(classifyMossSession(snapshot('ended', 'ended'))).toBe('replace')
    expect(shouldRescue('ended')).toBe(false)
  })
})

describe('seed built from a crashed session transcript', () => {
  async function transcriptWith(lines: string[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'moss-seed-'))
    const path = join(dir, 'transcript.jsonl')
    await writeFile(path, lines.join('\n'), 'utf-8')
    return path
  }

  it('carries the recent exchange into the successor', async () => {
    const path = await transcriptWith([
      JSON.stringify({ type: 'user', message: { role: 'user', content: '订单号 A123 的状态' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '已发货' }] } }),
    ])
    const seed = await buildTranscriptSeed(path)
    expect(seed).toContain('【历史对话摘要】')
    expect(seed).toContain('A123')
    expect(seed).toContain('已发货')
  })

  it('degrades quietly when the transcript is missing, so a failed rescue never breaks the message', async () => {
    expect(await buildTranscriptSeed('/nonexistent/path/transcript.jsonl')).toBe('')
  })

  it('degrades quietly on an empty transcript', async () => {
    expect(await buildTranscriptSeed(await transcriptWith([]))).toBe('')
  })

  it('does not nest a previous seed inside a new one', async () => {
    // Otherwise each crash would wrap the last summary in a new one and grow without bound.
    const first = await transcriptWith([
      JSON.stringify({ type: 'user', message: { role: 'user', content: '第一轮问题' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '第一轮回答' }] } }),
    ])
    const seed = await buildTranscriptSeed(first)
    expect(seed).toContain('【历史对话摘要】')

    // A successor whose transcript contains ONLY the injected seed has nothing new to carry.
    const second = await transcriptWith([
      JSON.stringify({ type: 'user', message: { role: 'user', content: seed } }),
    ])
    expect(await buildTranscriptSeed(second)).toBe('')
  })
})
