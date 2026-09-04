#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="${1:?usage: run-server-release-smoke.sh VERSION ARCH DIST_DIR [DIAGNOSTICS_DIR]}"
ARCH="${2:?usage: run-server-release-smoke.sh VERSION ARCH DIST_DIR [DIAGNOSTICS_DIR]}"
DIST_DIR="$(cd "${3:?usage: run-server-release-smoke.sh VERSION ARCH DIST_DIR [DIAGNOSTICS_DIR]}" && pwd)"
DIAGNOSTICS_DIR="${4:-$DIST_DIR/e2e-diagnostics}"
SCODE_VERSION="${5:-}"

[ "$ARCH" = amd64 ] || { echo "E2E smoke only supports amd64" >&2; exit 1; }

TEST_USER="moss-e2e"
TEST_HOME="/tmp/moss-e2e-home"
INSTALL_DIR="$TEST_HOME/.moss/server"
OFFLINE_DIR="/tmp/moss-e2e-offline"
WORKSPACE_DIR="$TEST_HOME/workspace"
SERVICE_NAME="moss-server"
NETWORK_NAME="moss-network"
PORT="43129"
MOCK_API_KEY="moss-e2e-key"
ADMIN_USERNAME="e2e-admin"
ADMIN_PASSWORD="moss-e2e-admin-password"
SERVER_ARCHIVE="moss-server-$VERSION-linux-$ARCH.tar.gz"
RUNTIME_ARCHIVE="moss-runtime-$VERSION-linux-$ARCH.tar.gz"
RUNTIME_IMAGE="my-moss-runtime:$VERSION-$ARCH"
MOCK_PID=""
DIAGNOSTICS_COLLECTED=0

mkdir -p "$DIAGNOSTICS_DIR"
DIAGNOSTICS_DIR="$(cd "$DIAGNOSTICS_DIR" && pwd)"

collect_diagnostics() {
  DIAGNOSTICS_COLLECTED=1
  (
    set +e
    sudo journalctl -u "$SERVICE_NAME.service" --no-pager > "$DIAGNOSTICS_DIR/journalctl-moss-server.log" 2>&1
    sudo systemctl show "$SERVICE_NAME.service" --no-pager > "$DIAGNOSTICS_DIR/systemd-show.txt" 2>&1
    sudo systemctl cat "$SERVICE_NAME.service" > "$DIAGNOSTICS_DIR/systemd-unit.txt" 2>&1
    docker ps -a --no-trunc > "$DIAGNOSTICS_DIR/docker-ps.txt" 2>&1
    docker images --digests --no-trunc > "$DIAGNOSTICS_DIR/docker-images.txt" 2>&1
    docker network inspect "$NETWORK_NAME" > "$DIAGNOSTICS_DIR/docker-network.json" 2>&1
    if sudo test -f "$INSTALL_DIR/server.json" \
      && sudo test -x "$INSTALL_DIR/current/node/bin/node"; then
      sudo "$INSTALL_DIR/current/node/bin/node" - "$INSTALL_DIR/server.json" "$DIAGNOSTICS_DIR/server.json.redacted" <<'NODE'
const fs = require('node:fs')
const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
function redact(value) {
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== 'object') return value
  const result = {}
  for (const [key, child] of Object.entries(value)) {
    result[key] = /(password|secret|token|api.?key)/i.test(key) ? '<redacted>' : redact(child)
  }
  return result
}
fs.writeFileSync(process.argv[3], `${JSON.stringify(redact(input), null, 2)}\n`)
NODE
    fi
    if sudo test -d "$INSTALL_DIR/data/runtime"; then
      while IFS= read -r -d '' file; do
        relative="${file#"$INSTALL_DIR/data/runtime/"}"
        target="$DIAGNOSTICS_DIR/runtime/$relative"
        mkdir -p "$(dirname "$target")"
        sudo cp "$file" "$target"
      done < <(sudo find "$INSTALL_DIR/data/runtime" -type f \( -name '*.log' -o -name 'status.json' \) -print0 2>/dev/null)
    fi
    sudo chown -R "$(id -u):$(id -g)" "$DIAGNOSTICS_DIR" 2>/dev/null || true
  )
}

cleanup() {
  set +e
  if sudo test -x "$INSTALL_DIR/uninstall.sh"; then
    sudo "$INSTALL_DIR/uninstall.sh" --purge >/dev/null 2>&1
  else
    sudo systemctl disable --now "$SERVICE_NAME.service" >/dev/null 2>&1
    sudo rm -f "/etc/systemd/system/$SERVICE_NAME.service"
    sudo systemctl daemon-reload >/dev/null 2>&1
    sudo rm -rf "$INSTALL_DIR"
  fi
  docker ps -aq --filter label=moss.kind=user-container | xargs -r docker rm -f >/dev/null 2>&1
  docker ps -aq --filter name=moss-session- | xargs -r docker rm -f >/dev/null 2>&1
  docker image rm "$RUNTIME_IMAGE" >/dev/null 2>&1
  docker network rm "$NETWORK_NAME" >/dev/null 2>&1
  if [ -n "$MOCK_PID" ]; then kill "$MOCK_PID" >/dev/null 2>&1; fi
  sudo userdel -r "$TEST_USER" >/dev/null 2>&1
  sudo rm -rf "$TEST_HOME" "$OFFLINE_DIR"
}

finish() {
  status=$?
  trap - EXIT
  [ "$DIAGNOSTICS_COLLECTED" = 1 ] || collect_diagnostics
  cleanup
  exit "$status"
}
trap finish EXIT

for command_name in node curl docker systemctl sha256sum zip; do
  command -v "$command_name" >/dev/null 2>&1 || { echo "$command_name is required" >&2; exit 1; }
done
test -f "$DIST_DIR/install.sh"
test -f "$DIST_DIR/SHA256SUMS-$ARCH"
test -f "$DIST_DIR/$SERVER_ARCHIVE"
test -f "$DIST_DIR/$RUNTIME_ARCHIVE"

# A hosted runner is disposable, but keep cleanup narrowly scoped and fail if a
# foreign moss-server service is already present instead of deleting it.
if sudo systemctl cat "$SERVICE_NAME.service" >/dev/null 2>&1; then
  echo "$SERVICE_NAME.service already exists; refusing to overwrite it" >&2
  exit 1
fi
if id "$TEST_USER" >/dev/null 2>&1; then
  echo "test user already exists: $TEST_USER" >&2
  exit 1
fi

sudo useradd --create-home --home-dir "$TEST_HOME" --shell /bin/bash "$TEST_USER"
sudo install -d -m 0755 -o "$TEST_USER" -g "$TEST_USER" "$WORKSPACE_DIR"
mkdir -p "$OFFLINE_DIR"
cp "$DIST_DIR/install.sh" "$OFFLINE_DIR/install.sh"
cp "$DIST_DIR/SHA256SUMS-$ARCH" "$OFFLINE_DIR/SHA256SUMS"
cp "$DIST_DIR/$SERVER_ARCHIVE" "$DIST_DIR/$RUNTIME_ARCHIVE" "$OFFLINE_DIR/"
chmod 755 "$OFFLINE_DIR/install.sh"
(cd "$OFFLINE_DIR" && sha256sum -c SHA256SUMS)

# The image still exists from the build step. Remove it so the installer and
# all Docker session assertions can only pass with the image loaded from the
# final runtime tarball.
docker image rm "$RUNTIME_IMAGE" >/dev/null

docker network create "$NETWORK_NAME" >/dev/null
NETWORK_GATEWAY="$(docker network inspect -f '{{(index .IPAM.Config 0).Gateway}}' "$NETWORK_NAME")"
[ -n "$NETWORK_GATEWAY" ]

MOCK_URL_FILE="$DIAGNOSTICS_DIR/mock-url.txt"
MOCK_LOG_FILE="$DIAGNOSTICS_DIR/mock-llm-requests.jsonl"
node "$ROOT_DIR/scripts/e2e/mock-openai-server.mjs" \
  --host 0.0.0.0 \
  --port 0 \
  --api-key "$MOCK_API_KEY" \
  --log-file "$MOCK_LOG_FILE" \
  --url-file "$MOCK_URL_FILE" \
  > "$DIAGNOSTICS_DIR/mock-llm.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 100); do
  [ -s "$MOCK_URL_FILE" ] && break
  kill -0 "$MOCK_PID" >/dev/null 2>&1 || { cat "$DIAGNOSTICS_DIR/mock-llm.log" >&2; exit 1; }
  sleep 0.1
done
[ -s "$MOCK_URL_FILE" ] || { echo 'mock LLM did not become ready' >&2; exit 1; }
LOCAL_MOCK_URL="$(cat "$MOCK_URL_FILE")"
MOCK_PORT="${LOCAL_MOCK_URL##*:}"
MOCK_PORT="${MOCK_PORT%/v1}"
MOCK_URL="http://$NETWORK_GATEWAY:$MOCK_PORT/v1"
curl -fsS "http://127.0.0.1:$MOCK_PORT/healthz" >/dev/null
curl -fsS "http://$NETWORK_GATEWAY:$MOCK_PORT/healthz" >/dev/null

sudo env \
  MOSS_NON_INTERACTIVE=1 \
  MOSS_INSTALL_USER="$TEST_USER" \
  MOSS_PORT="$PORT" \
  MOSS_ADVERTISED_HOST=127.0.0.1 \
  MOSS_ADMIN_USERNAME="$ADMIN_USERNAME" \
  MOSS_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  ANTHROPIC_BASE_URL="$MOCK_URL" \
  ANTHROPIC_API_KEY="$MOCK_API_KEY" \
  "$OFFLINE_DIR/install.sh" --offline

# Keep model discovery and the agent/skill Hub hermetic too. Session runners
# inherit these settings from moss-server, while both host and Docker scode use
# ANTHROPIC_BASE_URL above.
printf 'MOSS_MODEL_LIST_URL=http://127.0.0.1:%s/api/specific_pricing\nMOSS_HUB_API_BASE_URL=http://127.0.0.1:%s\nANTHROPIC_API_KEY=%s\n' \
  "$MOCK_PORT" "$MOCK_PORT" "$MOCK_API_KEY" \
  | sudo tee -a "$INSTALL_DIR/moss-server.env" >/dev/null
sudo systemctl restart "$SERVICE_NAME.service"
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$PORT/readyz" >/dev/null 2>&1 && break
  sleep 1
done

test "$INSTALL_DIR" = "$(getent passwd "$TEST_USER" | awk -F: '{print $6}')/.moss/server"
sudo systemctl is-enabled --quiet "$SERVICE_NAME.service"
sudo systemctl is-active --quiet "$SERVICE_NAME.service"
sudo systemctl show "$SERVICE_NAME.service" -p ExecStart --value | grep -Fq "$INSTALL_DIR/current/node/bin/node $INSTALL_DIR/current/app/bin/moss-server.mjs start"
curl -fsS "http://127.0.0.1:$PORT/healthz" | grep -Fq '"ready":true'
curl -fsS "http://127.0.0.1:$PORT/readyz" | grep -Fq '"ready":true'
test "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/admin/")" = 200
HOST_SCODE_VERSION="$(sudo -u "$TEST_USER" "$INSTALL_DIR/current/app/bin/scode" --version 2>&1)"
docker run --rm --network "$NETWORK_NAME" "$RUNTIME_IMAGE" \
  sh -c "curl -fsS http://$NETWORK_GATEWAY:$MOCK_PORT/healthz >/dev/null && scode --version" \
  > "$DIAGNOSTICS_DIR/runtime-scode-version.txt"
printf '%s\n' "$HOST_SCODE_VERSION" > "$DIAGNOSTICS_DIR/host-scode-version.txt"
if [ -n "$SCODE_VERSION" ]; then
  grep -Fq "${SCODE_VERSION#v}" "$DIAGNOSTICS_DIR/host-scode-version.txt"
  grep -Fq "${SCODE_VERSION#v}" "$DIAGNOSTICS_DIR/runtime-scode-version.txt"
fi

node "$ROOT_DIR/scripts/e2e/server-release-smoke.mjs" \
  --base-url "http://127.0.0.1:$PORT" \
  --username "$ADMIN_USERNAME" \
  --password "$ADMIN_PASSWORD" \
  --output-dir "$DIAGNOSTICS_DIR" \
  --runtimes host,docker \
  --timeout-seconds 180

sudo "$INSTALL_DIR/current/node/bin/node" "$ROOT_DIR/scripts/e2e/server-admin-browser-smoke.mjs" \
  --base-url "http://127.0.0.1:$PORT" \
  --username "$ADMIN_USERNAME" \
  --password "$ADMIN_PASSWORD" \
  --summary-file "$DIAGNOSTICS_DIR/e2e-summary.json" \
  --output-dir "$DIAGNOSTICS_DIR" \
  --timeout-seconds 60

grep -Fq 'MOSS_E2E_OK:MOSS_E2E_TOKEN_host_' "$MOCK_LOG_FILE"
grep -Fq 'MOSS_E2E_OK:MOSS_E2E_TOKEN_docker_' "$MOCK_LOG_FILE"
grep -Fq '"path":"/api/assistants/cursor"' "$MOCK_LOG_FILE"
grep -Fq '"path":"/api/skills/cursor"' "$MOCK_LOG_FILE"
USER_CONTAINER="$(docker ps --filter label=moss.kind=user-container --format '{{.Names}}' | head -n 1)"
[ -n "$USER_CONTAINER" ]
SCODE_STOPPED=0
for _ in $(seq 1 60); do
  if docker exec "$USER_CONTAINER" sh -c '\
      for process in /proc/[0-9]*; do \
        [ "$(cat "$process/comm" 2>/dev/null || true)" != scode ] || exit 1; \
      done' \
    && ! pgrep -u "$TEST_USER" -x scode >/dev/null; then
    SCODE_STOPPED=1
    break
  fi
  sleep 0.5
done
[ "$SCODE_STOPPED" = 1 ]

UPGRADE_OUTPUT="$(sudo env MOSS_INSTALL_USER="$TEST_USER" MOSS_INSTALL_DIR="$INSTALL_DIR" \
  "$OFFLINE_DIR/install.sh" --upgrade --offline)"
printf '%s\n' "$UPGRADE_OUTPUT" | tee "$DIAGNOSTICS_DIR/same-version-upgrade.log"
grep -Fq 'already installed; no downloads needed' <<< "$UPGRADE_OUTPUT"
test -f "$OFFLINE_DIR/$SERVER_ARCHIVE"
test -f "$OFFLINE_DIR/$RUNTIME_ARCHIVE"

OLD_PID="$(sudo systemctl show "$SERVICE_NAME.service" -p MainPID --value)"
sudo systemctl stop "$SERVICE_NAME.service"
test "$(sudo systemctl is-active "$SERVICE_NAME.service" || true)" = inactive
if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  echo 'health endpoint remained available after service stop' >&2
  exit 1
fi
sudo systemctl start "$SERVICE_NAME.service"
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$PORT/readyz" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/readyz" >/dev/null
START_PID="$(sudo systemctl show "$SERVICE_NAME.service" -p MainPID --value)"
sudo systemctl restart "$SERVICE_NAME.service"
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$PORT/readyz" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/readyz" >/dev/null
RESTART_PID="$(sudo systemctl show "$SERVICE_NAME.service" -p MainPID --value)"
[ "$OLD_PID" != "$START_PID" ]
[ "$START_PID" != "$RESTART_PID" ]

collect_diagnostics
sudo "$INSTALL_DIR/uninstall.sh" --purge
! sudo test -e "$INSTALL_DIR"
! sudo systemctl cat "$SERVICE_NAME.service" >/dev/null 2>&1
! docker ps -aq --filter label=moss.kind=user-container | grep -q .
docker image rm "$RUNTIME_IMAGE" >/dev/null
docker network rm "$NETWORK_NAME" >/dev/null 2>&1 || true
! docker image inspect "$RUNTIME_IMAGE" >/dev/null 2>&1

printf '{"ok":true,"version":"%s","arch":"%s","hostSession":true,"dockerSession":true,"browserUi":true,"agentHub":true,"skillStore":true,"credentials":true,"lifecycle":true}\n' \
  "$VERSION" "$ARCH" > "$DIAGNOSTICS_DIR/release-smoke-result.json"

node - "$DIAGNOSTICS_DIR" "$VERSION" "$ARCH" "$SCODE_VERSION" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [diagnosticsDir, version, arch, scodeVersion] = process.argv.slice(2)
const sessions = JSON.parse(fs.readFileSync(path.join(diagnosticsDir, 'e2e-summary.json'), 'utf8'))
const browser = JSON.parse(fs.readFileSync(path.join(diagnosticsDir, 'browser-e2e-summary.json'), 'utf8'))
const runtime = name => sessions.runtimes.find(item => item.runtime === name)
const resultRows = [
  ['离线安装、校验和、Docker 镜像加载', '✅'],
  ['浏览器表单登录', '✅'],
  [`浏览器创建用户 \`${browser.createdUser}\``, '✅'],
  ['智能体管理（Hub 数据、页签切换）', '✅'],
  ['技能商店（Hub 数据、页签切换）', '✅'],
  ['凭据配置（模板表单、服务器凭据脱敏）', '✅'],
  [`host 会话聊天 \`${runtime('host').sessionId}\``, '✅'],
  [`Docker 会话聊天 \`${runtime('docker').sessionId}\``, '✅'],
  ['同版本升级不下载', '✅'],
  ['systemd 停止、启动、重启', '✅'],
  ['卸载并清理数据、容器、镜像', '✅'],
]
const summaryLines = [
  `**版本：** \`${version}-${arch}\``,
  '',
  '| 验证项 | 结果 |',
  '| --- | --- |',
  ...resultRows.map(([name, result]) => `| ${name} | ${result} |`),
  '',
  '**浏览器截图：**',
  '',
  '- 下载 artifact 后打开 `browser-evidence.html` 可一次查看全部截图。',
  ...browser.screenshots.map(item => `- \`${item.file}\`（${item.width}×${item.height}）`),
]
fs.writeFileSync(path.join(diagnosticsDir, 'ci-summary.md'), `${summaryLines.join('\n')}\n`)

const reportLines = [
    '# Moss Server E2E 测试报告',
    '',
    '> 结论：✅ 最终 Server 安装包通过离线安装、host/Docker 会话、智能体、技能商店、凭据配置、真实浏览器管理操作、升级、服务生命周期和卸载验证。',
    '',
    '此 ZIP 是 Release 中唯一的 E2E 验证入口。直接打开本文件即可查看结论和全部截图；原始可复核数据位于 `evidence/`。',
    '',
    '## 测试对象',
    '',
    '| 项目 | 值 |',
    '| --- | --- |',
    `| Server | \`${version}-${arch}\` |`,
    `| scode | \`${scodeVersion || '未指定'}\` |`,
    `| Commit | \`${process.env.GITHUB_SHA || 'local'}\` |`,
    `| 管理端测试用户 | \`${browser.createdUser}\` |`,
    '',
    '## 测试结论',
    '',
    '| 验证项 | 结果 |',
    '| --- | --- |',
    ...resultRows.map(([name, result]) => `| ${name} | ${result} |`),
    '',
    '## 浏览器操作断言',
    '',
    ...browser.assertions.map(item => `- ${item.ok ? '✅' : '❌'} ${item.name}`),
    '',
    '## 浏览器截图',
    '',
    ...browser.screenshots.flatMap((item, index) => [
      `### ${index + 1}. ${path.basename(item.file, '.png')}`,
      '',
      `页面：\`${item.path}\`　尺寸：\`${item.width}×${item.height}\``,
      '',
      `![${path.basename(item.file)}](${item.file})`,
      '',
    ]),
    '## 可复核数据',
    '',
    `- host Session ID：\`${runtime('host').sessionId}\``,
    `- host Mock 回复：\`${runtime('host').response}\``,
    `- Docker Session ID：\`${runtime('docker').sessionId}\``,
    `- Docker Mock 回复：\`${runtime('docker').response}\``,
    '- `evidence/e2e-summary.json`：会话结果。',
    '- `evidence/browser-e2e-summary.json`：浏览器断言和截图清单。',
    '- `evidence/release-smoke-result.json`：整体验证结果。',
    '- `evidence/host-scode-version.txt`、`runtime-scode-version.txt`：两种运行时版本。',
    '- `evidence/same-version-upgrade.log`：同版本升级不下载的日志。',
    '- `SHA256SUMS`：压缩包内所有证据文件的校验和。',
]
fs.writeFileSync(path.join(diagnosticsDir, 'e2e-report.md'), `${reportLines.join('\n')}\n`)

const escapeHtml = value => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;')
const checkRows = resultRows.map(([name, result]) =>
  `<tr><td>${escapeHtml(name.replaceAll('`', ''))}</td><td class="result">${result}</td></tr>`,
).join('\n')
const assertionRows = browser.assertions.map(item =>
  `<li><span class="pass">${item.ok ? '通过' : '失败'}</span>${escapeHtml(item.name)}</li>`,
).join('\n')
const screenshotCards = browser.screenshots.map((item, index) => `
<figure id="screenshot-${index + 1}">
  <figcaption><strong>${index + 1}. ${escapeHtml(path.basename(item.file, '.png'))}</strong><span>${escapeHtml(item.path)} · ${item.width}×${item.height}</span></figcaption>
  <a href="${escapeHtml(item.file)}"><img loading="lazy" src="${escapeHtml(item.file)}" alt="${escapeHtml(path.basename(item.file))}"></a>
</figure>`).join('\n')
const htmlReport = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Moss Server ${escapeHtml(version)} E2E 测试报告</title>
  <style>
    :root{color-scheme:light;--ink:#172033;--muted:#64748b;--line:#dbe2ea;--panel:#fff;--bg:#f4f7fb;--ok:#08783e}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 system-ui,-apple-system,"Segoe UI","Noto Sans CJK SC",sans-serif}
    main{max-width:1480px;margin:0 auto;padding:32px}.hero,.section,figure{background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:0 4px 18px #1e293b0d}
    .hero{padding:28px;margin-bottom:24px}.hero h1{margin:0 0 10px}.verdict{padding:14px 18px;border-radius:10px;background:#eaf8ef;color:var(--ok);font-weight:700}
    .section{padding:24px;margin:24px 0}h2{margin-top:0}table{width:100%;border-collapse:collapse}th,td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left}.result,.pass{color:var(--ok);font-weight:700}
    code{background:#eef2f7;padding:2px 6px;border-radius:5px;overflow-wrap:anywhere}ul{padding-left:22px}li{margin:7px 0}.pass{display:inline-block;margin-right:9px}
    figure{margin:24px 0;padding:16px}figcaption{display:flex;justify-content:space-between;gap:16px;margin-bottom:12px}figcaption span{color:var(--muted);font-family:ui-monospace,monospace;font-size:13px}
    img{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:8px}a{color:#0755b5}footer{color:var(--muted);margin-top:24px}
    @media(max-width:700px){main{padding:14px}.hero,.section,figure{padding:14px}figcaption{display:block}figcaption span{display:block;margin-top:4px}}
  </style>
</head>
<body><main>
  <section class="hero"><h1>Moss Server E2E 测试报告</h1><div class="verdict">✓ 最终安装包全链路验证通过</div></section>
  <section class="section"><h2>测试对象</h2><table><tbody>
    <tr><th>Server</th><td><code>${escapeHtml(`${version}-${arch}`)}</code></td></tr>
    <tr><th>scode</th><td><code>${escapeHtml(scodeVersion || '未指定')}</code></td></tr>
    <tr><th>Commit</th><td><code>${escapeHtml(process.env.GITHUB_SHA || 'local')}</code></td></tr>
    <tr><th>管理端测试用户</th><td><code>${escapeHtml(browser.createdUser)}</code></td></tr>
  </tbody></table></section>
  <section class="section"><h2>测试结论</h2><table><thead><tr><th>验证项</th><th>结果</th></tr></thead><tbody>${checkRows}</tbody></table></section>
  <section class="section"><h2>浏览器操作断言</h2><ul>${assertionRows}</ul></section>
  <section><h2>浏览器截图</h2>${screenshotCards}</section>
  <section class="section"><h2>可复核数据</h2><ul>
    <li>host Session ID：<code>${escapeHtml(runtime('host').sessionId)}</code></li>
    <li>host Mock 回复：<code>${escapeHtml(runtime('host').response)}</code></li>
    <li>Docker Session ID：<code>${escapeHtml(runtime('docker').sessionId)}</code></li>
    <li>Docker Mock 回复：<code>${escapeHtml(runtime('docker').response)}</code></li>
    <li><a href="evidence/e2e-summary.json">会话结果 JSON</a></li>
    <li><a href="evidence/browser-e2e-summary.json">浏览器断言 JSON</a></li>
    <li><a href="evidence/release-smoke-result.json">整体验证结果 JSON</a></li>
    <li><a href="evidence/same-version-upgrade.log">同版本升级日志</a></li>
    <li><a href="SHA256SUMS">内部文件 SHA256</a></li>
  </ul></section>
  <footer>同目录的 README.md 提供等价 Markdown 版本。</footer>
</main></body></html>\n`
fs.writeFileSync(path.join(diagnosticsDir, 'e2e-report.html'), htmlReport)
NODE

EVIDENCE_NAME="moss-server-e2e-report-$VERSION-$ARCH"
EVIDENCE_ROOT="$(mktemp -d)"
EVIDENCE_DIR="$EVIDENCE_ROOT/$EVIDENCE_NAME"
mkdir -p "$EVIDENCE_DIR/screenshots" "$EVIDENCE_DIR/evidence"
cp "$DIAGNOSTICS_DIR/e2e-report.md" "$EVIDENCE_DIR/README.md"
cp "$DIAGNOSTICS_DIR/e2e-report.html" "$EVIDENCE_DIR/index.html"
cp "$DIAGNOSTICS_DIR/e2e-summary.json" \
  "$DIAGNOSTICS_DIR/browser-e2e-summary.json" \
  "$DIAGNOSTICS_DIR/release-smoke-result.json" \
  "$DIAGNOSTICS_DIR/host-scode-version.txt" \
  "$DIAGNOSTICS_DIR/runtime-scode-version.txt" \
  "$DIAGNOSTICS_DIR/same-version-upgrade.log" \
  "$EVIDENCE_DIR/evidence/"
cp "$DIAGNOSTICS_DIR/screenshots/"*.png "$EVIDENCE_DIR/screenshots/"
(
  cd "$EVIDENCE_DIR"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
)
(
  cd "$EVIDENCE_ROOT"
  zip -q -r "$DIST_DIR/$EVIDENCE_NAME.zip" "$EVIDENCE_NAME"
)
rm -rf "$EVIDENCE_ROOT"
echo "Moss Server packaged E2E smoke passed: $VERSION-$ARCH"
