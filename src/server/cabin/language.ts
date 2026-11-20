import { createHash } from 'crypto'
import type { CabinPassengerContext } from './types.js'

export const languageNames = {
  zh: 'Chinese', en: 'English', yue: 'Cantonese', ar: 'Arabic', de: 'German', fr: 'French',
  es: 'Spanish', pt: 'Portuguese', id: 'Indonesian', it: 'Italian', ko: 'Korean', ru: 'Russian',
  th: 'Thai', vi: 'Vietnamese', ja: 'Japanese', tr: 'Turkish', hi: 'Hindi', ms: 'Malay', nl: 'Dutch',
  sv: 'Swedish', da: 'Danish', fi: 'Finnish', pl: 'Polish', cs: 'Czech', fil: 'Filipino', fa: 'Persian',
  el: 'Greek', hu: 'Hungarian', mk: 'Macedonian', ro: 'Romanian',
} as const
export type Language = keyof typeof languageNames
const aliases = new Map<string, Language>([['mandarin', 'zh'], ['zh-yue', 'yue'], ['tagalog', 'fil'], ['tl', 'fil']])
for (const [code, name] of Object.entries(languageNames)) {
  aliases.set(code, code as Language)
  aliases.set(name.toLowerCase(), code as Language)
}

export function languageCode(value: unknown): Language | undefined {
  if (typeof value !== 'string') return undefined
  const label = value.trim().toLowerCase().replaceAll('_', '-')
  return aliases.get(label) ?? (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})+$/.test(label) ? aliases.get(label.split('-')[0]!) : undefined)
}

export function asrLanguage(payload: { language?: unknown; segments?: unknown }, requested?: string): Language | 'unknown' {
  const labels: unknown[] = [payload.language]
  if (Array.isArray(payload.segments)) {
    for (const segment of payload.segments) labels.push(segment?.language)
  }
  const codes = new Set(labels.flat().filter(value => value != null && value !== '').map(languageCode))
  const [code] = codes
  return code && codes.size === 1 && (!requested || code === languageCode(requested)) ? code : 'unknown'
}

export function languageScope(conversation: string, context: CabinPassengerContext): string {
  return digest(JSON.stringify([conversation, context.contextMode, context.aircraftNo, context.flightId,
    context.flightDate, context.seatId, context.tabletId, context.passengerId, context.passengerRef, context.bindingId]))
}

export function digest(text: string): string {
  return createHash('sha256').update(text.normalize('NFC').trim()).digest('hex')
}

const vocabulary: Partial<Record<Language, RegExp>> = {
  en: /\b(?:hello|please|the|what|turn|would|could|thank|reading|is my)\b/i,
  de: /\b(?:hallo|bitte|schalte[n]?|leselicht|leselampe|welche|danke|guten|ich)\b/i,
  fr: /\b(?:bonjour|merci|veuillez|allume[zr]?|éteignez|quelle|lecture)\b/i,
  es: /\b(?:hola|gracias|enciend[ae]|apaga|lectura|quisiera|cuál)\b/i,
  pt: /\b(?:olá|obrigad[oa]|acenda|apague|leitura|gostaria|você)\b/iu,
  it: /\b(?:ciao|grazie|accendi|spegni|lettura|vorrei|buongiorno)\b/i,
}

export function textLanguage(text: string): Language | undefined {
  const matches = new Set<Language>()
  if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(text)) matches.add('ja')
  if (/\p{Script=Hangul}/u.test(text)) matches.add('ko')
  if (!matches.size && /\p{Script=Han}/u.test(text) && /[请您我你他她这哪吗了么的帮开关调灯说为会没将想需读来要点冷热]/u.test(text)) matches.add('zh')
  if (/[ыэёъ]|(?:включ|выключ|пожалуйста|привет|спасибо)/iu.test(text)) matches.add('ru')
  if (/\p{Script=Thai}/u.test(text)) matches.add('th')
  if (/\p{Script=Greek}/u.test(text)) matches.add('el')
  for (const [code, pattern] of Object.entries(vocabulary)) if (pattern.test(text)) matches.add(code as Language)
  return matches.size === 1 ? [...matches][0] : undefined
}

export function replyInstruction(language?: Language): string {
  return language ? `For this turn, write the passenger-facing reply in ${languageNames[language]} (${language}), regardless of profile or conversation history. Keep tool names and parameters unchanged.` : ''
}

export const clarifyText: Record<Language, string> = {
  zh:'请再具体说明您的需求。', en:'Please clarify your request.', de:'Bitte präzisieren Sie Ihre Anfrage.', fr:'Pouvez-vous préciser votre demande ?',
  es:'¿Podría precisar su solicitud?', pt:'Pode esclarecer o seu pedido?', it:'Può precisare la richiesta?', ja:'ご希望をもう少し詳しく教えてください。',
  ko:'요청을 좀 더 구체적으로 말씀해 주세요.', ru:'Пожалуйста, уточните ваш запрос.', yue:'唔該講清楚少少你嘅要求。', ar:'يرجى توضيح طلبك.',
  id:'Mohon perjelas permintaan Anda.', th:'กรุณาระบุคำขอให้ชัดเจนขึ้น', vi:'Xin vui lòng nói rõ yêu cầu của bạn.', tr:'Lütfen isteğinizi biraz daha açıklayın.',
  hi:'कृपया अपना अनुरोध स्पष्ट करें।', ms:'Sila jelaskan permintaan anda.', nl:'Kunt u uw verzoek verduidelijken?', sv:'Kan du förtydliga din fråga?',
  da:'Kan du præcisere dit spørgsmål?', fi:'Voisitko tarkentaa pyyntöäsi?', pl:'Proszę sprecyzować prośbę.', cs:'Upřesněte prosím svůj požadavek.',
  fil:'Pakilinaw ang inyong kahilingan.', fa:'لطفاً درخواست خود را روشن‌تر بیان کنید.', el:'Παρακαλώ διευκρινίστε το αίτημά σας.',
  hu:'Kérem, pontosítsa a kérését.', mk:'Ве молам појаснете го вашето барање.', ro:'Vă rugăm să precizați cererea.',
}

export function wrongReplyLanguage(text: string, expected: Language): boolean {
  const detected = textLanguage(text)
  if (detected === 'zh' && (expected === 'yue' || expected === 'ja')) {
    return expected === 'ja' && /(?:您的|为您|请问|收到|请稍后|已为)/u.test(text)
  }
  return detected !== undefined && detected !== expected
}
