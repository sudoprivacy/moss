#!/bin/bash

# ---------------------------------------------------------
# Moss 部署与启动脚本
# 功能:
# 1. 加载 Docker 镜像 (runtime + server)
# 2. 使用 Docker Compose 启动 moss-server 容器
# 3. 支持环境变量配置
# ---------------------------------------------------------

set -e

BASE_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$BASE_DIR"

LOG_DIR="$BASE_DIR/logs"
LOG_FILE="$LOG_DIR/moss-server.log"

mkdir -p "$LOG_DIR"
mkdir -p "$BASE_DIR/data"
mkdir -p "$BASE_DIR/.moss"

compose() {
    if docker compose version >/dev/null 2>&1; then
        docker compose "$@"
    elif command -v docker-compose >/dev/null 2>&1; then
        docker-compose "$@"
    else
        echo "  错误: 未找到 Docker Compose。请安装 docker compose 插件或 docker-compose。"
        exit 1
    fi
}

find_user_containers() {
    {
        docker ps -aq --filter "label=moss.kind=user-container" 2>/dev/null || true
        docker ps -aq --filter "name=^/moss-user-" 2>/dev/null || true
    } | sort -u | grep -v '^$' || true
}

drain_user_containers() {
    USER_CONTAINERS=$(find_user_containers)
    if [ -z "$USER_CONTAINERS" ]; then
        return 0
    fi

    echo "  发现 Moss 用户级运行容器，正在清理..."
    echo "$USER_CONTAINERS" | while read -r CONTAINER_ID; do
        [ -z "$CONTAINER_ID" ] && continue
        CONTAINER_NAME=$(docker inspect --format '{{.Name}}' "$CONTAINER_ID" 2>/dev/null | sed 's#^/##' || echo "$CONTAINER_ID")
        echo "  清理用户容器: $CONTAINER_NAME"
        docker rm -f "$CONTAINER_ID" 2>/dev/null || true
    done
}

migrate_legacy_db_to_volume() {
    local legacy_db="$BASE_DIR/data/moss.db"
    local migrated_db="$BASE_DIR/data/moss.db.migrated-for-volume"

    if [ ! -f "$legacy_db" ]; then
        return 0
    fi

    if docker run --rm -v moss-db:/app/db "$SERVER_IMAGE" sh -c 'test -f /app/db/moss.db' >/dev/null 2>&1; then
        echo "  moss-db volume 已存在数据库，跳过旧库迁移。"
        return 0
    fi

    echo "  检测到旧数据库 $legacy_db，正在迁移到 Docker volume moss-db..."
    python3 - "$legacy_db" "$migrated_db" <<'PY'
import sqlite3
import sys
from pathlib import Path

src = Path(sys.argv[1])
dst = Path(sys.argv[2])
if dst.exists():
    dst.unlink()

source = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
target = sqlite3.connect(dst)
source.backup(target)
check = target.execute("PRAGMA integrity_check").fetchone()
target.close()
source.close()
if not check or check[0] != "ok":
    raise SystemExit(f"migrated database integrity_check failed: {check}")
PY

    docker run --rm \
        -v moss-db:/app/db \
        -v "$BASE_DIR/data:/host-data" \
        "$SERVER_IMAGE" \
        sh -c 'cp /host-data/moss.db.migrated-for-volume /app/db/moss.db'
    rm -f "$migrated_db"
    echo "  数据库迁移完成：moss-db:/app/db/moss.db"
}

echo "=== Moss 部署启动流程开始 ==="
echo "工作目录: $BASE_DIR"

# 1. 加载 Docker 镜像
echo "[1/4] 检查并加载 Docker 镜像..."

# 从镜像文件名提取 tag (格式: my-moss-server-{tag}.tar.gz)
extract_tag_from_image() {
    local image_file="$1"
    # my-moss-server-abc12345.tar.gz -> abc12345
    local filename=$(basename "$image_file")
    local tag="${filename#my-moss-server-}"
    tag="${tag%.tar.gz}"
    echo "$tag"
}

# 查找并加载 server 镜像
SERVER_IMAGE_FILE=$(ls my-moss-server-*.tar.gz 2>/dev/null | head -1)
if [ -z "$SERVER_IMAGE_FILE" ]; then
    echo "  错误: 未找到 my-moss-server-*.tar.gz 镜像文件"
    exit 1
fi

IMAGE_TAG=$(extract_tag_from_image "$SERVER_IMAGE_FILE")
echo "  检测到镜像 tag: $IMAGE_TAG"

# 加载 server 镜像
echo "  正在加载 Server 镜像: $SERVER_IMAGE_FILE"
docker load -i "$SERVER_IMAGE_FILE"
SERVER_IMAGE="my-moss-server:$IMAGE_TAG"
echo "  Server 镜像加载完成: $SERVER_IMAGE"

# 查找并加载 runtime 镜像
RUNTIME_IMAGE_FILE=$(ls my-moss-runtime-*.tar.gz 2>/dev/null | head -1)
if [ -z "$RUNTIME_IMAGE_FILE" ]; then
    echo "  警告: 未找到 my-moss-runtime-*.tar.gz 镜像文件，会话容器可能无法正常运行"
else
    RUNTIME_TAG=$(extract_tag_from_image "$RUNTIME_IMAGE_FILE")
    echo "  正在加载 Runtime 镜像: $RUNTIME_IMAGE_FILE"
    docker load -i "$RUNTIME_IMAGE_FILE"
    echo "  Runtime 镜像加载完成: my-moss-runtime:$RUNTIME_TAG"
fi

# 2. 配置环境变量
echo "[2/4] 配置环境变量..."

if [ -z "$MOSS_PORT" ]; then
    MOSS_PORT="43127"
fi
echo "  MOSS_PORT=$MOSS_PORT"

if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo "  警告: ANTHROPIC_API_KEY 未设置，请配置后启动。"
fi

if [ -z "$ANTHROPIC_BASE_URL" ]; then
    ANTHROPIC_BASE_URL="https://hk.sudorouter.ai/v1"
fi
echo "  ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"

if [ -z "$MOSS_HOST_PATH_MAP" ]; then
    MOSS_HOST_PATH_MAP="{\"$BASE_DIR/data\":\"/app/data\",\"$BASE_DIR/.moss\":\"/root/.moss\"}"
fi
echo "  MOSS_HOST_PATH_MAP=$MOSS_HOST_PATH_MAP"

# 3. 停止已有容器
echo "[3/4] 检查并停止已有容器..."

drain_user_containers

if docker ps -a --format "{{.Names}}" | grep -q "^moss-server$"; then
    echo "  发现已存在的容器，正在停止..."
    compose -p moss-server down 2>/dev/null || true
    docker rm -f moss-server 2>/dev/null || true
    sleep 2
fi

migrate_legacy_db_to_volume

# 4. 启动 Moss Server
echo "[4/4] 正在启动 Moss Server..."

export MOSS_IMAGE_TAG="$IMAGE_TAG"
export MOSS_PORT
export ANTHROPIC_API_KEY
export ANTHROPIC_BASE_URL
export MOSS_HOST_PATH_MAP

compose -p moss-server up -d

# 等待启动完成
sleep 3

# 检查容器状态
if docker ps --format "{{.Names}}" | grep -q "^moss-server$"; then
    CONTAINER_ID=$(docker ps --filter "name=moss-server" --format "{{.ID}}" | head -1)
    echo "-----------------------------------------------"
    echo "Moss Server 启动成功！"
    echo "容器 ID: $CONTAINER_ID"
    echo "服务端口: $MOSS_PORT"
    echo "镜像: $SERVER_IMAGE"
    echo "查看日志: docker logs -f moss-server"
    echo "-----------------------------------------------"
else
    echo "错误: Moss Server 启动失败，请检查日志。"
    compose -p moss-server logs
    exit 1
fi
