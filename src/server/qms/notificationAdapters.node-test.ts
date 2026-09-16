import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { QmsNotificationAdapter } from './notificationAdapters.js'

describe('QmsNotificationAdapter', () => {
  it('sends the legacy interactive card to a configured HTTPS Lark webhook', async () => {
    const requests: Array<{ url: string; body: string }> = []
    const adapter = new QmsNotificationAdapter({
      config: () => ({ larkWebhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test' }),
      fetch: async (url, init) => {
        requests.push({ url: String(url), body: String(init?.body) })
        return new Response(JSON.stringify({ StatusCode: 0 }), { status: 200 })
      },
    })

    assert.deepEqual(await adapter.send('lark', {
      title: '错误率', message: '超过阈值', level: 'critical', timestamp: 1_000,
    }), { success: true })
    assert.equal(requests.length, 1)
    assert.match(requests[0]!.body, /interactive/)
  })

  it('rejects insecure webhook URLs before network access', async () => {
    let calls = 0
    const adapter = new QmsNotificationAdapter({
      config: () => ({ larkWebhookUrl: 'http://127.0.0.1/internal' }),
      fetch: async () => { calls += 1; return new Response('{}') },
    })

    const result = await adapter.send('lark', { title: 'x' })
    assert.equal(result.success, false)
    assert.match(result.error ?? '', /HTTPS/)
    assert.equal(calls, 0)
  })

  it('uses the SMTP URL without exposing credentials in errors', async () => {
    const sent: Array<Record<string, unknown>> = []
    const adapter = new QmsNotificationAdapter({
      config: () => ({ smtpUrl: 'smtps://user:very-secret@mail.example:465?from=qms%40example.com&to=ops%40example.com' }),
      createMailer: () => ({
        sendMail: async message => { sent.push({ ...message }); return { messageId: 'm1' } },
      }),
    })

    assert.deepEqual(await adapter.send('email', { title: '<Failure>', message: '<b>boom</b>' }), { success: true })
    assert.equal(sent[0]?.to, 'ops@example.com')
    assert.match(String(sent[0]?.html), /&lt;b&gt;boom&lt;\/b&gt;/)
    assert.doesNotMatch(JSON.stringify(sent), /very-secret/)
  })
})
