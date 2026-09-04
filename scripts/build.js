#!/usr/bin/env bun
/**
 * 构建脚本：读取 features.js，生成 bun build 命令
 * 用法：bun run build.js [--target=node]
 */
import { RECOMMENDED, EXPERIMENTAL, NATIVE_REQUIRED, INTERNAL_ONLY } from './features.js'
import { spawnSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

/**
 * 清理打包产物中由 bun build 内联的绝对路径。
 * 第三方 CJS 库（undici, aws-sdk, grpc-js）的 __filename/__dirname
 * 会被 bun 替换为编译机器的绝对路径，导致跨机器不可用。
 */
function sanitizePaths(outfile) {
  const fullPath = resolve(outfile)
  const content = readFileSync(fullPath, 'utf8')
  const replaced = content.replace(
    /(["'])\/[^"']*?\/node_modules\//g,
    (match, quote) => quote + './node_modules/'
  )
  if (replaced !== content) {
    writeFileSync(fullPath, replaced, 'utf8')
    console.log(`  Sanitized absolute paths in ${outfile}`)
  }
}

const onlyNode = process.argv.includes('--target=node')

const enabledFeatures = Object.entries({ ...RECOMMENDED, ...EXPERIMENTAL, ...NATIVE_REQUIRED, ...INTERNAL_ONLY })
  .filter(([, v]) => v)
  .map(([k]) => k)

const defines = [
  `--define=MACRO.VERSION="2.1.88"`,
  `--define=MACRO.PACKAGE_URL="moss"`,
  `--define=MACRO.NATIVE_PACKAGE_URL="moss"`,
  `--define=MACRO.BUILD_TIME="${new Date().toISOString()}"`,
  `--define=MACRO.FEEDBACK_CHANNEL=""`,
  `--define=MACRO.ISSUES_EXPLAINER=""`,
  `--define=MACRO.VERSION_CHANGELOG=""`,
]

const aliases = [
  '--alias=bun:bundle=./scripts/bun-bundle-feature.js',
  '--alias=@ant/claude-for-chrome-mcp=./vendor/@ant/claude-for-chrome-mcp/index.js',
  '--alias=@anthropic-ai/bedrock-sdk=./vendor/@anthropic-ai/bedrock-sdk/index.mjs',
  '--alias=@anthropic-ai/foundry-sdk=./vendor/@anthropic-ai/foundry-sdk/index.mjs',
  '--alias=@anthropic-ai/vertex-sdk=./vendor/@anthropic-ai/vertex-sdk/index.mjs',
  '--alias=@anthropic-ai/mcpb=./vendor/@anthropic-ai/mcpb/index.mjs',
  '--alias=color-diff-napi=./vendor/color-diff-napi/index.js',
  '--alias=modifiers-napi=./vendor/modifiers-napi/index.js',
]

function build(label, args) {
  console.log(`\nBuilding ${label}`)
  const result = spawnSync('bun', args, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function ensureAdminBuildDependencies() {
  const requiredPaths = [
    resolve('admin', 'node_modules', 'vite', 'package.json'),
    resolve('admin', 'node_modules', '.bin', 'vite'),
    resolve('admin', 'node_modules', '.bin', 'vite.cmd'),
  ]
  if (!requiredPaths.some((path) => existsSync(path))) {
    console.error('Missing admin build dependencies. Run "bun install" in the admin directory before "bun run build:node".')
    process.exit(1)
  }
}

/**
 * Build an in-scode Go CLI from cli/<name>/ into bin/<name>.
 *
 * Non-fatal: if Go is missing we warn and continue. The scode env will
 * still get PATH including bin/, but calls to the CLI will fail with
 * "command not found" — surfaceable to ops via server logs.
 */
function buildGoCli(name) {
  if (!existsSync(resolve('cli', name, 'main.go'))) {
    console.log(`Skipping bin/${name} — cli/${name}/main.go not found`)
    return
  }
  const probe = spawnSync('go', ['version'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    console.warn(
      `⚠  Skipping bin/${name} build — \`go\` not on PATH. Install Go 1.22+ or pre-build cli/${name} manually.`,
    )
    return
  }
  console.log(`\nBuilding bin/${name} (Go)`)
  const result = spawnSync(
    'go',
    ['build', '-o', resolve('bin', name), '.'],
    { cwd: resolve('cli', name), stdio: 'inherit' },
  )
  if (result.status !== 0) {
    console.warn(`⚠  bin/${name} build failed (exit ${result.status}); continuing`)
  }
}

console.log(`Enabled features (${enabledFeatures.length}): ${enabledFeatures.join(', ') || '(none)'}`)

// 本地开发（Windows/macOS 原生）自动获取 nexus runtime（vault 插件 + nexusd）。
// 仅 --target=node 且 win32/darwin 且非 CI 触发：Linux 走镜像内置（Dockerfile 亦跑 build:node，
// platform=linux 在此跳过）；CI 的 mac/win runner 打包 ui/ Electron 不需要 nexus，故用 !CI 排除。
// 注意：平台判断必须用 includes/显式比较，切勿写成 process.platform==='win32' || 'darwin'
//（'darwin' 恒真会让 Linux 也进块，架空平台门）。下载失败不阻断构建，运行期有 fail-fast 兜底。
if (onlyNode && ['win32', 'darwin'].includes(process.platform) && !process.env.CI) {
  try {
    const { ensureNexusRuntime } = await import('./fetch-nexus-runtime.js')
    await ensureNexusRuntime()
  } catch (e) {
    console.warn(`⚠  nexus runtime fetch skipped (non-fatal): ${e?.message ?? e}`)
  }
}



// admin/dist（由 moss server 直接挂载到 /admin）
ensureAdminBuildDependencies()
build('admin/dist', [
  'run',
  '--cwd', 'admin',
  'build',
])

const external = [
  '--external=better-sqlite3',
  // @xenova/transformers (and its onnxruntime-node native dep) ships its
  // own ONNX runtime + tokenizer assets. Bundling them produces a broken
  // import for the .node binding and ~50MB of wasted code. Resolve from
  // node_modules at runtime instead.
  '--external=@xenova/transformers',
  '--external=onnxruntime-node',
  '--external=sharp',
]

// bin/moss-server.mjs（统一服务端入口）
build('bin/moss-server.mjs', [
  'build', 'src/server/serverCli.ts',
  '--outfile=bin/moss-server.mjs',
  '--target=node',
  '--format=esm',
  ...aliases,
  ...defines,
  ...external,
])
sanitizePaths('bin/moss-server.mjs')

// bin/direct-connect-session-runner.mjs（session detached runner）
build('bin/direct-connect-session-runner.mjs', [
  'build', 'src/server/sessionRunnerCli.ts',
  '--outfile=bin/direct-connect-session-runner.mjs',
  '--target=node',
  '--format=esm',
  ...aliases,
  ...defines,
])

// bin/wiki（Document Center: in-scode wiki CLI; written in Go so scode's
// shell can shell out to it. server.ts prepends bin/ to PATH for scode
// subprocesses so it resolves without manual install.）
buildGoCli('wiki')

// bin/corpapp（企业应用管理: in-scode corp-app CLI; same PATH mechanism.）
buildGoCli('corpapp')

// direct-connect-open.mjs（独立 headless 客户端入口）
// build('direct-connect-open.mjs', [
//   'build', 'src/server/openCli.ts',
//   '--outfile=direct-connect-open.mjs',
//   '--target=node',
//   '--format=esm',
//   ...aliases,
//   ...defines,
// ])
