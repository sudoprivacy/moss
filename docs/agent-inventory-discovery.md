# Agent 1.1：台账、发现和认领

本增量提供 AM-01～04 的发现、登记入口和 AM-13/14 的推荐、发布准入基础。不是完整 1.1 验收报告，未授予任何 Agent L1/L2 等级。

## 操作

Moss → 智能体管理 → 智能体台账。管理员可扫描当前组织目录、已连接的 IM Bot，添加 Dify／Router／平台清单来源。负责人在“发现与认领”认领，再补充用途、数据／工具／模型连接并提交；管理员退回或审核。管理员也能为资产选择组织内有效负责人。导出 JSON 保留来源、风险、证据和修订号；缺失成本不会显示为零。

发现和登记不开放运行权限。核心域策略来自 Nexus，不会因浏览器选择“办公域”而降低；无有效 L2 证据时，发布／频道提升／执行解析被拒绝。组织共享目录、个人 Agent 和资产台账各自保留归属语义。

## 部署前置

沿既有 Registry 显式初始化流程创建附加台账表。普通启动和 GET 不迁移、不发布。Moss 配置 `MOSS_AGENT_REGISTRY_CONFIG_FILE` 并连接 Nexus 密钥库；Nexus 配置台账域策略和验收签发者。未配置验收签发者时，不接受自行声明的 L1/L2/L3。

`MOSS_AGENT_DISCOVERY_ORIGINS` 为按 Moss 组织 ID 分组的 JSON 地址数组，例如 `{"org-example":["http://127.0.0.1:22145"]}`。这是部署方允许连接的服务地址，组织管理员从已批准地址中选择来源。当前只支持 IP 地址，拒绝 URL 凭据、路径、查询和重定向；尚未支持 SaaS 域名的直接连接。域外来源可从平台清单或手工登记纳入 L0。

来源配置复用 IntegrationConnection，凭据存 Nexus secret namespace。前端和台账不返回凭据。来源创建／停用进现有操作审计；资产写入及实际发起人进 Nexus 修订历史。停用发现来源只停止扫描，和 Agent 运行停用不同。

## 来源边界

| 来源 | 实际读取 | 边界 |
|---|---|---|
| Moss 目录 | 当前组织拥有的目录元数据 | 不把其他组织共享目录导入为本组织资产 |
| IM | 本组织且所有者仍属于本组织的已存 Bot 连接元数据 | 不连接 Bot、不读取聊天；连接候选须认领、确认或合并，不能自动判断其业务 Agent |
| Dify | GET `/console/api/workspaces` 当前工作区，以及分页 `/console/api/apps` | 工作区 ID 必须匹配；1.14.2 需要同次登录的 access_token、csrf_token。过期后重新添加来源，不自动切换工作区。不会读取应用密钥或修改应用 |
| SudoRouter/new-api | `/api/log/query` 指定账户最近 24 小时的消费记录 | Token ID 仅是调用来源候选，不能自动当成可信 Agent 身份。无 Token ID 和网关外调用不可识别；真实 Router 验收尚待后续身份／计量链路 |
| 平台清单 | GET `/agent-inventory/v1/agents?scope=...&after=...` | owner 为 Nexus `PlatformDiscoveryPage`；仅发现元数据，不能据此授予身份或运行等级 |

清单接口使用 `agent-inventory.sudo.dev/v1alpha1`、`scope`、至多 100 个排序的 `items` 和 `next_cursor`。每项只有 `id/name/platform/external_domain`。这是实验发现 profile，不替代 HTTP、OpenAI、MCP 或 A2A 的运行协议。精确 schema 沿 Nexus → SudoStack → Moss 的 source lock 分发。

一次远端扫描最多 100 页／一万条。扫描失败明确返回 `complete:false` 和已处理计数；已写入的记录保留，重扫幂等去重。来自同一来源的最新快照覆盖该来源的展示证据，历史请求和修订仍保存。未知负责人为 null；认领有修订冲突检查，不能抢占已认领资产。合并是显式管理员操作，不移动已绑定的运行身份。

## 当前验证

- 实际 Dify 1.14.2 的 8 个应用通过 Moss 网关进入真实 Nexus 台账，均保持 L0、待认领；重复扫描新增和更新均为 0。
- 隔离环境预埋的目录、停用 Bot、HTTP、域外 SaaS 元数据样例均被发现。后两者仅为清单协议样例，不是实际 SaaS 或 LangGraph 运行服务。
- 实际 HTTP 验证认领、幂等、跨组织资产及来源隔离、普通用户拒绝管理员扫描；真实页面验证重复扫描及域外样例认领。
- 底层测试覆盖分页、错误工作区、Router 错误账户、未知字段、重定向拒绝、组织地址白名单、无凭据泄露、负责人和部门校验。
- 成本仍为不可用；短期 IAM 身份、真实 Router 归因、MCP 工具路径、IM 实际调用、Dify/LangGraph L2、同集评测和原生转换仍须继续交付。

运行本地清单样例：`npx tsx scripts/agent-inventory-reference.ts <私有输出目录> [端口]`。连接参数仅写到私有文件。不要把该目录或 `.planning` 内的联调凭据提交到仓库。
