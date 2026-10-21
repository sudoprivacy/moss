# 外部任务的模型／工具 HTTP 入口

此入口供持有 Nexus 任务执行凭证的受控 Agent 调用。它复用现有 IAM、模型内容路径、Router 与逐工具审核，不接受浏览器自行指定身份或 Router／模型密钥。

- 模型：`POST /api/v1/agent-models/<moss-org-id>/invoke`。
- 工具：`POST /api/v1/agent-tools/<moss-org-id>/invoke`，配置与权限见 `agent-tool-gateway.md`。
- 仅支持 `Content-Type: application/json`，可声明 UTF-8；不支持压缩请求。模型正文上限 256000 字节、工具正文上限 40000 字节，在读取时执行；正文读取最长 10 秒。
- Authorization 必须是 Nexus 为指定任务签发的短期执行凭证。查询串不能传递身份或 token；普通浏览器 JWT 不会被视为任务凭据。请求中的组织只是选择器，必须通过 IAM grant 的组织、任务、定义摘要及资源权限校验。

模型请求示例（所有标识与凭证由受信任务协调器提供）：

```json
{
  "call_id": "task-id:1",
  "grant_id": "nexus-grant-id",
  "task_id": "task-id",
  "spec_digest": "sha256:<64 lowercase hex>",
  "resource": "approved-model-resource",
  "input": {
    "messages": [{ "role": "user", "content": "20 + 22" }],
    "max_tokens": 64,
    "temperature": 0
  }
}
```

响应 `data` 是白名单投影：`kind=ModelInvocationResult`、`call_id`、`task_id`、`model_call_id`、`status`、成功时的 `output.text`、失败时的 `error_code`、`usage_status`。不返回内部 Router token、账户配置、资产负责人、提示词、原始账单记录或配置端点。组织管理员通过台账成本报表读取可信计量。

`preparing`／`dispatching` 表示请求已保留但尚无最终结果；过期的未结束记录只投影为 `unknown`。相同调用标识的重放沿用网关持久幂等规则，不产生第二次模型请求。凭证被撤销后，连历史结果的调用重放也需要拒绝。调用方断开时会请求中止本地等待；不能声称撤回 Router 已受理的请求或抹去已经发生的费用。

生产 run 凭证必须使用已配置的 Nexus 内容路径；评测使用独立授予的测试权限。模型调用次数、有效期、固定模型与输出长度上限继续由原网关执行。平台需要把短期任务上下文传给此入口，不能把 token 放进模型提示词。

本次新增的是 **HTTP 执行入口**，没有自动为所有外部 Provider 签发凭证或提升纳管等级。后续仍须完成各协议的任务上下文 profile、真实 Task 装配和 L1 停用组合验收。不能据此宣称 Dify、HTTP、OpenAI compatible、MCP、A2A 均已完成可信模型与工具链路。

## 2026-10-21 验证

4 项新增测试通过，包括真实 Node HTTP chunked 请求在派发前触发大小限制。Moss 全量 1272 通过、12 跳过、0 失败；服务端类型基线 104 未增加，修改模块 lint 和生产构建通过。

隔离环境使用实际 Nexus evaluation grant，经此 HTTP 入口、Nexus 内容路径和真实 Router 模型返回 `20 + 22 = 42`。相同请求重放保留同一调用；伪造任务被拒绝，超大正文 413，缺少凭证 401，撤销凭证后的重放 401。结束时已回收凭证，私有检查点移除了原始凭据。安全证据：`/tmp/agent-v11-lab-20261021/http-model-gateway-evidence.json`。

这是一次专门的网关评测调用，不是 Work 外部 Agent Task 的端到端证明，也不替代四协议样例或 R4。
