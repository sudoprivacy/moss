/**
 * Rule-based redaction for park inquiry content (园区咨询脱敏). Deterministic,
 * model-free: masks phones/emails/ID-card numbers and truncates length. The
 * redacted_* columns are the only inquiry content ever exposed to park roles;
 * the raw question/answer stay behind refs into the session transcript.
 */
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const ID_CARD_RE = /(?<!\d)\d{17}[\dXx](?![a-zA-Z\d])/g

export const REDACTED_MAX_LENGTH = 200

export function redactText(input: string | null | undefined, maxLength = REDACTED_MAX_LENGTH): string {
  if (!input) return ''
  let out = input
    .replace(ID_CARD_RE, '***')
    .replace(PHONE_RE, '***')
    .replace(EMAIL_RE, '***')
  if (out.length > maxLength) {
    out = `${out.slice(0, maxLength)}…`
  }
  return out
}
