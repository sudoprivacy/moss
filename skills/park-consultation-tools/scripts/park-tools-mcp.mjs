#!/usr/bin/env node
/**
 * Park consultation MCP server (stdio). Exposes the park agent tools as
 * structured MCP tools so the model calls them natively instead of running
 * shell commands. Auth mirrors park-tools.mjs: SESSION_TOKEN + MOSS_SERVER_URL.
 */
const BASE = (process.env.MOSS_SERVER_URL || 'http://127.0.0.1:3000').replace(/\/$/, '')
const TOKEN = process.env.SESSION_TOKEN

if (!TOKEN) {
  process.stderr.write('park-tools-mcp: SESSION_TOKEN is not set\n')
  process.exit(1)
}

const TOOLS = [
  {
    name: 'policy_search',
    description: '检索园区公开政策原文。回答政策问题前必须调用。matches 的 line 是完整条款，包含金额、资格、期限及限制，回答时应据此说明具体标准并引用 file/line_no。按原文保留完整自然月计算、各笔申请期限、资格限制和有效期衔接，不用模糊摘要替代明确标准。空结果只表示本次未检索到依据；工具错误表示查询失败，不能断言没有政策。',
    inputSchema: { type: 'object', properties: { q: { type: 'string', description: '检索关键词，取自用户问题的核心词' } }, required: ['q'] },
  },
  {
    name: 'inquiry_append',
    description: '兼容入口：提交本轮咨询建议。服务端在回答完成后可靠记录问答，不要求调用此工具。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' }, answer: { type: 'string' },
        intent: { type: 'string', enum: ['policy_inquiry', 'settlement_intent', 'rent_consultation', 'subsidy_application', 'service_request', 'other'] },
        industry_tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['question', 'answer', 'intent'],
    },
  },
  {
    name: 'lead_propose',
    description: '兼容入口：线索由服务端在回答完成后异步抽取和生成。此工具不会直接创建线索。',
    inputSchema: {
      type: 'object',
      properties: { intent: { type: 'string' }, industry_tags: { type: 'array', items: { type: 'string' } }, suggested_action: { type: 'string' } },
    },
  },
  {
    name: 'park_profile_read',
    description: '读取园区公开简介。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'service_catalog_read',
    description: '读取园区服务清单。',
    inputSchema: { type: 'object', properties: {} },
  },
]

const ENDPOINTS = {
  policy_search: input => ({ method: 'GET', path: `/api/v1/agent/park/policies/search?q=${encodeURIComponent(input.q.trim())}` }),
  inquiry_append: input => ({ method: 'POST', path: '/api/v1/agent/park/inquiries', body: { question: input.question, answer: input.answer, intent: input.intent, industry_tags: input.industry_tags ?? [] } }),
  lead_propose: input => ({ method: 'POST', path: '/api/v1/agent/park/leads/propose', body: { intent: input.intent ?? 'other', industry_tags: input.industry_tags ?? [], suggested_action: input.suggested_action ?? '' } }),
  park_profile_read: () => ({ method: 'GET', path: '/api/v1/agent/park/profile' }),
  service_catalog_read: () => ({ method: 'GET', path: '/api/v1/agent/park/service-catalog' }),
}

async function callTool(name, input) {
  const spec = ENDPOINTS[name]
  if (!spec) return { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true }
  if (name === 'policy_search' && (typeof input?.q !== 'string' || !input.q.trim())) {
    return { content: [{ type: 'text', text: 'q must be a non-empty string' }], isError: true }
  }
  const { method, path, body } = spec(typeof input === 'object' && input !== null ? input : {})
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  if (!response.ok) return { content: [{ type: 'text', text: `政策查询失败，不能据此判断没有政策。park API ${response.status}: ${text.slice(0, 400)}` }], isError: true }
  return { content: [{ type: 'text', text }] }
}

function write(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

const buffer = { data: '' }
process.stdin.on('data', chunk => {
  buffer.data += String(chunk)
  let index = buffer.data.indexOf('\n')
  while (index >= 0) {
    const line = buffer.data.slice(0, index).trim()
    buffer.data = buffer.data.slice(index + 1)
    if (line) void handle(line)
    index = buffer.data.indexOf('\n')
  }
})

async function handle(line) {
  let request
  try { request = JSON.parse(line) } catch { return }
  const { id, method, params } = request
  try {
    if (method === 'initialize') {
      write({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'park-consultation-tools', version: '1.0.0' } } })
    } else if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      // no response for notifications
    } else if (method === 'tools/list') {
      write({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    } else if (method === 'tools/call') {
      const result = await callTool(params?.name, params?.arguments ?? {})
      write({ jsonrpc: '2.0', id, result })
    } else if (method === 'ping') {
      write({ jsonrpc: '2.0', id, result: {} })
    } else if (id !== undefined) {
      write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
    }
  } catch (error) {
    if (id !== undefined) write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `工具调用失败，请稍后再试；不能据此判断没有政策。${String(error)}` }], isError: true } })
  }
}
