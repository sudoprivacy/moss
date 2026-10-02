# 扩展来源索引

研究日期：2026-09-19。Paperclip 固定版本：`685d4faba3715197fef85e7634f415b589f67812`。所有以下 GitHub 链接都固定到该 commit；不将后续更新自动视为本报告依据。MOSS 的固定版本和定位行号见主文档第 16 节。

## P1｜定位与许可

- [README](https://github.com/paperclipai/paperclip/blob/685d4faba3715197fef85e7634f415b589f67812/README.md)：产品定位与总体能力。
- [LICENSE](https://github.com/paperclipai/paperclip/blob/685d4faba3715197fef85e7634f415b589f67812/LICENSE)：标准 MIT；版权行为 Copyright (c) 2025 Paperclip AI。未对第三方依赖逐项审计。

## P2｜对象、成员授权、组织与导航

- [Core concepts](https://github.com/paperclipai/paperclip/blob/685d4faba3715197fef85e7634f415b589f67812/docs/start/core-concepts.md#L6-L105)：Company、Agent、Issue 等定义。
- [Companies API](https://github.com/paperclipai/paperclip/blob/685d4faba3715197fef85e7634f415b589f67812/docs/api/companies.md#L8-L25)：accessible 目录、membership、实例管理员与本地模式的区别。
- [Authentication](https://github.com/paperclipai/paperclip/blob/685d4faba3715197fef85e7634f415b589f67812/docs/api/authentication.md#L10-L56)：Agent key、短期 run JWT、company scope。
- [Org structure](https://github.com/paperclipai/paperclip/blob/685d4faba3715197fef85e7634f415b589f67812/docs/guides/board-operator/org-structure.md)：Agent 直属上级树、委派与升级。
- [Sidebar.tsx](https://github.com/paperclipai/paperclip/blob/685d4faba3715197fef85e7634f415b589f67812/ui/src/components/Sidebar.tsx#L167-L269)：当前导航、精简模式与实验开关。早期截图不可作为当前默认导航依据。

## P3｜目标、项目、任务与交互

- [Goals and projects](https://github.com/paperclipai/paperclip/blob/685d4faba3715197fef85e7634f415b589f67812/docs/api/goals-and-projects.md)：目标层级、项目与工作空间。
- [Issues API](https://github.com/paperclipai/paperclip/blob/685d4faba3715197fef85e7634f415b589f67812/docs/api/issues.md)：状态、单 Agent 指派、checkout、评论、附件、版本化文档、interaction 与 resolver 规则。

## P4｜Agent 生命周期、适配器与运行

- [Managing agents](https://github.com/paperclipai/paperclip/blob/685d4faba3715197fef85e7634f415b589f67812/docs/guides/board-operator/managing-agents.md)：环境测试、暂停／恢复／终止、配置 revision 与回滚。
- [Adapters overview](https://github.com/paperclipai/paperclip/blob/685d4faba3715197fef85e7634f415b589f67812/docs/adapters/overview.md#L104-L125)：ACP 与普通 Process／HTTP 的反馈粒度差异。
- [Heartbeat protocol](https://github.com/paperclipai/paperclip/blob/685d4faba3715197fef85e7634f415b589f67812/docs/guides/agent-developer/heartbeat-protocol.md)：唤醒触发、执行与有界 liveness continuation；续跑不等于失败重试或 session resume。

## P5｜首页、审批、成本与预算

- [Dashboard](https://github.com/paperclipai/paperclip/blob/685d4faba3715197fef85e7634f415b589f67812/docs/guides/board-operator/dashboard.md)：状态、工作、费用和活动概览。
- [Execution policy](https://github.com/paperclipai/paperclip/blob/685d4faba3715197fef85e7634f415b589f67812/docs/guides/execution-policy.md)：任务可选 review／approval，不是全局默认强制人工批准；当前参与者推进和带理由决策。
- [Costs and budgets](https://github.com/paperclipai/paperclip/blob/685d4faba3715197fef85e7634f415b589f67812/docs/guides/board-operator/costs-and-budgets.md)：UTC 月度、成本事件、Agent 80% 提醒与 100% 暂停。不能据此推断公司总预算具有同样硬停止行为。

## P6｜Routine 与 Skills

- [Routines API](https://github.com/paperclipai/paperclip/blob/685d4faba3715197fef85e7634f415b589f67812/docs/api/routines.md#L24-L218)：cron／时区、webhook／API、revision、并发与 missed-run 策略、Agent／Board 操作范围。
- [Skills store](https://github.com/paperclipai/paperclip/blob/685d4faba3715197fef85e7634f415b589f67812/docs/guides/agent-developer/skills-store.md)：Markdown playbook、导入、版本、fork、共享范围、外部 Git commit 固定与可执行脚本限制。

## P7｜Apps / MCP：特别注意未发布与隐藏能力

- [AppsSidebar.tsx](https://github.com/paperclipai/paperclip/blob/685d4faba3715197fef85e7634f415b589f67812/ui/src/components/AppsSidebar.tsx#L11-L77)：Browse／Review；Gateways／Profiles 暂时隐藏；Smoke Lab 受实验开关控制。
- [AppsReview.tsx](https://github.com/paperclipai/paperclip/blob/685d4faba3715197fef85e7634f415b589f67812/ui/src/pages/apps/AppsReview.tsx)：Approve／always-allow／decline 的待确认动作入口。
- [MCP access governance 发布草稿](https://github.com/paperclipai/paperclip/blob/685d4faba3715197fef85e7634f415b589f67812/doc/RELEASE-NOTES-mcp-access-governance.md)：标记 Draft，依赖操作者安装后 opt-in。图 5 是可参考的研发界面，不是“全部稳定可用”的证明。

## P8｜凭据、部署、数据存储与迁移

- [Secrets API](https://github.com/paperclipai/paperclip/blob/685d4faba3715197fef85e7634f415b589f67812/docs/api/secrets.md)：静态加密、绑定、按需读取 no-store、审计，以及注入进程后的风险边界。
- [Database](https://github.com/paperclipai/paperclip/blob/685d4faba3715197fef85e7634f415b589f67812/docs/deploy/database.md)：嵌入式／Docker／托管 PostgreSQL。
- [Storage](https://github.com/paperclipai/paperclip/blob/685d4faba3715197fef85e7634f415b589f67812/docs/deploy/storage.md)：本机与 S3 兼容对象存储。
- [Importing and exporting](https://github.com/paperclipai/paperclip/blob/685d4faba3715197fef85e7634f415b589f67812/docs/guides/board-operator/importing-and-exporting.md)：导出省略项、云托管导入限制、导入后暂停与激活。
- [部署概览（在线文档）](https://docs.paperclip.ing/reference/deploy/overview/)；[多用户登录（在线文档）](https://docs.paperclip.ing/how-to/enable-multi-user-login/)：local_trusted、authenticated/private、authenticated/public。在线页面未固定 commit，可能在研究日期之后改变。

## 截图证据

[image-sources.json](image-sources.json) 保存 8 张成品截图的原图 URL、固定 commit、原仓库路径、裁剪区域、输出尺寸和 SHA-256。开发环境、fixture 与 Draft 能力的标记见主文档逐图图注；没有把测试数据称作生产数据。

## 研究限制

未部署 Paperclip，未执行真实 Agent 调用，未登录外部 SaaS，未做越权／负载／隔离测试。MOSS 功能基线来自代码检索；“本次未发现”不能读成“产品绝对没有”。原图可证明特定界面场景，但不能独立证明后端执行、发布范围、性能或安全性。
