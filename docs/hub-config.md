# Hub 配置说明

MOSS 支持配置 Hub API 和 COS（对象存储）的基础 URL，用于连接技能/智能体 Hub 和加载图标等资源。

## 配置方式

### 1. 环境变量（优先级最高）

```bash
# Hub API 基础 URL
export MOSS_HUB_API_BASE_URL="https://sudoclawhub.sudoprivacy.com/api"
# 或
export MOSS_HUB_BASE_URL="https://sudoclawhub.sudoprivacy.com"

# Hub 认证信息
export MOSS_HUB_AUTHORIZATION="sud0@sudo"

# COS 对象存储基础 URL（用于技能/智能体图标等资源）
export MOSS_COS_BASE_URL="https://sudoclaw-1309794936.cos.ap-beijing.myqcloud.com"
```

### 2. 配置文件

在 `~/.claude/server/server.json` 中配置：

```json
{
  "hub": {
    "apiBaseUrl": "https://sudoclawhub.sudoprivacy.com/api",
    "authorization": "sud0@sudo",
    "cosBaseUrl": "https://sudoclaw-1309794936.cos.ap-beijing.myqcloud.com"
  }
}
```

### 3. 前端配置（Admin 管理后台）

前端通过环境变量或 `.env` 文件配置：

```bash
# .env 文件
VITE_COS_BASE_URL=https://sudoclaw-1309794936.cos.ap-beijing.myqcloud.com
```

或在构建时传入：

```bash
VITE_COS_BASE_URL=https://your-cos-url.com pnpm build
```

## 默认值

如果未配置，系统使用以下默认值：

| 配置项 | 默认值 |
|--------|--------|
| Hub API URL | `https://sudoclawhub.sudoprivacy.com/api` |
| Hub Authorization | `sud0@sudo` |
| COS Base URL | `https://sudoclaw-1309794936.cos.ap-beijing.myqcloud.com` |

## 配置优先级

配置加载优先级（从高到低）：

1. 环境变量
2. 配置文件
3. 默认值

## 使用场景

### COS Base URL

COS Base URL 用于解析技能和智能体的图标路径。当 Hub 返回的图标路径是相对路径（如 `skill-hub/xxx/icon.png`）时，系统会自动拼接 COS Base URL 生成完整的资源地址。

示例：
- 输入路径: `skill-hub/b07a3fcd-5051-4c33-b6ba-e9797a779c63/icon.png`
- 输出 URL: `https://sudoclaw-1309794936.cos.ap-beijing.myqcloud.com/skill-hub/b07a3fcd-5051-4c33-b6ba-e9797a779c63/icon.png`

### Hub API Base URL

Hub API Base URL 用于连接技能和智能体 Hub，获取：
- 技能列表和详情
- 智能体列表和详情
- 分类信息
- 版本信息

## 私有化部署

如果需要私有化部署，可以将 Hub 和 COS 部署到自己的服务器，然后修改配置：

```json
{
  "hub": {
    "apiBaseUrl": "https://your-hub-server.com/api",
    "authorization": "your-auth-token",
    "cosBaseUrl": "https://your-cos-server.com"
  }
}
```

或通过环境变量：

```bash
export MOSS_HUB_API_BASE_URL="https://your-hub-server.com/api"
export MOSS_HUB_AUTHORIZATION="your-auth-token"
export MOSS_COS_BASE_URL="https://your-cos-server.com"
```
