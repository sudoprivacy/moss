import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { DatabaseSync } from 'node:sqlite'
import { formatCreateOrderReply, formatOrderListReply, formatCancellationQuestion, formatCancelOrderReply, formatOrderItems } from '../orders.js'
import { orderReply } from '../orderLanguage.js'
import { spokenLanguages } from '../language.js'
import { CabinServices } from '../service.js'
import { CabinStore } from '../store.js'
import type { CabinConfig, CabinOrder, CabinOrderCancellationCandidate } from '../types.js'

const order: CabinOrder = { id: 'internal-id', orderNo: 'SV-101', serviceTypeId: '3', status: '1', statusName: '已接单',
  items: [{ subItemId: 1, itemName: '可乐', quantity: 2 }, { subItemId: 2, itemName: '鲜榨橙汁', quantity: 1 }], createTime: '2026-11-24 15:00' }
const candidate: CabinOrderCancellationCandidate = { orderId: order.id, orderNo: order.orderNo, serviceTypeId: order.serviceTypeId,
  items: order.items, createTime: order.createTime }

describe('complete Chinese service order receipts', () => {
  it('places quantities and correct units before every supported product, including multi-item orders', () => {
    expect(formatCreateOrderReply(1, [], [2])).toBe('已为您创建2条毛毯的服务订单，请稍候。')
    for (const [id, name] of [[1, '可乐'], [2, '鲜榨橙汁'], [3, '手工茉莉拿铁']] as const) {
      expect(formatCreateOrderReply(3, [id], [1])).toBe(`已为您创建1杯${name}的服务订单，请稍候。`)
    }
    expect(formatCreateOrderReply(3, [1, 2, 3], [2, 1, 3])).toBe('已为您创建2杯可乐、1杯鲜榨橙汁、3杯手工茉莉拿铁的服务订单，请稍候。')
  })
  it('uses the same item details in queries, cancellation choices and cancellation receipts without inventing missing quantities', () => {
    const query = formatOrderListReply([order])
    const choices = formatCancellationQuestion([candidate])
    const cancel = formatCancelOrderReply(candidate)
    for (const text of [query, choices, cancel]) {
      expect(text).toContain('2杯可乐、1杯鲜榨橙汁')
      expect(text).not.toContain('可乐2份')
    }
    expect(query).toContain('1笔服务订单')
    expect(query).toContain('已接单')
    expect(choices).toContain('第1笔')
    expect(formatOrderItems([{ itemName: '毛毯', count: 2 }], '1')).toBe('2条毛毯')
    expect(formatOrderItems([{ subItemId: 3, num: 3 }], '3')).toBe('3杯手工茉莉拿铁')
    expect(formatOrderItems([{ itemName: '可乐', quantity: '2', unit: '瓶' }], '3')).toBe('2瓶可乐')
    expect(formatOrderItems([{ itemName: '可乐' }], '3')).toBe('可乐')
    expect(formatOrderItems([{ itemName: '耳机', quantity: 2 }])).toBe('耳机（数量2）')
    expect(formatOrderListReply([{ ...order, status: undefined, statusName: undefined, items: [] }])).toContain('状态暂未知')
    expect(formatOrderListReply([])).toContain('没有符合条件')
  })
})

describe('all spoken order languages', () => {
  for (const language of spokenLanguages.filter(code => code !== 'zh')) {
    it(`${language} preserves actual items/counts, named statuses and operation-specific failures`, () => {
      const create = orderReply(language, { intent: 'service_order_create', ok: true, reply: '', slots: {
        execution_status: 'succeeded', service_type_id: 3, sub_item_ids: [1, 2], quantities: [2, 1],
      } })
      expect(create).toContain('2')
      expect(create).toContain('1')
      expect(create).not.toContain('undefined')
      const list = orderReply(language, { intent: 'service_order_query', ok: true, reply: '', slots: {
        execution_status: 'succeeded', orders: [order],
      } })
      expect(list).toContain('2')
      expect(list).toContain(order.orderNo!)
      expect(list).not.toContain('internal-id')
      expect(list).not.toContain('已接单')
      const selection = orderReply(language, { intent: 'service_order_cancel_confirmation', ok: false, reply: '', slots: {
        execution_status: 'confirmation_required', candidates: [candidate],
      } })
      expect(selection).toContain('2')
      expect(selection).toContain(order.orderNo!)
      const cancelled = orderReply(language, { intent: 'service_order_cancel', ok: true, reply: '', slots: {
        execution_status: 'succeeded', service_type_id: '3', items: order.items,
      } })
      expect(cancelled).toContain('2')
      const failures = ['service_order_create', 'service_order_query', 'service_order_cancel'].map(intent =>
        orderReply(language, { intent, ok: false, reply: '', slots: { execution_status: 'failed' } }))
      expect(new Set(failures).size).toBe(3)
      expect(failures).not.toContain(create)
    })
  }
})

describe('order reply outcome integrity', () => {
  it('does not report success or no orders for malformed upstream results, and describes the actual cancelled order', async () => {
    let payload: unknown = { code: 0, data: null }
    const store = new CabinStore(new Database(':memory:') as unknown as DatabaseSync)
    const services = new CabinServices({ config: { controlBaseUrl: 'http://mock.invalid', controlTimeoutMs: 100 } as CabinConfig,
      store, fetchImpl: (async () => Response.json(payload)) as typeof fetch })
    const context = { flightId: 'f', flightDate: '2026-11-24', tabletId: 'p', tabletAccessToken: 'token', seatId: '7A' }
    const conversation = await services.ensureConversation(context)
    const run = (text: string) => services.executeOrderIntent({ context, conversationId: conversation.id, text })
    expect((await run('我要一杯可乐')).slots.execution_status).toBe('failed')
    for (const data of [null, {}, [{ status: 1 }], { list: 'not-an-array' }]) {
      payload = { code: 0, data }
      const result = await run('查询订单')
      expect(result.slots.execution_status).toBe('failed')
      expect(result.reply).not.toContain('没有')
    }
    payload = { code: 0, data: [] }
    const empty = await run('查询订单')
    expect(empty.slots.execution_status).toBe('succeeded')
    expect(empty.reply).toContain('没有符合条件')
    payload = { code: 0, data: false }
    store.setPendingOrderCancellation(conversation.id, [candidate])
    const failed = await run('第1笔')
    expect(failed.slots.execution_status).toBe('failed')
    expect(failed.reply).toContain('取消失败')
    payload = { code: 0, data: true }
    store.setPendingOrderCancellation(conversation.id, [candidate])
    const cancelled = await run('第1笔')
    expect(cancelled.slots.execution_status).toBe('succeeded')
    expect(cancelled.reply).toBe('已为您取消2杯可乐、1杯鲜榨橙汁的服务订单。')
    payload = { code: 503, data: [] }
    expect((await run('取消可乐')).reply).toContain('无法查询可取消')
  })
})
