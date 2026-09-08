# Sudowork 管理端能力迁入 Moss 对照矩阵

## 判定原则

- Moss 管理端是唯一长期维护入口，不复制旧 Sudowork 管理端工程。
- 已有同义能力直接复用 Moss 页面；只有没有等价入口的运营能力新增页面。
- 新页面调用同一套 Moss 身份、组织、账本、Dify 和 QMS 服务。旧 URL 只是协议入口，不拥有数据。
- 企业管理员只能查看当前 Organization；超级管理员使用 Moss 现有组织切换器切换管理范围。

## 能力矩阵

| Sudowork 旧菜单 | Moss 统一入口 | 结论 | 说明 |
| --- | --- | --- | --- |
| 仪表盘 | `/` 数据看板 | 需增强 | Moss 看板继续作为全局入口；财务和质量详情进入各自运营页。 |
| 企业列表 | `/users` + `/settings/enterprise` | 已有 | 组织切换、成员数量、企业资料和本地/云端策略使用 Moss Organization。 |
| 配置项列表 | `/secrets/config-items` | 已有 | 配置定义、组织授权和密钥引用均使用 Moss 配置中心与 Nexus。 |
| 用户管理 | `/users` | 需增强 | Moss 用户页是唯一用户管理入口；旧审批接口映射统一用户状态与钱包命令。 |
| 专属技能 | `/settings/skill` | 已有 | 本地与云端共享同一 Skill Catalog。 |
| 专属智能体 | `/settings/agents` | 已有 | 本地、Moss Runtime、Dify 共用同一 Agent 主数据和可见性。 |
| 知识库管理 | `/document-center` | 已有 | 统一文档、外部数据源、构建任务和 Dify Dataset 绑定。 |
| 定时任务 | `/cron` | 已有 | 本地任务只下发配置，企业任务由 Moss 云端执行。 |
| 渠道管理 | `/channels`、`/corp-apps` | 已有 | Channel、企业应用、租约和云端 Session 均由 Moss 管理。 |
| 订单管理 | `/operations/billing` 的“订单”页签 | 新增 | 读取统一 Billing 订单，提供同步、重试和退款操作。 |
| 充值记录 | `/operations/billing` 的“充值记录”页签 | 新增 | 读取统一 Billing 活动记录，不维护旧充值表。 |
| 积分申请 | `/operations/billing` 的“授信申请”页签 | 新增 | 读取并审批统一 CreditApplication。 |
| 邀请码管理 | `/operations/invitations` | 新增 | 使用统一 Invitation 与稳定数字别名，支持筛选、批量创建和撤销。 |
| 操作日志 | `/operations/audit` | 新增 | 查询统一 `operation_audit_events`；历史日志由迁移命令导入。 |
| QMS 总览/用户/会话/安装 | `/operations/quality` | 新增 | 同页签承接 QMS PostgreSQL 聚合查询。 |
| QMS 性能/崩溃/告警/系统 | `/operations/quality` | 新增 | 运维页签复用统一 QMS 服务；旧隐藏菜单能力仍可达。 |
| 系统配置 | `/settings`、`/settings/server-credentials`、`/settings/enterprise` | 已有 | 登录方式、Dify、支付、QMS 和组织品牌分别进入现有统一设置。 |

## API 接入

新增运营页继续调用已经接入统一领域服务的 `/api/v1/admin/invitation-codes`、`/api/v1/admin/recharge/*`、`/api/v1/admin/credit-applications`、`/api/v1/admin/logs` 与 `/api/v1/qms/*`。这些无冲突路由在 Moss 域名和旧 Sudowork 域名上共用同一个 Hono 处理器；处理器同时接受 Moss Access Token 与旧 JWT，并保持各自 Organization 权限。

不把 `/api/v1/admin/users`、认证接口等与 Moss 原生路径冲突的旧路由暴露到 Moss 域名；对应页面继续使用 Moss 原生 API。

## 验收口径

- 每个旧菜单都有明确的新入口或兼容保留理由。
- 新增入口只对具有对应管理 scope 的角色显示。
- 页面具备加载、空数据、失败、分页和确认操作状态。
- 桌面与移动视口无横向遮挡；表格允许在自身区域横向滚动。
- 旧域名行为和 216 条冻结接口不因管理端接入而改变。
