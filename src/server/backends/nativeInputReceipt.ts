import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

export type NativeInputReceipt = { state: 'unknown' }
  | { state: 'pending'; sessionId: string; turnId: number }
  | { state: 'complete'; text: string; error?: string }

/** Recover from the ordinary transcript, never from a second execution ledger. */
export async function readNativeInputReceipt(path: string, clientId: string): Promise<NativeInputReceipt> {
  const stream = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let target: { sessionId: string; turnId: number } | undefined
  const answers: string[] = []
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      const row = JSON.parse(line)
      const input = row.nativeInput
      if (row.type === 'user' && row.uuid === clientId) {
        if (target || !input || typeof input.sessionId !== 'string' || !Number.isSafeInteger(input.turnId) || input.turnId < 1) return { state: 'unknown' }
        target = { sessionId: input.sessionId, turnId: input.turnId }
      }
      if (!target || input?.sessionId !== target.sessionId || input.turnId !== target.turnId) continue
      if (row.type === 'assistant' && Array.isArray(row.message?.content)) {
        for (const block of row.message.content) if (block.type === 'text' && typeof block.text === 'string') answers.push(block.text)
      }
      if (row.type === 'result' && row.subtype === 'native_input_complete' && Array.isArray(input.clientIds) && input.clientIds.includes(clientId)) {
        if (!['end_turn', 'cancelled', 'error'].includes(row.stopReason)) return { state: 'unknown' }
        return { state: 'complete', text: answers.join('\n\n'),
          ...(row.stopReason === 'cancelled' ? { error: 'TURN_CANCELLED' } : row.stopReason === 'error' ? { error: 'TURN_FAILED' } : {}) }
      }
    }
    return target ? { state: 'pending', ...target } : { state: 'unknown' }
  } catch { return { state: 'unknown' } }
  finally { lines.close(); stream.destroy() }
}
