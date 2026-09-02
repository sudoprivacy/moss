# ---------------------------------------------------------
# Session Runtime 使用 Ubuntu 24.04；scode bundle 本身为静态二进制。
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

# 1. 安装基础依赖和常用工具（含 tzdata 以提供时区数据库）
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    git \
    python3 \
    bash \
    tzdata \
    && ln -snf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo 'Asia/Shanghai' > /etc/timezone \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 2. 安装 Node.js 20 (如果 scode 本身或其插件需要 Node 环境)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 3. 从 GitHub 下载并校验 scode bundle，只安装静态 scode 二进制
# 版本与 Server host 安装包共用仓库配置
# 当前 Release 仅发布 linux/amd64 bundle
ARG TARGETARCH
COPY src/server/nexus/runtime-versions.json /tmp/moss-runtime-versions.json
RUN SCODE_VERSION="$(node -p 'require("/tmp/moss-runtime-versions.json").scode')" && \
    SCODE_SHA256="$(node -p 'require("/tmp/moss-runtime-versions.json")["scode-linux-x64-bundle-sha256"]')" && \
    case "$TARGETARCH" in amd64) ;; *) echo "scode bundle only supports amd64, got: $TARGETARCH"; exit 1 ;; esac && \
    SCODE_ASSET=scode-linux-x64-bundle.tar.gz && \
    curl -fsSL "https://github.com/sudoprivacy/sudocode/releases/download/${SCODE_VERSION}/${SCODE_ASSET}" -o "/tmp/$SCODE_ASSET" && \
    echo "$SCODE_SHA256  /tmp/$SCODE_ASSET" | sha256sum -c - && \
    tar -xzf "/tmp/$SCODE_ASSET" -C /tmp && \
    (cd /tmp/scode-linux-x64-bundle && sha256sum -c SHA256SUMS.txt) && \
    install -m 0755 /tmp/scode-linux-x64-bundle/scode /usr/local/bin/scode && \
    scode --version && \
    rm -rf /tmp/scode-linux-x64-bundle "/tmp/$SCODE_ASSET" && \
    rm -f /tmp/moss-runtime-versions.json && \
    ln -s /usr/local/bin/scode /usr/bin/scode

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
