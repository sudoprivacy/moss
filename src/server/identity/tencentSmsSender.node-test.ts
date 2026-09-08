import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { TencentSmsSender } from './tencentSmsSender.js'

describe('Tencent SMS sender', () => {
  test('uses the legacy request shape and normalizes mainland phone numbers', async () => {
    let request: Record<string, unknown> | undefined
    const sender = new TencentSmsSender({
      sdkAppId: '1400000000', signName: '企业签名', templateId: '1234', signId: '5678',
      client: {
        async SendSms(input) {
          request = input
          return { SendStatusSet: [{ Code: 'Ok' }] }
        },
      },
    })
    await sender.send({ phone: '13800000000', code: '123456', expireMinutes: 5 })
    assert.deepEqual(request, {
      PhoneNumberSet: ['+8613800000000'],
      TemplateId: '1234',
      SmsSdkAppId: '1400000000',
      SignName: '企业签名',
      TemplateParamSet: ['123456', '5'],
    })
  })

  test('surfaces provider rejection without leaking credentials', async () => {
    const sender = new TencentSmsSender({
      sdkAppId: 'app', signName: 'sign', templateId: 'tpl', signId: 'sign-id',
      client: {
        async SendSms() {
          return { SendStatusSet: [{ Code: 'Failed', Message: 'provider rejected' }] }
        },
      },
    })
    await assert.rejects(
      sender.send({ phone: '+8613800000000', code: '123456', expireMinutes: 5 }),
      /短信发送失败：provider rejected/,
    )
  })
})
