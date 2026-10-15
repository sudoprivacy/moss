# ---------------------------------------------------------
# Session Runtime 使用 Ubuntu 24.04；scode 按目标架构下载并校验。
# docker build -t my-moss-runtime:v1 -f deploy/runtime/Dockerfile .
# scode 版本统一读取 src/server/nexus/runtime-versions.json。
# ---------------------------------------------------------

# Stage 1: build the Document Center wiki CLI (Go, no deps)
FROM golang:1.22-alpine AS wiki-builder
WORKDIR /src
COPY ./cli/wiki/go.mod ./
# go.sum intentionally absent — wiki CLI has zero external deps
COPY ./cli/wiki/*.go ./
COPY ./cli/wiki/client/*.go ./client/
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/wiki .

# Stage 1b: build the Corp App (企业应用) CLI (Go, no deps)
FROM golang:1.22-alpine AS corpapp-builder
WORKDIR /src
COPY ./cli/corpapp/go.mod ./
# go.sum intentionally absent — corpapp CLI has zero external deps
COPY ./cli/corpapp/*.go ./
COPY ./cli/corpapp/client/*.go ./client/
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/corpapp .

# Stage 1c: build the Corp Auth (企业鉴权) CLI (Go, no deps)
FROM golang:1.22-alpine AS corpauth-builder
WORKDIR /src
COPY ./cli/corpauth/go.mod ./
# go.sum intentionally absent — corpauth CLI has zero external deps
COPY ./cli/corpauth/*.go ./
COPY ./cli/corpauth/client/*.go ./client/
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/corpauth .

# Stage 1d: build the fetchurl CLI (Go, no deps) — curl-compatible HTTP through
# the auth proxy so skills reach authenticated services without handling creds.
FROM golang:1.22-alpine AS fetchurl-builder
WORKDIR /src
COPY ./cli/fetchurl/go.mod ./
# go.sum intentionally absent — fetchurl CLI has zero external deps
COPY ./cli/fetchurl/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/fetchurl .

# Stage 2: runtime image
FROM ubuntu:24.04

# 设置非交互模式（防止安装过程弹出时区选择）
ENV DEBIAN_FRONTEND=noninteractive

# 0. 时区：会话容器内一律使用中国时间（Asia/Shanghai），使 agent 观察到的
#    时间、日志、scode 时间戳均为 CST，与服务端保持一致（默认 UTC 会导致时间偏差）。
ENV TZ=Asia/Shanghai

# Ubuntu's image gives /home/ubuntu mode 0750. Sandboxed commands drop DAC
# bypass capabilities, so they must be able to traverse this empty image home
# to reach session workspaces mounted below it. Keep directory listing private.
RUN chmod 0711 /home/ubuntu

# 1. 安装基础依赖和常用工具（含 tzdata 以提供时区数据库）
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    git \
    jq \
    python3 \
    python3-venv \
    ffmpeg \
    fonts-noto-cjk \
    bash \
    tzdata \
    && ln -snf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo 'Asia/Shanghai' > /etc/timezone \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Keep media dependencies and the speech model in the image, outside each
# session's empty HOME. New cloud conversations work without package downloads.
ENV SUDOWORK_SUBTITLE_PYTHON=/opt/sudowork-subtitles/bin/python \
    SUDOWORK_WHISPER_MODEL_DIR=/opt/sudowork-models/faster-whisper-small
COPY deploy/runtime/fetch-whisper-model.py /tmp/fetch-whisper-model.py
RUN python3 -m venv /opt/sudowork-subtitles \
    && /opt/sudowork-subtitles/bin/python -m pip install --no-cache-dir faster-whisper==1.2.1 av==16.1.0
ARG HF_ENDPOINT=https://huggingface.co
ARG HF_HUB_DISABLE_XET=0
RUN --mount=type=secret,id=hf_token \
    HF_TOKEN="$(cat /run/secrets/hf_token 2>/dev/null || true)" \
       /opt/sudowork-subtitles/bin/python /tmp/fetch-whisper-model.py \
    && rm -f /tmp/fetch-whisper-model.py \
    && /opt/sudowork-subtitles/bin/python -c "from faster_whisper import WhisperModel; WhisperModel('/opt/sudowork-models/faster-whisper-small', device='cpu', compute_type='int8', cpu_threads=2)" \
    && ffmpeg -hide_banner -filters 2>/dev/null | grep -q subtitles

# Exercise decoding as well as imports: incompatible PyAV releases can import
# successfully while rejecting the arguments faster-whisper uses to open audio.
RUN ffmpeg -f lavfi -i anullsrc=r=16000:cl=mono -t 0.1 /tmp/subtitle-smoke.wav \
    && /opt/sudowork-subtitles/bin/python -c "from faster_whisper.audio import decode_audio; assert len(decode_audio('/tmp/subtitle-smoke.wav')) > 0" \
    && rm /tmp/subtitle-smoke.wav

# 2. 安装 Node.js 20 (如果 scode 本身或其插件需要 Node 环境)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 3. 从 GitHub 下载并校验原生 scode，只安装二进制
# 版本与 Server host 安装包共用仓库配置
ARG TARGETARCH
ARG SCODE_DOWNLOAD_URL
COPY src/server/nexus/runtime-versions.json /tmp/moss-runtime-versions.json
COPY deploy/fetch-scode.sh /tmp/fetch-scode.sh
RUN bash /tmp/fetch-scode.sh /tmp/moss-runtime-versions.json "$TARGETARCH" /usr/local/bin/scode && \
    scode --version && \
    rm -f /tmp/fetch-scode.sh /usr/local/bin/scode.version && \
    ln -s /usr/local/bin/scode /usr/bin/scode

# The embedded engine and CLI share the release pins. Signed Vault services use
# the same artifact as the controller; credentials are projected per owner.
RUN COHOST_VERSION="$(node -p 'require("/tmp/moss-runtime-versions.json")["nexusd-cohost"]')" && \
    VAULT_VERSION="$(node -p 'require("/tmp/moss-runtime-versions.json")["nexus-vault"]')" && \
    case "$TARGETARCH" in amd64) COHOST_ARCH=x64; VAULT_ARCH=x86_64 ;; arm64) COHOST_ARCH=arm64; VAULT_ARCH=aarch64 ;; *) exit 1 ;; esac && \
    mkdir -p /tmp/cohost /opt/scode-plugins && \
    curl -fsSL --retry 3 --connect-timeout 15 --max-time 300 "https://github.com/sudoprivacy/sudocode/releases/download/nexusd-cohost-v${COHOST_VERSION}/nexusd-cohost-linux-${COHOST_ARCH}.tar.gz" -o /tmp/cohost/runtime.tar.gz && \
    COHOST_SHA256="$(jq -er --arg artifact "nexusd-cohost-linux-${COHOST_ARCH}.tar.gz" '."artifact-sha256"[$artifact]' /tmp/moss-runtime-versions.json)" && \
    echo "$COHOST_SHA256  /tmp/cohost/runtime.tar.gz" | sha256sum -c - && \
    tar -xzf /tmp/cohost/runtime.tar.gz -C /tmp/cohost && \
    install -m 0755 "/tmp/cohost/nexusd-cohost-linux-${COHOST_ARCH}/nexusd-cohost" /usr/local/bin/nexusd-cohost && \
    curl -fsSL --retry 3 --connect-timeout 15 --max-time 300 "https://github.com/nexi-lab/nexus/releases/download/vault-v${VAULT_VERSION}/nexus-vault-linux-${VAULT_ARCH}.tar.gz" -o /tmp/vault.tar.gz && \
    VAULT_SHA256="$(jq -er --arg artifact "nexus-vault-linux-${VAULT_ARCH}.tar.gz" '."artifact-sha256"[$artifact]' /tmp/moss-runtime-versions.json)" && \
    echo "$VAULT_SHA256  /tmp/vault.tar.gz" | sha256sum -c - && \
    tar -xzf /tmp/vault.tar.gz -C /opt/scode-plugins && \
    test -f /opt/scode-plugins/libnexus_vault.so.sig && \
    nexusd-cohost --version && \
    nexusd-cohost serve-user --help >/dev/null && \
    rm -rf /tmp/cohost /tmp/vault.tar.gz /tmp/moss-runtime-versions.json

# 5. Agent-facing CLIs (built in the wiki / corpapp / corpauth / fetchurl stages):
#    wiki (Document Center), corpapp (企业应用), corpauth (企业鉴权),
#    fetchurl (authenticated HTTP via the auth proxy).
COPY --from=wiki-builder /out/wiki /usr/local/bin/wiki
COPY --from=corpapp-builder /out/corpapp /usr/local/bin/corpapp
COPY --from=corpauth-builder /out/corpauth /usr/local/bin/corpauth
COPY --from=fetchurl-builder /out/fetchurl /usr/local/bin/fetchurl
RUN chmod +x /usr/local/bin/wiki /usr/local/bin/corpapp /usr/local/bin/corpauth /usr/local/bin/fetchurl

# 6. moss-session-launch / moss-session-reap (per-user container mode)
#    Launcher records pid + start_ticks (USER_HZ since boot, /proc/<pid>/stat
#    field 22) so the reaper can detect PID reuse before SIGKILL.
COPY deploy/runtime/moss-session-launch.sh /usr/local/bin/moss-session-launch
COPY deploy/runtime/moss-session-reap.sh   /usr/local/bin/moss-session-reap
RUN chmod +x /usr/local/bin/moss-session-launch /usr/local/bin/moss-session-reap

# 7. Image dependency assertion: launcher/reaper require setsid, awk, fractional
#    sleep, and /proc/<pid>/stat. Ubuntu 24.04 has these by default; this RUN
#    fails the build if a future base image switch (Alpine, distroless) drops
#    any of them.
RUN command -v setsid >/dev/null \
 && setsid --wait true \
 && sleep 0.001 \
 && command -v awk >/dev/null \
 && [ -r /proc/self/stat ] \
 && echo 'moss-runtime image deps ok'

# 8. 设置工作目录（Moss 创建会话容器时通常会挂载这里）
WORKDIR /workspace

# 默认命令（仅用于测试）
CMD ["scode", "--help"]
