import { describe, expect, it } from 'bun:test'
import { CabinSpeechCache } from '../speechCache.js'
import { audioSha256, wavMetadata } from '../audioFingerprint.js'
import { greetingReply, isFixedSpeechReply } from '../greeting.js'
import { serverFileConfigSchema } from '../../types.js'
import { CabinServices } from '../service.js'
import type { CabinConfig } from '../types.js'
import type { CabinLogger } from '../logger.js'
import { assertTtsBackend, ttsGenerationOptions } from '../ttsOptions.js'
import { speechText } from '../speechText.js'

const verifiedChineseInstruct = '用清晰、平稳的普通话播报，完整读出每一个字，句首不要吞字。'

function diagnosticWav(): Buffer {
  const pcm = Buffer.alloc(4800)
  const head = Buffer.alloc(44)
  head.write('RIFF'); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22)
  head.writeUInt32LE(24000, 24); head.writeUInt32LE(48000, 28); head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([head, pcm])
}

describe('fixed reply speech cache', () => {
  it('coalesces simultaneous generation and isolates every returned Buffer', async () => {
    const cache = new CabinSpeechCache({ maxEntries: 2, maxBytes: 100, ttlMs: 1000 })
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const generate = async () => { calls++; await gate; return { audio: Buffer.from('original'), contentType: 'audio/wav' } }
    const first = cache.getOrGenerate('one', true, generate)
    const second = cache.getOrGenerate('one', true, generate)
    release()
    const [a,b] = await Promise.all([first,second])
    expect(calls).toBe(1); expect(a.cacheStatus).toBe('miss'); expect(b.cacheStatus).toBe('shared')
    a.audio.fill(0)
    expect(b.audio.toString()).toBe('original')
    const hit = await cache.getOrGenerate('one', true, generate)
    expect(hit.audio.toString()).toBe('original'); expect(hit.cacheStatus).toBe('hit'); expect(calls).toBe(1)
  })

  it('enforces LRU, byte limits, expiry and oversized bypass', async () => {
    let now = 0
    let calls = 0
    const cache = new CabinSpeechCache({ maxEntries: 2, maxBytes: 6, ttlMs: 10 }, () => now)
    const load = (key: string, size = 3) => cache.getOrGenerate(key, true, async () => { calls++; return { audio: Buffer.alloc(size), contentType: 'audio/wav' } })
    await load('a'); await load('b'); expect((await load('a')).cacheStatus).toBe('hit')
    await load('c'); expect((await load('a')).cacheStatus).toBe('hit')
    expect((await load('b')).cacheStatus).toBe('miss')
    now = 11; expect((await load('b')).cacheStatus).toBe('miss')
    await load('large', 7); expect((await load('large', 7)).cacheStatus).toBe('miss')
    expect(calls).toBe(7)
    const bytes = new CabinSpeechCache({ maxEntries: 10, maxBytes: 4, ttlMs: 100 })
    const get = (key: string) => bytes.getOrGenerate(key, true, async () => ({ audio: Buffer.alloc(3), contentType: 'audio/wav' }))
    await get('a'); await get('b'); expect((await get('a')).cacheStatus).toBe('miss')
  })

  it('retries failures and never caches dynamic or disabled requests', async () => {
    const cache = new CabinSpeechCache({ maxEntries: 2, maxBytes: 100, ttlMs: 100 })
    let calls = 0
    const generate = async () => { if (++calls === 1) throw new Error('unavailable'); return { audio: Buffer.from('ok'), contentType: 'audio/wav' } }
    await expect(cache.getOrGenerate('x', true, generate)).rejects.toThrow('unavailable')
    expect((await cache.getOrGenerate('x', true, generate)).cacheStatus).toBe('miss')
    expect((await cache.getOrGenerate('x', false, generate)).cacheStatus).toBe('bypass')
    expect((await cache.getOrGenerate('x', false, generate)).cacheStatus).toBe('bypass')
    expect(calls).toBe(4)
    for (const limit of ['maxEntries','maxBytes','ttlMs']) {
      const disabled = new CabinSpeechCache({ maxEntries: 2, maxBytes: 100, ttlMs: 100, [limit]: 0 })
      expect((await disabled.getOrGenerate('x', true, generate)).cacheStatus).toBe('bypass')
    }
  })
})

describe('speech service integration', () => {
  function config(): CabinConfig {
    return {
      ttsUrl: 'http://tts.test/speech', ttsModel: 'test-model', ttsVoice: 'fallback', ttsLanguage: 'auto',
      conversationSeatAudioEnabled: true, broadcastEnabled: true, broadcastApiBaseUrl: 'http://broadcast.test',
      broadcastApiKey: 'key', controlTimeoutMs: 1000,
      ttsGeneration: { temperature: 0, topP: 1, topK: 50, repetitionPenalty: 1.05 },
    } as CabinConfig
  }

  it('uses actual Chinese status fields and never asks a model to invent empty status', async () => {
    for (const [language, data] of [['zh', { position: 40 }], ['zh', {}], ['en', {}]] as const) {
      let llmCalls = 0
      const services = new CabinServices({ config: { ...config(), llmBaseUrl: 'http://llm.test/v1', llmModel: 'test', controlBaseUrl: 'http://device.test' }, store: {} as never,
        fetchImpl: (async url => {
          if (String(url).startsWith('http://llm.test')) {
            if (++llmCalls > 1) throw new Error('Empty status must not be interpreted by a model')
            return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ type: 'function', function: {
              name: 'cabin_status', arguments: JSON.stringify({ target_type: 'seat', status_key: 'posture' }),
            } }] } }] })
          }
          return Response.json({ code: 0, data: { data } })
        }) as typeof fetch })
      const result = await services.generateCompactReply({ context: { seatId: '01A', replyLanguage: language } as never, messages: [],
        text: language === 'zh' ? '请查看当前座椅角度。' : 'Please check the current seat position.' })
      expect(llmCalls).toBe(1)
      expect(result.reply).not.toContain('平躺')
      expect(result.reply).toContain('position' in data ? '40%' : language === 'zh' ? '暂未获取' : 'unavailable')
    }
  })

  it('shares only generation across seats while preserving upload bytes, request IDs and fingerprint logs', async () => {
    const original = diagnosticWav()
    const posts: Record<string, unknown>[] = []
    const seats: string[] = []
    const logs: Array<Record<string, any>> = []
    const services = new CabinServices({ config: config(), store: {} as never,
      logger: { log: event => logs.push(event) } as CabinLogger,
      fetchImpl: (async (url, init) => {
        if (String(url).includes('tts.test')) {
          posts.push(JSON.parse(String(init?.body)))
          return new Response(original, { headers: { 'content-type': 'audio/wav' } })
        }
        const form = await new Response(init?.body).formData()
        const file = form.get('file') as File
        expect(Buffer.from(await file.arrayBuffer()).equals(original)).toBe(true)
        seats.push(String(form.get('seatNo')))
        return Response.json({ code: 0, data: { matchedCount: 1, sentCount: 1, requestId: `broadcast-${seats.length}` } })
      }) as typeof fetch,
    })
    const send = (seatId: string, requestId: string) => services.speakToSeat({
      context: { aircraftNo: 'B-TEST', seatId, flightId: 'F1', flightDate: '2026-11-24', tabletId: seatId, replyLanguage: 'zh' },
      text: '已下发阅读灯指令。', cacheable: true, logContext: { requestId },
    })
    const results = await Promise.all([send('1A','r1'), send('2A','r2')])
    expect(results.every(result => result.status === 'sent')).toBe(true)
    expect(new Set(results.map(result => result.requestId)).size).toBe(2)
    await send('3A','r3')
    expect(posts).toHaveLength(1); expect(seats.sort()).toEqual(['1A','2A','3A'])
    expect(posts[0]).toMatchObject({ temperature: 0, top_p: 1, top_k: 50, repetition_penalty: 1.05, voice: 'Vivian', lang_code: 'Chinese' })
    const tts = logs.filter(event => event.upstream === 'tts')
    for (const event of tts) {
      expect(event.details.speech_input_chars).toBe('已下发阅读灯指令。'.length)
      expect(event.details.speech_input_sha256).toBe(audioSha256(Buffer.from('已下发阅读灯指令。')))
    }
    expect(tts.map(event => event.details.cache_status).sort()).toEqual(['hit','miss','shared'])
    const uploads = logs.filter(event => event.upstream === 'conversation-audio-seat')
    expect(uploads).toHaveLength(3)
    for (const event of [...tts,...uploads]) {
      expect(event.details.audio_sha256).toBe(audioSha256(original))
      expect(event.details.audio_format).toMatchObject({ sample_rate: 24000, duration_ms: 100 })
    }
    expect(uploads.map(event => event.requestId).sort()).toEqual(['r1','r2','r3'])
  })

  it('invalidates cached generation for text, profile, model, endpoint, auth and generation settings', async () => {
    const settings = config()
    let calls = 0
    const services = new CabinServices({ config: settings, store: {} as never, fetchImpl: (async () => {
      calls++; return new Response(diagnosticWav(), { headers: { 'content-type': 'audio/wav' } })
    }) as typeof fetch })
    const profile = { voice: 'Vivian', language: 'Chinese', field: 'lang_code' as 'lang_code' | 'language' }
    const say = (text = '公开回执') => services.speech(text, undefined, profile, true)
    await say(); expect((await say()).cacheStatus).toBe('hit')
    const changes = [
      () => { profile.voice = 'Serena' }, () => { profile.language = 'English' }, () => { profile.field = 'language' },
      () => { settings.ttsModel = 'different-model' }, () => { settings.ttsUrl = 'http://other.test/speech' },
      () => { settings.ttsApiKey = 'different-key' }, () => { settings.ttsGeneration!.temperature = 0.3 },
      () => { settings.ttsGeneration!.instruct = 'Speak calmly' }, () => { settings.ttsGeneration!.topP = 0.9 },
      () => { settings.ttsGeneration!.topK = 10 }, () => { settings.ttsGeneration!.repetitionPenalty = 1.1 },
      () => { settings.ttsGeneration!.maxTokens = 1000 },
    ]
    for (const change of changes) { change(); expect((await say()).cacheStatus).toBe('miss') }
    expect((await say('不同完整文本')).cacheStatus).toBe('miss')
    expect(calls).toBe(changes.length + 2)
  })

  it('uses the actual synthesis language for the verified prompt and isolates cached profiles', async () => {
    const settings = config()
    settings.ttsModel = 'qwen3-tts'
    settings.ttsLanguage = 'English'
    settings.ttsVoice = 'Vivian'
    settings.ttsGeneration = { temperature: 0.9, topP: 1, topK: 50, repetitionPenalty: 1.05, maxTokens: 1024, seed: 42 }
    const requests: Record<string, unknown>[] = []
    const logs: Array<Record<string, any>> = []
    const services = new CabinServices({ config: settings, store: {} as never,
      logger: { log: event => logs.push(event) } as CabinLogger,
      fetchImpl: (async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)))
        return new Response(diagnosticWav(), { headers: { 'content-type': 'audio/wav' } })
      }) as typeof fetch })
    const text = '已为您下发打开阅读灯的指令，请稍候。'
    const chinese = { voice: 'Vivian', language: 'Chinese', field: 'lang_code' as const }
    expect((await services.speech(text, undefined, chinese, true)).cacheStatus).toBe('miss')
    for (const language of ['English', 'Japanese', 'auto']) {
      await services.speech(text, undefined, { ...chinese, language }, true)
      expect(requests.at(-1)).not.toHaveProperty('instruct')
    }
    expect((await services.speech(text, undefined, chinese, true)).cacheStatus).toBe('hit')
    expect(requests).toHaveLength(4)
    expect(requests[0]).toEqual({
      model: 'qwen3-tts', voice: 'Vivian', lang_code: 'Chinese', input: text, response_format: 'wav',
      temperature: 0.9, top_p: 1, top_k: 50, repetition_penalty: 1.05, max_tokens: 1024, seed: 42,
      instruct: verifiedChineseInstruct,
    })
    const chineseLogs = logs.filter(event => event.upstream === 'tts' && event.details.language === 'Chinese')
    expect(chineseLogs).toHaveLength(2)
    for (const event of chineseLogs) {
      expect(event.details.instruct_sha256).toBe(audioSha256(Buffer.from(verifiedChineseInstruct)))
    }
    settings.ttsGeneration.instruct = '用温和的普通话播报。'
    expect((await services.speech(text, undefined, chinese, true)).cacheStatus).toBe('miss')
    expect(requests.at(-1)?.instruct).toBe(settings.ttsGeneration.instruct)
  })

  it('never uploads invalid audio or a backend that silently ignores seed', async () => {
    let uploads = 0
    const settings = config()
    settings.ttsModel = 'Qwen3-TTS'
    settings.ttsGeneration = { seed: 42 }
    settings.ttsDeterministicRequired = true
    let validBackend = false
    let validAudio = false
    const services = new CabinServices({ config: settings, store: {} as never, fetchImpl: (async url => {
      if (!String(url).includes('tts.test')) { uploads++; return Response.json({ code: 0 }) }
      return new Response(validAudio ? diagnosticWav() : Buffer.from('corrupt audio'), { headers: validBackend
        ? { 'x-cabin-tts-deterministic': 'seeded-serial-v1', 'x-cabin-tts-seed': '42' } : {} })
    }) as typeof fetch })
    const send = () => services.speakToSeat({ context: { aircraftNo: 'B-TEST', seatId: '1A', replyLanguage: 'zh' } as never, text: '您好', cacheable: true })
    expect((await send()).status).toBe('failed')
    validBackend = true
    expect((await send()).status).toBe('failed')
    expect(uploads).toBe(0)
    validAudio = true
    await services.speech('您好', undefined, undefined, true)
  })

  it('bounds a stalled TTS response body and does not retain failed synthesis', async () => {
    const settings = config()
    settings.ttsTimeoutMs = 20
    let calls = 0
    const services = new CabinServices({ config: settings, store: {} as never, fetchImpl: (async () => {
      calls++
      return calls === 1 ? new Response(new ReadableStream({ start() {} })) : new Response(diagnosticWav())
    }) as typeof fetch })
    await expect(services.speech('您好', undefined, undefined, true)).rejects.toThrow('timeout')
    expect((await services.speech('您好', undefined, undefined, true)).cacheStatus).toBe('miss')
    expect(calls).toBe(2)
  })

  it('omits unconfigured sampler fields and bypasses dynamic and named-passenger caching', async () => {
    const settings = config(); delete settings.ttsGeneration
    const requests: Record<string, unknown>[] = []
    const services = new CabinServices({ config: settings, store: {} as never, fetchImpl: (async (url, init) => {
      if (String(url).includes('tts.test')) {
        requests.push(JSON.parse(String(init?.body)))
        return new Response(diagnosticWav(), { headers: { 'content-type': 'audio/wav' } })
      }
      return Response.json({ code: 0, data: { sentCount: 1 } })
    }) as typeof fetch })
    await services.speech('相同动态文本'); await services.speech('相同动态文本')
    const input = { context: { aircraftNo: 'B-TEST', seatId: '1A', flightId: 'F1', flightDate: '2026-11-24', tabletId: 'one', passengerName: '张先生' }, text: '张先生，您好。', cacheable: true }
    await services.speakToSeat(input); await services.speakToSeat(input)
    expect(requests).toHaveLength(4)
    for (const field of ['temperature','top_p','top_k','repetition_penalty','instruct','max_tokens']) expect(requests[0]).not.toHaveProperty(field)
  })
})

describe('audio diagnostics', () => {
  it('renders emphasis, lists and links as speech without changing the displayed reply', () => {
    const displayed = '## 服务\n* **座椅调节**：加热、通风。\n* [灯光](https://example.test)：阅读灯。'
    expect(speechText(displayed)).toBe('服务 座椅调节：加热、通风。 灯光：阅读灯。')
    expect(displayed).toContain('**座椅调节**')
  })
  it('reads PCM metadata including padded extra chunks, without accepting truncated data', () => {
    const wav = diagnosticWav()
    const metadata = { sample_rate: 24000, channels: 1, bits_per_sample: 16, duration_ms: 100 }
    expect(wavMetadata(wav)).toEqual(metadata)
    const junk = Buffer.from([74,85,78,75,1,0,0,0,42,0])
    const extended = Buffer.concat([wav.subarray(0,36), junk, wav.subarray(36)])
    extended.writeUInt32LE(extended.length - 8, 4)
    expect(wavMetadata(extended)).toEqual(metadata)
    expect(wavMetadata(wav.subarray(0,50))).toBeUndefined()
    expect(wavMetadata(Buffer.from('not a wave'))).toBeUndefined()
    expect(audioSha256(Buffer.from(wav))).toBe(audioSha256(wav))
  })
})

describe('greeting routing and sampler configuration', () => {
  it('defaults only Qwen Mandarin to the verified instruction and preserves explicit overrides', () => {
    const config = { ttsModel: 'qwen3-tts', ttsLanguage: 'Chinese', ttsGeneration: { seed: 42 } } as CabinConfig
    for (const language of ['Chinese', 'chinese', 'Mandarin', 'zh', 'zh-CN', 'zh_TW']) {
      expect(ttsGenerationOptions(config, language).instruct).toBe(verifiedChineseInstruct)
    }
    expect(ttsGenerationOptions(config).instruct).toBe(verifiedChineseInstruct)
    for (const language of ['English', 'Japanese', 'Korean', 'Cantonese', 'yue', 'auto', 'unknown']) {
      expect(ttsGenerationOptions(config, language)).not.toHaveProperty('instruct')
    }
    expect(ttsGenerationOptions({ ...config, ttsModel: 'other-tts' })).not.toHaveProperty('instruct')
    config.ttsGeneration = { seed: 0, temperature: 0, instruct: 'Read the original text calmly.' }
    for (const language of ['Chinese', 'English']) {
      expect(ttsGenerationOptions(config, language)).toMatchObject({
        seed: 0, temperature: 0, instruct: 'Read the original text calmly.',
      })
    }
  })

  it('accepts only whole greetings in the selected language', () => {
    expect(greetingReply(' 你好。 ', 'zh')).toContain('您好')
    expect(greetingReply('Hello!', 'en')).toContain('Hello')
    expect(greetingReply('こんにちは。', 'ja')).toContain('こんにちは')
    expect(greetingReply('你好', 'en')).toBeUndefined()
    for (const text of ['你好，帮我开灯', '你好？', '你好，我想喝水', '不要说你好', '如果我说你好就打开灯', 'Hello, turn on the light']) expect(greetingReply(text,'zh')).toBeUndefined()
    for (const route of ['service-order','hardware-status','comfort-offer', undefined]) expect(isFixedSpeechReply(route)).toBe(false)
  })

  it('retains zero values, supplies cache limits, and rejects unsupported generation settings', () => {
    const parse = (cabin: unknown) => serverFileConfigSchema().parse({ cabin }).cabin
    expect(parse({ ttsGeneration: { temperature: 0, topK: 0 }, ttsCache: {} })).toMatchObject({
      greetingFastPathEnabled: true, ttsGeneration: { temperature: 0, topK: 0 },
      ttsCache: { maxEntries: 64, maxBytes: 16777216, ttlMs: 1800000 },
    })
    expect(parse({}).ttsGeneration).toBeUndefined()
    expect(parse({ greetingFastPathEnabled: false }).greetingFastPathEnabled).toBe(false)
    expect(parse({ ttsGeneration: { seed: 0 } }).ttsGeneration?.seed).toBe(0)
    for (const ttsGeneration of [{ temperature: -1 }, { topP: 0 }, { topP: 2 }, { topK: 1.5 }, { maxTokens: 0 }, { repetitionPenalty: 0 }, { seed: -1 }, { seed: 1.5 }]) {
      expect(serverFileConfigSchema().safeParse({ cabin: { ttsGeneration } }).success).toBe(false)
    }
  })

  it('uses safe sampling for Qwen languages and verifies the backend actually honored seed', () => {
    const config = { ttsModel: 'Qwen3-TTS', ttsDeterministicRequired: true, ttsGeneration: { seed: 42 } } as CabinConfig
    expect(ttsGenerationOptions(config)).toMatchObject({ temperature: 0.9, seed: 42, max_tokens: 1024 })
    expect(ttsGenerationOptions(config, 'Chinese').temperature).toBe(0.9)
    expect(ttsGenerationOptions(config, 'Japanese').temperature).toBe(0.9)
    expect(ttsGenerationOptions(config, 'Korean').temperature).toBe(0.9)
    expect(() => assertTtsBackend(new Response(), config)).toThrow('acknowledge')
    const reply = (seed: number) => new Response('', { headers: { 'x-cabin-tts-deterministic': 'seeded-serial-v1', 'x-cabin-tts-seed': String(seed) } })
    expect(() => assertTtsBackend(reply(43), config)).toThrow('requested seed')
    expect(() => assertTtsBackend(reply(42), config)).not.toThrow()
    config.ttsGeneration = { temperature: 0, seed: 0 }
    expect(ttsGenerationOptions(config)).toMatchObject({ temperature: 0, seed: 0 })
    expect(() => assertTtsBackend(reply(0), config)).not.toThrow()
  })
})
