---
name: park-consultation-tools
displayName: 园区咨询工具
description: Use this skill when answering park anonymous consultation questions. It provides policy search with citations and the park public profile. Completed inquiries and lead extraction are managed by the server. All calls go through the session-scoped park API with SESSION_TOKEN.
version: 1.1.0
category: 园区招商
emoji: "🏭"
---

# Park Consultation Tools

园区咨询助手的工具集。所有请求通过 `scripts/park-tools.mjs` 发起，脚本自动携带
`SESSION_TOKEN` 与 `MOSS_SERVER_URL`（会话容器内环境变量），园区与会话上下文由服务端
从会话推导——**不要**尝试在参数中提交任何组织/园区标识。

## 硬性规则

1. 咨询问答由服务端在成功完成后保存，结构化提取与线索草稿异步生成，无需调用 `inquiry.append`。
2. 回答政策问题前**必须先 `policy.search`**，回答必须引用命中的文档名与行号
   （如「来源：租金减免政策.md 第 2 行」）。检索无命中时明确告知用户不确定、
   建议转人工咨询，**禁止编造政策内容**。
3. 线索由服务端根据用户原文提取并评分，由园区工作人员人工确认；无需调用 `lead.propose`。禁止向用户承诺成交或结果。
4. 工具返回 403 表示当前咨询会话的园区服务受限，向用户致歉并建议稍后再试，
   不要重试该操作。

## 用法（按平台选择）

Linux/macOS（Bash）：
```bash
node "${CLAUDE_SKILL_DIR}/scripts/park-tools.mjs" <command> [json-args]
```

Windows（PowerShell——引擎运行在 Windows 时**必须用这种形式**，Bash 包装层不可用）：
```powershell
$env:CLAUDE_SKILL_DIR; node "$env:CLAUDE_SKILL_DIR\scripts\park-tools.mjs" <command> '<json-args>'
```
（`CLAUDE_SKILL_DIR` 未注入时，先用 `Get-ChildItem -Recurse -Filter park-tools.mjs "$PWD" | Select-Object -First 1` 定位脚本绝对路径再执行。）

## 命令

### policy.search — 政策检索
```bash
node "${CLAUDE_SKILL_DIR}/scripts/park-tools.mjs" policy.search '{"q": "租金减免"}'
```
返回 `matches: [{ file, line_no, line, wiki_id }]`。引用时使用 `file` + `line_no`。

### inquiry.append — 兼容意图建议（可选）
```bash
node "${CLAUDE_SKILL_DIR}/scripts/park-tools.mjs" inquiry.append '{
  "question": "用户本轮的问题",
  "answer": "本轮回答摘要",
  "intent": "policy_inquiry",
  "industry_tags": ["AI"]
}'
```
`intent` 取值：`policy_inquiry | settlement_intent | rent_consultation |
subsidy_application | service_request | other`。引用来源由服务端按本轮 `policy.search`
的实际命中记录，无需在参数中提交。

### lead.propose — 兼容线索建议（可选，完成后由服务端提取）
```bash
node "${CLAUDE_SKILL_DIR}/scripts/park-tools.mjs" lead.propose '{
  "industry_tags": ["AI", "机器人"],
  "suggested_action": "建议安排园区参观与租金政策讲解"
}'
```
这两个兼容接口仅在正在执行的咨询轮次可用，返回服务端管理状态，不直接创建咨询或线索。

### park-profile.read — 园区公开信息
```bash
node "${CLAUDE_SKILL_DIR}/scripts/park-tools.mjs" park-profile.read '{}'
```

### service-catalog.read — 园区服务清单
```bash
node "${CLAUDE_SKILL_DIR}/scripts/park-tools.mjs" service-catalog.read '{}'
```
