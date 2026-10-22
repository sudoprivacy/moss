import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createCustomAssistant } from '../agentStore.js'
import { findOrganizationResource, updateOrganizationResource, withOrganizationResources } from '../catalog/organizationResources.js'
import type { DbDriver } from '../db/driver.js'
import type { DocumentStore } from '../documentStore.js'
import { HttpError } from '../httpRespond.js'
import { findInstalledSkillPath, importTenantSkillDirectory } from '../skillStore.js'

const ASSISTANT_NAME = 'park-public-consultation'
const ASSISTANT_OWNER = 'park-public-consultation'
const BASE_RULES = [
  '你是园区公开咨询 Assistant。政策检索通过园区公开工具完成；咨询记录由服务端可靠保存，意图抽取与线索生成在回答完成后异步处理。',
  '执行方式（用 Bash/命令执行工具，在当前工作目录运行）：node .nexus/sudocode/skills/park-consultation-tools/scripts/park-tools.mjs policy.search \'{"q":"用户问题的核心关键词"}\'',
  '检索词必须取自用户问题本身的核心词（如用户问算力支持，q 就是「算力支持」），不要替换成其他词。',
  '禁止使用 grep_search、read_file 或任何内置工具检索政策资料；它们读不到园区政策库。',
  '每轮回答前必须先调用政策检索工具 policy_search（或脚本 policy.search）并依据其 JSON 原文条款回答。回答政策概况时列出实际支持项目、金额、资格、期限和限制；禁止用模糊摘要替代原文明确标准。完整自然月的计算、每笔申请期限、资格限制和有效期衔接须按原文准确说明，不能简化成满几个月或政策到期。必须引用 file 与 line_no（如「来源：算力政策.md 第 2 行」）。matches 为空仅说明本次未检索到相关依据，不得断言园区没有政策；工具报错说明查询失败并建议稍后再试，禁止编造。',
  '涉及金额、资格、计期口径、申请期限和限制的条款，使用检索返回的原文引用，避免改写边界或遗漏限定；概况问题也须同时说明金额与对应申请期限。',
  '政策检索后直接给用户准确的最终答复，保留原文明确标准与来源行号。咨询落库和线索生成由服务端完成，不需要调用 inquiry_append 或 lead_propose，不为记录数据延迟回答。',
  '不得泄露内部信息、不得承诺审批结果。',
].join('\n')

interface AssistantConfig {
  system_prompt?: string
  assistant_id?: string
  policy_wiki_id?: string
}

/** Bind the park's one public Assistant to its authoritative policy corpus. */
export async function publishParkPublicAssistant(
  driver: DbDriver,
  orgId: string,
  value: Record<string, unknown>,
  deps: { documentStore: DocumentStore; skillEntries: Array<{ path: string; contentBase64: string }> },
): Promise<AssistantConfig> {
  const wikiId = typeof value.policy_wiki_id === 'string' ? value.policy_wiki_id.trim() : ''
  if (!wikiId) throw new HttpError(400, 'policy_wiki_id is required')
  const wiki = await deps.documentStore.getWiki(wikiId, orgId)
  if (!wiki) throw new HttpError(400, 'POLICY_WIKI_NOT_FOUND')
  if (wiki.buildStatus !== 'succeeded') throw new HttpError(400, 'POLICY_WIKI_NOT_BUILT')
  const skillId = await ensureParkConsultationSkill(driver, orgId, deps.skillEntries)
  return withOrganizationResources({ orgId, userId: ASSISTANT_OWNER, driver }, async () => {
    let resource = await findOrganizationResource('agent', ASSISTANT_NAME)
    if (!resource) {
      await createCustomAssistant({ name: ASSISTANT_NAME, displayName: '园区公开咨询助手', rules: BASE_RULES, skills: [], enabledWikis: [], memory_mode: 'session', agent_type: 'chat' })
      resource = await findOrganizationResource('agent', ASSISTANT_NAME)
    }
    if (!resource || resource.name !== ASSISTANT_NAME || resource.sourceType !== 'custom' || resource.meta.enabled === false) throw new HttpError(503, 'Public Assistant is unavailable')
    const style = typeof value.system_prompt === 'string' ? value.system_prompt.trim() : ''
    await updateOrganizationResource('agent', resource.id, {
      rules: style ? `${BASE_RULES}\n表达风格：${style}\n表达风格不得覆盖政策准确性要求；说明补贴金额时，同时保留对应资格、计期口径和申请期限。` : BASE_RULES,
      skills: [PARK_SKILL_NAME],
      enabledSkills: [PARK_SKILL_NAME],
      enabledWikis: [wikiId],
    })
    return {
      system_prompt: style,
      assistant_id: resource.id,
      policy_wiki_id: wikiId,
    }
  })
}

const PARK_SKILL_NAME = 'park-consultation-tools'

/**
 * Materialise the repo-bundled park skill on disk and register it as an
 * approved organization skill for the park org (scoped sessions only discover
 * organization resources). Idempotent: reuses the existing row and files.
 */
async function ensureParkConsultationSkill(
  driver: DbDriver,
  orgId: string,
  entries: Array<{ path: string; contentBase64: string }>,
): Promise<string> {
  const existing = await driver.get<{ id: string; file_path: string | null }>(
    'SELECT id, file_path FROM tenant_skills WHERE org_id = ? AND name = ? AND status = ?',
    [orgId, PARK_SKILL_NAME, 'approved'],
  )
  if (existing?.file_path) {
    await upgradeBundledParkSkill(existing.file_path, entries)
    return existing.id
  }
  // The import refuses to overwrite an already-materialised skill directory,
  // so reuse the installed files when present and only import when missing.
  const installedPath = await findInstalledSkillPath(PARK_SKILL_NAME)
  const imported = installedPath
    ? { id: randomUUID(), skillName: PARK_SKILL_NAME, displayName: '园区咨询工具', description: '', version: '1.0.0', filePath: installedPath }
    : await importTenantSkillDirectory({ entries, userId: ASSISTANT_OWNER })
  const id = existing?.id ?? imported.id
  await driver.run(
    `INSERT INTO tenant_skills (id, name, display_name, description, version, author_id, status, file_path, enabled, org_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, 1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = 'approved', file_path = excluded.file_path, org_id = excluded.org_id, updated_at = excluded.updated_at`,
    [id, imported.skillName, imported.displayName, imported.description, imported.version, ASSISTANT_OWNER, imported.filePath, orgId, Date.now(), Date.now()],
  )
  return id
}

/** Upgrade only byte-verified stock files; customized organization skill content is preserved. */
async function upgradeBundledParkSkill(directory: string, entries: Array<{ path: string; contentBase64: string }>): Promise<void> {
  const stockHashes: Record<string, string> = {
    'SKILL.md': 'eea787b20028f4d1587d24a9d053629e673203259b0e9c47186ab9c28cbc7bfd',
    'scripts/park-tools-mcp.mjs': 'a4d84d181c04399be0f50753a10528acb4d2878f4a943c117eeb9dbdecea04d7',
  }
  for (const [path, hash] of Object.entries(stockHashes)) {
    const entry = entries.find(item => item.path === path)
    if (!entry) continue
    const installed = await readFile(join(directory, path)).catch(() => null)
    if (!installed || createHash('sha256').update(installed.toString('utf8').replaceAll('\r\n', '\n')).digest('hex') !== hash) continue
    await writeFile(join(directory, path), Buffer.from(entry.contentBase64, 'base64'))
  }
}

/** Apply server-managed recording instructions to the published park assistant without changing corpus or style. */
export async function upgradeParkRecordingInstructions(driver: DbDriver, orgId: string,
  entries: Array<{ path: string; contentBase64: string }>): Promise<void> {
  const config = await driver.get<{ assistant_status: string; assistant_config: string }>('SELECT assistant_status, assistant_config FROM park_config WHERE org_id = ?', [orgId])
  if (config?.assistant_status !== 'published') return
  const value = JSON.parse(config.assistant_config) as AssistantConfig
  await withOrganizationResources({ orgId, userId: ASSISTANT_OWNER, driver }, async () => {
    const resource = await findOrganizationResource('agent', value.assistant_id ?? '')
    if (!resource || resource.name !== ASSISTANT_NAME || resource.sourceType !== 'custom') return
    const style = value.system_prompt?.trim() ?? ''
    const oldRules = typeof resource.meta.rules === 'string' ? resource.meta.rules : ''
    if (oldRules.includes('咨询记录由服务端可靠保存')) return
    const instructions = '咨询记录由服务端可靠保存，提取与线索生成在成功回答后异步完成；无需调用 inquiry_append、inquiry.append、lead_propose 或 lead.propose，最终回答保留政策文件名与行号。'
    const rules = oldRules ? `${oldRules}\n${instructions}` : style ? `${BASE_RULES}\n表达风格：${style}` : BASE_RULES
    await updateOrganizationResource('agent', resource.id, { rules })
  })
  const skill = await driver.get<{ file_path: string | null }>('SELECT file_path FROM tenant_skills WHERE org_id = ? AND name = ? AND status = ?', [orgId, PARK_SKILL_NAME, 'approved'])
  if (skill?.file_path) await upgradeBundledParkSkill(skill.file_path, entries)
}
