// Extracted from sessionStorage.ts so server-side modules (budgetStats) can
// use the guard without dragging in the CLI module graph (bun:bundle & friends
// make sessionStorage.ts unloadable under Node/tsx). Keep this module free of
// node:sqlite and bun: imports — both runners must be able to load it.
import type { Entry, TranscriptMessage } from '../types/logs.js'

/**
 * Type guard to check if an entry is a transcript message.
 * Transcript messages include user, assistant, attachment, and system messages.
 * IMPORTANT: This is the single source of truth for what constitutes a transcript message.
 * loadTranscriptFile() uses this to determine which messages to load into the chain.
 *
 * Progress messages are NOT transcript messages. They are ephemeral UI state
 * and must not be persisted to the JSONL or participate in the parentUuid
 * chain. Including them caused chain forks that orphaned real conversation
 * messages on resume (see #14373, #23537).
 */
export function isTranscriptMessage(entry: Entry): entry is TranscriptMessage {
  return (
    entry.type === 'user' ||
    entry.type === 'assistant' ||
    entry.type === 'attachment' ||
    entry.type === 'system'
  )
}
