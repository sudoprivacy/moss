import nodemailer from 'nodemailer'

import type { QmsNotificationPort } from './alertService.js'

interface Mailer {
  sendMail(message: Record<string, unknown>): Promise<unknown>
}

export interface QmsNotificationRuntimeConfig {
  larkWebhookUrl?: string
  smtpUrl?: string
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/(?:smtp|smtps):\/\/[^\s@]+@/gi, 'smtp://***@').slice(0, 500)
}

export class QmsNotificationAdapter implements QmsNotificationPort {
  private readonly fetch: typeof fetch
  private readonly createMailer: (url: string) => Mailer

  constructor(private readonly options: {
    config(): QmsNotificationRuntimeConfig
    fetch?: typeof fetch
    createMailer?: (url: string) => Mailer
  }) {
    this.fetch = options.fetch ?? fetch
    this.createMailer = options.createMailer ?? (url => nodemailer.createTransport(url))
  }

  async send(channel: string, payload: Record<string, unknown> = {}) {
    try {
      if (channel === 'lark') return await this.sendLark(payload)
      if (channel === 'email') return await this.sendEmail(payload)
      return { success: false, error: `Unknown channel: ${channel}` }
    } catch (error) {
      return { success: false, error: safeError(error) }
    }
  }

  private async sendLark(payload: Record<string, unknown>) {
    const value = this.options.config().larkWebhookUrl?.trim()
    if (!value) return { success: false, error: 'Lark webhook URL not configured' }
    const url = new URL(value)
    if (url.protocol !== 'https:') return { success: false, error: 'Lark webhook URL must use HTTPS' }
    const response = await this.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        msg_type: 'interactive',
        card: {
          config: { wide_screen_mode: true },
          elements: [
            { tag: 'div', text: { content: String(payload.message ?? ''), tag: 'lark_md' } },
            { tag: 'note', elements: [{
              tag: 'plain_text', content: `时间: ${new Date(Number(payload.timestamp ?? Date.now())).toLocaleString('zh-CN')}`,
            }] },
          ],
          header: {
            title: { tag: 'plain_text', content: String(payload.title ?? 'QMS Alert') },
            template: payload.level === 'critical' ? 'red' : payload.level === 'warning' ? 'orange' : 'blue',
          },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return { success: false, error: `Lark HTTP ${response.status}` }
    const result = await response.json() as { StatusCode?: number; code?: number; StatusMessage?: string; msg?: string }
    const code = result.StatusCode ?? result.code ?? 0
    return code === 0
      ? { success: true }
      : { success: false, error: result.StatusMessage ?? result.msg ?? 'Lark API error' }
  }

  private async sendEmail(payload: Record<string, unknown>) {
    const value = this.options.config().smtpUrl?.trim()
    if (!value) return { success: false, error: 'Email SMTP not configured' }
    const url = new URL(value)
    if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') {
      return { success: false, error: 'SMTP URL must use smtp:// or smtps://' }
    }
    const from = url.searchParams.get('from') || decodeURIComponent(url.username)
    const to = url.searchParams.get('to')
    if (!to) return { success: false, error: 'No recipient email address configured' }
    url.search = ''
    const mailer = this.createMailer(url.toString())
    await mailer.sendMail({
      from, to,
      subject: `[${String(payload.level ?? 'INFO').toUpperCase()}] ${String(payload.title ?? 'QMS Alert')}`,
      html: `<h2>${escapeHtml(payload.title ?? 'QMS Alert')}</h2><p>${escapeHtml(payload.message ?? '')}</p>`
        + `<p>${escapeHtml(payload.detail ?? '')}</p>`,
    })
    return { success: true }
  }
}
