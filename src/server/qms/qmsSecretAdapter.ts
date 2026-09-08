import type { QmsRuntimeConfig } from './config.js'
import type { QmsSystemSecretPort } from './qmsSystemService.js'

export type QmsNexusConfigKey = 'server.qms-lark-webhook-url' | 'server.qms-smtp-url'

export interface QmsNexusSecretBacking {
  get(key: QmsNexusConfigKey): string | undefined
  put(key: QmsNexusConfigKey, value: string): Promise<void>
}

export interface QmsLegacyNotificationInput {
  lark?: { webhookUrl?: string }
  email?: {
    smtpHost?: string
    smtpPort?: number
    smtpUser?: string
    smtpPass?: string
    from?: string
    to?: string
  }
}

type SmtpParts = {
  protocol: 'smtp:' | 'smtps:'
  host: string
  port: string
  user: string
  pass: string
  from: string
  to: string
}

function smtpParts(value?: string): SmtpParts {
  if (!value) {
    return { protocol: 'smtp:', host: '', port: '587', user: '', pass: '', from: '', to: '' }
  }
  const url = new URL(value)
  if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') throw new Error('QMS SMTP URL must use smtp:// or smtps://')
  return {
    protocol: url.protocol,
    host: url.hostname,
    port: url.port || (url.protocol === 'smtps:' ? '465' : '587'),
    user: decodeURIComponent(url.username),
    pass: decodeURIComponent(url.password),
    from: url.searchParams.get('from') ?? '',
    to: url.searchParams.get('to') ?? '',
  }
}

function smtpUrl(parts: SmtpParts): string {
  if (!parts.host.trim()) throw new Error('QMS SMTP host is required')
  const url = new URL(`${parts.protocol}//${parts.host}`)
  url.port = parts.port
  url.username = parts.user
  url.password = parts.pass
  if (parts.from) url.searchParams.set('from', parts.from)
  if (parts.to) url.searchParams.set('to', parts.to)
  return url.toString()
}

export class QmsNexusSecretAdapter implements QmsSystemSecretPort {
  constructor(
    private readonly config: QmsRuntimeConfig,
    private readonly backing: QmsNexusSecretBacking,
  ) {}

  get(key: string): string | undefined {
    if (key === 'notification_lark_webhook') return this.config.secrets.larkWebhookUrl
    const smtp = smtpParts(this.config.secrets.smtpUrl)
    if (key === 'notification_email_smtp_host') return smtp.host || undefined
    if (key === 'notification_email_smtp_port') return smtp.port
    if (key === 'notification_email_smtp_user') return smtp.user || undefined
    if (key === 'notification_email_smtp_pass') return smtp.pass || undefined
    if (key === 'notification_email_from') return smtp.from || undefined
    if (key === 'notification_email_to') return smtp.to || undefined
    return undefined
  }

  async put(key: string, value: string): Promise<void> {
    if (key === 'notification_lark_webhook') {
      await this.updateNotifications({ lark: { webhookUrl: value } })
      return
    }
    const field = fieldNames[key as keyof typeof fieldNames]
    if (!field) throw new Error(`Unsupported QMS secret key: ${key}`)
    await this.updateNotifications({ email: { [field]: field === 'smtpPort' ? Number(value) : value } })
  }

  async updateNotifications(input: QmsLegacyNotificationInput): Promise<void> {
    const writes: Array<Promise<void>> = []
    let nextLark: string | undefined
    let nextSmtp: string | undefined
    if (input.lark?.webhookUrl !== undefined) {
      nextLark = input.lark.webhookUrl.trim()
      writes.push(this.backing.put('server.qms-lark-webhook-url', nextLark))
    }
    if (input.email) {
      const current = smtpParts(this.config.secrets.smtpUrl)
      const next: SmtpParts = {
        ...current,
        host: input.email.smtpHost?.trim() ?? current.host,
        port: input.email.smtpPort === undefined ? current.port : String(input.email.smtpPort),
        user: input.email.smtpUser ?? current.user,
        pass: input.email.smtpPass ?? current.pass,
        from: input.email.from ?? current.from,
        to: input.email.to ?? current.to,
      }
      nextSmtp = smtpUrl(next)
      writes.push(this.backing.put('server.qms-smtp-url', nextSmtp))
    }
    await Promise.all(writes)
    if (nextLark !== undefined) this.config.secrets.larkWebhookUrl = nextLark || undefined
    if (nextSmtp !== undefined) this.config.secrets.smtpUrl = nextSmtp
  }
}

const fieldNames = {
  notification_email_smtp_host: 'smtpHost',
  notification_email_smtp_port: 'smtpPort',
  notification_email_smtp_user: 'smtpUser',
  notification_email_smtp_pass: 'smtpPass',
  notification_email_from: 'from',
  notification_email_to: 'to',
} as const
