import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ExternalAgentUsageDetails } from '../components/external-agent-usage-details'
import type { ExternalAgent } from '../../contracts/external-provider/v1/contract'

const agent: ExternalAgent = {
  id: 'a', name: 'Test', provider: 'dify', execution_mode: 'external_hosted', profile: 'synthetic_pilot',
  source_identity_evidence: 'unverified', source_digest: 'sha256:test', decoder: 'text', approved: true, review_expires_at: 100,
  capabilities: { streaming: 'supported', cancel: 'unsupported', resume: 'unknown', version_pin: 'unsupported' },
}

test('old servers do not imply confirmed usage; current data distinguishes review, declarations and run evidence', () => {
  assert.match(renderToStaticMarkup(<ExternalAgentUsageDetails agent={agent} />), /服务未提供使用范围信息/)
  const html = renderToStaticMarkup(<ExternalAgentUsageDetails agent={{ ...agent, usage: {
    data_scope: 'synthetic_only', input: 'text_query_only', attachments: 'unsupported', resource_refs: 'unsupported', tools: 'unsupported',
    content_classification: 'caller_declared_only', capability_basis: 'adapter_contract', reviewed_at: null, evaluated_at: 100, review_state: 'expired',
  } }} />)
  for (const message of ['仅允许合成测试文本', '尚未进行内容识别', '不支持', '未确认', '审核已到期', '未记录', '不代表实时连接状态', '来源身份尚未验证']) assert.ok(html.includes(message), message)
})
