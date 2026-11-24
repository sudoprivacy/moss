import type { CabinConfig } from './types.js'
import { languageCode } from './language.js'

export function isQwenTts(model: string): boolean {
  return /qwen3[-_]tts/i.test(model)
}

export function ttsGenerationOptions(config: CabinConfig, language = config.ttsLanguage): Record<string, number | string> {
  const generation = config.ttsGeneration
  const defaults = isQwenTts(config.ttsModel)
    // Chinese greedy decoding passed the corpus; Japanese/Korean require sampling.
    // The dedicated seeded server serializes both paths, eliminating batch drift.
    ? { temperature: languageCode(language) === 'zh' ? 0 : 0.9, top_p: 1, top_k: 50, repetition_penalty: 1.05, max_tokens: 1024 }
    : {}
  return {
    ...defaults,
    ...(generation?.temperature !== undefined ? { temperature: generation.temperature } : {}),
    ...(generation?.topP !== undefined ? { top_p: generation.topP } : {}),
    ...(generation?.topK !== undefined ? { top_k: generation.topK } : {}),
    ...(generation?.repetitionPenalty !== undefined ? { repetition_penalty: generation.repetitionPenalty } : {}),
    ...(generation?.instruct !== undefined ? { instruct: generation.instruct } : {}),
    ...(generation?.maxTokens !== undefined ? { max_tokens: generation.maxTokens } : {}),
    ...(generation?.seed !== undefined ? { seed: generation.seed } : {}),
  }
}

// Stock mlx_audio silently ignores seed. Require a capability acknowledgement
// when deploying the seeded server, rather than claiming determinism from JSON.
export function assertTtsBackend(response: Response, config: CabinConfig): void {
  if (!config.ttsDeterministicRequired) return
  if (response.headers.get('x-cabin-tts-deterministic') !== 'seeded-serial-v1') {
    throw new Error('TTS backend does not acknowledge seeded serial generation')
  }
  const seed = config.ttsGeneration?.seed ?? 42
  if (response.headers.get('x-cabin-tts-seed') !== String(seed)) {
    throw new Error('TTS backend did not use the requested seed')
  }
}
