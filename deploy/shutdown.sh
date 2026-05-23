#!/bin/bash

# ---------------------------------------------------------
# Moss 服务关闭脚本
# 功能:
# 1. 检查 Moss Server 容器运行状态
# 2. 优雅关闭容器
# 3. 清理相关资源
# ---------------------------------------------------------

set -e

BASE_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$BASE_DIR"

echo "=== Moss 关闭流程开始 ==="

# 检查容器是否在运行
if ! docker ps --format "{{.Names}}" | grep -q "^moss-server$"; then
    echo "Moss Server 容器未在运行中。"
    # 检查是否有停止的容器
    if docker ps -a --format "{{.Names}}" | grep -q "^moss-server$"; then
        echo "发现已停止的容器，正在清理..."
        docker rm moss-server 2>/dev/null || true
    fi
    exit 0
fi

# 获取容器信息
CONTAINER_ID=$(docker ps --filter "name=moss-server" --format "{{.ID}}" | head -1)
echo "发现 Moss Server 容器: $CONTAINER_ID"

# 使用 docker-compose 优雅关闭
echo "正在停止 Moss Server..."
docker-compose -p moss-server down

# 等待容器停止
WAIT_COUNT=0
MAX_WAIT=10

while [ $WAIT_COUNT -lt $MAX_WAIT ]; do
    if ! docker ps --format "{{.Names}}" | grep -q "^moss-server$"; then
        echo "Moss Server 已成功停止。"
        echo "-----------------------------------------------"
        echo "关闭时间: $(date '+%Y-%m-%d %H:%M:%S')"
        echo "-----------------------------------------------"
        exit 0
    fi
    sleep 1
    WAIT_COUNT=$((WAIT_COUNT + 1))
    echo "等待容器停止... ($WAIT_COUNT/$MAX_WAIT)"
done

# 如果容器还在运行，强制停止
if docker ps --format "{{.Names}}" | grep -q "^moss-server$"; then
    echo "容器未响应，正在强制停止..."
    docker stop -t 5 moss-server 2>/dev/null || true
    docker rm moss-server 2>/dev/null || true

    if ! docker ps --format "{{.Names}}" | grep -q "^moss-server$"; then
        echo "Moss Server 已强制停止。"
    else
        echo "错误: 无法停止 Moss Server，请手动检查。"
        exit 1
    fi
fi

echo "-----------------------------------------------"
echo "关闭时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "-----------------------------------------------"
