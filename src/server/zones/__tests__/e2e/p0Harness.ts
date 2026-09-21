/**
 * P0 跨进程 E2E 编排设施（§11.3）：拉起真实 nexus（Python full profile，
 * 含 /v2 Zone 控制面与 typed runtime）与真实 moss server（tsx 直跑源码），
 * 就绪等待、凭据铸造、登录与清理。
 *
 * 编排事实（2026-09-20 实测）：
 *  - nexus 启动：`.venv` python `-c "from nexus.daemon.main import main; …"`
 *    `--host 127.0.0.1 --port N --data-dir tmp --profile full`；就绪标志为
 *    stderr 的 "Application startup complete"（同 nexus tests/e2e/conftest.py）；
 *  - service credential：kernel binary `auth mint --subject-type service
 *    --subject-id moss-e2e --admin`，配合 `NEXUS_ZONE_DELEGATION_ISSUERS=
 *    moss-e2e` 满足 §6.4 trusted-issuer 检查（authz 要求 issuer 为 service）；
 *  - delegation 的数据面出示方式：请求头 `X-Nexus-Zone-Delegation`（nexus
 *    zone_security.py 既有实现）；
 *  - moss 数据目录隔离：`CLAUDE_CONFIG_DIR`；配置：`MOSS_SERVER_CONFIG` 指向
 *    临时 server.json；串行运行（规格 `-n 0` 语义，避免并行端口竞争）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { Agent, setGlobalDispatcher } from 'undici'

// 连接复用（根治"监听消失"假象）：裸 fetch 每次新连接，长序列轮询会积累
// 数千 TIME_WAIT 直至 ephemeral 端口耗尽——fetch failed 被误读为监听消失
// （netstat 的 LISTENING 行其实还在）。要点：① keepAlive 复用；② 超时由
// Agent 的 headers/bodyTimeout 承担——per-request AbortSignal 会保守销毁
// 连接、使复用失效（实测）。
setGlobalDispatcher(new Agent({
  keepAliveTimeout: 120_000,
  keepAliveMaxTimeout: 600_000,
  headersTimeout: 30_000,
  bodyTimeout: 30_000,
}))

export const NEXUS_REPO = 'C:/work/sudo_workspace_v3/nexus'
export const MOSS_REPO = 'C:/work/sudo_workspace_v3/moss'

export interface NexusProcess {
  baseUrl: string
  /** moss issuance service credential（§6.4 trusted issuer）。 */
  apiKey: string
  /** 初始 admin key（E2E 验证通道用：直接管理操作）。 */
  adminApiKey: string
  stop: () => Promise<void>
}

export interface MossProcess {
  baseUrl: string
  adminUsername: string
  adminPassword: string
  stop: () => Promise<void>
  /** 进程 stdout/stderr 累积（崩溃诊断）。 */
  bootLog: () => string
  /** 主进程是否仍在运行（exitCode 为 null 即活）。 */
  alive: () => boolean
}

/**
 * 从低段（25000-45000）选取可用端口——避开 ephemeral 范围（49152+）。
 *
 * 根因（2026-09-21 watch6 实证）：Windows 的动态保留端口段（Hyper-V/WSL
 * 启动时重排，`netsh interface ipv4 show excludedportrange` 可见）全部落
 * 在 ephemeral 范围。从此范围挑 server 监听端口会与动态保留/系统出站
 * 分配竞态：监听进程正常 startup 后端口对外不可达（connect
 * ECONNREFUSED，进程存活、无崩溃日志）——nexus（Python）与 moss（node）
 * 均复现，与被测系统无关。低段端口不受动态保留影响，实测稳定。
 */
function freePort(): Promise<number> {
  const pick = (): Promise<number> =>
    new Promise((resolve, reject) => {
      const candidate = 25000 + Math.floor(Math.random() * 20000)
      const srv = createServer()
      srv.once('error', () => { srv.close(); resolve(pick()) })
      srv.listen(candidate, '127.0.0.1', () => {
        srv.close(() => resolve(candidate))
      })
    })
  return pick()
}

function kernelBinary(): string {
  return join(NEXUS_REPO, 'target', 'debug', process.platform === 'win32' ? 'nexusd-cluster.exe' : 'nexusd-cluster')
}

/** 铸 moss issuance service credential（§6.4：trusted service identity）。 */
function mintServiceKey(env: NodeJS.ProcessEnv, tmp: string): string {
  const result = spawnSync(kernelBinary(), [
    'auth', 'mint',
    '--subject-type', 'service',
    '--subject-id', 'moss-e2e',
    '--admin',
    '--name', 'moss-p0-e2e',
  ], {
    env: { ...env, NEXUS_DATA_DIR: join(tmp, 'metastore') },
    encoding: 'utf8',
    cwd: NEXUS_REPO,
  })
  const key = (result.stdout || '').trim().split(/\r?\n/).pop() || ''
  if (!key) {
    throw new Error(`kernel key mint failed: ${result.stderr || 'no stdout'}`)
  }
  return key
}

/** 启动真实 nexus（Python full profile）。 */
export async function startNexus(tmp: string): Promise<NexusProcess> {
  mkdirSync(join(tmp, 'metastore'), { recursive: true })
  mkdirSync(join(tmp, 'kernel-identity'), { recursive: true })
  mkdirSync(join(tmp, 'home'), { recursive: true })

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NEXUS_API_KEY_SECRET: 'test-e2e-kernel-secret-12345',
    NEXUS_IDENTITY_DIR: join(tmp, 'kernel-identity'),
    NEXUS_NO_TLS: 'true',
    NEXUS_JWT_SECRET: 'p0-e2e-jwt-secret',
    NEXUS_DATABASE_URL: `sqlite:///${join(tmp, 'nexus.db').replaceAll('\\', '/')}`,
    NEXUS_ZONE_DELEGATION_ISSUERS: 'moss-e2e',
    NEXUS_RECORD_STORE_PATH: join(tmp, 'record_store.db'),
    NEXUS_UPLOAD_MIN_CHUNK_SIZE: '1',
    NEXUS_RATE_LIMIT_ENABLED: 'false',
    NEXUS_SEARCH_DAEMON: 'false',
    HOME: join(tmp, 'home'),
    PYTHONPATH: join(NEXUS_REPO, 'src'),
  }
  const apiKey = mintServiceKey(env, tmp)
  env.NEXUS_API_KEY = apiKey

  const port = await freePort()
  const python = process.platform === 'win32'
    ? join(NEXUS_REPO, '.venv', 'Scripts', 'python.exe')
    : join(NEXUS_REPO, '.venv', 'bin', 'python')
  const child = spawn(python, [
    '-c', 'from nexus.daemon.main import main; import sys; main(sys.argv[1:])',
    '--host', '127.0.0.1', '--port', String(port),
    '--data-dir', tmp, '--profile', 'full',
  ], { env, cwd: NEXUS_REPO, stdio: ['ignore', 'pipe', 'pipe'] })

  const ready = await waitForLine(child, 'Application startup complete', 120_000)
  if (!ready) {
    child.kill('SIGKILL')
    throw new Error('nexus server did not become ready in 120s')
  }
  const baseUrl = `http://127.0.0.1:${port}`
  // §6.4 trusted issuer：issuer 必须是 service 主体且在
  // NEXUS_ZONE_DELEGATION_ISSUERS 内。kernel `auth mint` 的 key 在 HTTP 认证
  // 链上解析不出 service 主体（实测 403）；现有 e2e 的做法是起服后经
  // `POST /api/v2/auth/keys` 铸 service key——跟随该已验证路径。startup
  // complete 后的首次连接在 Windows 上有间歇性拒绝（WFP/杀软扫描窗口，
  // 实测约 1/3 概率）——单发会假失败，循环重试直到通。
  let minted: Response | null = null
  for (let i = 0; i < 15 && !minted; i++) {
    try {
      minted = await fetchWithTimeout(`${baseUrl}/api/v2/auth/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          label: 'moss-e2e',
          subject_type: 'service',
          subject_id: 'moss-e2e',
          zone_id: 'root',
          is_admin: true,
        }),
      })
    } catch {
      await new Promise((r) => setTimeout(r, 1_000))
    }
  }
  if (!minted || !minted.ok) {
    await stopChild(child)
    throw new Error(`service key mint failed: ${minted ? minted.status : 'unreachable'} ${minted ? await minted.text() : ''}`)
  }
  const serviceKey = ((await minted.json()) as { key: string }).key
  return {
    baseUrl,
    apiKey: serviceKey,
    adminApiKey: apiKey,
    stop: () => stopChild(child),
  }
}

/** 停止子进程（Windows 上父进程终止不连带子进程——embedded nexusd 会
 * 滞留持有端口与文件句柄，必须 taskkill /T /F 杀整棵进程树）。 */
function stopChild(child: { kill: (signal?: NodeJS.Signals) => boolean; pid?: number; exitCode: number | null; on: (event: string, cb: () => void) => void }): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve()
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: true })
    return new Promise<void>((resolve) => {
      child.on('exit', () => resolve())
      setTimeout(resolve, 10_000).unref?.()
    })
  }
  child.kill()
  return new Promise<void>((resolve) => child.on('exit', () => resolve()))
}

/** 启动真实 moss server（tsx 源码直跑）。 */
export async function startMoss(
  tmp: string,
  input: { nexusV2BaseUrl: string; nexusServiceToken: string },
): Promise<MossProcess> {
  const adminUsername = 'p0admin'
  const adminPassword = 'p0-e2e-password-123'
  const port = await freePort()
  const configPath = join(tmp, 'server.json')
  writeFileSync(configPath, JSON.stringify({
    server: { host: '127.0.0.1', port },
    auth: { mode: 'auth-center', tokenTtlSec: 3600 },
    bootstrapAdmin: { username: adminUsername, password: adminPassword, email: 'p0@e2e.local' },
  }, null, 2))
  mkdirSync(join(tmp, 'mosshome'), { recursive: true })

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MOSS_SERVER_CONFIG: configPath,
    CLAUDE_CONFIG_DIR: join(tmp, 'mosshome'),
    // nexusDir 硬编码 homedir()/.moss/nexus（nexusManager.ts:273）——通过
    // 重定向 USERPROFILE/HOME 实现数据目录隔离，避免触碰真实 ~/.moss
    USERPROFILE: join(tmp, 'home'),
    HOME: join(tmp, 'home'),
    MOSS_NEXUS_V2_BASE_URL: input.nexusV2BaseUrl,
    MOSS_NEXUS_V2_SERVICE_TOKEN: input.nexusServiceToken,
    MOSS_NEXUS_DEPLOYMENT_ID: 'p0-e2e',
    // embedded nexus（secrets 数据面）gRPC 端口随机：moss#1 停止后端口可能
    // 处于 TIME_WAIT，复用 2126 会让 moss#2 的 embedded nexusd bind 失败
    MOSS_NEXUS_GRPC_PORT: String(await freePort()),
  }
  // 生产部署形态：node 跑 build 产物（源码直跑被 bun:/node:sqlite 双向
  // 卡死——bun 缺 node:sqlite，node 的 tsx 链含 bun: 协议；bundle 两者皆无）。
  // 运行 E2E 前必须先 `npm run build` 使 bundle 包含待测代码。
  const child = spawn(process.execPath, [
    join(MOSS_REPO, 'bin', 'moss-server.mjs'),
  ], { env, cwd: MOSS_REPO, stdio: ['ignore', 'pipe', 'pipe'], shell: false })

  const baseUrl = `http://127.0.0.1:${port}`
  // 收集启动日志：失败时 dump 末尾，避免"起不来"无诊断
  let bootLog = ''
  child.stderr?.on('data', (chunk: Buffer) => { bootLog += chunk.toString('utf8') })
  child.stdout?.on('data', (chunk: Buffer) => { bootLog += chunk.toString('utf8') })
  // 双条件就绪：本进程日志出现 started banner + 端口响应。只有端口通而
  // 日志无 banner 意味着响应来自残留进程（上一实例未死透、端口被复用）——
  // 此时后续状态会张冠李戴，必须当场报错而不是让场景莫名失败。
  const [alive, banner] = await Promise.all([
    waitForHttp(baseUrl, 180_000),
    waitForLine(child, 'Moss server started', 180_000),
  ])
  if (!alive || !banner) {
    child.kill('SIGKILL')
    throw new Error(
      `moss server did not become ready (http=${alive}, banner=${banner}); boot log tail:\n${bootLog.slice(-3000)}`,
    )
  }
  return {
    baseUrl,
    adminUsername,
    adminPassword,
    stop: () => stopChild(child),
    bootLog: () => bootLog,
    alive: () => child.exitCode === null,
  }
}

function waitForLine(child: { stderr?: NodeJS.ReadableStream | null; stdout?: NodeJS.ReadableStream | null; on: (event: string, cb: () => void) => void }, needle: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let buffer = ''
    let settled = false
    const done = (ok: boolean) => {
      if (!settled) { settled = true; resolve(ok) }
    }
    const collect = (stream?: NodeJS.ReadableStream | null) => {
      if (!stream) return
      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        if (buffer.includes(needle)) done(true)
      })
    }
    collect(child.stderr)
    collect(child.stdout)
    child.on('exit', () => done(false))
    setTimeout(() => done(false), timeoutMs).unref?.()
  })
}

function waitForHttp(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  const attempt = async (): Promise<boolean> => {
    if (Date.now() > deadline) return false
    try {
      const response = await fetchWithTimeout(`${baseUrl}/api/v1/auth/me`, { method: 'GET' })
      // 401（无 token）即服务已监听
      if (response.status === 401 || response.status === 200) return true
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 1_000))
    return attempt()
  }
  return attempt()
}

/** moss 登录 → Bearer token。 */
export async function login(moss: MossProcess, username: string, password: string): Promise<string> {
  const response = await fetchWithTimeout(`${moss.baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!response.ok) {
    throw new Error(`login failed for ${username}: ${response.status} ${await response.text()}`)
  }
  const body = (await response.json()) as { access_token?: string; data?: { access_token?: string } }
  const token = body.access_token ?? body.data?.access_token
  if (!token) throw new Error(`login response missing access_token: ${JSON.stringify(body).slice(0, 200)}`)
  return token
}

/** 带 Bearer 的 moss API 调用。 */
export async function mossApi(
  moss: MossProcess,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  let response: Response
  try {
    response = await fetchWithTimeout(`${moss.baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${token}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (error) {
    // 即时探活 + 端口取证：区分"进程死/监听消失/请求挂起"
    let probe = 'n/a'
    try {
      const me = await fetchWithTimeout(`${moss.baseUrl}/api/v1/auth/me`, { method: 'GET' })
      probe = `me=${me.status}`
    } catch (probeError) {
      probe = `me-failed=${String(probeError).slice(0, 80)}`
    }
    let netstat = ''
    if (process.platform === 'win32') {
      try {
        const port = moss.baseUrl.split(':').pop() ?? ''
        netstat = spawnSync(`netstat -ano | findstr :${port}`, { shell: 'cmd.exe', encoding: 'utf8' }).stdout.trim().slice(0, 400)
      } catch { netstat = '(netstat failed)' }
    }
    throw new Error(
      `mossApi ${method} ${path} unreachable (alive=${moss.alive()}, probe=${probe}, netstat:\n${netstat}): ${String(error)}\nboot tail:\n${moss.bootLog().slice(-8000)}`,
    )
  }
  const text = await response.text()
  return { status: response.status, json: text ? JSON.parse(text) as unknown : null }
}

/** nexus /v2 管理 API（E2E 的验证通道，非被测链路；默认 admin key）。 */
export async function nexusApi(
  nexus: NexusProcess,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
  const response = await fetchWithTimeout(`${nexus.baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${nexus.adminApiKey}`,
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  return { status: response.status, json: text ? (() => { try { return JSON.parse(text) as unknown } catch { return text } })() : null }
}

/** 在 nexus 侧为 moss 用户铸 API key（用户自身认证载体；subject 对齐 moss
 * userId；zone 绑定目标 zone——GET /v2/zones/{id} 的可见性跟 key 的 zone）。 */
export async function mintNexusUserKey(nexus: NexusProcess, subjectId: string, zoneId: string): Promise<string> {
  const response = await fetchWithTimeout(`${nexus.baseUrl}/api/v2/auth/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${nexus.adminApiKey}` },
    body: JSON.stringify({
      label: `moss-user-${subjectId.slice(0, 8)}`,
      subject_type: 'user',
      subject_id: subjectId,
      zone_id: zoneId,
      is_admin: false,
    }),
  })
  if (!response.ok) {
    throw new Error(`user key mint failed: ${response.status} ${await response.text()}`)
  }
  return ((await response.json()) as { key: string }).key
}


/** fetch（超时由全局 Agent 的 headers/bodyTimeout 承担——不用 per-request
 * signal，那会销毁连接使 keepAlive 复用失效）。 */
async function fetchWithTimeout(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, init)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
