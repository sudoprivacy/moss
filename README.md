# Moss — AgentHub

Moss 是一个多用户 AI coding agent 平台：一个 HTTP/WebSocket 服务端（`moss-server`，端口 43127）加一个 Electron 桌面客户端。每个会话运行 sudocode（`scode`）作为 agent 引擎，并提供可视化的聊天界面、工作区文件管理以及生成式 Mini App 的运行环境。

## 文档

- [Moss Server API](src/server/API.md)
- [Moss Server 部署说明](deploy/README.md)
- [Moss Server v0.1.2 Release](https://github.com/sudoprivacy/moss/releases/tag/server-v0.1.2)

## Moss Server 一键安装

适用于 Linux x86_64/ARM64、glibc 2.35+、systemd 和 Docker 20.10+。安装包
自带 Node.js 22、编译后的 `moss-server.mjs`、运行依赖和官方 Nexus；用户会话
使用随 Release 发布的 Docker Runtime 镜像。

交互式在线安装：

```bash
curl -fsSL https://github.com/sudoprivacy/moss/releases/download/server-v0.1.2/install.sh | sudo bash
```

安装器会提示对外地址、管理员账号、密码和可选模型 API 配置。通过 `sudo` 安装
时，默认目录为发起用户的 `$HOME/.moss/server`，systemd 服务也以该用户运行；
直接使用 root 安装时才会使用 `/root/.moss/server`。默认端口是 `43127`。

非交互安装示例：

```bash
curl -fsSL https://github.com/sudoprivacy/moss/releases/download/server-v0.1.2/install.sh \
  | sudo env MOSS_NON_INTERACTIVE=1 \
      MOSS_ADVERTISED_HOST=10.0.1.206 \
      MOSS_ADMIN_USERNAME=admin \
      MOSS_ADMIN_PASSWORD='replace-with-a-strong-password' \
      bash
```

需要指定其他目录时增加 `MOSS_INSTALL_DIR=/data/moss`；直接由 root 为其他用户
安装时可以增加 `MOSS_INSTALL_USER=username`。

离线安装：

```bash
curl -fLO https://github.com/sudoprivacy/moss/releases/download/server-v0.1.2/moss-offline-0.1.2-linux-amd64.tar.gz
tar -xzf moss-offline-0.1.2-linux-amd64.tar.gz
cd moss-offline
sudo ./install.sh --offline
```

ARM64 机器将文件名中的 `amd64` 替换为 `arm64`。

常用服务命令：

```bash
sudo systemctl status moss-server
sudo systemctl start moss-server
sudo systemctl stop moss-server
sudo systemctl restart moss-server
journalctl -u moss-server -f
curl http://127.0.0.1:43127/healthz
```

安装完成后访问 `http://SERVER:43127/admin/`。升级时执行新版本的一键安装命令，
安装器会保留配置和数据；完整的镜像下载、目录、回滚及卸载说明见
[Moss Server 部署说明](deploy/README.md)。

## 快速启动

### 1. 构建服务端

启动前先在仓库根目录构建服务端：

```bash
# 生成 bin/moss-server.mjs + bin/direct-connect-session-runner.mjs
bun run build:node
```

### 2. 启动 UI

```bash
# 进入 ui 目录
cd ui

# 安装 UI 依赖 (仅首次需要)
bun install

# 启动程序 (会自动执行 vite build 并运行 electron)
bun run start
```

## 开发与打包

### 1. 构建服务端

```bash
# 生成 bin/moss-server.mjs + bin/direct-connect-session-runner.mjs
bun run build:node
```

### 2. 应用打包 (EXE/DMG)

确保已执行上述二进制准备步骤，然后进入 `ui` 目录执行打包命令：

```bash
cd ui

# 打包 Windows (exe)
bun run dist:win

# 打包 macOS (dmg)
bun run dist:mac

# 打包所有平台
bun run dist:all
```

生成的安装包将位于 `ui/dist/installers` 目录下。

## 核心功能

- **可视化 Agent 对话**：直接连接本地 Agent，支持流式输出和思考过程展示。
- **工作区管理**：右侧面板实时展示当前工作区文件树，支持文件预览和变更监听。
- **Mini App 生成**：支持通过自然语言描述生成单文件 HTML 应用，并提供 Host API 访问宿主能力。
- **自动 Git 初始化**：每个新会话创建的工作区会自动执行 `git init`，方便 Agent 使用版本控制工具。

## 桌面端配置文件

桌面端配置存储在 `~/.moss/settings.json`。你可以手动修改该文件来配置自定义的 API 地址、模型名称或环境变量。

通过一键脚本安装的服务端使用独立目录：主配置为
`~/.moss/server/server.json`，模型与系统设置为
`~/.moss/server/.moss/settings.json`，运行数据位于
`~/.moss/server/data/`。这里的 `~` 指安装发起用户的 home。

### 配置示例

```json
{
  "model": "MiniMax-M2.7",
  "bypassPermissions": true,
  "maxTurns": 100,
  "thinkingMode": "disabled",
  "thinkingBudgetTokens": 16000,
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.minimaxi.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "your-api-key"
  }
}
```

### 参数说明

- **model**: 指定使用的模型名称。
- **bypassPermissions**: 是否跳过工具执行的权限确认（建议仅在受控环境下开启）。
- **maxTurns**: 单次会话的最大轮数。
- **thinkingMode**: 思考模式配置（如 `disabled`, `enabled`）。
- **thinkingBudgetTokens**: 思考过程的 Token 预算。
- **env**: 环境变量配置，可用于设置 `ANTHROPIC_BASE_URL` (API 中转地址) 和 `ANTHROPIC_AUTH_TOKEN` (API Key)。

UI 的设置页面会以增量方式更新此文件，不会删除你手动添加的自定义 Key。
