# Agent 平台第一阶段：能力说明与兼容入口边界

状态：本分支实现 N01、N03；N00/候选交付的准备材料不等于 Registry、原生运行或生产发布已完成。

## 使用方式

Moss 组织管理员在「智能体库 → 专属智能体 → 外部托管」展开「能力与使用范围」。SudoWork 桌面端/WebUI 在相同目录和统一对话页消费同一响应，无额外 Provider 探测请求。

- 仅合成测试文本；附件、ResourceRef 和工具调用不受支持。
- Dify 支持流式回复，不支持取消、恢复、固定远端执行版本。
- HTTP v1alpha1 不支持流式、取消、恢复或固定执行版本。
- Durable HTTP v1alpha2 支持固定执行 revision 和查询同一 run 的恢复；不支持流式、取消。结果未知时不会重发模型请求。
- 数据类型仍为调用方声明，没有内容 DLP；来源身份仍为 unverified。
- 支持固定版本是适配器契约能力，实际任务执行证据仍通过 task evidence 单独查询。

## 增量契约

Moss owner：`contracts/external-provider/v1/contract.ts`。版本仍为 v1alpha5，新增可选 `usage` 字段，旧字段和请求行为保持兼容。Stack 从 Moss 精确 commit 生成，下游 Work 固定 Stack commit 和摘要。新客户端允许旧响应无 usage，显示「未提供」，绝不推定可用。

`capability_basis=adapter_contract`；`evaluated_at` 是本次只读投影时间，不能称为联网检查时间。`reviewed_at` 只在显式批准且检查成功后记录；历史批准记录没有此时间时返回 null。配置失效/未批准时返回 null。`review_state` 只反映生成时的批准及期限；实际派发仍复核政策、授权、凭据和连接。无后台探测、隐式发布或 GET 写入。

## N03 profile 清单

| Profile | 入口/服务 | 权限和能力边界 |
|---|---|---|
| 新 external_hosted synthetic_pilot | external-agents 目录/管理、正式 Task ingress | 组织授权、批准期限、端点政策、凭据状态、版本解析和能力准入；只允许合成 query |
| 旧 Dify runtime | agent-templates chat/stop/conversations/messages/feedback/suggested/parameters/meta/files/audio | 活跃身份、目录可见性、同组织 connection 和 Nexus secret；全部通过 resolveRuntimeContext，external_hosted 在取密钥前拒绝 409 |
| 旧 Dify enhancement | describe/invoke/invoke-stream，workflow/agent-chat/rag-only | resolveEnhancementContext；新外部绑定 describe disabled，blocking 拒绝 409，stream 输出 error 事件且零外发 |
| 旧组织 dataset 管理 | difyDatasetService 的 dataset/document/retrieve | 独立组织连接、读写权限、CommandContext；resolveOrganizationContext 排除 external_hosted 连接，不能据此宣称已具备 Pilot 内容治理 |

旧入口中原有文件、语音、stop、dataset 功能继续按旧权限运行，不计入新 Pilot 能力。后续 G01/G03 必须分别覆盖这些出口后，才能声称组织全部 Dify 外发经过内容治理。

## 验证

- `node scripts/run-node-tests.js externalProviders agentFederation dify src/server/api/compat/sudowork/difyRoutes.node-test.ts`
- 管理端 `bun run check`、`bun test tests/external-agent-usage.test.tsx tests/external-agents-api.test.ts`、`bun run build`。
- 新测试检查旧审核时间不伪造、读取无写入、三种适配器能力、禁用失效、6 种 legacy mode 与所有旧 runtime 操作拒绝且零密钥读取/零 Provider 外发。
- 既有 Task admission 测试继续覆盖过期、越权、能力不支持、非 synthetic、资源引用以及未知结果不自动重发。

## 下一步

N00 的通用 Registry/原生 resolution owner 和接口需在实际上游确认后才能冻结。当前 accepted resolution 仍为 external_hosted，不能把这次 usage DTO 解释为已支持原生托管 Task。D01–D03 需要新的组件制品、Provider 组件配置和真实安装验收；当前本地构建与 UI 测试不替代部署证据。
