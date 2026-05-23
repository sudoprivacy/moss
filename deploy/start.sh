#!/bin/bash

# ---------------------------------------------------------
# Moss 部署与启动脚本
# 功能:
# 1. 加载 Docker 镜像 (runtime + server)
# 2. 使用 docker-compose 启动 moss-server 容器
# 3. 支持环境变量配置
# ---------------------------------------------------------

set -e

BASE_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$BASE_DIR"

LOG_DIR="$BASE_DIR/logs"
LOG_FILE="$LOG_DIR/moss-server.log"

mkdir -p "$LOG_DIR"
mkdir -p "$BASE_DIR/data"

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

# 3. 停止已有容器
echo "[3/4] 检查并停止已有容器..."

if docker ps -a --format "{{.Names}}" | grep -q "^moss-server$"; then
    echo "  发现已存在的容器，正在停止..."
    docker-compose -p moss-server down 2>/dev/null || true
    docker rm -f moss-server 2>/dev/null || true
    sleep 2
fi

# 4. 启动 Moss Server
echo "[4/4] 正在启动 Moss Server..."

export MOSS_IMAGE_TAG="$IMAGE_TAG"
export MOSS_PORT
export ANTHROPIC_API_KEY
export ANTHROPIC_BASE_URL

docker-compose -p moss-server up -d

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
    docker-compose -p moss-server logs
    exit 1
fi
