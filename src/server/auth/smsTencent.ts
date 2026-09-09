/**
 * Tencent Cloud SMS delivery for phone verification codes.
 *
 * ## Where the credentials live, and why
 *
 * Nowhere in this repo and nowhere in `server.json`. The SecretId/SecretKey are
 * read from the Nexus vault at send time, through the same client the rest of
 * moss uses for secrets. A key that can send SMS spends real money and can be
 * turned into a flood of texts at someone else's number, so it must not sit in a
 * config file that gets copied between machines, pasted into a chat, or ends up
 * in a backup tarball.
 *
 * `server.json` therefore carries only the non-secret half — sign name, template
 * id, app id, region — which is useless on its own.
 *
 * ## Signing
 *
 * Tencent Cloud API v3 uses TC3-HMAC-SHA256: a canonical request is hashed, put
 * into a string-to-sign scoped by date and service, and signed with a key chain
 * derived from the secret. Implemented here rather than pulling the vendor SDK
 * in: it is ~40 lines, and the SDK would add a dependency (and its transitive
 * tree) to a server that needs exactly one API call.
 */
import { createHash, createHmac } from 'node:crypto'

const ENDPOINT = 'sms.tencentcloudapi.com'
const SERVICE = 'sms'
const VERSION = '2021-01-11'
const ACTION = 'SendSms'

/** Non-secret settings; the credential pair is fetched separately. */
export type TencentSmsSettings = {
  sdkAppId: string
  signName: string
  templateId: string
  region: string
}

export type TencentSmsCredentials = {
  secretId: string
  secretKey: string
}

export class SmsDeliveryError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message)
    this.name = 'SmsDeliveryError'
  }
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

/**
 * TC3-HMAC-SHA256 Authorization header for a JSON POST.
 *
 * Exported for the tests: the signature is the part that silently fails in
 * production (a wrong one returns AuthFailure, not a crash), so it is pinned
 * against a fixed timestamp rather than only exercised through a live call.
 */
export function buildAuthorization(input: {
  secretId: string
  secretKey: string
  payload: string
  timestamp: number
}): string {
  const date = new Date(input.timestamp * 1000).toISOString().slice(0, 10)

  // Canonical request. Tencent requires content-type and host in the signed
  // headers, lowercase and newline-terminated, in this order.
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${ENDPOINT}\n`
  const signedHeaders = 'content-type;host'
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256Hex(input.payload),
  ].join('\n')

  const credentialScope = `${date}/${SERVICE}/tc3_request`
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(input.timestamp),
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n')

  const secretDate = hmac(`TC3${input.secretKey}`, date)
  const secretService = hmac(secretDate, SERVICE)
  const secretSigning = hmac(secretService, 'tc3_request')
  const signature = createHmac('sha256', secretSigning).update(stringToSign, 'utf8').digest('hex')

  return (
    `TC3-HMAC-SHA256 Credential=${input.secretId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`
  )
}

/**
 * Send one verification code.
 *
 * Throws `SmsDeliveryError` on refusal so the caller can decide what the user
 * sees; the code itself is never logged here — that is the whole point of having
 * a real provider.
 */
export async function sendTencentSms(input: {
  phone: string
  code: string
  settings: TencentSmsSettings
  credentials: TencentSmsCredentials
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  now?: number
}): Promise<void> {
  const timestamp = Math.floor((input.now ?? Date.now()) / 1000)
  const payload = JSON.stringify({
    // Tencent wants E.164; the stored identity is the bare 11 digits.
    PhoneNumberSet: [`+86${input.phone}`],
    SmsSdkAppId: input.settings.sdkAppId,
    SignName: input.settings.signName,
    TemplateId: input.settings.templateId,
    TemplateParamSet: [input.code],
  })

  const doFetch = input.fetchImpl ?? fetch
  const res = await doFetch(`https://${ENDPOINT}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Host: ENDPOINT,
      'X-TC-Action': ACTION,
      'X-TC-Version': VERSION,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Region': input.settings.region,
      Authorization: buildAuthorization({
        secretId: input.credentials.secretId,
        secretKey: input.credentials.secretKey,
        payload,
        timestamp,
      }),
    },
    body: payload,
  })

  if (!res.ok) {
    throw new SmsDeliveryError(`SMS provider returned HTTP ${res.status}`)
  }

  const body = (await res.json()) as {
    Response?: {
      Error?: { Code?: string; Message?: string }
      SendStatusSet?: Array<{ Code?: string; Message?: string }>
    }
  }

  // Tencent answers 200 for API-level failures too, so the body decides.
  const apiError = body?.Response?.Error
  if (apiError) {
    throw new SmsDeliveryError(apiError.Message || 'SMS send failed', apiError.Code)
  }
  const status = body?.Response?.SendStatusSet?.[0]
  if (status && status.Code !== 'Ok') {
    throw new SmsDeliveryError(status.Message || 'SMS send rejected', status.Code)
  }
}
