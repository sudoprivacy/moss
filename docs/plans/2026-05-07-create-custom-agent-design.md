---
name: create-custom-agent-design
description: Design for creating custom agents locally and syncing with scode
type: project
---

# 设计方案：创建自定义智能体 (Create Custom Agent)

## 背景与目的
目前 Moss 支持从 Hub 安装智能体，但缺乏本地直接创建自定义智能体的功能。本方案旨在实现该功能，确保用户可以定义自己的智能体（名称、头像、指令、技能），并能让这些智能体被 `scode` 桥接端识别和使用。

## 核心逻辑

### 1. 存储结构
自定义智能体将存储在 `~/.moss/assistants/_my-custom-assistant/` 目录下。每个智能体拥有独立的文件夹：

```text
_my-custom-assistant/
└── {agent-name}/
    ├── _moss_meta.json   # 存储头像、描述、关联技能ID等元数据
    └── instructions.md   # 存储智能体的系统提示词 (Rules/System Prompt)
```

### 2. 元数据定义 (_moss_meta.json)
```json
{
  "id": "agent-id",               // 唯一ID，通常与文件夹名一致
  "name": "agent-name",           // 内部标识名称
  "display_name": "显示名称",      // 用户可见名称
  "description": "描述信息",       // 智能体功能描述
  "avatar": "https://...",        // 头像 URL (可选)
  "emoji": "🤖",                  // 表情符号 (可选)
  "source_type": "custom",        // 固定为 "custom"
  "tag": "custom",                // 标签
  "is_builtin": false,            // 非内置
  "enabled": true,                // 是否启用
  "ruleFile": "instructions.md",  // 规则文件名
  "skills": ["skill-id-1"],       // 关联的技能 ID 列表
  "enabledSkills": ["skill-id-1"],// 默认启用的技能 ID 列表
  "installed_at": "ISO-8601"      // 创建时间
}
```

### 3. API 接口 (POST /api/v1/agents/create)

**参数：**
- `name`: 唯一内部名称 (必填)
- `displayName`: 显示名称 (必填)
- `description`: 描述 (选填)
- `avatar`: 头像 URL (选填)
- `emoji`: Emoji (选填)
- `rules`: 规则指令内容 (必填)
- `skills`: 关联技能 ID 数组 (选填)

**逻辑步骤：**
1. **重名校验**：调用 `findAssistantDir` 检查名称是否冲突。
2. **创建环境**：创建 `_my-custom-assistant/{name}` 文件夹。
3. **文件写入**：
   - 写入 `instructions.md`。
   - 构造并写入 `_moss_meta.json`。
4. **Scode 同步**：
   - 调用 `bridgeAgentToScode(name, dir)` 建立桥接。
   - 调用 `refreshInstructionsFile()` 刷新指令文件，确保 `scode` 能发现新智能体。

## 成功标准
- [ ] 能够通过接口成功创建新的智能体文件夹。
- [ ] `GET /api/v1/agents/installed` 接口能返回新创建的智能体。
- [ ] `scode` 端能发现新创建的智能体并加载其指令。
- [ ] 智能体能正确关联并使用指定的技能。
