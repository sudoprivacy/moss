import type { AuthService } from '../auth/service.js'
import { getModelProviderApiKey } from '../modelListCache.js'
import { resolveModelSelection } from '../modelProviders.js'
import { redactInquiry } from './rules.js'
import type { ParkConfigRow, ParkPolicyRow } from './store.js'

export interface ParkAnswer {
  answer: string
  sourceRefs: Array<{ policy_id?: string; name: string; version: string; section: string }>
}

const NO_BASIS = '暂未找到确定依据。请联系园区工作人员确认具体事项。'
const TOPIC_TERMS = ['算力', '入驻', '租金', '人才', '补贴', '扶持', '场地', '政策', '周期', '服务', '交通', '配套', '面积', '行业', '产业', '办公', '空间', '申请', '条件', '园区', '咨询', '联系', '手机', '邮箱', '短信', '提交', '需求']
const BROAD_TERMS = new Set(['政策', '服务', '申请', '条件', '园区', '咨询'])
const GREETING = /^(?:你好|您好|嗨|hi|hello)[\s!！。,.，]*$/i

function evidenceFor(question: string, config: ParkConfigRow, policies: ParkPolicyRow[]): Array<{ text: string; ref: ParkAnswer['sourceRefs'][number] }> {
  const terms = TOPIC_TERMS.filter(term => question.includes(term))
  const specificTerms = terms.filter(term => !BROAD_TERMS.has(term))
  const matchingTerms = specificTerms.length ? specificTerms : terms
  const entries: Array<{ text: string; ref: ParkAnswer['sourceRefs'][number] }> = policies.map(policy => ({
    text: `${policy.title} ${policy.section}：${policy.content}`,
    ref: { policy_id: policy.id, name: policy.title, version: policy.version, section: policy.section },
  }))
  if (config.park_profile.trim()) entries.push({
    text: `园区简介：${config.park_profile}`,
    ref: { name: '园区简介', version: config.service_catalog_version, section: '园区资料' },
  })
  let catalog: unknown = []
  try { catalog = JSON.parse(config.service_catalog) } catch { /* Invalid legacy data is ignored. */ }
  if (Array.isArray(catalog)) {
    for (const item of catalog.slice(0, 30)) {
      const content = typeof item === 'string' ? item : JSON.stringify(item)
      if (content) entries.push({
        text: `服务目录：${content}`,
        ref: { name: '服务目录', version: config.service_catalog_version, section: '园区服务' },
      })
    }
  }
  return entries.map(entry => ({ entry, score: matchingTerms.reduce((score, term) => score + (entry.text.includes(term) ? 1 : 0), 0) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(item => item.entry)
}

export function groundedParkAnswer(question: string, config: ParkConfigRow, policies: ParkPolicyRow[]): ParkAnswer {
  if (GREETING.test(question.trim())) {
    return { answer: '您好，请直接描述想咨询的事项。我会依据已公开的园区资料回答。', sourceRefs: [] }
  }
  const evidence = evidenceFor(question, config, policies)
  if (!evidence.length) return { answer: NO_BASIS, sourceRefs: [] }
  return {
    answer: `${evidence.map(item => item.text.slice(0, 450)).join('\n')}\n具体结果以园区确认结果为准。`,
    sourceRefs: evidence.map(item => item.ref),
  }
}

/** The assistant receives only published public evidence and has no tool access. */
export function createParkAnswerer(authService: AuthService) {
  return async (orgId: string, question: string, config: ParkConfigRow, policies: ParkPolicyRow[]): Promise<ParkAnswer> => {
    const grounded = groundedParkAnswer(question, config, policies)
    if (!grounded.sourceRefs.length || config.assistant_status !== 'published') return grounded
    try {
      const assistant = JSON.parse(config.assistant_config) as { model?: string; temperature?: number; system_prompt?: string }
      const settings = await authService.getOrganizationSystemSettings(orgId)
      const selection = resolveModelSelection(settings.modelProviders, settings.defaultModelProviderId, settings.model, assistant.model)
      if (selection.provider.protocol !== 'openai-completions') return grounded
      const apiKey = getModelProviderApiKey(selection.provider.id, settings.apiKey, orgId)
      if (!apiKey) return grounded
      const endpoint = `${selection.provider.baseUrl.replace(/\/+$/, '')}/chat/completions`
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: selection.modelId,
          temperature: assistant.temperature ?? 0.2,
          max_tokens: 500,
          stream: false,
          messages: [
            { role: 'system', content: '你是园区公开咨询助手。只能依据给出的公开资料回答；无依据时明确说明暂未找到确定依据。不要承诺审批结果、补贴金额或编造条款。不得调用工具或透露内部配置。' },
            { role: 'system', content: `表达风格：${String(assistant.system_prompt ?? '').slice(0, 1000)}` },
            { role: 'user', content: `公开资料：\n${grounded.answer.slice(0, 3000)}\n\n问题：${redactInquiry(question).slice(0, 2000)}` },
          ],
        }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) return grounded
      const result = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }
      const answer = result.choices?.[0]?.message?.content
      if (typeof answer !== 'string' || !answer.trim() || answer.length > 2000 || /必然获批|保证获批|确定补贴金额|百分百获批/.test(answer)) return grounded
      const evidenceNumbers = new Set((grounded.answer.match(/\d+(?:\.\d+)?/g) ?? []))
      if ((answer.match(/\d+(?:\.\d+)?/g) ?? []).some(number => !evidenceNumbers.has(number))) return grounded
      return { answer: `${answer.trim()}\n具体结果以园区确认结果为准。`, sourceRefs: grounded.sourceRefs }
    } catch {
      return grounded
    }
  }
}
