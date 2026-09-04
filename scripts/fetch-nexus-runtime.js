#!/usr/bin/env bun
/**
 * 本地开发（Windows/macOS 原生）自动获取 nexus runtime。
 *
 * 从阶梯下载源（COS Runtime → Legacy COS → GitHub）拉取当前平台的 vault 插件与
 * nexusd 二进制，校验 sha256，用系统 tar 解压后落盘到仓库 bin/nexus 下，供 server
 * 运行期 assertVaultPluginAvailable / resolveCompatibleBinary 使用。
 *
 * moss 是服务器端服务，与 sudowork（Electron 桌面端）天然不同：此处用 Node 原生实现，
 * 不引入 Electron API、不引入第三方解压依赖（用系统 tar，Windows 用 System32\tar.exe）。
 *
 * 由 scripts/build.js 在 `--target=node` 且 win32/darwin 且非 CI 时调用；也可
 * `bun scripts/fetch-nexus-runtime.js` 独立运行（便于单独验证与手动重取）。
 *
 * 版本来源：src/server/nexus/runtime-versions.json；升级版本时必须同步更新下方 SHA256 表。
 */
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { get as httpGet } from 'http'
import { get as httpsGet } from 'https'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
// 落盘基准取运行期同源的 process.cwd()：与 nexusManager.resolveNexusPluginDir()
// / resolveCompatibleBinary 的 cwd 语义一致，要求在仓库根既 build:node 又启动 server。
const REPO_ROOT = process.cwd()

// COS 桶来源：sudowork packages/common/src/cos.ts（sudowork 侧基础设施；moss 仓库无引用）。
// 已本机实测 6 个 win/mac 制品 200 + sha256 MATCH。升级版本时按平台矩阵逐条复测对齐。
const COS_RUNTIME = 'https://sudowork-runtime-1309794936.cos.ap-beijing.myqcloud.com'
const COS_LEGACY = 'https://sudoclaw-download-1309794936.cos.ap-beijing.myqcloud.com'

// sha256 真源（实测值）。仅列 build.js 触发平台（win/mac）所需；Linux 由
// server.Dockerfile.local 内联 sha 各自维护。升级 runtime-versions.json 版本时必须同步此表。
const SHA256 = {
  'nexus-vault-macos-arm64.tar.gz': '8ad59f175c9079709ced75dabea5b90fe89ea6d133c8cb37e5153f1ab0a0e67b',
  'nexus-vault-macos-x86_64.tar.gz': '7bce4cfa6de33f886b8bdc6ca9fd3c6f6f1cd732358d0a361179f54c2bd64111',
  'nexus-vault-windows-x86_64.zip': '23619d44c877dbd377dca96fdef944efe14553f9e4a4580f668df29eb504c603',
  'nexusd-cluster-macos-aarch64.tar.gz': 'c9af8542fdfe08925bb554253d2edb73537428d67900e38a34db6b2db2cb6c40',
  'nexusd-cluster-macos-x86_64.tar.gz': 'ce4609a4f3e4015a3538fc5f520da7cf94d23f3605425dc2916689477e2bcf7e',
  'nexusd-cluster-windows-x86_64.zip': 'e4cf87c84a4ee60ea53614d630fbb75b4710367891d1edbd0b66dd7917ad9c75',
}

const GITHUB = 'https://github.com/nexi-lab/nexus/releases/download'

function loadVersions() {
  const p = join(SCRIPT_DIR, '..', 'src', 'server', 'nexus', 'runtime-versions.json')
  const j = JSON.parse(readFileSync(p, 'utf8'))
  return { vault: j['nexus-vault'], nexusd: j['nexusd-cluster'] }
}

// ── 平台映射 ──────────────────────────────────────────────────────────────────
// vault：arch token 用 arm64/x86_64（与 nexusd 的 aarch64 不同，勿混用）。仅列 fetch 支持三平台。
function vaultArtifact(platform, arch) {
  return {
    'darwin-arm64': 'nexus-vault-macos-arm64.tar.gz',
    'darwin-x64': 'nexus-vault-macos-x86_64.tar.gz',
    'win32-x64': 'nexus-vault-windows-x86_64.zip',
  }[`${platform}-${arch}`] ?? null
}

// vault dylib 名：必须与 nexusManager.resolveVaultDylibName 保持一致。
function vaultDylibName(platform) {
  if (platform === 'win32') return 'nexus_vault.dll'
  if (platform === 'darwin') return 'libnexus_vault.dylib'
  return 'libnexus_vault.so'
}

// nexusd：arch token 用 aarch64/x86_64。
function nexusdArtifact(platform, arch) {
  const os = { darwin: 'macos', win32: 'windows', linux: 'linux' }[platform]
  const a = { arm64: 'aarch64', x64: 'x86_64' }[arch]
  if (!os || !a) return null
  return `nexusd-cluster-${os}-${a}.${platform === 'win32' ? 'zip' : 'tar.gz'}`
}

function vaultUrls(ver, artifact) {
  return [
    { label: 'COS Runtime', url: `${COS_RUNTIME}/nexus-vault/release/v${ver}/${artifact}` },
    { label: 'Legacy COS', url: `${COS_LEGACY}/nexus-vault/release/v${ver}/${artifact}` },
    { label: 'GitHub', url: `${GITHUB}/vault-v${ver}/${artifact}` },
  ]
}

function nexusdUrls(ver, artifact) {
  return [
    { label: 'COS Runtime', url: `${COS_RUNTIME}/nexusd-cluster/release/v${ver}/${artifact}` },
    { label: 'Legacy COS', url: `${COS_LEGACY}/nexusd-cluster/release/v${ver}/${artifact}` },
    { label: 'GitHub', url: `${GITHUB}/nexusd-cluster-v${ver}/${artifact}` },
  ]
}

// ── 下载 / 校验 / 解压 ────────────────────────────────────────────────────────
function downloadTo(url, dest) {
  return new Promise((resolve, reject) => {
    let redirects = 0
    const doReq = u => {
      if (redirects++ > 10) return reject(new Error('too many redirects'))
      const getter = u.startsWith('https:') ? httpsGet : httpGet
      getter(u, res => {
        const code = res.statusCode
        if (code && [301, 302, 307, 308].includes(code) && res.headers.location) {
          res.resume()
          doReq(res.headers.location)
          return
        }
        if (code === 404) {
          res.resume()
          reject(new Error('NOT_FOUND'))
          return
        }
        if (code !== 200) {
          res.resume()
          reject(new Error(`HTTP ${code}`))
          return
        }
        const file = createWriteStream(dest)
        res.pipe(file)
        file.on('finish', () => file.close(() => resolve()))
        file.on('error', err => {
          try { unlinkSync(dest) } catch {}
          reject(err)
        })
      }).on('error', err => {
        try { unlinkSync(dest) } catch {}
        reject(err)
      })
    }
    doReq(url)
  })
}

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

// 阶梯下载：任一级失败（404 / 网络 reset/超时/非200 / sha256 不符）都回退下一级；全失败才抛错。
async function downloadWithFallback(urls, expectedSha, dest) {
  let lastErr = 'unknown error'
  for (const { label, url } of urls) {
    try {
      await downloadTo(url, dest)
      const actual = sha256File(dest)
      if (actual !== expectedSha) {
        try { unlinkSync(dest) } catch {}
        lastErr = `sha256 mismatch (expected ${expectedSha}, got ${actual})`
        console.warn(`[fetch-nexus] ${label} ${url} -> ${lastErr}, trying next mirror`)
        continue
      }
      console.log(`[fetch-nexus] ${label} OK: ${url}`)
      return
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
      console.warn(`[fetch-nexus] ${label} ${url} -> ${lastErr}, trying next mirror`)
    }
  }
  throw new Error(`all mirrors failed: ${lastErr}`)
}

// 系统 tar：unix `tar`；Windows 用绝对路径 System32\tar.exe（bsdtar，可解 tar.gz 与 zip；
// 不能用 Git-Bash 的 tar，会把 C: 当远程主机）。`-xf` 自动识别 gzip。
function extract(archivePath, targetDir) {
  const tarBin =
    process.platform === 'win32'
      ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar'
  execFileSync(tarBin, ['-xf', archivePath, '-C', targetDir], { stdio: 'inherit' })
}

function findFile(dir, name) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      const found = findFile(full, name)
      if (found) return found
    } else if (e.name === name) {
      return full
    }
  }
  return null
}

// marker 版本一致且目标文件在 → 已安装，跳过（支持版本升级刷新）。
function alreadyInstalled(markerPath, version, ...targets) {
  if (!existsSync(markerPath)) return false
  if (!targets.every(t => existsSync(t))) return false
  try {
    return readFileSync(markerPath, 'utf8').trim() === version
  } catch {
    return false
  }
}

// ── vault / nexusd 安装 ───────────────────────────────────────────────────────
async function ensureVault(version) {
  const { platform, arch } = process
  const artifact = vaultArtifact(platform, arch)
  if (!artifact) {
    console.warn(`[fetch-nexus] vault: no upstream artifact for ${platform}-${arch}; skip.`)
    return
  }
  const expectedSha = SHA256[artifact]
  if (!expectedSha) {
    // 下载前判定：无 sha 条目视为不支持，跳过不下载（安全，不静默安装未校验字节）。
    console.warn(`[fetch-nexus] vault: no known sha256 for ${artifact}; skip (unsupported platform).`)
    return
  }
  const dylibName = vaultDylibName(platform)
  const pluginDir = join(REPO_ROOT, 'bin', 'nexus', 'plugins')
  const dylibPath = join(pluginDir, dylibName)
  const sigPath = `${dylibPath}.sig`
  const markerPath = join(pluginDir, '.vault-version')
  if (alreadyInstalled(markerPath, version, dylibPath, sigPath)) {
    console.log(`[fetch-nexus] vault already installed at v${version}; skip.`)
    return
  }
  mkdirSync(pluginDir, { recursive: true })
  const tmp = mkdtempSync(join(tmpdir(), 'moss-nexus-vault-'))
  try {
    const archive = join(tmp, artifact)
    await downloadWithFallback(vaultUrls(version, artifact), expectedSha, archive)
    const extractDir = join(tmp, `_extract-${process.pid}-${Date.now()}`)
    mkdirSync(extractDir, { recursive: true })
    extract(archive, extractDir)
    const dylibSrc = findFile(extractDir, dylibName)
    if (!dylibSrc) throw new Error(`vault archive ${artifact} did not contain ${dylibName}`)
    copyFileSync(dylibSrc, dylibPath)
    if (platform !== 'win32') chmodSync(dylibPath, 0o755)
    const sigSrc = findFile(extractDir, `${dylibName}.sig`)
    if (sigSrc) {
      copyFileSync(sigSrc, sigPath)
    } else {
      try { unlinkSync(sigPath) } catch {}
      console.warn(`[fetch-nexus] vault ${artifact} has no .sig; nexusd will reject the plugin.`)
    }
    writeFileSync(markerPath, version)
    console.log(`[fetch-nexus] vault installed: ${dylibPath}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

async function ensureNexusd(version) {
  const { platform, arch } = process
  const artifact = nexusdArtifact(platform, arch)
  if (!artifact) {
    console.warn(`[fetch-nexus] nexusd: no upstream artifact for ${platform}-${arch}; skip.`)
    return
  }
  const expectedSha = SHA256[artifact]
  if (!expectedSha) {
    console.warn(`[fetch-nexus] nexusd: no known sha256 for ${artifact}; skip (unsupported platform).`)
    return
  }
  const binDir = join(REPO_ROOT, 'bin', 'nexus')
  const targetName = platform === 'win32' ? 'nexusd.exe' : 'nexusd'
  const srcName = platform === 'win32' ? 'nexusd-cluster.exe' : 'nexusd-cluster'
  const targetPath = join(binDir, targetName)
  const markerPath = join(binDir, '.nexusd-version')
  if (alreadyInstalled(markerPath, version, targetPath)) {
    console.log(`[fetch-nexus] nexusd already installed at v${version}; skip.`)
    return
  }
  mkdirSync(binDir, { recursive: true })
  const tmp = mkdtempSync(join(tmpdir(), 'moss-nexus-nexusd-'))
  try {
    const archive = join(tmp, artifact)
    await downloadWithFallback(nexusdUrls(version, artifact), expectedSha, archive)
    const extractDir = join(tmp, `_extract-${process.pid}-${Date.now()}`)
    mkdirSync(extractDir, { recursive: true })
    extract(archive, extractDir)
    const src = findFile(extractDir, srcName)
    if (!src) throw new Error(`nexusd archive ${artifact} did not contain ${srcName}`)
    copyFileSync(src, targetPath) // 重命名为 moss 期望的 nexusd[.exe]
    if (platform !== 'win32') chmodSync(targetPath, 0o755)
    writeFileSync(markerPath, version)
    console.log(`[fetch-nexus] nexusd installed: ${targetPath}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * 入口：确保当前平台的 vault + nexusd 就位。每个制品的失败均被捕获为 warn（不阻断构建）；
 * 运行期 assertVaultPluginAvailable / resolveCompatibleBinary 的 fail-fast 作为最终兜底。
 */
export async function ensureNexusRuntime() {
  const { vault, nexusd } = loadVersions()
  await ensureVault(vault).catch(e =>
    console.warn(`[fetch-nexus] vault fetch failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`),
  )
  await ensureNexusd(nexusd).catch(e =>
    console.warn(`[fetch-nexus] nexusd fetch failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`),
  )
}

if (import.meta.main) {
  await ensureNexusRuntime()
}
