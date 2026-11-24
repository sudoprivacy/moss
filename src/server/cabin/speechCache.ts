export type SpeechAudio = { audio: Buffer; contentType: string }
export type SpeechCacheStatus = 'hit' | 'miss' | 'shared' | 'bypass'
export type SpeechCacheOptions = { maxEntries: number; maxBytes: number; ttlMs: number }

export const defaultSpeechCacheOptions: SpeechCacheOptions = {
  maxEntries: 64, maxBytes: 16 * 1024 * 1024, ttlMs: 30 * 60 * 1000,
}

// Only callers which have identified a public, fixed reply may opt in.
export class CabinSpeechCache {
  private readonly entries = new Map<string, { value: SpeechAudio; expiresAt: number }>()
  private readonly pending = new Map<string, Promise<SpeechAudio>>()
  private bytes = 0

  constructor(private readonly options: SpeechCacheOptions, private readonly now = Date.now) {}

  async getOrGenerate(key: string, cacheable: boolean, generate: () => Promise<SpeechAudio>): Promise<SpeechAudio & { cacheStatus: SpeechCacheStatus }> {
    const { maxEntries, maxBytes, ttlMs } = this.options
    if (!cacheable || maxEntries <= 0 || maxBytes <= 0 || ttlMs <= 0) {
      return { ...await generate(), cacheStatus: 'bypass' }
    }
    for (const [entryKey, entry] of this.entries) {
      if (entry.expiresAt <= this.now()) this.remove(entryKey)
    }
    const entry = this.entries.get(key)
    if (entry) {
      this.entries.delete(key)
      this.entries.set(key, entry)
      return { ...this.copy(entry.value), cacheStatus: 'hit' }
    }
    const pending = this.pending.get(key)
    if (pending) return { ...this.copy(await pending), cacheStatus: 'shared' }
    // Bound retained in-flight keys as well as completed audio. Extra requests bypass.
    if (this.pending.size >= maxEntries) return { ...await generate(), cacheStatus: 'bypass' }
    const generation = Promise.resolve().then(generate).then(value => {
      if (value.audio.length > 0 && value.audio.length <= maxBytes) {
        while (this.entries.size >= maxEntries || this.bytes + value.audio.length > maxBytes) {
          this.remove(this.entries.keys().next().value!)
        }
        const stored = this.copy(value)
        this.entries.set(key, { value: stored, expiresAt: this.now() + ttlMs })
        this.bytes += stored.audio.length
      }
      return value
    })
    this.pending.set(key, generation)
    try {
      return { ...this.copy(await generation), cacheStatus: 'miss' }
    } finally {
      this.pending.delete(key)
    }
  }

  private copy(value: SpeechAudio): SpeechAudio {
    return { audio: Buffer.from(value.audio), contentType: value.contentType }
  }

  private remove(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.bytes -= entry.value.audio.length
    this.entries.delete(key)
  }
}
