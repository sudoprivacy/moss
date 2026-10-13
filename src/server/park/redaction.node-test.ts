import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { redactText, REDACTED_MAX_LENGTH } from './redaction.js'

void describe('park redaction', () => {
  void test('抹除手机号', () => {
    assert.equal(
      redactText('请联系 13812345678 咨询租金政策'),
      '请联系 *** 咨询租金政策',
    )
  })

  void test('手机号不误伤长数字中的片段', () => {
    // 13 位以内不含独立 11 位手机号的数字串不应被部分抹除
    assert.equal(redactText('订单号 20261012001'), '订单号 20261012001')
  })

  void test('抹除邮箱', () => {
    assert.equal(
      redactText('发我 email 到 zhang.san@example.com 谢谢'),
      '发我 email 到 *** 谢谢',
    )
  })

  void test('抹除 18 位身份证号', () => {
    assert.equal(
      redactText('证件号 11010119900307891X'),
      '证件号 ***',
    )
  })

  void test('同时出现多种敏感信息时全部抹除', () => {
    const out = redactText('联系 13812345678 或 a@b.cn，证件 110101199003078912')
    assert.equal(out, '联系 *** 或 ***，证件 ***')
  })

  void test('超长文本截断并加省略号', () => {
    const long = '租'.repeat(REDACTED_MAX_LENGTH + 50)
    const out = redactText(long)
    assert.equal(out.length, REDACTED_MAX_LENGTH + 1)
    assert.ok(out.endsWith('…'))
  })

  void test('空输入返回空字符串', () => {
    assert.equal(redactText(''), '')
    assert.equal(redactText(null), '')
    assert.equal(redactText(undefined), '')
  })
})
