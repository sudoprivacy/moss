/**
 * @license
 * Copyright 2025 Sudowork (sudowork.ai)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Builds a bounded conversation seed from a session's transcript, so a channel
 * chat that must be REPLACED (turn cap reached, or a wedged session the user
 * asked to reset) still carries recent context into its successor.
 *
 * Why read the transcript file rather than our own message store: cabin does
 * the equivalent with `buildContextReplayBlock`, but reads `cabin_messages`.
 * The channel layer has no message table — `channel_sessions` stores routing
 * only — so the transcript jsonl on the host is the sole record of what was
 * said. It survives container death (bind-mounted under data/runtime).
 *
 * Two failure modes this code exists to avoid:
 *
 * 1. Summary nesting. The runtime re-compacts its own transcript every turn,
 *    nesting each prior summary inside a new "Previously compacted context"
 *    wrapper (~+12KB/cycle) until a single request overflows the model context
 *    — the exact growth CronService caps with cronReuseMaxRuns. If we seeded a
 *    successor with a block that itself contained the previous seed, rotation
 *    would become a second instance of that same leak. So the seed is fenced
 *    in markers and we cut everything up to and including the last fence:
 *    only what was said AFTER the previous seed is ever re-summarized.
 *
 * 2. Tool-output bloat. A single grep can dwarf the whole seed budget, so we
 *    take user/assistant text on an allowlist — tool_use/tool_result are
 *    dropped outright rather than filtered by heuristics.
 */

import { readFile } from 'fs/promises'

/** Fence markers. Must survive a round-trip through the model's transcript. */
const SEED_HEADER = '【历史对话摘要】'
const SEED_FOOTER = '【摘要结束】'

export type TranscriptSeedOptions = {
  /** Max conversation turns to carry over. */
  maxTurns?: number
  /** Hard ceiling on the rendered block, in characters. A turn count alone is
   *  not a bound: one IM turn can be a pasted document. */
  maxChars?: number
  /** Per-message truncation, in characters. */
  maxCharsPerMessage?: number
}

const DEFAULT_MAX_TURNS = 20
const DEFAULT_MAX_CHARS = 4000
const DEFAULT_MAX_CHARS_PER_MESSAGE = 500

type SeedEntry = { role: 'user' | 'assistant'; text: string }

/**
 * Flatten a transcript `content` field to plain text, keeping only text parts.
 * Content is either a string or an array of typed blocks; tool_use/tool_result
 * blocks carry payloads we never want in a seed.
 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (block && typeof block === 'object') {
      const b = block as Record<string, unknown>
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    }
  }
  return parts.join('\n').trim()
}

function truncate(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`
}

/**
 * Parse the transcript into user/assistant text turns, dropping sidechains,
 * tool traffic, and empty messages.
 */
function parseSeedEntries(buf: string): SeedEntry[] {
  const entries: SeedEntry[] = []
  for (const line of buf.split('\n')) {
    if (!line.trim()) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue // malformed line — skip, same as transcript.ts
    }
    const type = obj.type
    // Allowlist: tool_use / tool_result carry payloads that would blow the budget.
    if (type !== 'user' && type !== 'assistant') continue
    if (obj.isSidechain === true) continue
    const message = obj.message as Record<string, unknown> | undefined
    const text = extractText(message?.content ?? obj.content)
    if (!text) continue
    entries.push({ role: type === 'user' ? 'user' : 'assistant', text })
  }
  return entries
}

/**
 * Drop everything up to and including the last seed fence, so a seed injected
 * into the PREVIOUS rotation is never folded into this one. Without this,
 * successive rotations nest summaries the way runtime compaction does.
 */
function stripPriorSeed(entries: SeedEntry[]): SeedEntry[] {
  let cut = -1
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.text.includes(SEED_HEADER)) {
      cut = i
      break
    }
  }
  return cut === -1 ? entries : entries.slice(cut + 1)
}

/** Render entries newest-last, respecting the character ceiling. */
function render(entries: SeedEntry[], maxChars: number, maxPerMessage: number): string {
  const lines: string[] = []
  let total = 0
  // Walk backwards so that when the budget binds we keep the MOST RECENT turns.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    const speaker = entry.role === 'assistant' ? '助手' : '用户'
    const line = `${speaker}: ${truncate(entry.text, maxPerMessage)}`
    if (total + line.length > maxChars) break
    lines.push(line)
    total += line.length + 1
  }
  return lines.reverse().join('\n')
}

/**
 * Build the seed block for `transcriptPath`, or '' when there is nothing worth
 * carrying over (missing/unreadable file, empty transcript, or a transcript
 * containing only a prior seed). Never throws: a failed seed must degrade to a
 * plain fresh session, not break the user's message.
 */
export async function buildTranscriptSeed(
  transcriptPath: string,
  options: TranscriptSeedOptions = {},
): Promise<string> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  const maxPerMessage = options.maxCharsPerMessage ?? DEFAULT_MAX_CHARS_PER_MESSAGE
  if (maxTurns <= 0 || maxChars <= 0) return ''

  let buf: string
  try {
    buf = await readFile(transcriptPath, 'utf-8')
  } catch {
    return '' // no transcript (never started, or workspace wiped) — degrade quietly
  }

  const fresh = stripPriorSeed(parseSeedEntries(buf)).slice(-maxTurns)
  if (!fresh.length) return ''

  const body = render(fresh, maxChars, maxPerMessage)
  if (!body) return ''

  return `${SEED_HEADER}\n以下是本次对话在会话重建前的最近记录，供你延续上下文，不要重复回答其中已答复的问题。\n${body}\n${SEED_FOOTER}`
}

export const __testing = { SEED_HEADER, SEED_FOOTER, stripPriorSeed, parseSeedEntries, render }
