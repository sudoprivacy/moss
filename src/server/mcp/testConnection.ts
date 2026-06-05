import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServer, McpConnectionTestResult } from './types.js'
import { resolveAuthHeaders } from './authResolver.js'

const CLIENT_INFO = { name: 'moss-mcp-connection-test', version: '1.0.0' }

/**
 * 测试 MCP 服务连接。
 * 通过 MCP SDK 执行真正的 initialize 协议握手（而非依赖进程退出码 /
 * 单纯的 HTTP 2xx），握手成功即代表该 MCP server 可用。
 */
export async function testMcpConnection(server: McpServer): Promise<McpConnectionTestResult> {
  const start = Date.now()

  try {
    if (server.mcp_type === 'stdio') {
      return await runHandshake(() => buildStdioTransport(server), server.timeout_ms, start)
    }

    if (server.mcp_type === 'http') {
      if (!server.url) return fail('URL 未配置', start)
      const headers = resolveAuthHeaders(server.auth_type, server.auth_config_json)
      return await runHandshake(
        () => new StreamableHTTPClientTransport(new URL(server.url as string), { requestInit: { headers } }),
        server.timeout_ms,
        start,
      )
    }

    if (server.mcp_type === 'sse') {
      if (!server.url) return fail('URL 未配置', start)
      const headers = resolveAuthHeaders(server.auth_type, server.auth_config_json)
      return await runHandshake(
        () => new SSEClientTransport(new URL(server.url as string), { requestInit: { headers } }),
        server.timeout_ms,
        start,
      )
    }

    return fail(`不支持的 MCP 类型: ${server.mcp_type}`, start)
  } catch (err) {
    return fail(classifyError(err), start)
  }
}

function buildStdioTransport(server: McpServer): StdioClientTransport {
  if (!server.command) {
    throw new Error('启动命令未配置')
  }

  let args: string[] = []
  if (server.args_json) {
    try {
      const parsed = JSON.parse(server.args_json)
      if (Array.isArray(parsed)) args = parsed.filter((v: unknown): v is string => typeof v === 'string')
    } catch { /* ignore malformed args */ }
  }

  let customEnv: Record<string, string> = {}
  if (server.env_json) {
    try {
      const parsed = JSON.parse(server.env_json)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string') customEnv[k] = v
        }
      }
    } catch { /* ignore malformed env */ }
  }

  return new StdioClientTransport({
    command: server.command,
    args,
    // 继承父进程 env（含 PATH，使 npx/uvx/node 可被解析且子进程能联网），
    // 再叠加用户配置的环境变量
    env: { ...(process.env as Record<string, string>), ...customEnv },
    stderr: 'pipe',
  })
}

/**
 * 用给定 transport 执行 initialize 握手，并尝试拉取工具列表。
 * connect() 成功即判连接成功；listTools 仅作为附加信息（失败不致命，
 * 因为部分 MCP server 不声明 tools capability）。
 */
async function runHandshake(
  makeTransport: () => Transport,
  timeoutMs: number,
  start: number,
): Promise<McpConnectionTestResult> {
  let transport: Transport
  try {
    transport = makeTransport()
  } catch (err) {
    return fail(classifyError(err), start)
  }

  const client = new Client(CLIENT_INFO)
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('__timeout__')), timeoutMs)
    })

    const toolCount = await Promise.race([
      (async () => {
        await client.connect(transport)
        try {
          const list = await client.listTools()
          return list.tools.length
        } catch {
          return null
        }
      })(),
      timeoutPromise,
    ])

    const info = client.getServerVersion()
    const label = info?.name
      ? `${info.name}${info.version ? ` v${info.version}` : ''}`
      : ''
    const toolsPart = toolCount != null ? `，${toolCount} 个工具` : ''
    const message = `连接成功${label ? `：${label}` : ''}${toolsPart}`

    return { ok: true, message, latency_ms: Date.now() - start }
  } catch (err) {
    return fail(classifyError(err), start)
  } finally {
    if (timer) clearTimeout(timer)
    try { await client.close() } catch { /* ignore close error */ }
  }
}

function classifyError(err: unknown): string {
  if (!(err instanceof Error)) return truncate(String(err))

  if (err.message === '__timeout__') return '连接超时'

  const code = (err as NodeJS.ErrnoException).code
  const m = err.message

  if (code === 'ENOENT' || m.includes('ENOENT') || m.includes('not found') || m.includes('Executable not found')) {
    return '命令未找到，请确认对应程序已安装并在 PATH 中'
  }
  if (code === 'EACCES' || m.includes('EACCES') || m.includes('permission denied')) {
    return '权限不足，无法执行启动命令'
  }
  // stdio: 进程启动后立即退出 / 命令无法运行时，SDK 抛 "Connection closed"
  if (m.includes('Connection closed') || m.includes('-32000')) {
    return '连接已关闭：请检查启动命令、参数与依赖是否正确'
  }
  return truncate(m)
}

function truncate(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function fail(message: string, start: number): McpConnectionTestResult {
  return { ok: false, message, latency_ms: Date.now() - start }
}
