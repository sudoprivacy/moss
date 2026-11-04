/**
 * Browser check of the 协作智能体 admin page against a running test server.
 * Uses the locally installed Chrome (headless) through playwright-core.
 *
 *   PLAYWRIGHT_CORE=<dir with node_modules/playwright-core> \
 *   npx tsx scripts/agentify-ui-check.ts --base http://127.0.0.1:43137 --db <moss.db> --out <screenshot dir>
 */
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'crypto'
import { createRequire } from 'module'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { issueAccessToken } from '../src/server/auth/token.js'

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`)
  const v = i >= 0 ? process.argv[i + 1] : fallback
  if (!v) throw new Error(`--${name} is required`)
  return v
}
const BASE = arg('base', 'http://127.0.0.1:43137')
const OUT = arg('out')
const ORG = arg('org', '609ce2ab-f742-4cfe-aeb8-a09617bffe3a')
mkdirSync(OUT, { recursive: true })

const req = createRequire(join(process.env.PLAYWRIGHT_CORE ?? process.cwd(), 'noop.js'))
const { chromium } = req('playwright-core') as typeof import('playwright-core')

const db = new DatabaseSync(arg('db'), { readOnly: true })
const cfg = (k: string) => (db.prepare('SELECT value FROM server_config WHERE key = ?').get(k) as { value?: string } | undefined)?.value
const admin = db.prepare(`SELECT id FROM users WHERE role = 'super_admin' LIMIT 1`).get() as { id: string }
const token = issueAccessToken({ iss: cfg('issuer') ?? 'moss-server', sub: admin.id, org_id: ORG, role: 'super_admin', scopes: ['*'], key_id: randomUUID() }, cfg('jwt_secret')!, 3600).token
const jwtSecret = cfg('jwt_secret')!
const issuer = cfg('issuer') ?? 'moss-server'
db.close()
// A plain employee (one the end-to-end run created, found through the API) for the confirmations page.
const usersList = (await (await fetch(`${BASE}/api/v1/users`, { headers: { authorization: `Bearer ${token}` } })).json()) as { users?: Array<{ id: string; name: string; role: string; createdAt: number }> }
const employee = (usersList.users ?? []).filter(u => u.role === 'user' && u.name.startsWith('e2e_gendan1_')).sort((a, b) => b.createdAt - a.createdAt)[0]
const employeeToken = employee
  ? issueAccessToken({ iss: issuer, sub: employee.id, org_id: ORG, role: 'user', scopes: [], key_id: randomUUID() }, jwtSecret, 3600).token
  : null

let failures = 0
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`)
  if (!ok) failures += 1
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const consoleErrors: string[] = []
page.on('console', m => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', e => consoleErrors.push(String(e)))

await page.goto(`${BASE}/admin/login`)
await page.evaluate(([t, org]) => {
  localStorage.setItem('moss_access_token', t)
  localStorage.setItem('moss_token_expires_at', String(Date.now() + 3600_000))
  localStorage.setItem('moss_preferred_org_id', org)
}, [token, ORG])
await page.goto(`${BASE}/admin/agentify`)
await page.getByRole('heading', { name: '协作智能体' }).waitFor({ timeout: 30_000 })
check(true, 'page loads behind admin sign-in')
check(await page.getByText('协作智能体').first().isVisible(), 'sidebar / title shows 协作智能体')
const visible = (loc: import('playwright-core').Locator) => loc.waitFor({ timeout: 20_000 }).then(() => true, () => false)
check(await visible(page.getByText(/记忆存储：Nexus VFS/)), 'status shows the agent home on Nexus VFS')
check(await visible(page.getByText(/Nexus 0\.8\.26（已升级/)), 'status shows Nexus 0.8.26 and the verified upgrade')
check(await visible(page.getByText('已开启').first()), 'agentified agents are marked 已开启')
await page.waitForSelector('table tbody tr')
const rows = await page.locator('table tbody tr').count()
check(rows > 0, `agents table lists agents (${rows} rows)`)
const actionsBox = await page.locator('table tbody tr').first().getByRole('button', { name: '历史' }).boundingBox()
check(actionsBox !== null && actionsBox.x + actionsBox.width <= 1440, 'row action buttons are on screen (no horizontal overflow)')
await page.screenshot({ path: join(OUT, '1-agents.png'), fullPage: true })

// Config dialog of the first agentified agent.
const enabledRow = page.locator('table tbody tr', { hasText: '已开启' }).first()
const enabledName = (await enabledRow.locator('td').first().innerText()).split('\n')[0]!.trim()
await enabledRow.getByRole('button', { name: '配置' }).click()
await page.getByText(/协作配置：/).waitFor()
const dialogWidth = (await page.locator('[role=dialog]').boundingBox())?.width ?? 0
check(dialogWidth >= 1000, `the config dialog uses the screen width (${Math.round(dialogWidth)} px)`)
const tabs = ['常规', '对外能力', '共享权限', 'JSON']
check((await Promise.all(tabs.map(t => page.getByRole('tab', { name: new RegExp(`^${t}`) }).isVisible()))).every(Boolean), 'config dialog has tabs 常规 / 对外能力 / 共享权限 / JSON')
const openTab = async (name: string) => {
  await page.getByRole('tab', { name: new RegExp(`^${name}`) }).click()
  await page.waitForTimeout(300)
}
const deleteInput = page.getByLabel('删除期限（小时）')
check(await page.getByLabel('整理回溯（小时）').isVisible() && await page.getByLabel('检索衰减半衰期（小时）').isVisible() && await deleteInput.isVisible(),
  'config dialog has lookback / decay / deletion hour fields')
check((await deleteInput.getAttribute('placeholder')) === '默认 4320', `deletion field shows the server default (${await deleteInput.getAttribute('placeholder')})`)
check(await visible(page.getByTestId('history-policy').filter({ hasText: '删除期限 4320 小时（180 天）' })), 'dialog shows the policy in effect')
await deleteInput.fill('2400')
await page.getByLabel('整理回溯（小时）').fill('48')
check((await deleteInput.inputValue()) === '2400', 'hour fields write into the config JSON and read back')
await page.waitForTimeout(300)
await page.screenshot({ path: join(OUT, '2-config.png') })
await openTab('JSON')
check(await page.locator('[role=dialog] .monaco-editor .line-numbers').first().waitFor({ timeout: 20_000 }).then(() => true, () => false),
  'the JSON tab renders the editor (with line numbers)')
check(await page.getByText(/capabilities/).first().isVisible(), 'the JSON tab explains the fields')
// The editor draws only the lines on screen; read its whole text.
const editorText = () => page.evaluate(() => ((window as any).monaco?.editor?.getModels?.() ?? []).map((m: any) => m.getValue()).join('\n')) as Promise<string>
check(/"deleteAfterHours": 2400/.test(await editorText()), 'the JSON shows the hours typed on the first tab')
await page.getByRole('button', { name: '保存', exact: true }).click()
await page.getByText(/协作配置：/).waitFor({ state: 'hidden' })
const adminApi = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return r.json() as Promise<any>
}
const listed = (await adminApi('GET', '/api/v1/admin/agentify/agents')).agents.find((a: any) => a.displayName === enabledName)
check(listed?.config?.memory?.deleteAfterHours === 2400 && listed?.config?.memory?.digestLookbackHours === 48, `saving from the dialog stores the hours (${JSON.stringify(listed?.config?.memory)})`)
check(listed?.historyPolicy?.deleteAfterHours === 2400 && listed?.historyPolicy?.digestLookbackHours === 48, 'the agent list reports the policy in effect')
// Put the agent back on server defaults through the dialog.
await enabledRow.getByRole('button', { name: '配置' }).click()
await page.getByText(/协作配置：/).waitFor()
await page.getByLabel('删除期限（小时）').fill('')
await page.getByLabel('整理回溯（小时）').fill('')
await page.getByRole('button', { name: '保存', exact: true }).click()
await page.getByText(/协作配置：/).waitFor({ state: 'hidden' })
const restored = (await adminApi('GET', '/api/v1/admin/agentify/agents')).agents.find((a: any) => a.displayName === enabledName)
check(restored?.config?.memory?.deleteAfterHours === undefined && restored?.historyPolicy?.deleteAfterHours === 4320, 'clearing the fields returns the agent to server defaults')

// Sharing panel: levels and lists per data type, written into the config.
const original = restored.config
await enabledRow.getByRole('button', { name: '配置' }).click()
await page.getByText(/协作配置：/).waitFor()
await openTab('共享权限')
for (const name of ['对话正文', '工作摘要', '输入文件', '产出文件', '中间文件', '共享记忆']) {
  check(await page.getByLabel(`${name} 共享范围`).isVisible(), `sharing row for ${name}`)
}
check(await page.getByLabel('对话正文 员工 允许').isDisabled(), 'employee lists are disabled for 仅本人')
check(await page.getByLabel('共享记忆 智能体 允许').isDisabled(), 'agent lists are disabled below 员工 + 其他智能体')
const pickLevel = async (type: string, level: string) => {
  await page.getByLabel(`${type} 共享范围`).click()
  await page.getByRole('option', { name: level, exact: true }).click()
}
await pickLevel('输入文件', '本智能体员工')
await pickLevel('产出文件', '员工 + 其他智能体')
check(await page.getByLabel('产出文件 智能体 允许').isEnabled(), 'choosing 员工 + 其他智能体 enables the agent list')
// Exclude one employee from summaries; hand outputs to one agent.
const pickFirst = async (label: string) => {
  await page.getByLabel(label).click()
  const item = page.locator('[data-radix-popper-content-wrapper] label').nth(1) // 0 = 全部
  const name = (await item.innerText()).trim()
  await item.click()
  await page.keyboard.press('Escape')
  return name
}
const excluded = await pickFirst('工作摘要 员工 排除')
const handedTo = await pickFirst('产出文件 智能体 允许')
check(await page.getByLabel('工作摘要 员工 排除').innerText().then(t => t.includes(excluded)), `the picker shows the chosen employee (${excluded})`)
await page.waitForTimeout(300)
const sharingTable = await page.locator('[role=dialog] table').boundingBox()
const dialogBox = await page.locator('[role=dialog]').boundingBox()
check(!!sharingTable && !!dialogBox && sharingTable.x >= dialogBox.x && sharingTable.x + sharingTable.width <= dialogBox.x + dialogBox.width + 1, 'the sharing table fits inside the dialog')
await page.screenshot({ path: join(OUT, '2b-sharing.png') })
await openTab('JSON')
check(/"deny": \[\s*"/.test(await editorText()), 'the JSON tab follows the sharing panel')
await page.getByRole('button', { name: '保存', exact: true }).click()
await page.getByText(/协作配置：/).waitFor({ state: 'hidden' })
const shared = (await adminApi('GET', '/api/v1/admin/agentify/agents')).agents.find((a: any) => a.displayName === enabledName)?.config?.sharing
check(shared?.input?.level === 'users' && shared?.output?.level === 'agents', `levels are saved (${JSON.stringify({ input: shared?.input, output: shared?.output })})`)
const inheritedAgents = (original.sharing?.agents ?? original.a2a.callers).allow.length
check(shared?.summary?.users?.deny?.length === 1 && shared?.output?.agents?.allow?.length === inheritedAgents + 1, `lists are saved (${handedTo}; ${JSON.stringify({ summary: shared?.summary, output: shared?.output })})`)
check(JSON.stringify(shared?.summary?.users?.allow) === '["*"]', 'excluding one employee keeps everyone else (starts from the default list)')
await adminApi('PUT', `/api/v1/admin/agentify/agents/${restored.id}`, { config: original })

// Capabilities form: add a task that acts outward, pick a confirmer, save.
await page.reload()
await page.getByRole('heading', { name: '协作智能体' }).waitFor({ timeout: 30_000 })
await page.waitForSelector('table tbody tr')
await page.locator('table tbody tr', { hasText: enabledName }).first().getByRole('button', { name: '配置' }).click()
await page.getByText(/协作配置：/).waitFor()
await openTab('对外能力')
const capCount = original.a2a.capabilities.length
check(await page.getByTestId('capability-0').isVisible() === capCount > 0, `existing capabilities are listed (${capCount})`)
await page.getByRole('button', { name: '添加能力' }).click()
const n = capCount + 1
check(await page.getByTestId('capability-problems').isVisible(), 'a new capability without a description is flagged')
await page.getByLabel(`能力 ${n} ID`).fill('Bad Id')
check(await visible(page.getByTestId('capability-problems').filter({ hasText: 'ID 只能用小写字母' })), 'an invalid id is flagged')
await page.getByLabel(`能力 ${n} ID`).fill('ui-check-notify')
await page.getByLabel(`能力 ${n} 说明`).fill('界面检查：通知供应商')
check(await page.getByRole('checkbox', { name: '需要人工确认', exact: true }).nth(n - 1).isDisabled(), 'a read-only question cannot require confirmation')
await page.getByLabel(`能力 ${n} 类型`).click()
await page.getByRole('option', { name: '委派任务' }).click()
await page.getByRole('checkbox', { name: '允许对外动作', exact: true }).nth(n - 1).click()
check(await page.getByRole('checkbox', { name: '需要人工确认', exact: true }).nth(n - 1).isChecked(), 'allowing outward actions turns on confirmation')
check(await visible(page.getByText('建议指定确认人')), 'an outward task without confirmers is pointed out')
await page.getByLabel('任务确认人').click()
const confirmer = page.locator('[data-radix-popper-content-wrapper] label').first()
const confirmerName = (await confirmer.innerText()).trim()
check(confirmerName !== '全部', `the confirmer list has no 全部 entry (first: ${confirmerName})`)
await confirmer.click()
await page.keyboard.press('Escape')
await page.getByLabel('每日调用上限').fill('77')
await page.waitForTimeout(300)
await page.screenshot({ path: join(OUT, '2c-capabilities.png'), fullPage: true })
await page.getByRole('button', { name: '保存', exact: true }).click()
await page.getByText(/协作配置：/).waitFor({ state: 'hidden' })
const capsSaved = (await adminApi('GET', '/api/v1/admin/agentify/agents')).agents.find((a: any) => a.displayName === enabledName)?.config?.a2a
const added = capsSaved?.capabilities?.find((c: any) => c.id === 'ui-check-notify')
check(added?.kind === 'task' && added?.allowOutbound === true && added?.requiresConfirmation === true, `the new capability is saved (${JSON.stringify(added)})`)
check(capsSaved?.confirmers?.length === 1 && capsSaved?.dailyCallLimit === 77, `confirmer and daily limit are saved (${JSON.stringify({ confirmers: capsSaved?.confirmers, limit: capsSaved?.dailyCallLimit })})`)
await adminApi('PUT', `/api/v1/admin/agentify/agents/${restored.id}`, { config: original })

// History dialog with a Chinese search.
await enabledRow.getByRole('button', { name: '历史' }).click()
await page.getByText(/历史与产出：/).waitFor()
const historyWidth = (await page.locator('[role=dialog]').boundingBox())?.width ?? 0
check(historyWidth >= 1000, `the history dialog uses the screen width (${Math.round(historyWidth)} px)`)
await page.getByPlaceholder(/用中文提问/).fill('第44周 返厂')
await page.getByRole('button', { name: '检索' }).click()
await page.waitForTimeout(2500)
const results = await page.locator('[role=dialog] button', { hasText: /摘要|产出|输入|协作|对话|记忆/ }).count()
check(results > 0, `history search returns results (${results})`)
if (results > 0) {
  await page.locator('[role=dialog] button', { hasText: /摘要|产出|输入|协作|对话|记忆/ }).first().click()
  await page.waitForTimeout(1500)
  check(await page.locator('[role=dialog] pre').first().isVisible(), 'a history entry opens with its full text')
}
await page.screenshot({ path: join(OUT, '3-history.png') })
await page.keyboard.press('Escape')

// Memory dialog.
await enabledRow.getByRole('button', { name: '记忆' }).click()
await page.getByText(/共享记忆：/).waitFor()
check(await page.locator('[role=dialog] textarea').isVisible(), 'memory dialog shows an editable memory')
await page.screenshot({ path: join(OUT, '4-memory.png') })
await page.keyboard.press('Escape')

// Calls tab.
await page.getByRole('tab', { name: '协作记录' }).click()
await page.waitForTimeout(1500)
const callRows = await page.locator('table tbody tr').count()
check(callRows > 0 && !(await page.getByText('暂无协作记录').isVisible()), `calls tab lists agent calls (${callRows})`)
await page.locator('table tbody tr').first().click()
await page.waitForTimeout(800)
check(await page.getByText('请求', { exact: true }).isVisible(), 'a call opens with its request and result')
await page.screenshot({ path: join(OUT, '5-calls.png') })
await page.keyboard.press('Escape')

// Pending tab renders.
await page.getByRole('tab', { name: /待确认/ }).click()
await page.waitForTimeout(800)
await page.screenshot({ path: join(OUT, '6-pending.png') })
check(true, 'pending confirmations tab renders')

// A confirmer who is not an administrator: 待确认任务 is in their menu and loads.
if (employeeToken) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const p2 = await ctx.newPage()
  await p2.goto(`${BASE}/admin/login`)
  await p2.evaluate(([t, org]) => {
    localStorage.setItem('moss_access_token', t)
    localStorage.setItem('moss_token_expires_at', String(Date.now() + 3600_000))
    localStorage.setItem('moss_preferred_org_id', org)
  }, [employeeToken, ORG])
  await p2.goto(`${BASE}/admin/`)
  await p2.waitForTimeout(2500)
  check(await p2.getByRole('link', { name: '待确认任务' }).isVisible(), 'a plain employee sees 待确认任务 in the menu')
  check(!(await p2.getByRole('link', { name: '协作智能体' }).isVisible()), 'but not the 协作智能体 administration')
  await p2.getByRole('link', { name: '待确认任务' }).click()
  check(await p2.getByText(/没有需要你确认的任务|任务内容/).first().waitFor({ timeout: 20_000 }).then(() => true, () => false), 'the confirmations page loads for a plain employee')
  await p2.screenshot({ path: join(OUT, '7-confirmations-employee.png') })
  await ctx.close()
} else {
  check(false, 'no end-to-end employee found for the confirmations page check')
}

const relevant = consoleErrors.filter(e => !/favicon|Failed to load resource: the server responded with a status of 404/.test(e))
check(relevant.length === 0, `no browser console errors${relevant.length ? `: ${relevant.slice(0, 3).join(' | ')}` : ''}`)
await browser.close()
console.log(failures === 0 ? 'UI CHECKS PASSED' : `${failures} UI CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
