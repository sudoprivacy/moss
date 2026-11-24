import type { Language } from './language.js'

const greetings: Partial<Record<Language, { pattern: RegExp; reply: string }>> = {
  zh: { pattern: /^(?:你好|您好|你们好|大家好)[！!。.]?$/u, reply: '您好，请问有什么可以帮您？' },
  en: { pattern: /^(?:hello|hi|hey)[!.]?$/i, reply: 'Hello, I’m your cabin AI assistant. How can I help you?' },
  ja: { pattern: /^(?:こんにちは|おはようございます|こんばんは)[！!。.]?$/u, reply: 'こんにちは。客室AIアシスタントです。何かお手伝いできますか？' },
  de: { pattern: /^(?:hallo|guten tag)[!.]?$/i, reply: 'Hallo, ich bin Ihr KI-Kabinenassistent. Wie kann ich Ihnen helfen?' },
  fr: { pattern: /^bonjour[!.]?$/i, reply: 'Bonjour, je suis votre assistant de cabine IA. Comment puis-je vous aider ?' },
  es: { pattern: /^¡?hola[!.]?$/i, reply: 'Hola, soy su asistente de cabina de IA. ¿En qué puedo ayudarle?' },
  pt: { pattern: /^olá[!.]?$/iu, reply: 'Olá, sou o seu assistente de cabine de IA. Como posso ajudar?' },
  it: { pattern: /^(?:ciao|buongiorno)[!.]?$/i, reply: 'Buongiorno, sono il suo assistente di cabina IA. Come posso aiutarla?' },
  ko: { pattern: /^안녕하세요[!.。]?$/u, reply: '안녕하세요. 객실 AI 도우미입니다. 무엇을 도와드릴까요?' },
  ru: { pattern: /^(?:привет|здравствуйте)[!.]?$/iu, reply: 'Здравствуйте! Я ваш ИИ-помощник в салоне. Чем могу помочь?' },
}

export function greetingReply(text: string, language?: Language): string | undefined {
  const greeting = greetings[language ?? 'zh']
  return greeting?.pattern.test(text.trim()) ? greeting.reply : undefined
}

const cacheableRoutes = new Set(['greeting', 'invalid-device-setting', 'hardware-no-action', 'hardware-control', 'hardware-confirm', 'no-pending-action'])

export function isFixedSpeechReply(route?: string): boolean {
  return route !== undefined && cacheableRoutes.has(route)
}
