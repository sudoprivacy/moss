# Moss 部署说明

## 环境要求

- Docker 20.10+
- Docker Compose 2.0+
- Linux x64 操作系统

## 快速开始

### 1. 解压部署包

```bash
tar -xzf moss-deploy-*.tar.gz
cd moss
```

### 2. 修改配置

编辑 `server.json` 文件，修改以下配置：

```json
{
  "server": {
    "advertisedHost": "YOUR_SERVER_IP"  // 修改为服务器公网 IP 或域名
  }
}
```

> **注意**: `dockerImage` 配置会在打包时自动更新为正确的镜像 tag，无需手动修改。

### 3. 设置环境变量（可选）

```bash
# API Key（必须设置）
export ANTHROPIC_API_KEY="your-api-key"

# API Base URL（可选，默认使用 sudorouter）
export ANTHROPIC_BASE_URL="https://hk.sudorouter.ai/v1"

# 服务端口（可选，默认 43127）
export MOSS_PORT="43127"
```

### 4. 启动服务

```bash
chmod +x start.sh shutdown.sh
./start.sh
```

### 5. 验证服务

```bash
# 检查容器状态
docker ps | grep moss-server

# 查看日志
docker logs -f moss-server

# 访问服务
curl http://localhost:43127/health
```

## 停止服务

```bash
./shutdown.sh
```

## 配置说明

### server.json 关键配置

| 配置项 | 说明 | 是否需要修改 |
|--------|------|--------------|
| `server.host` | 监听地址，默认 `0.0.0.0` | 否 |
| `server.port` | 服务端口，默认 `43127` | 否（通过 MOSS_PORT 环境变量修改） |
| `server.advertisedHost` | 对外通告地址 | **是**，改为服务器 IP |
| `bootstrapAdmin.username` | 管理员用户名 | 可选 |
| `bootstrapAdmin.password` | 管理员密码 | **建议修改** |
| `runtimeDefaults.dockerImage` | 会话容器镜像 | 否（自动匹配） |
| `runtimeDefaults.scodePath` | scode 路径 | 否 |
| `storage.rootDir` | 数据存储目录 | 否 |

### docker-compose.yml 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `MOSS_IMAGE_TAG` | 镜像 tag | 从镜像文件名自动提取 |
| `MOSS_PORT` | 服务端口 | 43127 |
| `ANTHROPIC_API_KEY` | API Key | 无（必须设置） |
| `ANTHROPIC_BASE_URL` | API Base URL | https://hk.sudorouter.ai/v1 |

## 目录结构

```
moss/
├── my-moss-runtime-*.tar.gz  # 会话容器镜像
├── my-moss-server-*.tar.gz   # 主服务镜像
├── server.json               # 服务配置
├── docker-compose.yml        # Docker Compose 配置
├── start.sh                  # 启动脚本
├── shutdown.sh               # 关闭脚本
├── README.md                 # 本说明文件
├── data/                     # 数据目录（启动后自动创建）
│   ├── moss.db              # SQLite 数据库
│   ├── transcripts/         # 会话记录
│   └── runtime/             # 运行时数据
└── logs/                     # 日志目录（启动后自动创建）
```

## 常见问题

### Q: 启动失败，提示镜像加载错误

确保 Docker 有足够的磁盘空间，且镜像文件完整。

### Q: 会话容器无法启动

检查 `my-moss-runtime-*.tar.gz` 是否存在，且 tag 与 `server.json` 中的配置匹配。

### Q: 无法连接 API

检查 `ANTHROPIC_API_KEY` 是否正确设置，网络是否能访问 API Base URL。

## 技术支持

- GitHub: https://github.com/sudoprivacy/moss
- Issues: https://github.com/sudoprivacy/moss/issues
