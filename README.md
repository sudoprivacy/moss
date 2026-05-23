# Moss - Claude Code Electron UI

Moss 是一个基于 Electron 的桌面客户端，它直接嵌入了 Anthropic 的 Claude Code Agent 逻辑，提供了可视化的聊天界面、工作区文件管理以及生成式 Mini App 的运行环境。

## 文档

- [Moss Server API](src/server/API.md)

## 快速启动

### 1. 编译依赖 (重要)

由于程序采用了嵌入式架构，启动前需要先编译 Agent 的核心逻辑：

```bash
# 在仓库根目录执行，生成 electron-direct.mjs 和相关依赖
bun run build:node
```

该命令会将 Agent 的核心逻辑打包成 Electron 可直接加载的模块。

### 2. 启动 UI

```bash
# 进入 ui 目录
cd ui

# 安装 UI 依赖 (仅首次需要)
bun install

# 启动程序 (会自动执行 vite build 并运行 electron)
bun run start
```

## 开发与部署

### 1. 构建核心 Agent 逻辑

```bash
# 生成 electron-direct.mjs 和相关依赖
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

## 配置文件

程序配置存储在 `~/.moss/settings.json`。你可以手动修改该文件来配置自定义的 API 地址、模型名称或环境变量。

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
