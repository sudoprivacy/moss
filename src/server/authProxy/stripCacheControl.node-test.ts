import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { dropCacheControl, stripCacheControlFromBody } from './authProxyServer.js'

/**
 * MOSS_STRIP_CACHE_CONTROL 剥离逻辑测试：JSON 请求体中所有 cache_control
 * 键被递归移除；非 JSON / 开关关闭时原样透传。（SudoRouter 网关 400 兼容）
 */

void describe('authProxy stripCacheControlFromBody（SudoRouter cache_control 兼容）', () => {
  void test('开启开关：Anthropic 请求体的 cache_control 全部剥离（content/system/tools 嵌套）', () => {
    process.env.MOSS_STRIP_CACHE_CONTROL = '1'
    try {
      const body = Buffer.from(JSON.stringify({
        model: 'claude-sonnet-4-6',
        system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }],
        tools: [{ name: 't', input_schema: {}, cache_control: { type: 'ephemeral' } }],
      }))
      const out = JSON.parse(stripCacheControlFromBody(body).toString('utf8'))
      assert.equal(JSON.stringify(out).includes('cache_control'), false, '无任何 cache_control 残留')
      assert.equal(out.system[0].text, 'sys', '其他字段保持原样')
      assert.equal(out.messages[0].content[0].text, 'hi')
      assert.equal(out.tools[0].name, 't')
    } finally {
      delete process.env.MOSS_STRIP_CACHE_CONTROL
    }
  })

  void test('开启开关：非 JSON 与空 body 原样透传', () => {
    process.env.MOSS_STRIP_CACHE_CONTROL = '1'
    try {
      const binary = Buffer.from([0x00, 0x01, 0x02])
      assert.deepEqual(stripCacheControlFromBody(binary), binary, '二进制透传')
      assert.deepEqual(stripCacheControlFromBody(Buffer.alloc(0)), Buffer.alloc(0), '空 body 透传')
      const scalar = Buffer.from('123')
      assert.deepEqual(stripCacheControlFromBody(scalar), scalar, '标量 JSON 透传')
    } finally {
      delete process.env.MOSS_STRIP_CACHE_CONTROL
    }
  })

  void test('关闭开关（默认）：含 cache_control 的 body 原样透传', () => {
    delete process.env.MOSS_STRIP_CACHE_CONTROL
    const body = Buffer.from(JSON.stringify({ system: [{ text: 'x', cache_control: { type: 'ephemeral' } }] }))
    assert.equal(stripCacheControlFromBody(body).toString('utf8'), body.toString('utf8'), '默认零行为变化')
  })

  void test('dropCacheControl 递归处理深层嵌套', () => {
    const input = { a: { b: { c: [{ cache_control: 1, keep: true }] } } }
    assert.deepEqual(dropCacheControl(input), { a: { b: { c: [{ keep: true }] } } })
  })
})
