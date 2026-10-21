# Agent 工具 MCP 网关（AM-07）

此增量让 Agent 使用已有 MCP 服务时，经过任务身份、资产范围、组织策略和逐工具审核。它复用 Nexus 的 `CheckExecutionGrant` / `tool.invoke`，不增加 IAM Token 格式，不把 MCP 管理凭据交给 Agent，也不替代现有 MCP 目录。

## 产品操作

1. Moss → 智能体管理 → 智能体台账 → **管理工具授权**，进入已有企业 MCP 服务页。
2. 创建并测试一个 HTTP MCP 服务。组织 MCP 策略须允许 HTTP、允许网络访问，并列出服务的精确主机名。地址、服务凭据仍由原 MCP 配置管理。
3. 点服务行的 **Agent 工具授权 → 读取工具定义**，选择工具并核对输入结构。管理员明确选择读取/写入、敏感字段和工具外联；远端 `readOnlyHint` 不授予权限。
4. **确认审核并授权**后，复制生成的资源标识 `mcp:<server-id>/<tool-name>`，登记到资产台账的工具引用。Nexus 部署的执行权限白名单以及任务签发权限也须包含这一精确资源。
5. 同一面板查看最近调用的任务、资产、执行身份、发起用户、目标和结果状态。读取状态不会重新调用工具、刷新授权或修改记录。
6. **停用工具授权**为本地持久操作，即使工具服务断网也可完成。后续派发被拒绝；已有远端操作可能继续执行。再次启用需重新读取并显式审核。

管理 API 同时要求当前数据库中的活跃管理员身份、登录角色和 `admin:users` / `admin:mcp` scope。不能通过陈旧管理员 JWT、普通用户、部门管理员或伪造发起人字段修改工具授权。

## 两种 MCP 的区别

- Agent 来源适配器 MCP：调用某个平台提供的 Agent 工具，获取 Agent 回答，对应 AM-12。
- 本文工具网关：Agent 在执行过程中调用业务工具，权限由任务 grant、资产工具声明与 MCP 策略共同决定，对应 AM-07。

两者分别测试，不能把一个 MCP 样例计为两项完整验收。

## 调用接口与权威边界

实验执行接口：`POST /api/v1/agent-tools/<moss-org-id>/invoke`，Authorization 使用 Nexus 为该任务签发的一次性短期 IAM 工作凭据。

```json
{
  "call_id": "task-unique-call-1",
  "grant_id": "grant-from-nexus",
  "task_id": "task-from-nexus",
  "spec_digest": "sha256:<64 lowercase hex>",
  "resource": "mcp:<server-id>/add_numbers",
  "arguments": { "a": 10, "b": 32 }
}
```

组织路径只是查询选择器。Moss 必须从 Registry 的组织配置获得 Zone，再校验返回 grant 的组织、任务、版本摘要、状态、期限和精确 `tool.invoke` 权限。IAM 验证、委派限制、资产审核以及 run 模式发布版本仍归 Nexus。发起用户和资产负责人来自受验证的 grant，不接受调用方覆盖。

本地管理接口位于 `/api/v1/admin/mcp-servers/<server>/agent-tools`：GET 审核记录，GET `/calls` 脱除工具返回正文的审计投影，POST `/discover` 读取定义，POST `/review` 条件审核，POST `/disable` 条件停用。审核和停用要求 `expected_revision`，防止覆盖其他管理员的新决定。

这组接口是 Moss 管理/执行适配面；底层共享 `ExecutionPermission` 契约未变。不能把它称为新版本的稳定 Sudo 六项契约。

## 执行与故障行为

- 真实工具定义的协议版本、schema 和描述构成审核摘要。每次执行重新发现并比对；变化时拒绝，不静默接受新权限。
- 先保留持久调用记录，再检查用户、工具范围和实时权限。相同组织与 call_id 的请求只派发一次，参数或 grant 不一致返回冲突。
- 每个 grant 最多保留 32 次工具调用。输入正文最多 40 KB、参数最多 32 KB，工具返回最多 128 KB。整个调用最长 60 秒并受 grant 更早到期时间约束。
- 最后派发准入与 MCP 服务/组织策略、工具审核和资产停用共享数据库锁；资产 generation 防止停用前准备好的请求跨越停用/重新审核继续执行。
- 派发前失败记为 rejected；工具正式返回 `isError` 记为 tool_error；派发后断网、超时或无可验证返回记为 unknown。重复请求、重启后的旧请求都不会重发。未结束记录过期时，读取投影为 unknown。
- 远端工具已受理后停用，不承诺取消、回滚副作用或抹去返回结果。停用资产通过现有本地 gate 与 Nexus grant 撤销阻止后续派发；在途工具事实保留在工具调用记录中。
- 权限拒绝的运行记录在可信 grant 验证后保留。无法通过 IAM 验证的调用返回拒绝，不把调用方自报身份写成可信任务主体。
- 只附加本地表：agent_tool_reviews、agent_tool_calls、agent_tool_grant_limits、agent_tool_review_audit。没有旧数据复制/删除或启动迁移切换。

## 当前支持范围

使用官方 TypeScript MCP SDK，支持协商版本 2025-06-18 / 2025-11-25 的 Streamable HTTP **JSON 返回** profile。工具输入为简单标量对象（字符串、数字、整数、布尔值与枚举），明确禁止额外字段。写操作如要求确认而没有确认机制，本 profile 返回 `TOOL_CONFIRMATION_REQUIRED`。

固定管理员审核端点；DNS 验证后钉住实际连接地址，拒绝重定向、混合公网/私网解析、metadata/link-local 目的地和任意发现链接。原有 Router 模型传输复用相同低层实现并保留原检查。工具服务只获得其自身配置的凭据，不获得 Nexus IAM/Router 管理凭据。

当前不支持 SSE 输出、OAuth 自动交互、stdio 工具、工具 resource/image 返回、复杂 schema、个人 MCP、无人值守确认和通用网络出口治理。工具自身外联、未走网关的直连业务系统仍在边界之外。现有 L2 纯文本制品没有因此获得工具执行能力；原平台具体 Agent / Work Task 的工具调用装配、协议归因和完整 L1 覆盖仍需在后续批次验证。

## 本地参考与证据

`node --import tsx scripts/e2e/agent-tool-reference.ts` 启动只监听 127.0.0.1 的官方 SDK 参考工具。需预置私有 `AGENT_TOOL_KEY_FILE`（文件权限 0600，至少 32 字符）；可选 `AGENT_TOOL_PORT` 默认 22175。仅支持两个合成数字相加，不访问业务数据、模型、磁盘或外部网络。不要把参考服务部署成企业业务工具。

自动化覆盖允许调用、真实 SDK 发现/执行、凭据不混传、伪造任务/组织/Token、无权限与离职用户、远端只读提示、定义变化、缺失/错误参数、重复并发、丢失响应、重启重放、停用/恢复代次、管理员 scope、审计 GET 不写、断网停用以及独立 PostgreSQL controller 竞争。PostgreSQL 测试使用 `MOSS_PG_TEST_URL` 指向专用测试数据库，创建并清理随机 schema；未配置时明确 skip。

2026-10-21 隔离环境实际链路：Nexus/IAM → Moss HTTP 执行接口 → 本地官方 SDK 工具，10+32=42；幂等重放仅一次远端调用，伪造任务 403，管理员 UI 停用后新调用 rejected，撤销 IAM 后迟到调用 401。凭据在测试结束时回收。安全证据 `/tmp/agent-v11-lab-20261021/tool-gateway-evidence.json`；测试资产仍是 L0，本证据不授予完整 L1/L2，也不替代真实 IM 验收。
