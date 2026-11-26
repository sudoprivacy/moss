export type LightSettings = { rgb?: number[]; percent?: number; relative?: number }
type Mode = 'office' | 'relax' | 'sleep' | 'personal'
export type LightingTurn =
  | { kind: 'mode'; mode: Mode } | { kind: 'switch'; on: boolean }
  | { kind: 'scene'; preset: string } | { kind: 'status' } | { kind: 'settings'; settings: LightSettings }
  | { kind: 'reply'; reply: string }

const colors: Record<string, number[]> = { 暖: [255,180,80], 蓝: [0,0,255], 红: [255,0,0], 白: [255,255,255], 绿: [0,255,0] }
const modes: Record<string, Mode> = { 办公: 'office', 工作: 'office', 放松: 'relax', 休闲: 'relax', 睡眠: 'sleep', 睡觉: 'sleep', 个人: 'personal', 个性: 'personal', 私人: 'personal' }
const scenes = { normal: /常亮|常规|巡航|清除.*效果|取消.*效果|关掉.*效果/, breath: /呼吸|夜间|夜晚/, flow: /流水|登机|降落|着陆/ }
export const sceneWire: Record<string,string> = { boarding:'flow', landing:'flow', night:'breath', cruise:'normal', normal:'normal', breath:'breath', flow:'flow' }

export function boundLight(seat: string | undefined, managed?: string) {
  const match = /^0*([1-9]\d?)([AB])$/i.exec(seat || '')
  if (!match) return
  const seatNo = `${match[1]}${match[2]!.toUpperCase()}`
  if (managed && !managed.toUpperCase().split(/[,，;\s]+/u).some(item => item.replace(/^0+/, '') === seatNo)) return
  const obj = (Number(match[1]) - 1) * 2 + (seatNo.endsWith('A') ? 1 : 2)
  return { seatNo, obj }
}

export function lightState(payload: unknown, aircraft: string, expected: number): Record<string, number> | undefined {
  if (!payload || typeof payload !== 'object' || !('data' in payload)) return
  const envelope = payload.data as { aircraftNo?: string; light?: Record<string, unknown> } | null
  if (envelope?.aircraftNo !== aircraft || !envelope.light) return
  const state: Record<string, number> = {}
  for (const [key, limit] of Object.entries({ obj:255, lightOpen:1, r:255, g:255, b:255, brightness:255, preset:65535 })) {
    const value = envelope.light[key]
    if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/u.test(value))) continue
    const number = Number(value)
    if (Number.isInteger(number) && number >= 0 && number <= limit) state[key] = number
  }
  return state.obj === expected ? state : undefined
}

export function describeLight(state: Record<string, number>, text = '') {
  const fields: string[] = []
  const color = /色|RGB/i.test(text), level = /亮度|多亮/.test(text), scene = /效果|灯效|呼吸|流水|常亮|场景/.test(text)
  if (!color && !level && !scene && state.lightOpen !== undefined) fields.push(state.lightOpen ? '氛围灯已开启' : '氛围灯已关闭')
  if ((color || !text) && ['r','g','b'].every(key => state[key] !== undefined)) {
    const rgb = [state.r,state.g,state.b].join(',')
    const name = Object.entries(colors).find(([, values]) => values.join(',') === rgb)?.[0]
    fields.push(name ? `颜色为${name}色` : `颜色为 RGB(${rgb})`)
  }
  if ((level || !text) && state.brightness !== undefined) fields.push(`亮度约为${Math.round(state.brightness * 100 / 255)}%`)
  if ((scene || !text) && state.preset !== undefined) fields.push(`灯效为${['常亮','呼吸','流水'][state.preset] ?? `预设${state.preset}`}`)
  return fields.length ? `${fields.join('，')}。` : '暂时读不到本座氛围灯的这项状态。'
}

export function describeLightEnglish(state: Record<string,number>, text: string) {
  if (/colou?r/i.test(text) && [state.r,state.g,state.b].every(value=>value !== undefined)) return `The color is RGB ${state.r}, ${state.g}, ${state.b}.`
  if (/brightness/i.test(text) && state.brightness !== undefined) return `Brightness is ${Math.round(state.brightness * 100 / 255)} percent.`
  if (/preset|effect/i.test(text) && state.preset !== undefined) return `The effect is ${['steady','breathing','flow'][state.preset] ?? 'preset '+state.preset}.`
  if (!/colou?r|brightness|preset|effect/i.test(text) && state.lightOpen !== undefined) return `Your ambient light is ${state.lightOpen ? 'on' : 'off'}.`
  return 'That light status is currently unavailable.'
}

export function requestsOtherSeat(text: string, seat?: string) {
  const seats = text.match(/\d{1,3}[a-z]\b/ig) ?? []
  return /全舱|所有座|全部座|隔壁|其他座|邻座|别人的|\ball seats\b|whole cabin|other seat/i.test(text) || seats.some(other => !boundLight(seat) || boundLight(other)?.seatNo !== boundLight(seat)?.seatNo)
}

export function lightingTurn(raw: string, seat: string | undefined, pending?: LightSettings, recentLight = false): LightingTurn | undefined {
  let text = raw.normalize('NFKC').trim()
  const mode = /(办公|工作|放松|休闲|睡眠|睡觉|个人|私人|个性)模式/.exec(text)?.[1]
  const lamp = /氛围灯|顶灯|客舱灯|舱灯|呼吸灯|灯效|流水灯|常亮|(?:登机|着陆|巡航|夜间|流水|呼吸)(?:效果|场景)/.test(text)
  const genericLamp = /^(?:请|帮我)?(?:把灯)?(?:调暗|调亮)(?:点|一点)?[。!！]?$/u.test(text)
  const follow = (pending || recentLight) && (genericLamp || /^(?:再打开|再关闭|把灯关掉|现在开着吗|现在关着吗|现在是什么颜色|什么颜色|一半|半亮|(?:(?:不是[红蓝白绿暖]色[,，]?)?(?:换|改)(?:成|为)?)?[红蓝暖白绿]色(?:[,，]还是一半)?|(?:亮度|调到)?\d{1,3}%?)[吗?？。!！]?$/u.test(text))
  if (genericLamp && !follow) return { kind: 'reply', reply: '您想调整阅读灯还是氛围灯？' }
  if (pending && /^(?:不用了?|不要了?|取消|算了|保持这样)[。！!，,\s]*$/u.test(text)) return { kind:'reply', reply:'好的，已取消这次氛围灯调整。' }
  if (!mode && !lamp && !follow) return
  if (requestsOtherSeat(text,seat)) return { kind:'reply',reply:'这里只能控制您当前座位的设备。' }
  if (/如果|假如|假设|要是|会怎样|会怎么样|介绍|解释|有什么|怎么用|如何使用|等到|一旦|[“”「」"]/.test(text)) return { kind:'reply',reply:'可以切换本座模式，也可以单独设置氛围灯的颜色、亮度和效果。' }
  if (/^(?:请问)?(?:能不能|可以|能否)(?:帮我|替我|给我)/u.test(text)) text = text.replace(/[吗么？?]+$/u, '')
  if (/不要|别|不用|不需要|禁止|不想|不许|不让/.test(text)) return { kind:'reply',reply:'好的，保持当前设置。' }
  if (/桌板|阅读灯|按摩|通风|加热/.test(text) || (text.match(/模式/g)?.length ?? 0) > 1 || /打开.*关|关掉.*开|关闭.*开|开灯.*关灯|(?:然后|再把|同时)/.test(text)) return {kind:'reply',reply:'请先选一项设备操作。'}
  if (mode && (lamp || /阅读灯|桌板|再把|然后/.test(text))) return { kind:'reply',reply:'您想先切换座位模式，还是先调整灯光？' }
  if (/什么颜色|多少|查询|查看|是不是|状态|现在.*[吗么]|开着吗|关着吗|当前|什么效果|什么灯效|是否/.test(text)) return mode ? { kind:'reply',reply:'暂时读不到座位的当前模式。' } : { kind:'status' }
  text = text.replace(/不是[红蓝暖白绿]色[,，]?\s*(?=(?:换|改)成)/u, '')
  if (/[?？吗么]|不是|喜欢|以前|刚才|听说|不打算|不[开关]|还没|没有/.test(text)) return { kind:'reply',reply:'请明确您希望进行哪项调整。' }
  if (mode && /切|进入|启动|打开|开启|调|换|启用/.test(text)) return { kind:'mode', mode:modes[mode]! }
  if (mode) return {kind:'reply',reply:'您想切换到什么座位模式？'}
  const scene = Object.entries(scenes).find(([, pattern]) => pattern.test(text))?.[0]
  const color = text.match(/(暖|蓝|红|白|绿)(?:色|光|灯)/)?.[1]
  const rgbText = /rgb\s*(?:为|是|=)?\s*\(?\s*(\d+)\s*[,，]\s*(\d+)\s*[,，]\s*(\d+)/i.exec(text)
  const rgb = rgbText ? rgbText.slice(1).map(Number) : color ? colors[color] : undefined
  if (!rgb && /(?:紫|橙|黄|粉|青|黑|灰|棕)色/.test(text)) return {kind:'reply',reply:'可以告诉我这个颜色的三个 RGB 色值吗？'}
  if (/rgb/i.test(text) && (!rgb || rgb.some(value=>value>255))) return {kind:'reply',reply:'请提供三个 0 到 255 之间的 RGB 色值。'}
  const number = /(-?\d+(?:\.\d+)?)\s*%|(?:亮度|调到|调至|亮到)(?:调到|到|为)?\s*(-?\d+(?:\.\d+)?)/.exec(text)
  const spokenPercent = /百分之(一百|[一二三四五六七八九]?十[一二三四五六七八九]?|[零一二三四五六七八九])(?![零一二三四五六七八九十百点])/.exec(text)?.[1]
  let percent = number ? Number(number[1] ?? number[2]) : /一半|半亮/.test(text) ? 50 : undefined
  if (spokenPercent) {
    const digits = '零一二三四五六七八九'
    const [tens, units] = spokenPercent.split('十')
    percent = spokenPercent === '一百' ? 100 : units === undefined ? digits.indexOf(tens!) : (tens ? digits.indexOf(tens) : 1) * 10 + digits.indexOf(units)
  }
  if (pending && /^\d{1,3}$/u.test(text)) percent = Number(text)
  if (text.includes('百分之') && spokenPercent === undefined && percent === undefined) return {kind:'reply',reply:'请说一个 0 到 100 之间的整数百分比。'}
  if (percent !== undefined && (!Number.isInteger(percent) || percent < 0 || percent > 100)) return { kind:'reply',reply:'请说一个 0 到 100 之间的整数百分比。' }
  if (scene && (color || percent !== undefined)) return { kind:'reply',reply:'您想先设置灯效，还是先调整颜色和亮度？' }
  if (!follow && !/调|设|换|改|切|恢复|清除|取消|关|开|点亮|熄灭|亮度|来个/.test(text)) return {kind:'reply',reply:'您想怎样调整氛围灯？'}
  if (scene && !/(?:关闭|关掉|熄灭)(?:本座)?(?:呼吸灯|流水灯|氛围灯|顶灯)/.test(text)) return { kind:'scene',preset:scene }
  if (/关掉|关闭|关上|熄灭|关灯/.test(text)) return { kind:'switch',on:false }
  if (/开灯|打开|开启|点亮/.test(text) && !rgb && percent === undefined && !/色|亮度|\d(?![AB])/iu.test(text.replace(/\d+[AB]/ig,''))) return { kind:'switch',on:true }
  const relative = /暗一点|暗点|调暗/.test(text) ? -10 : /亮一点|亮点|调亮/.test(text) ? 10 : undefined
  if (rgb || percent !== undefined || relative || /调色|换.*颜色|调.*亮度/.test(text)) {
    return { kind:'settings',settings:{ ...pending, ...(rgb && {rgb}), ...(relative && { relative, percent:undefined }), ...(percent !== undefined && { percent, relative:undefined }) } }
  }
  return {kind:'reply',reply:'请说出要调整的颜色、亮度或灯效。'}
}
