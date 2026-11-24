import { createHash } from 'crypto'

export function audioSha256(audio: Uint8Array): string {
  return createHash('sha256').update(audio).digest('hex')
}

// Diagnostics only: an unsupported or truncated WAV must not break playback.
export function wavMetadata(audio: Buffer): Record<string, number> | undefined {
  if (audio.length < 12 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') return
  let format: { encoding: number; channels: number; sampleRate: number; byteRate: number; bits: number } | undefined
  let dataBytes: number | undefined
  for (let offset = 12; offset + 8 <= audio.length;) {
    const size = audio.readUInt32LE(offset + 4)
    const start = offset + 8
    if (size > audio.length - start) return
    const kind = audio.toString('ascii', offset, offset + 4)
    if (kind === 'fmt ' && size >= 16) {
      format = {
        encoding: audio.readUInt16LE(start), channels: audio.readUInt16LE(start + 2),
        sampleRate: audio.readUInt32LE(start + 4), byteRate: audio.readUInt32LE(start + 8), bits: audio.readUInt16LE(start + 14),
      }
    }
    if (kind === 'data') dataBytes = (dataBytes ?? 0) + size
    offset = start + size + (size % 2)
  }
  if (!format || dataBytes === undefined || format.encoding !== 1 || !format.channels || !format.sampleRate || !format.bits || !format.byteRate) return
  if (format.byteRate !== format.sampleRate * format.channels * format.bits / 8) return
  return { sample_rate: format.sampleRate, channels: format.channels, bits_per_sample: format.bits, duration_ms: Math.round(dataBytes / format.byteRate * 1000) }
}
