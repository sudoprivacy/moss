# 外部 Agent 任务授权接入

此增量把已审核的外部 Agent 任务接入 Nexus 的短期任务身份、Moss 模型网关及工具 MCP 网关。它沿用 Agent Registry、Task、ExecutionGrant 的 owner，不新增用户 Token 格式。HTTP、OpenAI Chat Completions、MCP Agent 工具和 A2A 的协议适配器共用此边界。

## 1. 适用范围

这是可选的 `sudo-task-grant/v1` 接入声明。服务必须明确实现接收逻辑；普通 OpenAI compatible 服务、现有 Dify 应用、任意 MCP 工具或 A2A 服务不会因协议名称相同而自动支持任务权限。

外部服务只会收到任务限定的 IAM 凭据，不收到 Router 管理凭据、实际模型 API Key、工具连接密钥或浏览器登录凭据。模型与业务工具由服务主动调用 Moss 网关；服务自己的数据库连接和外联仍需单独治理。

首版支持 HTTP query-only v1、OpenAI Chat Completions、MCP 2025-06-18 JSON 响应和 A2A 0.3.0 单轮调用。durable HTTP v1alpha2、跨任务续期、崩溃后重新签发以及自动重放不在此声明内，schema 会拒绝不支持的组合。Dify query-only 适配器不注入隐藏输入。

## 2. 管理员操作

1. 服务提供方生成包含以下声明的 Manifest，并实现接收端。Moss 管理员在“专属智能体 → 外部托管 → 接入外部智能体”上传文件、测试连接。页面显示申请的模型、工具和每任务模型调用上限。
2. 在智能体台账登记负责人、部门、来源、办公域、模型路径和工具资源，并关联目录中的 Agent。工具资源来自已有 MCP 服务的逐工具审核结果，不能直接填远端任意 URL。
3. 按实际接入边界完成验收，记录证据，再审核等级。L0 不获得执行权限；核心域仍要求 L2。
4. 审核并发布固定版本，授权用户。版本页保留权限声明，权限变化随新来源摘要和新发布版本审核。
5. 员工在 SudoWork“智能体库 → 专属智能体”选择 Agent，沿用统一对话。每次执行申请独立短期授权；可信费用仍显示在 Moss 台账的成本与用量页。

```json
{
  "execution_context": {
    "profile": "sudo-task-grant/v1",
    "model_resource": "enterprise-model",
    "tool_resources": ["mcp:reviewed-server/add_numbers"],
    "max_model_calls": 1
  }
}
```

此片段嵌入已有 `CustomAgentManifest`，不替代完整 Manifest。工具最多 16 个，模型调用上限为 1～32；所有资源还受 Nexus 组织策略、资产声明、MCP 审核和活跃用户校验约束。声明本身不授予权限。

## 3. 服务端部署

Moss 需要已有 Registry/IAM、模型执行网关与适用的工具网关。设置 `MOSS_AGENT_EXTERNAL_TASK_CONTEXT_ORIGIN` 为外部服务能够访问的 Moss 根 origin。非本机 origin 必须 HTTPS，不能带用户信息、路径、查询串或片段。该部署开关不允许调用者通过请求覆盖。各实例须使用相同配置和共享任务数据库；配置缺失时声明该能力的 Agent 拒绝执行。

模型 `run` 模式仍强制经过 Nexus 内容路径和 Router。网关配置、模型密钥、工具连接密钥由已有部署与 Secret owner 管理。实验中的本机 HTTP 例外只用于隔离联调。

## 4. 调用契约

在实际执行请求中，保留原 Provider 的 `Authorization`，附带：

- `X-Sudo-Execution-Context`：无密钥元数据的 UTF-8 JSON、base64url 无 padding 编码。
- `X-Sudo-Execution-Token`：Nexus 为本任务签发的短期 IAM 凭据。

元数据字段为 `profile`、`model_resource`、`tool_resources`、`max_model_calls`、`task_id`、`attempt_id`、`session_id`、`org_id`、`grant_id`、`spec_digest`、`expires_at`、`model_gateway`、`tool_gateway`。期限为毫秒 Unix 时间戳，最多五分钟且不能晚于任务截止时间。两个 header 合计最多 12000 字符。

发现、MCP 初始化/工具列表、A2A 轮询和 MCP 会话清理不携带任务凭据。凭据不会写入 TaskSpec、Registry 制品、prompt 或历史；服务返回中直接回显凭据时拒绝持久化及用户展示。接收端也必须关闭敏感 header 日志，并在执行结束后释放内存中的凭据。

接收端须校验声明、组织、有效期和字段，再将网关 origin 与自身部署白名单比较。不能直接信任 header 中的地址转发 Token。参考接收器 `readTaskExecutionContext` 和 `src/server/testing/taskProtocolExecution.ts` 演示校验。网关仍独立调用 Nexus 逐次鉴权，header 不是最终授权证明。

模型调用见 `agent-execution-gateway-http.md`；业务工具见 `agent-tool-gateway.md`。`call_id` 只用于调用幂等，任务关联来自经过授权的 `task_id`；不能依赖 call_id 命名推断归属。

## 5. 生命周期与故障

Moss 先确认已发布版本、已纳管资产、权限资源和当前用户，在持久记录中预约一次 Attempt，再向 Nexus 申请 `mode=run` 的 grant。记录不保存原始 Token。资产停用与恢复改变本地 generation，旧任务不得跨越该边界重新激活。

结束、失败或超时后，先记录关闭意图，再独立处理 Nexus request fence/revoke 和本任务全部 Router token 清理。Nexus 不可达不阻止尝试 Router 清理。任一项未确认，保留 `cleanup_pending`；已有回答不变成“已成功且清理完成”。维护循环按最近清理时间轮转，避免永久失败记录阻塞其他任务。

重启只核对和清理终态/超时任务，不重新签发、不重发 Provider。关闭状态不能被延迟的签发响应覆盖。清理成功只说明可控授权被回收，不承诺远端 Agent/工具已经取消、回滚或没有副作用。

## 6. 本地参考服务

`AGENT_REFERENCE_EXECUTION_FILE` 可指向包含 `profile`、`gatewayOrigin`、`orgId` 的 JSON 文件，再运行现有 `scripts/agent-protocol-reference.ts`。四种本机协议样例可以在合成加法任务中先调用已审核工具，再调用真实模型网关；默认不设置此文件时仍是无模型的确定性协议样例。

这些参考服务用于接入和故障验证，不是 Dify、LangGraph、第三方 SaaS 或企业业务 Agent 的完整认证；不得把本机样例的通过结果套用于未测试的平台。

## 7. 本批验证记录（2026-10-21）

- Moss 全量：1288 通过、13 跳过、0 失败；新增任务生命周期/上下文/模型清理专项25项通过，包含真实 PostgreSQL 双控制器竞争；四协议 HTTP 工具→模型集成4项通过。服务端类型错误维持原有104条基线，未提高基线。
- Nexus 相关 Registry、资产、执行授权 API：SQLite55项、PostgreSQL55项通过。GET admitted-asset 只读，不登记、不发布、不切换频道。
- 四种本地参考服务均完成真实 Nexus IAM→工具 MCP→模型内容路径→Router 实际模型/账单的评测态验收；撤销后迟到模型请求401。随后按24小时合成范围分别记录本地L1证据、审核并发布。
- 四种服务均再次从正式 External Task 入口执行18+24=42：自动签发run grant、固定版本、真实工具/模型、可信账单、重复任务请求同一任务、生命周期closed且清理已确认。
- 浏览器实测：Moss版本页展示模型/工具资源和每任务上限；SudoWork统一历史中可打开A2A任务，显示42和已完成。

私有实验目录为 `/tmp/agent-v11-lab-20261021`，安全证据为 `task-protocol-{http,openai,mcp,a2a}-{qualification,run}.json`。凭据文件不进入仓库，证据不含原始Token。以上不代表生产HA、第三方平台完整L1、原生迁移或全部Agent管理1.1验收；真实IM按用户决定后置。
