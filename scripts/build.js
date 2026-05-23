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
  `--define=MACRO.PACKAGE_URL="@anthropic-ai/claude-code"`,
  `--define=MACRO.NATIVE_PACKAGE_URL="@anthropic-ai/claude-code"`,
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

console.log(`Enabled features (${enabledFeatures.length}): ${enabledFeatures.join(', ') || '(none)'}`)

if (!onlyNode) {
  // bin/cli.js（bun target，生产用）
  build('bin/cli.js', [
    'build', 'src/entrypoints/cli.tsx',
    '--outfile=bin/cli.js',
    '--target=bun',
    ...aliases,
    ...defines,
  ])
}

// bin/cli-node.js（node target，测试 / electron-sdk 子进程用）
build('bin/cli-node.js', [
  'build', 'src/entrypoints/cli.tsx',
  '--outfile=bin/cli-node.js',
  '--target=node',
  ...aliases,
  ...defines,
])
sanitizePaths('bin/cli-node.js')

// ui/electron-direct.mjs（供 Electron 桌面端打包）
build('ui/electron-direct.mjs', [
  'build', 'src/electron-direct.ts',
  '--outfile=ui/electron-direct.mjs',
  '--target=node',
  '--format=esm',
  ...aliases,
  ...defines,
])
sanitizePaths('ui/electron-direct.mjs')

// admin/dist（由 moss server 直接挂载到 /admin）
ensureAdminBuildDependencies()
build('admin/dist', [
  'run',
  '--cwd', 'admin',
  'build',
])

// bin/moss-server.mjs（统一服务端入口）
build('bin/moss-server.mjs', [
  'build', 'src/server/serverCli.ts',
  '--outfile=bin/moss-server.mjs',
  '--target=node',
  '--format=esm',
  ...aliases,
  ...defines,
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

// direct-connect-open.mjs（独立 headless 客户端入口）
// build('direct-connect-open.mjs', [
//   'build', 'src/server/openCli.ts',
//   '--outfile=direct-connect-open.mjs',
//   '--target=node',
//   '--format=esm',
//   ...aliases,
//   ...defines,
// ])
