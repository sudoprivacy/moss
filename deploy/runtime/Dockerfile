# ---------------------------------------------------------
# 使用 Ubuntu 24.04 以支持最新的 GLIBC 2.39
# docker build -t my-moss-runtime:v1 -f deploy/runtime/Dockerfile .
# ---------------------------------------------------------

# Stage 1: build the Document Center wiki CLI (Go, no deps)
FROM golang:1.22-alpine AS wiki-builder
WORKDIR /src
COPY ./cli/wiki/go.mod ./
# go.sum intentionally absent — wiki CLI has zero external deps
COPY ./cli/wiki/*.go ./
COPY ./cli/wiki/client/*.go ./client/
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/wiki .

# Stage 2: runtime image
FROM ubuntu:24.04

# 设置非交互模式（防止安装过程弹出时区选择）
ENV DEBIAN_FRONTEND=noninteractive

# 1. 安装基础依赖和常用工具
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    git \
    python3 \
    bash \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 2. 安装 Node.js 20 (如果 scode 本身或其插件需要 Node 环境)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 3. 将你的 scode 引擎放入镜像并赋予执行权限
# 注意：构建时确保本地路径 bin/scode 存在
COPY ./bin/scode /usr/local/bin/scode
RUN chmod +x /usr/local/bin/scode

# 4. 设置别名或链接，确保直接输入 scode 就能运行
RUN ln -s /usr/local/bin/scode /usr/bin/scode

# 5. Document Center wiki CLI (built in stage 1)
COPY --from=wiki-builder /out/wiki /usr/local/bin/wiki
RUN chmod +x /usr/local/bin/wiki

# 6. 设置工作目录（Moss 创建会话容器时通常会挂载这里）
WORKDIR /workspace

# 默认命令（仅用于测试）
CMD ["scode", "--help"]