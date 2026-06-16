FROM node:22.14.0-slim
# 让 apt 对镜像源的瞬时故障 (例如代理偶发 502/连接超时) 自动重试，并强制串行单连接下载，
# 避免并发把脆弱的代理打挂导致整层构建失败。
RUN printf 'Acquire::Retries "20";\nAcquire::http::Timeout "60";\nAcquire::https::Timeout "60";\nAcquire::Queue-Mode "access";\nAcquire::http::Pipeline-Depth "0";\n' > /etc/apt/apt.conf.d/80-retries
# 安装 Docker CLI + LibreOffice 依赖
# 镜像源代理偶发 502/连接超时，单次 apt-get install 任一包失败即整层失败。用重试循环包裹安装：
# apt 的下载缓存在同一 RUN 内保留，每次重试只补拉仍缺失的包，最终收敛。jq 供 OAuth2 凭证脚本解析 JSON。
RUN apt-get update \
    && for i in 1 2 3 4 5 6 7 8; do \
         apt-get install -y --no-install-recommends \
           curl \
           ca-certificates \
           gnupg \
           lsb-release \
           unzip \
           jq \
           tzdata \
           # LibreOffice 依赖
           libxinerama1 \
           libcairo2 \
           libcups2 \
           libxrandr2 \
           libxdamage1 \
           libxtst6 \
           libgtk-3-0 \
           libgl1-mesa-glx \
           libglib2.0-0 \
           libsm6 \
           libice6 \
           libxrender1 \
           libfontconfig1 \
           libdbus-1-3 \
           libxi6 \
           # LibreOffice 26.2 需要 OpenSSL 3 和 NSS
           libssl3 \
           libnss3 \
           libnspr4 \
         && break || { echo "apt install attempt $i failed; retrying in 10s..."; sleep 10; }; \
       done \
    && command -v jq >/dev/null || (echo "jq not installed after retries" && exit 1) \
    # LibreOffice looks for libssl3.so, but Debian provides libssl.so.3
    && ln -sf /lib/x86_64-linux-gnu/libssl.so.3 /lib/x86_64-linux-gnu/libssl3.so \
    && ln -sf /lib/x86_64-linux-gnu/libcrypto.so.3 /lib/x86_64-linux-gnu/libcrypto3.so \
    && rm -rf /var/lib/apt/lists/*

# 整个服务运行在中国时间（Asia/Shanghai）：日志、时间戳、cron 墙钟均为 CST。
# 默认 UTC 会导致 cron "9-17" 在 UTC 9-17（即中国傍晚）触发。tzdata 已在上面安装。
ENV TZ=Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo 'Asia/Shanghai' > /etc/timezone

# 安装 Docker CLI (使用重试 + 国内镜像备用)
RUN for i in 1 2 3; do \
        if curl -fsSL --connect-timeout 30 https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg 2>/dev/null; then \
            echo "Downloaded Docker GPG key from official source"; \
            break; \
        elif curl -fsSL --connect-timeout 30 https://mirrors.aliyun.com/docker-ce/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg 2>/dev/null; then \
            echo "Downloaded Docker GPG key from Aliyun mirror"; \
            break; \
        else \
            echo "Retry $i: Failed to download Docker GPG key, waiting..."; \
            sleep 5; \
        fi; \
    done \
    && if [ ! -f /usr/share/keyrings/docker-archive-keyring.gpg ]; then \
        echo "ERROR: Failed to download Docker GPG key from all sources"; \
        exit 1; \
    fi \
    && DISTRO_CODENAME=$(/usr/bin/lsb_release -cs) \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian ${DISTRO_CODENAME} stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null \
    && apt-get update && apt-get install -y docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# 下载 scode
# 安装 LibreOffice 和 PDF 工具 (直接从 apt 安装，确保依赖完整)
# 同样用重试循环包裹，避免镜像源代理瞬时故障导致整层失败 (见上方 apt 配置)。
RUN apt-get update \
    && for i in 1 2 3 4 5 6 7 8; do \
         apt-get install -y --no-install-recommends \
           libreoffice-writer libreoffice-core poppler-utils fonts-noto-cjk \
         && break || { echo "libreoffice install attempt $i failed; retrying in 10s..."; sleep 10; }; \
       done \
    && command -v soffice >/dev/null || (echo "libreoffice not installed after retries" && exit 1) \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

ENV LIBREOFFICE_BIN=/usr/bin/soffice


WORKDIR /app

# 复制本地构建产物
COPY bin/scode bin/
COPY bin/wiki bin/
COPY bin/moss-server.mjs ./bin/
COPY bin/direct-connect-session-runner.mjs ./bin/
COPY admin/dist/ ./admin/dist/
COPY assistants/ ./assistants/

# 复制 wiki (从 Go 构建阶段)
RUN chmod +x ./bin/wiki
RUN chmod +x ./bin/scode


EXPOSE 43127

CMD ["node", "bin/moss-server.mjs", "start"]