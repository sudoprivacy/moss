import { createRequire } from 'node:module'
import type { SmsSender } from './smsVerification.js'

export interface TencentSmsClient {
  SendSms(input: Record<string, unknown>): Promise<{
    SendStatusSet?: Array<{ Code?: string; Message?: string }>
  }>
}

interface TencentSmsSenderOptions {
  sdkAppId: string
  signName: string
  templateId: string
  signId: string
  client: TencentSmsClient
}

export class TencentSmsSender implements SmsSender {
  constructor(private readonly options: TencentSmsSenderOptions) {}

  async send(input: { phone: string; code: string; expireMinutes: number }): Promise<void> {
    const phone = input.phone.startsWith('+') ? input.phone : `+86${input.phone}`
    const result = await this.options.client.SendSms({
      PhoneNumberSet: [phone],
      TemplateId: this.options.templateId,
      SmsSdkAppId: this.options.sdkAppId,
      SignName: this.options.signName,
      TemplateParamSet: [input.code, String(input.expireMinutes)],
    })
    const status = result.SendStatusSet?.[0]
    if (status?.Code !== 'Ok') {
      throw new Error(`短信发送失败：${status?.Message || status?.Code || '未知错误'}`)
    }
  }
}

export function createTencentSmsSender(options: {
  secretId: string
  secretKey: string
  sdkAppId: string
  signName: string
  templateId: string
  signId: string
  region: string
}): TencentSmsSender {
  const missing = Object.entries(options).filter(([, value]) => !value.trim()).map(([key]) => key)
  if (missing.length > 0) {
    throw new Error(`Tencent SMS configuration is incomplete: ${missing.join(', ')}`)
  }
  const require = createRequire(import.meta.url)
  const tencentcloud = require('tencentcloud-sdk-nodejs') as {
    sms: { v20210111: { Client: new (input: Record<string, unknown>) => TencentSmsClient } }
  }
  const Client = tencentcloud.sms.v20210111.Client
  return new TencentSmsSender({
    sdkAppId: options.sdkAppId,
    signName: options.signName,
    templateId: options.templateId,
    signId: options.signId,
    client: new Client({
      credential: { secretId: options.secretId, secretKey: options.secretKey },
      region: options.region,
    }),
  })
}
