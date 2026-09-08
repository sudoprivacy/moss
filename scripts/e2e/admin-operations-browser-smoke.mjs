#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const baseUrl = process.env.ADMIN_E2E_BASE_URL || 'http://127.0.0.1:4173'
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
if (!fs.existsSync(chrome)) throw new Error('Google Chrome is required')

function assert(value, message) { if (!value) throw new Error(message) }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
async function waitFor(fn, label, timeout = 20_000) { const end = Date.now() + timeout; while (Date.now() < end) { try { const value = await fn(); if (value) return value } catch {} await sleep(100) } throw new Error(`timeout: ${label}`) }

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.listeners = new Map() }
  async connect() { this.ws = new WebSocket(this.url); await new Promise((resolve, reject) => { this.ws.addEventListener('open', resolve, { once: true }); this.ws.addEventListener('error', reject, { once: true }) }); this.ws.addEventListener('message', event => { const message = JSON.parse(String(event.data)); if (message.id) { const pending = this.pending.get(message.id); if (!pending) return; this.pending.delete(message.id); message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result || {}) } else for (const listener of this.listeners.get(message.method) || []) listener(message.params || {}) }) }
  on(method, fn) { this.listeners.set(method, [...(this.listeners.get(method) || []), fn]) }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  close() { this.ws?.close() }
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-admin-operations-'))
const log = fs.openSync(path.join(profile, 'chrome.log'), 'w')
const processChrome = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', log, log] })
let cdp
const errors = []

const user = { id: 'root', orgId: 'org-a', email: null, name: 'root', displayName: '管理员', departmentId: null, role: 'super_admin', status: 'active', localAuth: true, tokenLimit: null, createdAt: 1, passwordUpdatedAt: null, lastLoginAt: null, extUserId: null }
const org = { id: 'org-a', name: '企业 A', extOrgId: null, createdAt: 1, legacyId: 7, code: 'ENT-A' }
const fixtures = {
  '/api/v1/auth/me': { user, organization: org, scopes: ['*'], role: 'super_admin', key_id: 'password-login', isSuperAdmin: true },
  '/api/v1/users': { users: [{ ...user, legacyId: 17, balanceUnits: 1200 }, { ...user, id: 'pending', name: 'pending', displayName: '待审批用户', role: 'user', status: 'pending', legacyId: 18, balanceUnits: 0 }] },
  '/api/v1/departments': { departments: [] }, '/api/v1/api-keys': { api_keys: [] }, '/api/v1/roles': { roles: [] },
  '/api/v1/organizations': { organizations: [{ ...org, userCount: 2, departmentCount: 0 }] },
  '/api/v1/admin/stats': { success: true, data: { enterprises: 1, users: 2, pending: 1, points: { total: 1200 } } },
  '/api/v1/admin/recharge/stats': { success: true, data: { today: { amount_usd: 10, orders: 1 }, total: { amount_usd: 100, pending_count: 1 } } },
  '/api/v1/admin/recharge/orders': { success: true, data: { list: [{ id: 1, order_no: 'ORDER-1', user_nickname: '用户 A', amount_usd: 10, amount_cny: 73, points: 10000, payment_method: 'ALIPAY', status: 2, status_text: '支付成功', created_at: '2026-09-08 10:00:00' }], total: 1, page: 1, pageSize: 20 } },
  '/api/v1/admin/recharge-records': { success: true, data: { list: [{ id: 1, type: 'ADMIN', user_nickname: '用户 A', points: 1000, quota: 500000, admin_nickname: '管理员', source_text: '后台手工充值', reason: '补偿', created_at: '2026-09-08' }], total: 1, page: 1, pageSize: 20 } },
  '/api/v1/admin/credit-applications': { success: true, data: { list: [{ id: 1, application_no: 'APP-1', user_nickname: '用户 A', requested_points: 100, status: 'PENDING', reason: '申请', created_at: '2026-09-08' }], total: 1, page: 1, pageSize: 20 } },
  '/api/v1/admin/system-config': { success: true, data: { login_method: 1, third_party_auth: { enabled: 0, providers: [] }, log_report: { enabled: 0, key: '', key_set: false }, version_update: { enabled: 0 }, product_improvement: { enabled: 0 }, scode_auto_model: '', recharge_mode: 'approve', credit_application: { min_points: 1, max_points: 10000, allow_duplicate_pending: false } } },
  '/api/v1/admin/datasets': { success: true, data: { data: [{ id: 'ds-1', name: '企业知识库', description: '产品资料', document_count: 1 }] } },
  '/api/v1/admin/datasets/ds-1/documents': { success: true, data: { data: [{ id: 'doc-1', name: '说明文档', status: 'available', word_count: 120 }] } },
  '/api/v1/qms/dashboard/overview': { success: true, data: { total_conversations: 100, success_rate: 98.5 } },
  '/api/v1/qms/dashboard/conversations/trend': { success: true, data: [{ date: '2026-09-08', total_count: 10, success_count: 9 }] },
  '/api/v1/qms/dashboard/conversations/errors/trend': { success: true, data: [] },
  '/api/v1/qms/dashboard/installs/trend': { success: true, data: [{ date: '2026-09-08', total_count: 3, success_count: 3 }] },
  '/api/v1/qms/dashboard/perf/trend': { success: true, data: [{ date: '2026-09-08', metric: 'latency', p95: 500 }] },
  '/api/v1/qms/user-stats/conversations': { success: true, data: [{ user_id: 'user-a', conversations: 10 }] },
  '/api/v1/qms/user-stats/turns': { success: true, data: [] }, '/api/v1/qms/user-stats/steps': { success: true, data: [] }, '/api/v1/qms/user-stats/realtime': { success: true, data: {} },
  '/api/v1/qms/crash/issues': { success: true, data: [{ id: 1, title: 'Renderer crash', status: 'unresolved', count: 2 }] }, '/api/v1/qms/crash/stats/summary': { success: true, data: { total_events: 2, unresolved_issues: 1 } }, '/api/v1/qms/crash/stats/trend': { success: true, data: [] },
  '/api/v1/qms/alerts/configs': { success: true, data: [{ id: 'alert-1', name: '错误率', enabled: true }] }, '/api/v1/qms/alerts/history': { success: true, data: [] },
  '/api/v1/qms/system/health': { success: true, status: 'healthy' }, '/api/v1/qms/system/stats': { success: true, data: {} }, '/api/v1/qms/system/config': { success: true, data: {} }, '/api/v1/qms/system/notifications': { success: true, data: {} }, '/api/v1/qms/system/tasks': { success: true, data: [] }, '/api/v1/qms/system/raw-stats': { success: true, data: [] }, '/api/v1/qms/system/aggregation-info': { success: true, data: {} },
}

function fixtureFor(url, method) {
  const parsed = new URL(url); const pathName = parsed.pathname
  if (method !== 'GET') return { success: true, data: {} }
  if (fixtures[pathName]) return fixtures[pathName]
  if (pathName.startsWith('/api/v1/config-items')) return pathName.endsWith('/availability') ? { success: true, data: { availability: 'organization', ownerOrgId: 'org-a', organizationIds: [], organizations: [org] } } : { success: true, data: [], total: 0, page: 1, page_size: 20 }
  if (pathName.startsWith('/api/')) return { success: true, data: [] }
  return null
}

async function evalJs(expression) { const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result?.value }
async function navigate(route, title) { await cdp.send('Page.navigate', { url: `${baseUrl}/admin${route}` }); try { await waitFor(() => evalJs(`document.readyState === 'complete' && document.body.innerText.includes(${JSON.stringify(title)})`), title) } catch (error) { const diagnostic = await evalJs(`({ url: location.href, text: document.body.innerText.slice(0, 1200) })`); throw new Error(`${error.message}; url=${diagnostic.url}; text=${diagnostic.text}; errors=${errors.join(',')}`) } await sleep(200); const state = await evalJs(`({ width: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth, text: document.body.innerText.slice(0, 5000) })`); assert(state.width <= state.viewport + 1, `${route} horizontal overflow ${state.width}/${state.viewport}`); assert(state.text.includes(title), `${route} missing ${title}`) }

try {
  const portFile = path.join(profile, 'DevToolsActivePort'); await waitFor(() => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').trim(), 'DevTools')
  const [port] = fs.readFileSync(portFile, 'utf8').trim().split('\n'); const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); cdp = new Cdp(targets.find(item => item.type === 'page').webSocketDebuggerUrl); await cdp.connect()
  cdp.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'exception'))
  cdp.on('Runtime.consoleAPICalled', event => { if (event.type === 'error') errors.push(event.args?.map(arg => arg.value ?? arg.description).join(' ') || 'console error') })
  cdp.on('Fetch.requestPaused', event => { const method = event.request.method; const fixture = fixtureFor(event.request.url, method); if (fixture) void cdp.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(JSON.stringify(fixture)).toString('base64') }); else void cdp.send('Fetch.continueRequest', { requestId: event.requestId }) })
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*://*/api/*' }] }); await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('moss_access_token','fixture-token')` })
  for (const viewport of [{ width: 1440, height: 900, mobile: false }, { width: 390, height: 844, mobile: true }]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1 })
    for (const [route, title] of [['/', '数据看板'], ['/users', '用户与组织管理'], ['/operations/billing', '账务运营'], ['/operations/sudowork-settings', 'Sudowork 客户端策略'], ['/document-center/dify-datasets', 'Dify 数据集'], ['/operations/quality', '质量管理'], ['/secrets/config-items', '配置项列表']]) await navigate(route, title)
  }
  assert(errors.length === 0, `browser errors: ${errors.join(', ')}`)
  process.stdout.write('Admin operations browser smoke passed: 7 pages x 2 viewports\n')
} finally {
  cdp?.close(); if (processChrome.exitCode === null) processChrome.kill('SIGTERM'); await sleep(300); if (processChrome.exitCode === null) processChrome.kill('SIGKILL'); fs.closeSync(log); fs.rmSync(profile, { recursive: true, force: true })
}
