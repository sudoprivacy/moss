import { createHash } from 'node:crypto'
import type { ParkStore } from './store.js'
import { redactInquiry } from './rules.js'

export const QUESTION_GROUP_VERSION = 'park-question-text-v2'

export interface VerifiedQuestionRule {
  id: string
  question: string
  matches: (text: string) => boolean
  excludes: (text: string) => boolean
  verifiedSampleIds: readonly string[]
}

// Exact variants were verified through completed public consultations. Restrict
// the match to these texts so qualifications, quantities and compound questions
// remain separate; broader phrasing requires additional sample verification.
const VERIFIED_RULES: readonly VerifiedQuestionRule[] = [{
  id: 'enterprise-entry-requirements',
  question: '企业入驻需要什么条件？',
  matches: text => ['企业入驻需要什么条件', '企业入驻需要满足哪些条件'].includes(text),
  excludes: () => false,
  verifiedSampleIds: ['0e57733e-5c92-400e-8645-fbf70e6a502c', 'abea695a-7ade-44ff-a118-022e89ef5b05'],
}]

export function normalizeQuestion(text: string): string {
  return text.replace(/[\uFF01-\uFF5E]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim().replace(/[?？!！。．.]+$/u, '').trim()
}

export function groupQuestion(text: string, rules: readonly VerifiedQuestionRule[] = VERIFIED_RULES) {
  const normalized = normalizeQuestion(text)
  const candidates = rules.filter(rule => rule.verifiedSampleIds.length > 0 && rule.matches(normalized) && !rule.excludes(normalized))
  const rule = candidates.length === 1 ? candidates[0] : undefined
  return { key: rule ? `rule:${rule.id}` : `text:${createHash('sha256').update(normalized).digest('hex')}`,
    question: rule?.question ?? text.trim(), version: QUESTION_GROUP_VERSION }
}

export function questionForLeadership(text: string, config: { extra_terms?: string[]; summary_max_length?: number }) {
  const redacted = redactInquiry(text, config)
    .replace(/[\p{Script=Han}A-Za-z0-9（）()·&\-]{2,80}(?:有限责任公司|股份有限公司|有限公司|公司|研究院|事务所|合作社)/gu, '[企业名称]')
    .replace(/(?:我叫|姓名[：:]|联系人[：:]|负责人[：:])\s*[\p{Script=Han}]{2,4}/gu, '[姓名]')
    .replace(/[\p{Script=Han}]{1,3}(?:先生|女士|经理|总裁)/gu, '[称呼]')
  // Unresolved identity cues and truncated questions must not be published as safe text.
  const isDisplayable = Boolean(normalizeQuestion(redacted)) && redacted.length < (Number(config.summary_max_length) || 4000)
    && !/(?:名叫|名字是|本人是|我是|联系人|负责人|法定代表人|公司名称|企业名称)/u.test(redacted.replace(/\[[^\]]*\]/g, ''))
  return { text: redacted, isDisplayable }
}

export async function saveQuestionGroup(store: ParkStore, inquiryId: string, orgId: string, text: string) {
  const config = await store.config(orgId)
  const safe = questionForLeadership(text, JSON.parse(config?.redaction_config ?? '{}'))
  const group = groupQuestion(safe.text)
  await store.db.run(`INSERT INTO park_question_groups (inquiry_id, org_id, group_key, display_question, rule_version, is_displayable)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (inquiry_id) DO UPDATE SET group_key = excluded.group_key,
    display_question = excluded.display_question, rule_version = excluded.rule_version, is_displayable = excluded.is_displayable`,
  [inquiryId, orgId, group.key, group.question, group.version, safe.isDisplayable ? 1 : 0])
}

export async function prepareQuestionGroups(store: ParkStore, orgId?: string) {
  while (true) {
    const rows = await store.db.all(`SELECT i.id, i.org_id, i.redacted_question FROM park_inquiries i
      LEFT JOIN park_question_groups g ON g.inquiry_id = i.id WHERE i.completion_status = 'completed'
      AND (g.inquiry_id IS NULL OR g.rule_version <> ?)${orgId ? ' AND i.org_id = ?' : ''} ORDER BY i.id LIMIT 200`,
    orgId ? [QUESTION_GROUP_VERSION, orgId] : [QUESTION_GROUP_VERSION])
    if (!rows.length) break
    for (const row of rows) await saveQuestionGroup(store, String(row.id), String(row.org_id), String(row.redacted_question))
  }
}

export async function popularQuestions(store: ParkStore, orgId: string, from: number, to: number, limit = 10, groupKeys?: readonly string[]) {
  const rows = await store.db.all<{ group_key: string; question: string; count: number }>(`SELECT g.group_key, MIN(g.display_question) AS question, COUNT(*) AS count
    FROM park_inquiries i JOIN park_question_groups g ON g.inquiry_id = i.id AND g.org_id = i.org_id
    WHERE i.org_id = ? AND i.completion_status = 'completed' AND i.created_at >= ? AND i.created_at < ?
    AND g.is_displayable = 1 AND g.rule_version = ?
    ${groupKeys ? `AND g.group_key IN (${groupKeys.map(() => '?').join(',') || 'NULL'})` : ''}
    GROUP BY g.group_key ORDER BY count DESC, g.group_key LIMIT ?`,
  [orgId, from, to, QUESTION_GROUP_VERSION, ...(groupKeys ?? []), limit])
  const totals = await store.db.get<{ total: number; available: number }>(`SELECT COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN g.is_displayable = 1 AND g.rule_version = ? THEN 1 ELSE 0 END), 0) AS available
    FROM park_inquiries i LEFT JOIN park_question_groups g ON g.inquiry_id = i.id AND g.org_id = i.org_id
    WHERE i.org_id = ? AND i.completion_status = 'completed' AND i.created_at >= ? AND i.created_at < ?`,
  [QUESTION_GROUP_VERSION, orgId, from, to])
  return { rows: rows.map(({ question, count }) => ({ question, count })), groupKeys: rows.map(row => row.group_key),
    samples: { total: Number(totals?.total ?? 0), available: Number(totals?.available ?? 0) } }
}
