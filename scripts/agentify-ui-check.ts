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
db.close()

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
await enabledRow.getByRole('button', { name: '配置' }).click()
await page.getByText(/协作配置：/).waitFor()
check(await page.getByText(/capabilities/).first().isVisible(), 'config dialog explains the fields')
await page.waitForTimeout(1500)
await page.screenshot({ path: join(OUT, '2-config.png') })
await page.keyboard.press('Escape')

// History dialog with a Chinese search.
await enabledRow.getByRole('button', { name: '历史' }).click()
await page.getByText(/历史与产出：/).waitFor()
await page.getByPlaceholder(/用中文提问/).fill('第44周 返厂')
await page.getByRole('button', { name: '检索' }).click()
await page.waitForTimeout(2500)
const results = await page.locator('[role=dialog] button', { hasText: /摘要|产出|协作|对话|记忆/ }).count()
check(results > 0, `history search returns results (${results})`)
if (results > 0) {
  await page.locator('[role=dialog] button', { hasText: /摘要|产出|协作|对话|记忆/ }).first().click()
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

const relevant = consoleErrors.filter(e => !/favicon|Failed to load resource: the server responded with a status of 404/.test(e))
check(relevant.length === 0, `no browser console errors${relevant.length ? `: ${relevant.slice(0, 3).join(' | ')}` : ''}`)
await browser.close()
console.log(failures === 0 ? 'UI CHECKS PASSED' : `${failures} UI CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
