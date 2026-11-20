import type { Language } from './language.js'

export const spokenLanguages = ['zh', 'en', 'de', 'ja', 'ko', 'fr', 'es', 'pt', 'it', 'ru'] as const
export type SpokenLanguage = typeof spokenLanguages[number]
export function isSpoken(language: Language): language is SpokenLanguage {
  return spokenLanguages.some(code => code === language)
}

type Foreign = Exclude<SpokenLanguage, 'zh'>
type CommandWords = { on: string[]; off: string[]; light: string; ceiling: string; open: string; close: string; tray: string }
const commands: Record<Foreign, CommandWords> = {
  en: { on: ['turn on @', 'switch on @', 'turn @ on'], off: ['turn off @', 'switch off @', 'turn @ off'], light: 'the reading light', ceiling: 'the ceiling light', open: 'open @', close: 'close @', tray: 'the tray table' },
  de: { on: ['schalte @ ein', 'schalten sie @ ein', '@ einschalten'], off: ['schalte @ aus', 'schalten sie @ aus', '@ ausschalten'], light: 'das leselicht|die leselampe', ceiling: 'das deckenlicht', open: 'öffnen sie @|öffne @', close: 'schließen sie @|schließe @', tray: 'den klapptisch' },
  ja: { on: ['@をつけて', '@を点けて', '@を点灯して', '@をオンにして'], off: ['@を消して', '@を消灯して', '@をオフにして'], light: '読書灯|読書ライト', ceiling: '天井灯', open: '@を開いて|@を開けて', close: '@を閉じて', tray: 'テーブル|折りたたみテーブル' },
  ko: { on: ['@ 켜 주세요', '@ 켜주세요', '@ 켜 줘'], off: ['@ 꺼 주세요', '@ 꺼주세요', '@ 꺼 줘'], light: '독서등을', ceiling: '천장등을', open: '@ 펴 주세요', close: '@ 접어 주세요', tray: '테이블을' },
  fr: { on: ['allume @', 'allumez @'], off: ['éteins @', 'éteignez @'], light: 'la liseuse|la lampe de lecture', ceiling: 'le plafonnier', open: 'ouvrez @|ouvre @', close: 'fermez @|ferme @', tray: 'la tablette' },
  es: { on: ['enciende @', 'encienda @'], off: ['apaga @', 'apague @'], light: 'la luz de lectura', ceiling: 'la luz del techo', open: 'abre @|abra @', close: 'cierra @|cierre @', tray: 'la mesa plegable' },
  pt: { on: ['acenda @', 'ligue @'], off: ['apague @', 'desligue @'], light: 'a luz de leitura', ceiling: 'a luz do teto', open: 'abra @', close: 'feche @', tray: 'a mesa dobrável' },
  it: { on: ['accendi @', 'accenda @'], off: ['spegni @', 'spenga @'], light: 'la luce di lettura', ceiling: 'la plafoniera', open: 'apri @|apra @', close: 'chiudi @|chiuda @', tray: 'il tavolino' },
  ru: { on: ['включи @', 'включите @'], off: ['выключи @', 'выключите @'], light: 'лампу для чтения|свет для чтения', ceiling: 'потолочный свет', open: 'откройте @|открой @', close: 'закройте @|закрой @', tray: 'столик' },
}

const phrases = new Map<string, { canonical: string; language: Foreign }>()
for (const [code, words] of Object.entries(commands)) {
  const add = (patterns: string[], devices: string, canonical: string) => {
    for (const pattern of patterns) for (const device of devices.split('|')) {
      phrases.set(pattern.replace('@', device), { canonical, language: code as Foreign })
    }
  }
  add(words.on, words.light, '打开阅读灯'); add(words.off, words.light, '关闭阅读灯')
  add(words.on, words.ceiling, '打开顶灯'); add(words.off, words.ceiling, '关闭顶灯')
  add(words.open.split('|'), words.tray, '打开小桌板'); add(words.close.split('|'), words.tray, '关闭小桌板')
}

type Settings = { level:string; percent:string; devices:[string,string,string,string,string] }
const settings: Record<Foreign, Settings> = {
  en:{ level:'set @ to level #', percent:'set @ to #%', devices:['seat ventilation','seat heating','seat massage','the seat position','the reading light brightness'] },
  de:{ level:'stelle @ auf stufe #', percent:'stelle @ auf #%', devices:['die sitzlüftung','die sitzheizung','die sitzmassage','die sitzposition','die helligkeit der leselampe'] },
  ja:{ level:'@を#段階にして', percent:'@を#%にして', devices:['座席の送風','座席のヒーター','座席のマッサージ','座席の角度','読書灯の明るさ'] },
  ko:{ level:'@ #단계로 설정해 주세요', percent:'@ #%로 설정해 주세요', devices:['좌석 통풍을','좌석 난방을','좌석 마사지를','좌석 위치를','독서등 밝기를'] },
  fr:{ level:'réglez @ au niveau #', percent:'réglez @ à #%', devices:['la ventilation du siège','le chauffage du siège','le massage du siège','la position du siège','la luminosité de la liseuse'] },
  es:{ level:'ajusta @ al nivel #', percent:'ajusta @ al #%', devices:['la ventilación del asiento','la calefacción del asiento','el masaje del asiento','la posición del asiento','el brillo de la luz de lectura'] },
  pt:{ level:'ajuste @ para o nível #', percent:'ajuste @ para #%', devices:['a ventilação do assento','o aquecimento do assento','a massagem do assento','a posição do assento','o brilho da luz de leitura'] },
  it:{ level:'imposta @ al livello #', percent:'imposta @ al #%', devices:['la ventilazione del sedile','il riscaldamento del sedile','il massaggio del sedile','la posizione del sedile','la luminosità della luce di lettura'] },
  ru:{ level:'установите @ на уровень #', percent:'установите @ на #%', devices:['вентиляцию кресла','подогрев кресла','массаж кресла','положение кресла','яркость лампы для чтения'] },
}
const numericCommands = new Map<string,{ language:Foreign; canonical:string; max:number }>()
const canonicalSettings = ['座椅通风调到#档','座椅加热调到#档','座椅按摩调到#档','座椅位置调到#%','阅读灯亮度调到#%']
for (const [code, setting] of Object.entries(settings)) {
  setting.devices.forEach((device,index) => numericCommands.set((index < 3 ? setting.level : setting.percent).replace('@',device), {
    language:code as Foreign, canonical:canonicalSettings[index]!, max:index < 3 ? 3 : 100,
  }))
}

function cleanCommand(text: string): string {
  const clean = text.normalize('NFKC').toLowerCase().trim().replace(/[.!。！]+$/u, '').trim()
    .replace(/^(?:please|bitte|por favor|per favore|пожалуйста)[,，]?\s+/u, '')
    .replace(/[,，]?\s+(?:please|bitte|por favor|per favore|s['’]il vous plaît|пожалуйста)$/u, '')
    .replace(/ください$/u, '').replace(/\s+/gu, ' ').trim()
  return clean.replace(/(\d)\s+%/u, '$1%')
}

export function exactCommand(text: string): { language:Foreign; canonical:string } | undefined {
  const clean = cleanCommand(text)
  const exact = phrases.get(clean)
  if (exact) return exact
  const number = clean.match(/\d+/u)
  if (!number || clean.includes('#')) return undefined
  const rule = numericCommands.get(clean.replace(/\d+/u, '#'))
  if (!rule || Number(number[0]) > rule.max) return undefined
  return { language:rule.language, canonical:rule.canonical.replace('#', String(Number(number[0]))) }
}

export function invalidSetting(text: string): boolean {
  const clean = cleanCommand(text)
  if (!/\d/u.test(clean) || exactCommand(clean)) return false
  for (const template of numericCommands.keys()) {
    const [prefix, suffix] = template.split('#')
    if (clean.startsWith(prefix!) && clean.endsWith(suffix!)) return true
  }
  return false
}

const deviceWord = /灯|燈|桌板|座椅|通风|加热|按摩|テーブル|ライト|座席|독서등|천장등|테이블|좌석|light|tray|seat|heating|ventilation|massage|sitz|lese(?:licht|lampe)|deckenlicht|klapptisch|liseuse|lampe|plafonnier|tablette|siège|asiento|assento|sedile|luz|mesa|luce|plafoniera|tavolino|ламп[ауы]|свет|столик|кресл/iu
export function hypotheticalCommand(text: string): boolean {
  return deviceWord.test(text) && /如果|假如|要是|(?:^|[^\p{L}])(?:if|wenn|falls|si|se|если)(?!\p{L})|なら|たら|다면/iu.test(text)
}

export function describesDevice(text: string): boolean {
  return deviceWord.test(text) && /^(?:the |my |the current |die |das )[^.!?]*(?:\bis\b|\bist\b)|^(?:is|are|was|why|how|what|ist|est-ce|pourquoi|cómo|está|è|почему)\s|[?？]|(?:吗|ですか|ますか|나요)[。.]?$|(?:阅读灯|读书灯)(?:是)?[开关]着/u.test(text.trim().toLowerCase())
}
export function deniedCommand(text: string): boolean {
  return deviceWord.test(text) && /不要|不用|别|不许|不需要|ないで|しない|하지\s*마|지\s*마|n['’](?:allum|étei)|(?:^|[^\p{L}])(?:not|never|don['’]t|do not|nicht|kein\p{L}*|ne|pas|no|não|non|не)(?!\p{L})/iu.test(text)
}

type Replies = { sent: string; lightOn: string; lightOff: string; failed: string; folded: string; unavailable: string; already: string; clarify: string; noAction: string }
const replies: Record<SpokenLanguage, Replies> = {
  zh: { sent:'指令已下发。', lightOn:'已为您下发打开阅读灯的指令。', lightOff:'已为您下发关闭阅读灯的指令。', failed:'指令下发失败，请稍后再试。', folded:'小桌板未折叠，无法关闭。', unavailable:'无法确认小桌板状态，未下发关闭指令。', already:'小桌板已处于关闭状态。', clarify:'请再具体说明您的需求。', noAction:'没有执行设备操作。' },
  en: { sent:'Your request has been sent.', lightOn:'The request to turn on your reading light has been sent.', lightOff:'The request to turn off your reading light has been sent.', failed:'The request failed. Please try again later.', folded:'The tray table must be folded before it can be closed.', unavailable:'I could not verify the tray table status. No close command was sent.', already:'The tray table is already closed.', clarify:'Please clarify your request.', noAction:'No device command was sent.' },
  de: { sent:'Ihr Befehl wurde gesendet.', lightOn:'Der Befehl zum Einschalten der Leselampe wurde gesendet.', lightOff:'Der Befehl zum Ausschalten der Leselampe wurde gesendet.', failed:'Die Anfrage ist fehlgeschlagen. Bitte versuchen Sie es später erneut.', folded:'Der Tisch muss vor dem Schließen eingeklappt werden.', unavailable:'Der Tischstatus ist unklar. Es wurde kein Schließbefehl gesendet.', already:'Der Tisch ist bereits geschlossen.', clarify:'Bitte präzisieren Sie Ihre Anfrage.', noAction:'Es wurde kein Gerätebefehl gesendet.' },
  ja: { sent:'ご依頼の指示を送信しました。', lightOn:'読書灯をつける指示を送信しました。', lightOff:'読書灯を消す指示を送信しました。', failed:'リクエストに失敗しました。しばらくしてからもう一度お試しください。', folded:'テーブルを折りたたんでから閉じてください。', unavailable:'テーブルの状態を確認できないため、閉じる指示は送信していません。', already:'テーブルはすでに閉じています。', clarify:'ご希望をもう少し詳しく教えてください。', noAction:'機器への操作指示は送信していません。' },
  ko: { sent:'요청하신 명령을 전송했습니다.', lightOn:'독서등을 켜는 명령을 전송했습니다.', lightOff:'독서등을 끄는 명령을 전송했습니다.', failed:'요청에 실패했습니다. 나중에 다시 시도해 주세요.', folded:'테이블을 접은 후에 닫아 주세요.', unavailable:'테이블 상태를 확인할 수 없어 닫기 명령을 보내지 않았습니다.', already:'테이블은 이미 닫혀 있습니다.', clarify:'요청을 좀 더 구체적으로 말씀해 주세요.', noAction:'기기 명령을 보내지 않았습니다.' },
  fr: { sent:'Votre commande a été envoyée.', lightOn:'La commande pour allumer la liseuse a été envoyée.', lightOff:'La commande pour éteindre la liseuse a été envoyée.', failed:'La demande a échoué. Veuillez réessayer plus tard.', folded:'Il faut replier la tablette avant de la fermer.', unavailable:'Impossible de vérifier la tablette. Aucune commande de fermeture envoyée.', already:'La tablette est déjà fermée.', clarify:'Pouvez-vous préciser votre demande ?', noAction:'Aucune commande n’a été envoyée à l’appareil.' },
  es: { sent:'Se ha enviado su instrucción.', lightOn:'Se ha enviado la instrucción para encender la luz de lectura.', lightOff:'Se ha enviado la instrucción para apagar la luz de lectura.', failed:'La solicitud ha fallado. Inténtelo más tarde.', folded:'Hay que plegar la mesa antes de cerrarla.', unavailable:'No se pudo verificar el estado de la mesa. No se envió la orden de cierre.', already:'La mesa ya está cerrada.', clarify:'¿Podría precisar su solicitud?', noAction:'No se ha enviado ninguna orden al dispositivo.' },
  pt: { sent:'O seu comando foi enviado.', lightOn:'O comando para acender a luz de leitura foi enviado.', lightOff:'O comando para apagar a luz de leitura foi enviado.', failed:'O pedido falhou. Tente novamente mais tarde.', folded:'É necessário dobrar a mesa antes de a fechar.', unavailable:'Não foi possível verificar a mesa. Nenhum comando de fecho foi enviado.', already:'A mesa já está fechada.', clarify:'Pode esclarecer o seu pedido?', noAction:'Nenhum comando foi enviado ao dispositivo.' },
  it: { sent:'Il comando è stato inviato.', lightOn:'È stato inviato il comando per accendere la luce di lettura.', lightOff:'È stato inviato il comando per spegnere la luce di lettura.', failed:'La richiesta non è riuscita. Riprovi più tardi.', folded:'Il tavolino va ripiegato prima di chiuderlo.', unavailable:'Non è stato possibile verificare il tavolino. Nessun comando di chiusura è stato inviato.', already:'Il tavolino è già chiuso.', clarify:'Può precisare la richiesta?', noAction:'Non è stato inviato alcun comando al dispositivo.' },
  ru: { sent:'Ваша команда отправлена.', lightOn:'Команда на включение лампы для чтения отправлена.', lightOff:'Команда на выключение лампы для чтения отправлена.', failed:'Запрос не выполнен. Попробуйте позже.', folded:'Перед закрытием столик необходимо сложить.', unavailable:'Не удалось проверить состояние столика. Команда на закрытие не отправлена.', already:'Столик уже закрыт.', clarify:'Пожалуйста, уточните ваш запрос.', noAction:'Команда устройству не отправлена.' },
}

export function message(language: SpokenLanguage, key: keyof Replies): string { return replies[language][key] }

const lightQuestions = /^(?:(?:请问)?(?:阅读灯|读书灯)(?:现在|目前)?(?:是开着的|是关着的|开着|关着|开了|关了|打开了|关闭了)吗|is (?:my|the) reading light (?:on|off)|ist (?:die leselampe|das leselicht) (?:an|aus|eingeschaltet|ausgeschaltet)|読書灯は(?:ついて|点いて|消えて)いますか|독서등이 (?:켜져|꺼져) 있나요|la liseuse est-elle (?:allumée|éteinte)|está (?:encendida|apagada) la luz de lectura|a luz de leitura está (?:acesa|apagada)|la luce di lettura è (?:accesa|spenta)|(?:включена|выключена) ли лампа для чтения)$/iu
export function readingLightQuestion(text: string): boolean {
  return lightQuestions.test(text.normalize('NFKC').trim().replace(/^¿|[。.?？]+$/gu, ''))
}

const lightStates: Record<SpokenLanguage, [string, string, string]> = {
  zh: ['阅读灯已开启。','阅读灯已关闭。','无法确认阅读灯状态。'], en: ['The reading light is on.','The reading light is off.','The reading light status is unavailable.'],
  de: ['Die Leselampe ist an.','Die Leselampe ist aus.','Der Status der Leselampe ist unbekannt.'], ja: ['読書灯はついています。','読書灯は消えています。','読書灯の状態を確認できません。'],
  ko: ['독서등이 켜져 있습니다.','독서등이 꺼져 있습니다.','독서등 상태를 확인할 수 없습니다.'], fr: ['La liseuse est allumée.','La liseuse est éteinte.','Impossible de vérifier la liseuse.'],
  es: ['La luz de lectura está encendida.','La luz de lectura está apagada.','No se pudo verificar la luz de lectura.'], pt: ['A luz de leitura está acesa.','A luz de leitura está apagada.','Não foi possível verificar a luz de leitura.'],
  it: ['La luce di lettura è accesa.','La luce di lettura è spenta.','Non è possibile verificare la luce di lettura.'], ru: ['Лампа для чтения включена.','Лампа для чтения выключена.','Состояние лампы для чтения неизвестно.'],
}

export function lightStatusReply(language: SpokenLanguage, slots: Record<string, unknown>): string {
  const state = slots.status_data as { on?: unknown } | undefined
  const value = slots.execution_status === 'succeeded' ? String(state?.on).toLowerCase() : ''
  return lightStates[language][/^(true|on|1)$/.test(value) ? 0 : /^(false|off|0)$/.test(value) ? 1 : 2]
}

const actionKeys = ['seat.tray.open','seat.tray.close','seat.cushion','seat.ventilation','seat.heating','seat.massage','seat.light.brightness','seat.health.start','seat.health.stop','ceiling-on','ceiling-off','cabin.ceiling.color','cabin.scene','cabin.scene.clear'] as const
const actionLabels: Record<SpokenLanguage,readonly string[]> = {
  zh:['打开小桌板','关闭小桌板','座椅位置','座椅通风','座椅加热','座椅按摩','阅读灯亮度','开始生理检测','停止生理检测','打开顶灯','关闭顶灯','顶灯设置','客舱场景','清除客舱场景'],
  en:['Open tray table','Close tray table','Seat position','Seat ventilation','Seat heating','Seat massage','Reading light brightness','Start monitoring','Stop monitoring','Turn on ceiling light','Turn off ceiling light','Ceiling light settings','Cabin scene','Clear cabin scene'],
  de:['Klapptisch öffnen','Klapptisch schließen','Sitzposition','Sitzlüftung','Sitzheizung','Sitzmassage','Helligkeit der Leselampe','Messung starten','Messung stoppen','Deckenlicht einschalten','Deckenlicht ausschalten','Deckenlichteinstellung','Kabinenszene','Kabinenszene zurücksetzen'],
  ja:['テーブルを開く','テーブルを閉じる','座席の位置','座席の送風','座席のヒーター','座席のマッサージ','読書灯の明るさ','測定を開始','測定を停止','天井灯を点灯','天井灯を消灯','天井灯の設定','客室シーン','客室シーンの解除'],
  ko:['테이블 열기','테이블 닫기','좌석 위치','좌석 통풍','좌석 난방','좌석 마사지','독서등 밝기','측정 시작','측정 중지','천장등 켜기','천장등 끄기','천장등 설정','객실 장면','객실 장면 해제'],
  fr:['Ouvrir la tablette','Fermer la tablette','Position du siège','Ventilation du siège','Chauffage du siège','Massage du siège','Luminosité de la liseuse','Démarrer la mesure','Arrêter la mesure','Allumer le plafonnier','Éteindre le plafonnier','Réglage du plafonnier','Scène de cabine','Réinitialiser la scène'],
  es:['Abrir la mesa','Cerrar la mesa','Posición del asiento','Ventilación del asiento','Calefacción del asiento','Masaje del asiento','Brillo de la luz de lectura','Iniciar medición','Detener medición','Encender la luz del techo','Apagar la luz del techo','Ajustes de la luz del techo','Escena de cabina','Restablecer la escena'],
  pt:['Abrir a mesa','Fechar a mesa','Posição do assento','Ventilação do assento','Aquecimento do assento','Massagem do assento','Brilho da luz de leitura','Iniciar medição','Parar medição','Acender a luz do teto','Apagar a luz do teto','Ajustes da luz do teto','Cenário da cabine','Repor o cenário'],
  it:['Aprire il tavolino','Chiudere il tavolino','Posizione del sedile','Ventilazione del sedile','Riscaldamento del sedile','Massaggio del sedile','Luminosità della luce di lettura','Avviare la misurazione','Fermare la misurazione','Accendere la plafoniera','Spegnere la plafoniera','Impostazioni della plafoniera','Scenario della cabina','Ripristinare lo scenario'],
  ru:['Открыть столик','Закрыть столик','Положение кресла','Вентиляция кресла','Подогрев кресла','Массаж кресла','Яркость лампы для чтения','Начать измерение','Остановить измерение','Включить потолочный свет','Выключить потолочный свет','Настройки потолочного света','Сценарий салона','Сбросить сценарий'],
}

function actionDescription(language: SpokenLanguage, slots: Record<string,unknown>): string {
  let key = slots.command
  if (key === 'cabin.ceiling.light') key = slots.on === true || slots.action === 'on' ? 'ceiling-on' : slots.on === false || slots.action === 'off' ? 'ceiling-off' : undefined
  const index = actionKeys.findIndex(command => command === key)
  if (index < 0) return ''
  const value = typeof slots.level === 'number' ? ` (${slots.level})` : typeof slots.position === 'number' ? ` (${slots.position}%)` : ''
  return `${actionLabels[language][index]}${value}: `
}

export function hardwareReply(language: SpokenLanguage, slots: Record<string, unknown>): string {
  if (slots.blocked_reason === 'tray_not_folded') return message(language, 'folded')
  if (slots.blocked_reason === 'tray_status_unavailable') return message(language, 'unavailable')
  if (slots.already_reached === true && slots.command === 'seat.tray.close') return message(language, 'already')
  if (slots.execution_status !== 'dispatched') return actionDescription(language, slots) + message(language, 'failed')
  if (slots.command === 'seat.light') {
    if (slots.on === true || slots.action === 'on') return message(language, 'lightOn')
    if (slots.on === false || slots.action === 'off') return message(language, 'lightOff')
  }
  return actionDescription(language, slots) + message(language, 'sent')
}
