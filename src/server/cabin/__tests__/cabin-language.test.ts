import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { DatabaseSync } from 'node:sqlite'
import { asrLanguage, languageNames, languageScope, spokenLanguages, textLanguage, type Language } from '../language.js'
import { deniedCommand, exactCommand, hardwareReply, lightStatusReply } from '../commandLanguage.js'
import { CabinStore } from '../store.js'
import { orderChoice, orderReply } from '../orderLanguage.js'
import { serverFileConfigSchema } from '../../types.js'
import { getDefaultServerConfig } from '../../config.js'

describe('turn language', () => {
  for (const code of Object.keys(languageNames) as Language[]) {
    const name = languageNames[code]
    it(`normalizes ASR ${name} from real verbose-json shapes`, () => {
      expect(asrLanguage({ language: [name], segments: [{ language: code }] })).toBe(code)
      expect(asrLanguage({ segments: [{ language: name }] })).toBe(code)
    })
  }
  it('does not manufacture a detected language', () => {
    expect(asrLanguage({})).toBe('unknown')
    expect(asrLanguage({ language: ['German', 'unsupported'] })).toBe('unknown')
    expect(asrLanguage({ language: 'English', segments: [{ language: 'Japanese' }] })).toBe('unknown')
    expect(asrLanguage({ language: 'de-DE' }, 'zh')).toBe('unknown')
    expect(textLanguage('OK 42')).toBeUndefined()
    expect(textLanguage('请问 please')).toBeUndefined()
  })
  it('isolates, consumes, expires and rejects ambiguous ASR candidates', () => {
    const store = new CabinStore(new Database(':memory:') as unknown as DatabaseSync)
    const context = { flightId:'flight', flightDate:'date', seatId:'A1', tabletId:'one' }
    const scope = languageScope('id:0', context)
    const other = languageScope('id:0', { ...context, tabletId:'two' })
    store.recordLanguage(scope, '42', 'de', false, 1)
    expect(store.resolveLanguage(other, '42', 'auto', 'fr', 2)).toBe('fr')
    expect(store.resolveLanguage(languageScope('id:1', context), '42', 'auto', 'fr', 2)).toBe('fr')
    expect(store.resolveLanguage(scope, '42', 'zh', 'zh', 3)).toBe('de')
    expect(store.resolveLanguage(scope, '42', 'ja', 'zh', 4)).toBe('ja')
    store.recordLanguage(scope, '42', 'en', false, 5)
    store.recordLanguage(scope, '42', 'de', false, 5)
    expect(store.resolveLanguage(scope, '42', undefined, 'zh', 6)).toBe('de')
    store.recordLanguage(scope, '42', 'de', false, 7)
    expect(store.resolveLanguage(scope, '42', undefined, 'fr', 900_000)).toBe('fr')
    store.recordLanguage(scope, 'Hello', 'zh', true)
    expect(store.resolveLanguage(scope, 'Hello', 'zh')).toBe('en')
  })
  it('never interprets a denial, conditional or question as an exact imperative', () => {
    for (const text of ['Schalte die Leselampe nicht ein.', '読書灯をつけないでください。', "Don't turn on the reading light", '不要打开阅读灯']) {
      expect(exactCommand(text)).toBeUndefined()
      expect(deniedCommand(text)).toBe(true)
    }
    for (const text of ['Wenn es dunkel wird, schalte das Leselicht ein', 'Turn on the reading light?', '読書灯を消してからつけてください。']) expect(exactCommand(text)).toBeUndefined()
  })
  it('keeps hardware failures and interlocks distinct for each speech language', () => {
    for (const language of spokenLanguages) {
      const messages = new Set([
        hardwareReply(language, { execution_status:'dispatched', command:'seat.light', on:true }),
        hardwareReply(language, { execution_status:'dispatched', command:'seat.light', on:false }),
        hardwareReply(language, { execution_status:'failed' }),
        hardwareReply(language, { blocked_reason:'tray_not_folded' }),
        hardwareReply(language, { blocked_reason:'tray_status_unavailable' }),
        hardwareReply(language, { execution_status:'succeeded', command:'seat.tray.close', already_reached:true }),
      ])
      expect(messages.size).toBe(6)
      expect(lightStatusReply(language, { execution_status:'succeeded', status_data:{} })).not.toBe(lightStatusReply(language, { execution_status:'succeeded', status_data:{ on:false } }))
    }
  })
  it('matches bounded numeric commands only as complete phrases', () => {
    for (const text of ['set seat heating to level 2','stelle die sitzheizung auf stufe 2','座席のヒーターを2段階にしてください。','réglez le chauffage du siège au niveau 2']) expect(exactCommand(text)?.canonical).toBe('座椅加热调到2档')
    for (const text of ['set seat heating to level 4','set seat heating to level -2','set seat heating to level 2 or 3','if cold, set seat heating to level 2']) expect(exactCommand(text)).toBeUndefined()
  })
  it('renders real order outcomes, not an unconditional acknowledgement', () => {
    const base = {intent:'service_order_create', ok:true, reply:'旧回执'}
    expect(orderReply('de',{...base,slots:{execution_status:'succeeded',service_type_id:1,quantities:[2]}})).toContain('Decke × 2')
    expect(orderReply('ja',{...base,slots:{execution_status:'failed'}})).toContain('失敗')
  })
  it('expires and consumes confirmation only within its identity scope', () => {
    const store = new CabinStore(new Database(':memory:') as unknown as DatabaseSync)
    store.recordComfortOffer('one','heating',0)
    expect(store.takeComfortOffer('two',1)).toBeUndefined(); expect(store.takeComfortOffer('one',2)).toBe('heating')
    expect(store.takeComfortOffer('one',3)).toBeUndefined()
    store.recordComfortOffer('one','recline',4); expect(store.takeComfortOffer('one',130000)).toBeUndefined()
  })
  it('keeps language state on runner recovery but not after an explicit reset of the same conversation row', () => {
    const store = new CabinStore(new Database(':memory:') as unknown as DatabaseSync)
    const context = { flightId:'F1', flightDate:'2026-11-20', tabletId:'tab', passengerRef:'p', seatId:'A1', mossSessionId:'s1' }
    const conversation = store.createConversation(context)
    const scope = () => languageScope(`${conversation.id}:${store.languageEpoch(conversation.id)}`,context)
    const before = scope(); store.recordLanguage(before,'42','de',false)
    store.rebindMossSession(conversation.id,'s2'); expect(scope()).toBe(before)
    store.resetConversation(conversation.id); expect(store.createConversation({...context,mossSessionId:'s3'}).id).toBe(conversation.id)
    store.recordLanguage(before,'42','ja',false); expect(store.resolveLanguage(scope(),'42',undefined,'fr')).toBe('fr')
  })
  it('checks scoped order choices against the exact offered sequence once', () => {
    const store = new CabinStore(new Database(':memory:') as unknown as DatabaseSync)
    const choices = [{orderId:'a',orderNo:'100',items:[]},{orderId:'b',orderNo:'200',items:[]}]
    expect(orderChoice('Nummer 2',choices)).toBe('第2笔'); expect(orderChoice('100',choices)).toBe('第1笔')
    expect(orderChoice('Nein, nicht Nummer 2',choices)).toBeUndefined()
    store.rememberOrderChoices('one',choices); expect(store.takeOrderChoices('two',choices)).toBe(false)
    expect(store.takeOrderChoices('one',[...choices].reverse())).toBe(false)
    store.rememberOrderChoices('one',choices); expect(store.takeOrderChoices('one',choices)).toBe(true); expect(store.takeOrderChoices('one',choices)).toBe(false)
  })
  it('defaults new and existing configurations to enabled and ten Vivian profiles without enabling seat audio', () => {
    const expected = Object.fromEntries(Object.entries({
      zh: 'Chinese', en: 'English', de: 'German', ja: 'Japanese', ko: 'Korean',
      fr: 'French', es: 'Spanish', pt: 'Portuguese', it: 'Italian', ru: 'Russian',
    }).map(([code, language]) => [code, { voice: 'Vivian', field: 'lang_code', language }]))
    for (const cabin of [getDefaultServerConfig().cabin, serverFileConfigSchema().parse({}).cabin,
      serverFileConfigSchema().parse({ cabin: { enabled: true } }).cabin]) {
      expect(cabin.conversationLanguageMode).toBe('enabled')
      expect(cabin.conversationTtsProfiles).toEqual(expected)
      expect(cabin.conversationSeatAudioEnabled).toBe(false)
    }
  })
  it('honors explicit modes and whole profile maps independently, including an empty map', () => {
    const parse = (cabin: Record<string, unknown>) => serverFileConfigSchema().parse({ cabin }).cabin
    const profiles = { de: { voice: 'custom', language: 'de', field: 'language' } }
    expect(parse({ conversationTtsProfiles: profiles })).toMatchObject({ conversationLanguageMode: 'enabled' })
    expect(parse({ conversationTtsProfiles: profiles }).conversationTtsProfiles).toEqual(profiles)
    expect(parse({ conversationTtsProfiles: {} }).conversationTtsProfiles).toEqual({})
    for (const mode of ['legacy', 'shadow']) {
      const cabin = parse({ conversationLanguageMode: mode })
      expect(cabin.conversationLanguageMode).toBe(mode)
      expect(cabin.conversationTtsProfiles.de).toEqual({ voice: 'Vivian', language: 'German', field: 'lang_code' })
    }
  })
})
