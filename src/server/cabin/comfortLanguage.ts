import type { SpokenLanguage } from './commandLanguage.js'

export const comfortActions = { recline:'把座椅放倒到休息角度', heating:'开启座椅加热', ventilation:'开启座椅通风', massage:'开启座椅按摩' } as const
export type ComfortAction = keyof typeof comfortActions
const offers: Record<SpokenLanguage, Record<ComfortAction,string>> = {
  zh:{ recline:'需要我为您把座椅放倒到休息角度吗？', heating:'需要我为您开启座椅加热吗？', ventilation:'需要我为您开启座椅通风吗？', massage:'需要我为您开启座椅按摩吗？' },
  en:{ recline:'Would you like me to recline your seat?', heating:'Would you like me to turn on seat heating?', ventilation:'Would you like me to turn on seat ventilation?', massage:'Would you like me to turn on seat massage?' },
  de:{ recline:'Soll ich die Rückenlehne zurückstellen?', heating:'Soll ich die Sitzheizung einschalten?', ventilation:'Soll ich die Sitzlüftung einschalten?', massage:'Soll ich die Sitzmassage einschalten?' },
  ja:{ recline:'座席を倒しましょうか。', heating:'座席のヒーターをつけましょうか。', ventilation:'座席の送風をつけましょうか。', massage:'座席のマッサージを始めましょうか。' },
  ko:{ recline:'좌석 등받이를 뒤로 젖힐까요?', heating:'좌석 열선을 켤까요?', ventilation:'좌석 통풍을 켤까요?', massage:'좌석 마사지를 켤까요?' },
  fr:{ recline:'Voulez-vous que j’incline votre siège ?', heating:'Voulez-vous activer le chauffage du siège ?', ventilation:'Voulez-vous activer la ventilation du siège ?', massage:'Voulez-vous activer le massage du siège ?' },
  es:{ recline:'¿Quiere que recline su asiento?', heating:'¿Quiere activar la calefacción del asiento?', ventilation:'¿Quiere activar la ventilación del asiento?', massage:'¿Quiere activar el masaje del asiento?' },
  pt:{ recline:'Quer que recline o seu assento?', heating:'Quer ligar o aquecimento do assento?', ventilation:'Quer ligar a ventilação do assento?', massage:'Quer ligar a massagem do assento?' },
  it:{ recline:'Vuole che reclini il sedile?', heating:'Vuole attivare il riscaldamento del sedile?', ventilation:'Vuole attivare la ventilazione del sedile?', massage:'Vuole attivare il massaggio del sedile?' },
  ru:{ recline:'Хотите откинуть спинку кресла?', heating:'Включить подогрев кресла?', ventilation:'Включить вентиляцию кресла?', massage:'Включить массаж кресла?' },
}
const requests: Record<ComfortAction,RegExp> = {
  recline:/^(?:我?(?:感觉)?(?:有点|有一点)?(?:累|困)(?:了)?|我?(?:有点|有一点)?想睡觉(?:了)?|i(?: am|['’]m) tired|ich bin müde|眠いです|피곤해요|je suis fatiguée?|tengo sueño|estou com sono|ho sonno|я устал[а]?)$/iu,
  heating:/^(?:我?(?:有点)?冷(?:了)?|i(?: am|['’]m) cold|mir ist kalt|寒いです|추워요|j['’]ai froid|tengo frío|estou com frio|ho freddo|мне холодно)$/iu,
  ventilation:/^(?:我?(?:有点)?热(?:了)?|i(?: am|['’]m) hot|mir ist warm|暑いです|더워요|j['’]ai chaud|tengo calor|estou com calor|ho caldo|мне жарко)$/iu,
  massage:/^(?:我腰酸|my back aches|mein rücken tut weh|腰が痛いです|허리가 아파요|j['’]ai mal au dos|me duele la espalda|tenho dores nas costas|mi fa male la schiena|у меня болит спина)$/iu,
}
export function comfortAction(text: string): ComfortAction | undefined {
  const clean = text.trim().replace(/[。.!！]+$/u,'')
  return (Object.keys(requests) as ComfortAction[]).find(key => requests[key].test(clean))
}
export function comfortOffer(language: SpokenLanguage, action: ComfortAction): string { return offers[language][action] }
export function confirmsOffer(text: string): boolean {
  return /^(?:好|好的|可以|行|嗯|嗯嗯|是的|需要|需要的|要|要的|ok|okay|yes|sure|ja|はい|네|예|oui|sí|sim|sì|да)[。.!！]?$/iu.test(text.trim())
}
