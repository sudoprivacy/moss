import type { OutputDecoder } from '../../../contracts/external-provider/v1/contract.js'

/** Decode an incomplete JSON string without evaluating provider-controlled code. */
export function decodeOutput(raw: string, decoder: OutputDecoder, final = false): { answer: string; valid: boolean } {
  if (decoder === 'text') return { answer: raw, valid: true }
  if (final) {
    try {
      const value: unknown = JSON.parse(raw)
      if (value && typeof value === 'object' && typeof (value as { reply?: unknown }).reply === 'string') {
        return { answer: (value as { reply: string }).reply, valid: true }
      }
    } catch { /* Keep the original answer on malformed application output. */ }
    return { answer: raw, valid: false }
  }
  const start = findReplyStart(raw)
  if (start < 0) return { answer: '', valid: true }
  let answer = ''
  const text = raw.slice(start)
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') break
    if (char !== '\\') { answer += char; continue }
    const next = text[++i]
    if (next === undefined) break
    if (next === 'u') {
      const hex = text.slice(i + 1, i + 5)
      if (!/^[a-f\d]{4}$/i.test(hex)) break
      answer += String.fromCharCode(parseInt(hex, 16))
      i += 4
    } else {
      const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' }
      if (!(next in escapes)) break
      answer += escapes[next]
    }
  }
  // Do not publish a half surrogate pair while waiting for the next chunk.
  return { answer: answer.replace(/[\uD800-\uDBFF]$/, ''), valid: true }
}

// Only a root object key may supply the displayed reply (never nested tool output).
function findReplyStart(raw: string): number {
  if (!raw.trimStart().startsWith('{')) return -1
  let depth = 0
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]
    if (char === '{' || char === '[') depth++
    else if (char === '}' || char === ']') depth--
    else if (char === '"') {
      const start = i++
      for (; i < raw.length; i++) {
        if (raw[i] === '\\') i++
        else if (raw[i] === '"') break
      }
      if (i >= raw.length) return -1
      if (depth === 1) {
        const suffix = /^\s*:\s*"/.exec(raw.slice(i + 1))
        if (suffix) {
          try { if (JSON.parse(raw.slice(start, i + 1)) === 'reply') return i + 1 + suffix[0].length } catch { return -1 }
        }
      }
    }
  }
  return -1
}
