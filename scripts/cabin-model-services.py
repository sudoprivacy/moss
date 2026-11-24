#!/usr/bin/env python3
"""Prepare reviewable MLX LaunchAgents; never execute deployment commands.

Python 3.8+, standard library only. See docs/cabin_model_services_deployment.md.
"""

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shlex
import sys
from xml.parsers.expat import ExpatError


LLM = "com.comac.mlx-lm"
AUDIO = "com.comac.mlx-audio"
UPSTREAM = "http://host.docker.internal:8005"
OLD_UPSTREAM = "http://host.docker.internal:8004"
DEFAULT_ROOT = Path.home() / "models-docker-mac"
GATEWAY = Path(__file__).resolve().with_name("cabin-tts-server.py")
VERIFY_BUNDLE = b'''#!/usr/bin/env python3
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent
manifest = json.loads((root / "manifest.json").read_text())
for name, expected in manifest["artifacts"].items():
    path = root / name
    if path.is_symlink() or not path.is_file() or root not in path.resolve().parents:
        raise SystemExit("invalid artifact: " + name)
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise SystemExit("SHA-256 mismatch: " + name)
print("Bundle SHA-256 verification passed")
'''
GATEWAY_FILE = b'''#!/usr/bin/env python3
"""Explicit file-only install/check/remove; never manages a process or service."""
import hashlib
import json
import os
from pathlib import Path
import sys

root = Path(__file__).resolve().parent
runtime = json.loads((root / "manifest.json").read_text())["tts_runtime"]
if len(sys.argv) != 3 or sys.argv[1] not in ("install", "check", "remove"):
    raise SystemExit("usage: gateway-file.py install|check|remove ABSOLUTE_INSTALLED_SCRIPT")
action, target = sys.argv[1], Path(sys.argv[2])
if runtime["mode"] != "script" or str(target) != runtime["script"] or not target.is_absolute():
    raise SystemExit("target must equal the absolute gateway path in manifest")
payload = (root / "payload/cabin-tts-server.py").read_bytes()
expected = runtime["sha256"]
if hashlib.sha256(payload).hexdigest() != expected:
    raise SystemExit("gateway payload SHA-256 mismatch")
backup = root / "live-backup"
marker = backup / "gateway-created.json"
if not (backup / "complete").is_file():
    raise SystemExit("complete live-backup required")
if action == "install":
    if marker.exists():
        raise SystemExit("ownership record exists; refusing to reinstall")
    # Exclusive create refuses both existing files and symlinks. No directory is created.
    with target.open("xb") as stream:
        os.chmod(stream.fileno(), 0o600)
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
        info = os.fstat(stream.fileno())
        record = {"path": str(target), "sha256": expected, "device": info.st_dev, "inode": info.st_ino}
        with marker.open("x") as audit:
            os.chmod(audit.fileno(), 0o600)
            json.dump(record, audit)
    print("Installed gateway file: " + str(target))
else:
    if not marker.exists():
        print("No file owned by this bundle; nothing removed")
        raise SystemExit(0)
    record = json.loads(marker.read_text())
    if record["path"] != str(target) or record["sha256"] != expected:
        raise SystemExit("ownership record does not match this bundle")
    if target.exists() or target.is_symlink():
        info = target.lstat()
        if (target.is_symlink() or (info.st_dev, info.st_ino) != (record["device"], record["inode"])
                or hashlib.sha256(target.read_bytes()).hexdigest() != expected):
            raise SystemExit("installed gateway changed; refusing to remove someone else's file")
        if action == "remove":
            target.unlink()
    print("Gateway ownership verified: " + action)
'''


class PrepareError(ValueError):
    pass


def option(args, name, replacement=None, required=False):
    """Edit one option in place, retaining every unrelated argv entry and order."""
    positions = [i for i, value in enumerate(args)
                 if value == name or value.startswith(name + "=")]
    if len(positions) > 1:
        raise PrepareError("duplicate option: " + name)
    if not positions:
        if required:
            raise PrepareError("missing option: " + name)
        if replacement is not None:
            args.extend([name, replacement])
        return None
    index = positions[0]
    inline = args[index].startswith(name + "=")
    if inline:
        value = args[index].split("=", 1)[1]
    else:
        if index + 1 >= len(args) or args[index + 1].startswith("--"):
            raise PrepareError("missing value: " + name)
        value = args[index + 1]
    if not value:
        raise PrepareError("empty value: " + name)
    if replacement is not None:
        if inline:
            args[index] = name + "=" + replacement
        else:
            args[index + 1] = replacement
    return value


def load_agent(path, label):
    raw = path.read_bytes()
    agent = plistlib.loads(raw)
    if not isinstance(agent, dict) or agent.get("Label") != label:
        raise PrepareError("unexpected Label in " + str(path))
    args = agent.get("ProgramArguments")
    if not isinstance(args, list) or not args or not all(isinstance(v, str) for v in args):
        raise PrepareError("ProgramArguments must be a nonempty string array: " + str(path))
    for key, value in (("executable", args[0]),
                       ("WorkingDirectory", agent.get("WorkingDirectory", ""))):
        if not isinstance(value, str) or not Path(value).is_absolute():
            raise PrepareError(key + " must be absolute: " + str(path))
    return raw, agent


def scalar(value, model_home=False):
    """Conservative YAML scalar reader, not a general YAML parser."""
    value = value.strip()
    if value.startswith('"'):
        match = re.fullmatch(r'("(?:[^"\\]|\\.)*")\s*(?:#.*)?', value)
        if not match:
            raise PrepareError("unsupported quoted compose scalar")
        return json.loads(match[1])
    if value.startswith("'"):
        match = re.fullmatch(r"'((?:[^']|'')*)'\s*(?:#.*)?", value)
        if not match:
            raise PrepareError("unsupported quoted compose scalar")
        return match[1].replace("''", "'")
    value = re.split(r"\s+#", value, maxsplit=1)[0].strip()
    checked = value.replace("${MODEL_HOME}", "MODEL_HOME") if model_home else value
    if not value or any(c in checked for c in "${}[]&*!|>\\\""):
        raise PrepareError("unsupported or interpolated compose scalar")
    return value


def proxy_service(text, model_values=None):
    """Identify a literal UPSTREAM_URL in a simple block-style services map.

    Refuse unsupported YAML constructs instead of pretending to parse full YAML.
    Docker Compose itself remains the authority at manual deployment preflight.
    """
    if "\t" in text:
        raise PrepareError("compose tabs are unsupported; use space indentation")
    lines = []
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        # Includes/merges/anchors could change effective environment or services.
        if re.search(r"(^|\s)[&*][\w-]+|^\s*<<\s*:|^include\s*:", raw):
            raise PrepareError("compose anchors, aliases, merges and include are unsupported")
        lines.append((len(raw) - len(raw.lstrip()), raw.strip()))
    starts = [i for i, (indent, line) in enumerate(lines)
              if indent == 0 and re.fullmatch(r"(?:services|'services'|\"services\"):\s*(?:#.*)?", line)]
    if len(starts) != 1:
        raise PrepareError("compose must contain one block-style services mapping")
    body = []
    for item in lines[starts[0] + 1:]:
        if item[0] == 0:
            break
        body.append(item)
    if not body:
        raise PrepareError("compose services is empty")
    service_indent = body[0][0]
    services = {}
    current = None
    for indent, line in body:
        if indent == service_indent:
            match = re.fullmatch(r"([A-Za-z0-9_.-]+|\"[A-Za-z0-9_.-]+\"|'[A-Za-z0-9_.-]+'):\s*(?:#.*)?", line)
            if not match:
                raise PrepareError("unsupported compose service declaration")
            current = scalar(match[1])
            if current in services:
                raise PrepareError("duplicate compose service: " + current)
            services[current] = []
        elif current is None or indent < service_indent:
            raise PrepareError("invalid compose services indentation")
        else:
            services[current].append((indent, line))
    candidates = []
    for name, block in services.items():
        if not block:
            continue
        field_indent = min(i for i, _ in block)
        seen_fields = set()
        env_indent = None
        env_child_indent = None
        upstreams = []
        for indent, line in block:
            if indent == field_indent:
                key = line.split(":", 1)[0].strip("'\"")
                if key in seen_fields:
                    raise PrepareError("duplicate compose service field: " + key)
                seen_fields.add(key)
                env_indent = None
                env_child_indent = None
                if key in ("extends", "env_file"):
                    raise PrepareError("compose extends/env_file is unsupported; supply a literal reviewed compose")
                if key == "environment":
                    if not re.fullmatch(r"(?:environment|'environment'|\"environment\"):\s*(?:#.*)?", line):
                        raise PrepareError("compose environment must be block-style")
                    env_indent = indent
            elif env_indent is not None and indent > env_indent:
                if env_child_indent is None:
                    env_child_indent = indent
                if indent != env_child_indent:
                    raise PrepareError("nested/multiline compose environment is unsupported")
                if line.startswith("-"):
                    item = scalar(line[1:], model_home=True)
                    if item == "UPSTREAM_URL" or item.startswith("UPSTREAM_URL="):
                        if "=" not in item:
                            raise PrepareError("UPSTREAM_URL must be literal, not inherited")
                        upstreams.append(item.split("=", 1)[1])
                    if model_values is not None and "=" in item:
                        key, value = item.split("=", 1)
                        if key in ("DEFAULT_MODELS", "AUDIO_TTS_MODEL"):
                            model_values.setdefault(key, set()).add(value)
                else:
                    match = re.match(r"(?:UPSTREAM_URL|'UPSTREAM_URL'|\"UPSTREAM_URL\"):\s*(.*)$", line)
                    if match:
                        upstreams.append(scalar(match[1]))
                    if model_values is not None:
                        match = re.match(r"(?:([A-Z_]+)|'([A-Z_]+)'|\"([A-Z_]+)\"):\s*(.*)$", line)
                        if match:
                            key = match[1] or match[2] or match[3]
                            if key in ("DEFAULT_MODELS", "AUDIO_TTS_MODEL"):
                                model_values.setdefault(key, set()).add(scalar(match[4], model_home=True))
        if len(upstreams) > 1:
            raise PrepareError("duplicate UPSTREAM_URL in service " + name)
        if upstreams and upstreams[0] == OLD_UPSTREAM:
            candidates.append(name)
        elif upstreams and ("$" in upstreams[0] or upstreams[0] == UPSTREAM):
            raise PrepareError("UPSTREAM_URL is interpolated or already migrated in " + name)
    if len(candidates) != 1:
        raise PrepareError("expected exactly one service with literal UPSTREAM_URL="
                           + OLD_UPSTREAM + "; found " + str(len(candidates)))
    return candidates[0]


def override(service, url):
    # JSON strings are valid YAML quoted scalars. Only the discovered service is emitted.
    return 'services:\n  ' + json.dumps(service) + ':\n    environment:\n      UPSTREAM_URL: ' + json.dumps(url) + '\n'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def absolute_target(value, description):
    if not Path(value).is_absolute() or any(c in value for c in "\n\r\0"):
        raise PrepareError(description + " must be an absolute, single-line path")
    return value


def tts_model_path(args, root, llm, model_values):
    if args.tts_model:
        return absolute_target(args.tts_model, "--tts-model")
    values = model_values.get("AUDIO_TTS_MODEL", set())
    if len(values) != 1:
        raise PrepareError("cannot identify actual AUDIO_TTS_MODEL; provide --tts-model")
    value = next(iter(values))
    if value.startswith("/") and "$" not in value:
        return absolute_target(value, "AUDIO_TTS_MODEL")
    defaults = model_values.get("DEFAULT_MODELS", set())
    prefix = "${MODEL_HOME}/"
    if not value.startswith(prefix) or len(defaults) != 1 or not next(iter(defaults)).startswith(prefix):
        raise PrepareError("cannot resolve MODEL_HOME from snapshot; provide --tts-model")
    tts_suffix, llm_suffix = value[len(prefix):], next(iter(defaults))[len(prefix):]
    for suffix in (tts_suffix, llm_suffix):
        if not suffix or any(part in ("", ".", "..") for part in suffix.split("/")) or "$" in suffix:
            raise PrepareError("unsupported snapshot model path; provide --tts-model")
    llm_model = option(llm["ProgramArguments"], "--model", required=True)
    if not llm_model.startswith("/") or not llm_model.endswith("/" + llm_suffix):
        raise PrepareError("snapshot DEFAULT_MODELS does not match LLM model; provide --tts-model")
    config = root / "models" / tts_suffix / "config.json"
    if not config.is_file() or json.loads(config.read_text()).get("model_type") != "qwen3_tts":
        raise PrepareError("TTS model is not corroborated by snapshot config; provide --tts-model")
    return absolute_target(llm_model[:-len(llm_suffix)] + tts_suffix, "resolved TTS model")


def tts_candidate(audio, args, root, llm, model_values):
    tts = copy.deepcopy(audio)
    source = Path(args.tts_server_script or GATEWAY).expanduser().resolve()
    if not source.is_file():
        raise PrepareError("TTS gateway source not found: " + str(source))
    payload = source.read_bytes()
    if not payload:
        raise PrepareError("TTS gateway script is empty: " + str(source))
    model = tts_model_path(args, root, llm, model_values)
    script = absolute_target(args.tts_script_target or str(
        Path(audio["WorkingDirectory"]) / ("cabin-tts-server." + digest(payload)[:12] + ".py")),
        "--tts-script-target")
    executable = absolute_target(audio.get("Program", audio["ProgramArguments"][0]),
                                 "original audio executable")
    if Path(executable).parent.name != "bin":
        raise PrepareError("cannot locate existing venv/bin/python from original audio executable")
    # Keep the lexical venv path: resolving a Python symlink can bypass the venv.
    python = str(Path(executable).parent / "python")
    tts["ProgramArguments"] = [python, script, "--model", model,
                               "--host", "0.0.0.0", "--port", "8004"]
    if "Program" in tts:
        tts["Program"] = python  # launchd Program takes precedence over argv[0].
    return tts, {"mode": "script", "script": script, "python": python, "model": model,
                 "source": str(source), "sha256": digest(payload)}, payload


def deployment_plan(output, llm, audio, asr, tts_runtime, compose_target, agents_target, service):
    q = shlex.quote
    agents_assignment = q(agents_target) if agents_target else '"$HOME/Library/LaunchAgents"'
    llm_exe = llm.get("Program", llm["ProgramArguments"][0])
    audio_exe = audio.get("Program", audio["ProgramArguments"][0])
    llm_port = option(llm["ProgramArguments"], "--port", required=True)
    log_dirs = sorted({str(Path(asr[key]).parent)
                       for key in ("StandardOutPath", "StandardErrorPath")})
    tts_description = ("TTS 保留原 Label/8004/日志/环境，以现有 venv/python 运行显式指定脚本和模型；\n"
                           "不注入原生 batch 环境变量。脚本负责单进程/单 worker/串行生成及 seed 管理，\n"
                           "本工具不验证这些运行行为，也不承诺正温度跨语言确定性。")
    tts_checks = "\n".join(("test -x " + q(tts_runtime["python"]),
                                'test ! -e "$TTS_SCRIPT"', 'test ! -L "$TTS_SCRIPT"',
                                "test -d " + q(str(Path(tts_runtime["script"]).parent)),
                                "test -d " + q(tts_runtime["model"])))
    tts_assignment = "TTS_SCRIPT=" + q(tts_runtime["script"])
    gateway_install = 'python3 "$BUNDLE/verify-bundle.py"\npython3 "$BUNDLE/gateway-file.py" install "$TTS_SCRIPT"'
    gateway_check = 'python3 "$BUNDLE/gateway-file.py" check "$TTS_SCRIPT"'
    gateway_remove = 'python3 "$BUNDLE/gateway-file.py" remove "$TTS_SCRIPT"'
    return f'''# 手动部署计划（prepare 未执行以下命令）

必须在目标 Mac 的 LaunchAgent 所属用户图形登录会话中执行，不用 sudo。
先停业务流量，逐段执行和验收；不是无人值守安装脚本。LLM 重启会清空内存缓存。
独立 ASR 只隔离 audio broker/进程，仍共享 GPU、统一内存与带宽，不保证提速。
{tts_description}
新 ASR 使用原通用 audio server，不是 ASR 专用二进制；不额外注入 TTS batch 环境变量。

## 1. 路径与部署前检查

将整个产物目录复制到目标 Mac，按实际位置修改 BUNDLE。下列目标路径不是快照路径。
确认 BASE 是当前生产 compose，现有启动方式若有额外 -f、--env-file、-p 或 profiles，
须在下面所有 compose 命令中保留同一组参数及顺序，再把本次 override 放在最后。
不要切换 Compose 项目名。先核对 `docker compose ls` 与现有容器标签。

```sh
set -eu
BUNDLE={q(str(output))}
BASE={q(compose_target)}
AGENTS={agents_assignment}
DOMAIN="gui/$(id -u)"
LLM={q(LLM)}
TTS={q(AUDIO)}
{tts_assignment}
ASR={q(asr['Label'])}
PROXY={q(service)}
BACKUP="$BUNDLE/live-backup"
test "$(uname -s)" = Darwin
test -d "$AGENTS"
python3 "$BUNDLE/verify-bundle.py"
test -x {q(llm_exe)}
test -x {q(audio_exe)}
{tts_checks}
test -d {q(llm['WorkingDirectory'])}
test -d {q(audio['WorkingDirectory'])}
{chr(10).join('test -d ' + q(directory) for directory in log_dirs)}
test ! -L "$AGENTS/$LLM.plist"
test ! -L "$AGENTS/$TTS.plist"
cmp "$AGENTS/$LLM.plist" "$BUNDLE/backup/$LLM.plist"
cmp "$AGENTS/{AUDIO}.plist" "$BUNDLE/backup/{AUDIO}.plist"
cmp "$BASE" "$BUNDLE/backup/docker-compose.yml"
test ! -e "$AGENTS/$ASR.plist"
test ! -L "$AGENTS/$ASR.plist"
if launchctl print "$DOMAIN/$ASR" >/dev/null 2>&1; then
  echo 'ASR Label 已存在；停止并重新评审' >&2
  exit 1
fi
launchctl print "$DOMAIN/$LLM"
launchctl print "$DOMAIN/{AUDIO}"
plutil -lint "$BUNDLE/prepared/$LLM.plist" "$BUNDLE/prepared/$TTS.plist" "$BUNDLE/prepared/$ASR.plist"
docker compose -f "$BASE" config --services
docker compose -f "$BASE" -f "$BUNDLE/compose.asr-8005.override.yml" config
```

任一检查不通过就停止。cmp 不同表示快照已过期；从目标 Mac 重新收集文件后 prepare。
检查模型路径和 CLI `--help` 是否支持缓存参数；prepare 不探测远端可执行文件或模型。
检查 {llm_port}/8004 的现有监听归属；8005 必须空闲（同时检查 IPv4/IPv6）：

```sh
lsof -nP -iTCP:{llm_port} -iTCP:8004 -iTCP:8005 -sTCP:LISTEN
python3 - <<'PY'
import socket
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as ipv4:
    ipv4.bind(('0.0.0.0', 8005))
    with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as ipv6:
        ipv6.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        ipv6.bind(('::', 8005))
print('8005 IPv4/IPv6 bind 检查通过；启动前仍可能发生端口竞争')
PY
```

bind 失败、权限不足或无法确认端口归属时停止。此结果只是检查时刻的空闲状态。

## 2. 备份现场（先于任何修改）

```sh
umask 077
mkdir "$BACKUP"
cp -p "$AGENTS/$LLM.plist" "$BACKUP/$LLM.plist"
cp -p "$AGENTS/{AUDIO}.plist" "$BACKUP/{AUDIO}.plist"
cp -p "$BASE" "$BACKUP/docker-compose.yml"
docker compose -f "$BASE" config > "$BACKUP/compose.effective.before.yml"
docker compose -f "$BASE" ps > "$BACKUP/compose.ps.before.txt"
touch "$BACKUP/complete"
```

BACKUP 必须是新的目录；存在就停止，不覆盖旧备份。backup/ 是输入快照，live-backup/
才是现场回退依据。当前 ASR Label/文件必须不存在，因此回退删除本次新文件。
配置可能含凭据，保护备份权限。原 compose 不改写；TTS 原文件完整保存在备份中。

## 3. 应用 LaunchAgents，验收后再切代理

```sh
test -f "$BACKUP/complete"
{gateway_install}
launchctl bootout "$DOMAIN/$LLM"
cp "$BUNDLE/prepared/$LLM.plist" "$AGENTS/$LLM.plist"
chmod 600 "$AGENTS/$LLM.plist"
launchctl bootstrap "$DOMAIN" "$AGENTS/$LLM.plist"
launchctl bootout "$DOMAIN/$TTS"
cp "$BUNDLE/prepared/$TTS.plist" "$AGENTS/$TTS.plist"
chmod 600 "$AGENTS/$TTS.plist"
launchctl bootstrap "$DOMAIN" "$AGENTS/$TTS.plist"
cp "$BUNDLE/prepared/$ASR.plist" "$AGENTS/$ASR.plist"
chmod 600 "$AGENTS/$ASR.plist"
launchctl bootstrap "$DOMAIN" "$AGENTS/$ASR.plist"
launchctl print "$DOMAIN/$LLM"
launchctl print "$DOMAIN/$TTS"
launchctl print "$DOMAIN/$ASR"
lsof -nP -iTCP:8005 -sTCP:LISTEN
curl --fail --show-error http://127.0.0.1:8005/v1/models
```

验证 ASR 真实转录（沿用现有模型绝对路径）和 8004 TTS 真实合成。
`/v1/models`、bootstrap 成功或 PID 存在均不等于模型已加载、推理健康。
检查新日志与退出状态；保留原 host/bind，确认 Docker 可达 8005 后再切代理：
须核对 gateway 实际脚本版本、
单 worker/串行生成/seed 行为，以及 --model/--host/--port 接口。部署包携带已哈希的脚本副本，
上述显式 install 命令以独占创建写入明确的目标路径，拒绝覆盖现有文件；主工具 prepare 不执行它。
原生 HTTP schema 会忽略 seed，不能将请求里有 seed 等同于模型实际应用了 seed。
同一句/同请求参数分别串行和并发合成，比较音频时长、波形摘要并听辨；批量数变化可能改变结果。
已有日语 Vivian 零温度重复约 48s 的实测反馈，本工具不修改 temperature，不能宣称全语言已修复。
日语 ono_anna、韩语 sohee 零温度也有约 24s 达到 300 token 上限、丢后文/退化且 ASR 仅识别问候
的实测反馈。脚本方案的正温度确定性及跨语言完整性仍需同参数重复请求和并发请求分别验收。

```sh
docker compose -f "$BASE" -f "$BUNDLE/compose.asr-8005.override.yml" up -d --no-deps "$PROXY"
docker compose -f "$BASE" -f "$BUNDLE/compose.asr-8005.override.yml" exec -T "$PROXY" printenv UPSTREAM_URL
```

必须看到 {UPSTREAM}，再通过原代理入口做转录验收、TTS 合成和多座位交叠测试。
之后每次 compose up 都要保留同一 override；只用原 BASE 重建代理会回到 8004。
产物目录应作为持久配置保存，不能在切换后删除。比较首字/转录延迟、P95、错误率、
GPU/统一内存压力与冷启动成本。缓存 64 是条目数，不是字节上限或命中保证。

## 3a. 先 gateway 验收，再合并 app 配置

以上 gateway 安装和真实合成验收通过后，才部署配套 Moss 并按字段合并
docs/cabin_optimization_20261124.config.json 的 cabin 设置；先备份现场 app 配置，
保留 URL、模型绝对路径、凭据和其他未知配置，不用片段覆盖整个配置文件。
推荐 ttsGeneration.seed=42、maxTokens=1024、temperature=0.9；覆盖旧零温度配置。
生产中文个性化问候也出现零温度退化，各已验语言统一使用固定 seed 的串行采样，
ttsDeterministicRequired=true；日语 ono_anna、韩语 sohee，其余配置所列语言 Vivian。
HTTP 请求使用 max_tokens=1024。真实响应必须包含
x-cabin-tts-deterministic: seeded-serial-v1 和 x-cabin-tts-seed: 42。
按上述语言采样参数验证整句完整性、串行/并发摘要和听辨，再验证 app 链路。
stock HTTP 不支持 seed，也没有这些能力确认头；新 app guard 会拒绝它，不能先合并严格配置。
本生成器不读写 app 配置，也不安装/重启 Moss。

## 4. 回退（包括部分应用失败）

保持上面的变量；确认完整备份，先恢复原 TTS 文件/进程并验收 8004 健康，
若已合并严格 app 配置，必须先恢复已备份的 app 原配置/旧版本并停止业务流量；
不要在 ttsDeterministicRequired=true 下切回 stock，否则 app guard 会按设计拒绝。
再让代理回到 8004，最后停新 ASR。恢复前检查当前文件仍是本次候选或原始版本；
若他人已修改，先协调，不能直接覆盖。下面的 cmp 守卫也允许尚未安装 TTS 的部分失败回退。
如果代理尚未切换，可跳过第一条 up，但仍检查其 UPSTREAM_URL。

```sh
test -f "$BACKUP/complete"
python3 "$BUNDLE/verify-bundle.py"
{gateway_check}
cmp "$BASE" "$BACKUP/docker-compose.yml"
if ! cmp -s "$AGENTS/$TTS.plist" "$BUNDLE/prepared/$TTS.plist"; then
  cmp "$AGENTS/$TTS.plist" "$BACKUP/$TTS.plist"
fi
if ! cmp -s "$AGENTS/$LLM.plist" "$BUNDLE/prepared/$LLM.plist"; then
  cmp "$AGENTS/$LLM.plist" "$BACKUP/$LLM.plist"
fi
if test -e "$AGENTS/$ASR.plist"; then
  cmp "$AGENTS/$ASR.plist" "$BUNDLE/prepared/$ASR.plist"
fi
if launchctl print "$DOMAIN/$TTS" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$TTS"
fi
cp -p "$BACKUP/$TTS.plist" "$AGENTS/$TTS.plist"
launchctl bootstrap "$DOMAIN" "$AGENTS/$TTS.plist"
launchctl print "$DOMAIN/$TTS"
```

先做原 8004 真实合成/转录验收，成功后继续；启动失败时保留 ASR 及当前代理路由用于诊断。

```sh
docker compose -f "$BASE" -f "$BUNDLE/compose.rollback.override.yml" up -d --no-deps "$PROXY"
docker compose -f "$BASE" -f "$BUNDLE/compose.rollback.override.yml" exec -T "$PROXY" printenv UPSTREAM_URL
if launchctl print "$DOMAIN/$ASR" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$ASR"
fi
if test -e "$AGENTS/$ASR.plist" || test -L "$AGENTS/$ASR.plist"; then
  test ! -L "$AGENTS/$ASR.plist"
  cmp "$AGENTS/$ASR.plist" "$BUNDLE/prepared/$ASR.plist"
  rm "$AGENTS/$ASR.plist"
fi
if launchctl print "$DOMAIN/$LLM" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LLM"
fi
cp -p "$BACKUP/$LLM.plist" "$AGENTS/$LLM.plist"
launchctl bootstrap "$DOMAIN" "$AGENTS/$LLM.plist"
cmp "$AGENTS/{AUDIO}.plist" "$BACKUP/{AUDIO}.plist"
launchctl print "$DOMAIN/$LLM"
{gateway_remove}
```

确认代理为 {OLD_UPSTREAM}，重复真实 ASR/TTS/LLM 验收。
回退不删除日志/备份；若 cmp 检测到部署期间他人修改的文件，先人工协调。
gateway-file.py 仅删除本包有创建记录且绝对路径、SHA-256、设备号及 inode 均匹配的脚本。
文件被修改、替换或变为符号链接时停止，不删除他人文件；没有创建记录就不删除。
复制中断且尚未写完创建记录时也不自动删除残留文件，需人工核对，不将其归为本包可删除文件。
代理回退后，可恢复原来的完整 compose 启动命令；原 BASE 的上游已验证为 8004。
'''


def prepare(args):
    root = args.root.expanduser().resolve()
    launch = (args.launch_dir or root / "launch").expanduser().resolve()
    if args.compose_file:
        compose = args.compose_file.expanduser().resolve()
    else:
        candidates = [p for p in (root / "docker/docker-compose.yml",
                                  root / "deploy/docker-compose.yml",
                                  root / "deploy/docker-compose.yaml") if p.is_file()]
        if len(candidates) != 1:
            raise PrepareError("cannot select compose file; use --compose-file (no service name is guessed)")
        compose = candidates[0].resolve()
    llm_path, audio_path = launch / (LLM + ".plist"), launch / (AUDIO + ".plist")
    llm_raw, llm = load_agent(llm_path, LLM)
    audio_raw, audio = load_agent(audio_path, AUDIO)
    label = args.asr_label
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", label) or label in (LLM, AUDIO):
        raise PrepareError("ASR Label must be new and contain only letters, digits, dot, underscore, hyphen")
    for path in launch.glob("*.plist"):
        if plistlib.loads(path.read_bytes()).get("Label") == label:
            raise PrepareError("ASR Label already exists in launch-dir: " + str(path))
    if (launch / (label + ".plist")).exists():
        raise PrepareError("ASR destination filename already exists in launch-dir")
    # These launchd resources cannot be duplicated just by changing the Label/port.
    if any(key in audio for key in ("Sockets", "MachServices", "inetdCompatibility")):
        raise PrepareError("audio has launchd socket/Mach resources; independent clone needs manual review")
    port = option(audio["ProgramArguments"], "--port", required=True)
    if port != "8004":
        raise PrepareError("existing audio must explicitly use port 8004; refusing to alter TTS topology")
    llm_port = option(llm["ProgramArguments"], "--port", required=True)
    if not llm_port.isdigit() or not 1 <= int(llm_port) <= 65535 or int(llm_port) in (8004, 8005):
        raise PrepareError("LLM port is invalid or collides with audio/ASR")
    llm_new = copy.deepcopy(llm)
    option(llm_new["ProgramArguments"], "--prompt-cache-size", "64")
    compose_raw = compose.read_bytes()
    model_values = {}
    service = proxy_service(compose_raw.decode("utf-8"), model_values)
    tts, tts_runtime, gateway_payload = tts_candidate(audio, args, root, llm, model_values)
    # ASR stays stock: clone the original audio, never the gateway candidate.
    asr = copy.deepcopy(audio)
    asr["Label"] = label
    option(asr["ProgramArguments"], "--port", "8005", required=True)
    for key, suffix in (("StandardOutPath", "stdout"), ("StandardErrorPath", "stderr")):
        original = audio.get(key, str(Path(audio["WorkingDirectory"]) / "logs/audio.log"))
        absolute_target(original, key)
        asr[key] = str(Path(original).parent / (label + "." + suffix + ".log"))
        if asr[key] in tuple(agent.get(log_key) for agent in (llm, audio)
                             for log_key in ("StandardOutPath", "StandardErrorPath")):
            raise PrepareError("ASR log collides with an existing service log")
    compose_target = absolute_target(
        args.compose_target or str(Path(audio["WorkingDirectory"]) / "docker/docker-compose.yml"),
        "--compose-target")
    agents_target = (absolute_target(args.launch_agent_dir, "--launch-agent-dir")
                     if args.launch_agent_dir else None)
    output_input = args.output.expanduser()
    if output_input.is_symlink() or output_input.exists():
        raise PrepareError("--output must be a new directory; refusing to overwrite existing output")
    output = output_input.resolve()
    absolute_target(str(output), "--output")
    for directory in (launch, compose.parent):
        if output == directory or directory in output.parents:
            raise PrepareError("--output cannot be inside an input launch/compose directory")
    if not output.parent.is_dir():
        raise PrepareError("--output parent must already exist; no directories outside output are created")
    files = {
        "backup/" + LLM + ".plist": llm_raw,
        "backup/" + AUDIO + ".plist": audio_raw,
        "backup/docker-compose.yml": compose_raw,
        "prepared/" + LLM + ".plist": plistlib.dumps(llm_new, sort_keys=False),
        "prepared/" + AUDIO + ".plist": plistlib.dumps(tts, sort_keys=False),
        "prepared/" + label + ".plist": plistlib.dumps(asr, sort_keys=False),
        "compose.asr-8005.override.yml": override(service, UPSTREAM).encode(),
        "compose.rollback.override.yml": override(service, OLD_UPSTREAM).encode(),
        "verify-bundle.py": VERIFY_BUNDLE,
        "DEPLOYMENT.md": deployment_plan(output, llm, audio, asr, tts_runtime, compose_target,
                                         agents_target, service).encode(),
    }
    files["payload/cabin-tts-server.py"] = gateway_payload
    files["gateway-file.py"] = GATEWAY_FILE
    manifest = {
        "mode": "prepare-only", "proxy_service": service, "asr_label": label,
        "upstream_before": OLD_UPSTREAM, "upstream_after": UPSTREAM,
        "tts_runtime": tts_runtime,
        "target_compose": compose_target, "target_launch_agents": agents_target or "$HOME/Library/LaunchAgents",
        "sources": [{"path": str(path), "sha256": digest(raw)} for path, raw in
                    ((llm_path, llm_raw), (audio_path, audio_raw), (compose, compose_raw))],
        "artifacts": {name: digest(data) for name, data in files.items()},
        "changes": ["LLM: only --prompt-cache-size becomes explicit 64",
                    "TTS: existing venv/python + gateway script/model, host 0.0.0.0 port 8004; original Label/environment retained",
                    "ASR: clone audio, new Label/port 8005/separate stdout and stderr",
                    "Compose: only discovered proxy UPSTREAM_URL becomes " + UPSTREAM],
    }
    manifest["sources"].append({"path": tts_runtime["source"], "sha256": tts_runtime["sha256"]})
    files["manifest.json"] = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode()
    # All input validation and serialization completes before the first write.
    # Exclusive creation also rejects a concurrent directory/symlink replacement.
    output.mkdir(mode=0o700)
    for directory in (output / "backup", output / "prepared"):
        directory.mkdir(mode=0o700)
    (output / "payload").mkdir(mode=0o700)
    for name, data in files.items():
        with (output / name).open("xb") as stream:
            os.chmod(stream.fileno(), 0o600)
            stream.write(data)
    return output, service


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", nargs="?", choices=("prepare", "dry-run"), default="prepare",
                        help="both actions only write review artifacts; neither applies changes")
    parser.add_argument("--dry-run", action="store_true", help="alias for prepare-only behavior")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT,
                        help="source deployment root containing launch/ and docker/ (default: ~/models-docker-mac)")
    parser.add_argument("--launch-dir", type=Path, help="source plist directory; defaults to ROOT/launch")
    parser.add_argument("--compose-file", type=Path, help="source compose file; otherwise find one in ROOT/docker or ROOT/deploy")
    parser.add_argument("--compose-target", help="absolute production compose path for manual commands; defaults to audio WorkingDirectory/docker/docker-compose.yml")
    parser.add_argument("--launch-agent-dir", help="absolute production LaunchAgents path; default uses target user's HOME")
    parser.add_argument("--asr-label", default="com.comac.mlx-asr", help="new independent ASR launchd Label")
    parser.add_argument("--tts-server-script", help="local gateway source to bundle; default: cabin-tts-server.py beside this tool")
    parser.add_argument("--tts-script-target", help="absolute installed gateway path on target Mac; default: audio WorkingDirectory/cabin-tts-server.SHA12.py")
    parser.add_argument("--tts-model", help="actual absolute target TTS model; otherwise corroborate and resolve from snapshot compose/LLM/config")
    parser.add_argument("--output", type=Path, required=True, help="new output directory whose parent already exists")
    args = parser.parse_args(argv)
    try:
        output, service = prepare(args)
    except (OSError, ValueError, TypeError, AttributeError, plistlib.InvalidFileException, ExpatError) as exc:
        print("prepare failed: " + str(exc), file=sys.stderr)
        return 2
    print("Prepared only (no service/port/network operations): " + str(output))
    print("Discovered proxy service: " + service)
    print("Review manifest.json and DEPLOYMENT.md before any manual deployment.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
