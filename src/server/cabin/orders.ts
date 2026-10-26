import type { CabinConfig } from './types.js'
import type { CabinLogger, CabinLogContext } from './logger.js'
import type {
  CabinOrder,
  CabinOrderCancellationCandidate,
  CabinPassengerContext,
} from './types.js'
import { fetchWithTimeout } from './http.js'

type FetchLike = typeof fetch

export type CabinOrderIntent =
  | { kind: 'create'; serviceTypeId: 1 | 3; subItemIds: number[]; quantities: number[] }
  | { kind: 'query'; status?: string }
  | { kind: 'cancel'; serviceTypeId?: 1 | 3; subItemIds?: number[] }
  | { kind: 'clarify'; reason: 'drink_item_missing' }

export type CabinOrderResult = {
  intent: string
  slots: Record<string, unknown>
  reply: string
  ok: boolean
  toolCall?: {
    id: string
    name: string
    arguments: Record<string, unknown>
  }
}

type OrderResponse = {
  ok: boolean
  status?: number
  payload: unknown
  message?: string
}

const DRINKS = [
  { id: 1, names: ['可乐', '汽水', 'cola'] },
  { id: 2, names: ['鲜榨橙汁', '橙汁', 'orange juice'] },
  { id: 3, names: ['手工茉莉拿铁', '茉莉拿铁', '拿铁', 'latte'] },
] as const

const NUMBER_WORDS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
}

export class CabinOrderClient {
  constructor(
    private readonly config: CabinConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly logger?: CabinLogger,
  ) {}

  async create(input: {
    context: CabinPassengerContext
    serviceTypeId: 1 | 3
    subItemIds: number[]
    quantities: number[]
    logContext?: CabinLogContext
  }): Promise<OrderResponse> {
    return this.request({
      method: 'POST',
      path: '/admin-api/cabin/service-order/create',
      context: input.context,
      body: {
        serviceTypeId: input.serviceTypeId,
        subItemIds: input.subItemIds,
        quantities: input.quantities,
      },
      logContext: input.logContext,
    })
  }

  async listBySeat(input: {
    context: CabinPassengerContext
    status: string
    logContext?: CabinLogContext
  }): Promise<OrderResponse & { orders: CabinOrder[] }> {
    const response = await this.request({
      method: 'GET',
      path: `/admin-api/cabin/service-order/list-by-seat?status=${encodeURIComponent(input.status)}`,
      context: input.context,
      logContext: input.logContext,
    })
    return { ...response, orders: response.ok ? extractOrders(response.payload) : [] }
  }

  async cancel(input: {
    context: CabinPassengerContext
    orderId: string
    cancelReason: string
    logContext?: CabinLogContext
  }): Promise<OrderResponse> {
    return this.request({
      method: 'PUT',
      path: '/admin-api/cabin/service-order/cancel',
      context: input.context,
      body: {
        orderId: Number.isFinite(Number(input.orderId)) ? Number(input.orderId) : input.orderId,
        cancelReason: input.cancelReason,
      },
      logContext: input.logContext,
    })
  }

  private async request(input: {
    method: 'GET' | 'POST' | 'PUT'
    path: string
    context: CabinPassengerContext
    body?: Record<string, unknown>
    logContext?: CabinLogContext
  }): Promise<OrderResponse> {
    const baseUrl = this.config.controlBaseUrl?.replace(/\/+$/, '')
    const url = baseUrl ? `${baseUrl}${input.path}` : input.path
    if (!baseUrl) return { ok: false, payload: null, message: '订单服务地址未配置' }
    if (!input.context.tabletAccessToken) {
      return { ok: false, payload: null, message: '乘客信息缺少 tabletAccessToken' }
    }

    const headers: Record<string, string> = {
      'tablet-token': input.context.tabletAccessToken,
    }
    if (input.method !== 'GET') headers['content-type'] = 'application/json'
    if (this.config.controlAuth) headers.authorization = this.config.controlAuth

    const startedAt = Date.now()
    let response: Response
    let payload: unknown = null
    try {
      response = await fetchWithTimeout(
        this.fetchImpl,
        url,
        {
          method: input.method,
          headers,
          ...(input.body ? { body: JSON.stringify(input.body) } : {}),
        },
        this.config.controlTimeoutMs ?? 10_000,
        `service-order ${input.method}`,
      )
      const text = await response.text()
      payload = text.trim() ? parseJson(text) : null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log(input, startedAt, false, undefined, message)
      return { ok: false, payload: null, message }
    }

    const code = objectValue(payload, 'code')
    const message = typeof objectValue(payload, 'msg') === 'string'
      ? String(objectValue(payload, 'msg'))
      : undefined
    const ok = response.ok && (code === 0 || code === '0')
    this.log(input, startedAt, ok, response.status, ok ? undefined : message || `HTTP ${response.status}`)
    return { ok, status: response.status, payload, message }
  }

  private log(
    input: { method: string; path: string; logContext?: CabinLogContext },
    startedAt: number,
    ok: boolean,
    status?: number,
    errorMessage?: string,
  ): void {
    this.logger?.log({
      type: 'outbound',
      ...input.logContext,
      upstream: 'service-order',
      method: input.method,
      url: `${this.config.controlBaseUrl?.replace(/\/+$/, '') || ''}${input.path}`,
      status,
      ok,
      elapsedMs: Date.now() - startedAt,
      errorCode: ok ? undefined : 'SERVICE_ORDER_FAILED',
      errorMessage,
    })
  }
}

export function parseCabinOrderIntent(text: string): CabinOrderIntent | null {
  const normalized = text.trim().toLowerCase()
  if (!normalized) return null

  if (/(取消|不要了|不用了|退掉|撤销|cancel|remove)/i.test(normalized)) {
    const drink = findDrink(normalized)
    if (drink) return { kind: 'cancel', serviceTypeId: 3, subItemIds: [drink.id] }
    if (/(毛毯|毯子|blanket)/i.test(normalized)) return { kind: 'cancel', serviceTypeId: 1, subItemIds: [] }
    return { kind: 'cancel' }
  }

  if (/(订单|点了什么|点单|服务单|送到|配送|order|delivery)/i.test(normalized)) {
    return { kind: 'query' }
  }

  const drinks = findDrinks(normalized)
  if (drinks.length) {
    const subItemIds: number[] = []
    const quantities: number[] = []
    for (const drink of drinks) {
      const matchedName = drink.names.find(name => normalized.includes(name.toLowerCase())) || drink.names[0]
      const itemStart = normalized.indexOf(matchedName.toLowerCase())
      const quantity = extractQuantityAround(normalized, itemStart, itemStart + matchedName.length)
        || extractQuantity(normalized)
        || 1
      subItemIds.push(drink.id)
      quantities.push(quantity)
    }
    return { kind: 'create', serviceTypeId: 3, subItemIds, quantities }
  }

  if (/(毛毯|毯子|blanket)/i.test(normalized)) {
    return { kind: 'create', serviceTypeId: 1, subItemIds: [], quantities: [extractQuantity(normalized) || 1] }
  }

  if (/(饮料|drink)/i.test(normalized)) return { kind: 'clarify', reason: 'drink_item_missing' }

  return null
}

/**
 * A fuzzy order candidate is sent to the model only when the text contains a
 * service/order signal. Ordinary cabin chat therefore does not incur an LLM
 * classification request.
 */
export function looksLikeCabinOrderRequest(text: string): boolean {
  return /(订单|点单|点餐|服务单|饮品|饮料|毛毯|毯子|可乐|橙汁|果汁|拿铁|汽水|碳酸|咖啡|喝|口渴|渴了|吃点|吃的|一杯|一条|来一|blanket|drink|order|thirsty)/i.test(text)
}

export function parseModelCabinOrderIntent(value: unknown): CabinOrderIntent | null {
  const candidate = unwrapModelOrderPayload(value)
  if (!candidate || typeof candidate.kind !== 'string') return null

  if (candidate.kind === 'query') return { kind: 'query' }
  if (candidate.kind === 'cancel') {
    const serviceTypeId = parseServiceTypeId(candidate.serviceTypeId)
    const subItemIds = parseSubItemIds(candidate.subItemIds)
    if (candidate.serviceTypeId !== undefined && !serviceTypeId) return null
    if (!subItemIds) return null
    return {
      kind: 'cancel',
      ...(serviceTypeId ? { serviceTypeId } : {}),
      ...(subItemIds.length ? { subItemIds } : {}),
    }
  }
  if (candidate.kind === 'clarify') {
    return { kind: 'clarify', reason: 'drink_item_missing' }
  }
  if (candidate.kind !== 'create') return null

  const serviceTypeId = parseServiceTypeId(candidate.serviceTypeId)
  if (!serviceTypeId) return null
  const subItemIds = parseSubItemIds(candidate.subItemIds)
  const quantities = parseQuantities(candidate.quantities)
  if (!subItemIds || !quantities) return null
  if (serviceTypeId === 1) {
    if (subItemIds.length || quantities.length !== 1) return null
    return { kind: 'create', serviceTypeId, subItemIds: [], quantities }
  }
  if (!subItemIds.length || subItemIds.length !== quantities.length) return null
  return { kind: 'create', serviceTypeId, subItemIds, quantities }
}

function unwrapModelOrderPayload(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const direct = value as Record<string, unknown>
    if (typeof direct.kind === 'string') return direct
    const content = objectValue(direct, 'content')
    if (typeof content === 'string') return parseModelOrderJson(content)
    const choices = objectValue(direct, 'choices')
    if (Array.isArray(choices)) {
      const message = choices[0] && typeof choices[0] === 'object'
        ? objectValue(choices[0], 'message')
        : undefined
      const messageContent = objectValue(message, 'content')
      if (typeof messageContent === 'string') return parseModelOrderJson(messageContent)
    }
  }
  if (typeof value === 'string') return parseModelOrderJson(value)
  return null
}

function parseModelOrderJson(content: string): Record<string, unknown> | null {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      const parsed = JSON.parse(match[0]) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null
    } catch {
      return null
    }
  }
}

function parseServiceTypeId(value: unknown): 1 | 3 | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return number === 1 || number === 3 ? number : null
}

function parseSubItemIds(value: unknown): number[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const values = value.map(item => typeof item === 'number' ? item : typeof item === 'string' ? Number(item) : NaN)
  return values.every(item => Number.isInteger(item) && item >= 1 && item <= 3) ? values : null
}

function parseQuantities(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null
  const values = value.map(item => typeof item === 'number' ? item : typeof item === 'string' ? Number(item) : NaN)
  return values.every(item => Number.isInteger(item) && item >= 1 && item <= 99) ? values : null
}

export function isOrderSelection(text: string): boolean {
  return /(第\s*[0-9一二两三四五六七八九十]+\s*(笔|单|个)?|订单号|序号|可乐|橙汁|拿铁|毛毯|毯子)/i.test(text)
}

export function matchOrderCandidates(
  orders: CabinOrder[],
  intent: Extract<CabinOrderIntent, { kind: 'cancel' }>,
): CabinOrderCancellationCandidate[] {
  return orders
    .filter(order => order.status === '1' || order.status === '2')
    .filter(order => {
      if (!intent.serviceTypeId) return true
      if (order.serviceTypeId !== String(intent.serviceTypeId)) return false
      if (intent.serviceTypeId !== 3 || !intent.subItemIds?.length) return true
      return intent.subItemIds.every(id => order.items.some(item => itemMatches(item, id)))
    })
    .map(toCancellationCandidate)
}

export function resolveOrderSelection(
  text: string,
  candidates: CabinOrderCancellationCandidate[],
): CabinOrderCancellationCandidate | null {
  const byOrderNumber = candidates.filter(candidate => candidate.orderNo && text.includes(candidate.orderNo))
  if (byOrderNumber.length === 1) return byOrderNumber[0]

  const indexMatch = text.match(/第\s*([0-9一二两三四五六七八九十]+)\s*(?:笔|单|个)?/i)
  if (indexMatch) {
    const index = parseNumber(indexMatch[1])
    if (index && index >= 1 && index <= candidates.length) return candidates[index - 1]
  }

  const itemMatches = candidates.filter(candidate => candidate.items.some(item => {
    const name = itemName(item)
    return Boolean(name && text.toLowerCase().includes(name.toLowerCase()))
  }))
  return itemMatches.length === 1 ? itemMatches[0] : null
}

export function formatOrderListReply(orders: CabinOrder[]): string {
  if (!orders.length) return '当前座位没有符合条件的服务订单。'
  const lines = orders.map(order => {
    const itemText = formatOrderItems(order.items)
    const service = order.serviceTypeName || serviceTypeName(order.serviceTypeId)
    const details = [service, itemText, order.statusName || `状态${order.status || ''}`, order.createTime]
      .filter(Boolean)
      .join('，')
    return `${details}。`
  })
  return `当前座位的订单如下：\n${lines.map((line, index) => `${index + 1}. ${line}`).join('\n')}`
}

export function formatCancellationQuestion(candidates: CabinOrderCancellationCandidate[]): string {
  const lines = candidates.map((candidate, index) => {
    const service = candidate.serviceTypeName || serviceTypeName(candidate.serviceTypeId)
    const itemText = formatOrderItems(candidate.items)
    const detail = [service, itemText, candidate.createTime, candidate.orderNo ? `订单号${candidate.orderNo}` : undefined]
      .filter(Boolean)
      .join('，')
    return `${index + 1}. ${detail}`
  })
  return `您有多笔可取消的服务订单：\n${lines.join('\n')}\n请问要取消哪一笔？`
}

export function formatCreateOrderReply(serviceTypeId: 1 | 3, subItemIds: number[], quantities: number[]): string {
  const service = serviceTypeId === 1
    ? `毛毯${quantities[0] || 1}条`
    : subItemIds.map((id, index) => `${drinkName(id)}${quantities[index] || 1}杯`).join('、')
  return `已为您创建${service}服务订单，请稍候。`
}

function extractOrders(payload: unknown): CabinOrder[] {
  const data = objectValue(payload, 'data')
  const list = Array.isArray(data)
    ? data
    : data && typeof data === 'object'
      ? objectValue(data, 'list') || objectValue(data, 'records') || objectValue(data, 'rows')
      : []
  if (!Array.isArray(list)) return []
  return list.map(normalizeOrder).filter((order): order is CabinOrder => Boolean(order))
}

function normalizeOrder(value: unknown): CabinOrder | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const id = stringValue(value, 'id', 'orderId', 'order_id')
  if (!id) return null
  const itemsValue = objectValue(value, 'items')
  return {
    id,
    orderNo: stringValue(value, 'orderNo', 'order_no'),
    serviceTypeId: stringValue(value, 'serviceTypeId', 'service_type_id'),
    serviceTypeName: stringValue(value, 'serviceTypeName', 'service_type_name'),
    serviceTypeCode: stringValue(value, 'serviceTypeCode', 'service_type_code'),
    status: stringValue(value, 'status'),
    statusName: stringValue(value, 'statusName', 'status_name'),
    items: Array.isArray(itemsValue)
      ? itemsValue.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as Record<string, unknown>[]
      : [],
    createTime: stringValue(value, 'createTime', 'create_time'),
    updateTime: stringValue(value, 'updateTime', 'update_time'),
    deliverTime: stringValue(value, 'deliverTime', 'deliver_time'),
  }
}

function toCancellationCandidate(order: CabinOrder): CabinOrderCancellationCandidate {
  return {
    orderId: order.id,
    orderNo: order.orderNo,
    serviceTypeId: order.serviceTypeId,
    serviceTypeName: order.serviceTypeName,
    serviceTypeCode: order.serviceTypeCode,
    status: order.status,
    statusName: order.statusName,
    items: order.items,
    createTime: order.createTime,
    updateTime: order.updateTime,
    deliverTime: order.deliverTime,
  }
}

function findDrink(text: string): (typeof DRINKS)[number] | null {
  return findDrinks(text)[0] || null
}

function findDrinks(text: string): (typeof DRINKS)[number][] {
  return DRINKS
    .map(drink => ({
      drink,
      index: Math.min(...drink.names
        .map(name => text.indexOf(name.toLowerCase()))
        .filter(index => index >= 0)),
    }))
    .filter(item => Number.isFinite(item.index))
    .sort((left, right) => left.index - right.index)
    .map(item => item.drink)
}

function extractQuantity(text: string): number | null {
  const match = text.match(/(?:^|[^0-9一二两三四五六七八九十百零])([0-9]{1,2}|[一二两三四五六七八九十]{1,3})(?=\s*(?:个|条|杯|份|件|瓶)?)/)
  return match ? parseNumber(match[1]) : null
}

function extractQuantityAround(text: string, start: number, end: number): number | null {
  if (start < 0) return null
  const before = text.slice(Math.max(0, start - 8), start)
  const after = text.slice(end, Math.min(text.length, end + 8))
  const beforeMatch = before.match(/([0-9]{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:个|条|杯|份|件|瓶)?\s*$/)
  if (beforeMatch) return parseNumber(beforeMatch[1])
  const afterMatch = after.match(/^\s*([0-9]{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:个|条|杯|份|件|瓶)?/)
  return afterMatch ? parseNumber(afterMatch[1]) : null
}

function parseNumber(value: string): number | null {
  if (/^\d+$/.test(value)) {
    const number = Number(value)
    return number >= 1 && number <= 99 ? number : null
  }
  if (value === '十') return 10
  if (value.startsWith('十')) return 10 + (NUMBER_WORDS[value.slice(1)] || 0)
  if (value.endsWith('十')) return (NUMBER_WORDS[value[0]] || 0) * 10
  if (value.length === 2 && value[1] === '十') return (NUMBER_WORDS[value[0]] || 0) * 10
  const number = value.split('').reduce((sum, char) => sum * 10 + (NUMBER_WORDS[char] ?? 0), 0)
  return number >= 1 && number <= 99 ? number : null
}

function itemMatches(item: Record<string, unknown>, id: number): boolean {
  const itemId = stringValue(item, 'subItemId', 'sub_item_id', 'itemId', 'item_id', 'id')
  return itemId === String(id)
}

function itemName(item: Record<string, unknown>): string | undefined {
  return stringValue(item, 'name', 'itemName', 'item_name', 'subItemName', 'sub_item_name')
}

function formatOrderItems(items: Record<string, unknown>[]): string | undefined {
  if (!items.length) return undefined
  const parts = items.map(item => {
    const name = itemName(item) || '服务项'
    const quantity = stringValue(item, 'quantity', 'count', 'num')
    return quantity ? `${name}${quantity}份` : name
  })
  return parts.join('、')
}

function serviceTypeName(id?: string): string {
  if (id === '1') return '毛毯'
  if (id === '3') return '饮品'
  return '服务'
}

function drinkName(id: number): string {
  return DRINKS.find(drink => drink.id === id)?.names[0] || '饮品'
}

function objectValue(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined
}

function stringValue(value: unknown, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const item = objectValue(value, key)
    if (typeof item === 'string' && item.trim()) return item.trim()
    if (typeof item === 'number' && Number.isFinite(item)) return String(item)
  }
  return undefined
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}
