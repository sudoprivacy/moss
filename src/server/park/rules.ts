export interface LeadSignal {
  category: string
  intent: string
  industry: string | null
  scale: string | null
  urgency: string | null
  concerns: string[]
  score: number
  scoreExplanation: string
  suggestedAction: string
}

const TOPICS: ReadonlyArray<{ name: string; pattern: RegExp; score: number }> = [
  { name: '入驻条件', pattern: /入驻|落地|申请条件|准入/, score: 20 },
  { name: '场地空间', pattern: /场地|租金|厂房|办公空间|面积/, score: 20 },
  { name: '算力支持', pattern: /算力|GPU|模型资源/, score: 18 },
  { name: '产业扶持', pattern: /补贴|扶持|政策优惠|资助/, score: 15 },
  { name: '入驻周期', pattern: /多久|周期|什么时候|时间表/, score: 10 },
]

export const DEFAULT_REDACTION_SUMMARY_LENGTH = 4000

/** Remove direct identifiers before inquiry text enters the operational store. */
export function redactInquiry(text: string, config?: { extra_terms?: string[]; summary_max_length?: number }): string {
  let redacted = text
    .replace(/\b1[3-9]\d{9}\b/g, '[手机号]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱]')
    .replace(/\b\d{17}[\dXx]\b/g, '[证件号]')
    .replace(/\b\d{16,19}\b/g, '[账号]')
  for (const term of config?.extra_terms ?? []) {
    if (typeof term === 'string' && term.length >= 2 && term.length <= 100) redacted = redacted.replaceAll(term, '[敏感词]')
  }
  const limit = Math.min(4000, Math.max(100, Number(config?.summary_max_length) || DEFAULT_REDACTION_SUMMARY_LENGTH))
  return redacted.slice(0, limit)
}

/** Deterministic rules provide a safe baseline; a model may only add suggestions. */
export function extractLeadSignal(question: string, previousTopics: readonly string[] = []): LeadSignal {
  const concerns = TOPICS.filter(topic => topic.pattern.test(question)).map(topic => topic.name)
  const scoreParts: string[] = []
  let score = 0
  for (const topic of TOPICS) {
    if (concerns.includes(topic.name)) {
      score += topic.score
      scoreParts.push(`${topic.name} +${topic.score}`)
    }
  }
  const repeatedTopics = previousTopics.filter(topic => concerns.includes(topic)).length
  if (repeatedTopics > 0) {
    score += 10
    scoreParts.push('连续关注相关主题 +10')
  }
  const scale = /\b\d{2,5}\s*(人|平方米|平米|亩|台|卡)\b/.exec(question)?.[0] ?? null
  if (scale) { score += 15; scoreParts.push('明确规模 +15') }
  const urgency = /(下个月|本月|本季度|下季度|半年内|\d{1,2}\s*个月内|明年上半年)/.exec(question)?.[0] ?? null
  if (urgency) { score += 15; scoreParts.push('明确时间 +15') }
  const industry = /(人工智能|智能制造|生物医药|集成电路|新能源|机器人)/.exec(question)?.[0] ?? null
  const boundedScore = Math.min(100, score)
  return {
    category: concerns[0] ?? '其他咨询',
    intent: boundedScore >= 40 ? '入驻意向' : '一般咨询',
    industry, scale, urgency, concerns,
    score: boundedScore,
    scoreExplanation: scoreParts.length ? scoreParts.join('；') : '未命中高意向规则',
    suggestedAction: boundedScore >= 40 ? '人工观察并按需联系' : '继续观察',
  }
}

export interface PublicPolicy {
  title: string
  version: string
  section: string
  content: string
  status: string
  effectiveFrom: number
  effectiveUntil: number | null
}

export function isPolicyPublic(policy: PublicPolicy, now = Date.now()): boolean {
  return policy.status === 'published'
    && policy.effectiveFrom <= now
    && (policy.effectiveUntil === null || policy.effectiveUntil >= now)
}
