# 园区 AI 招商平台部署初始化 Runbook（P0）

对应实施计划 2.5"部署初始化（操作流程，非代码）"与四.4"配置说明"。覆盖 moss + webui 两侧的初始化步骤、环境变量与 E2E 环境要求。

## 一、部署初始化操作流程

按顺序执行（全部使用 moss 现有管理能力，无专用脚本）：

1. **创建园区组织与系统运营用户**：用 moss 管理能力创建园区 org；在园区 org 内创建系统运营用户（moss `role=admin`，组织内语义）。
2. **标记默认园区与服务清单**：以系统运营身份 `PUT /api/v1/parks/:parkOrgId/settings`，设置 `is_default_park` 与服务清单（`metadata_json.service_catalog`）——无邀请码的注册将绑定默认园区。
3. **上传政策文档并建知识库**：系统运营经园区端政策管理页（`/park/admin/policies`）上传政策文件（建议文件名带日期）、删除旧版、创建 wiki 并构建。政策更新 = 上传新文件 + 删旧 + 重建（版本/有效期管理后置，P0 决策）。
4. **创建园区咨询 Assistant**：用现有 tenant create（`admin:settings`）创建 Assistant，启用上一步的政策 wiki（enabledWikis）。
5. **上传 park skill**：将 `skills/park-consultation-tools/` 安装为 tenant skill，并在 Assistant 的 enabledSkills 中启用。
6. **分配 Assistant 给企业**：系统运营经 `/park/admin/assistant` 将 Assistant 分配给已绑定企业。

**运行约束（防御性）**：被分配的园区 assistant/skill 的 `visible_to` 建议保持 null——授权依据是分配表（显式授权），`visible_to` 只表达园区 org 内部可见性。

## 二、环境变量

| 变量 | 位置 | 默认 | 说明 |
|---|---|---|---|
| `PARK_REGISTER_RATE_LIMIT` | webui BFF | 10 | 注册转发限流（次/15 分钟/IP，express-rate-limit，进程内存） |
| `MOSS_PARK_REGISTER_RATE_LIMIT` | moss | 10 | moss 注册端点限流（次/15 分钟/客户端 IP，固定窗口，进程内存；≤0 禁用） |

两层限流参数对齐：经 BFF 的请求先被 BFF 计数（≤10 到达 moss），moss 只对直连流量额外生效，无双倍计数。

**部署要求：moss 注册端点若暴露公网，须前置单层反向代理覆写 `X-Forwarded-For`。** moss 限流 key 取 XFF 首个 IP（与 `server.ts` 主认证墙的 clientIp 解析口径一致）；无代理时直连方可伪造 XFF 换桶绕过——与仓库现有两处同款用法的信任模型一致（同 webui `app.ts` 的单跳 trust proxy 模型）。webui BFF 转发注册时已自动附带 `x-forwarded-for: req.ip`（单跳 trust proxy 下为真实客户端 IP）。

限流状态为进程内存（单实例约束，与 BFF 登录限流同架构决策）；多实例部署需改用共享存储。

## 三、E2E 环境要求（`apps/webui` Playwright）

`test:e2e` 需要以下环境（`playwright.config.ts` 的 webServer env，可用环境变量覆盖）：

- **本地 PostgreSQL**：`DATABASE_URL` 默认 `postgresql://postgres:postgres@127.0.0.1:5432/sudowork_webui`
- **可访问的 moss 实例**：`MOSS_BASE_URL` 默认 `http://10.0.1.79:43127`（`MOSS_WS_BASE_URL` 同址 ws）
- **seed 数据**：固定组织 UUID 常量见 `tests/e2e/park-userpath.spec.ts:12-14`（ORIGIN/PARK_ORG/ENT_ORG）；固定账号密码为各 spec `loginAs` 字面量（如 `park-pages.spec.ts` 的 `sysop/Sysop@2026`、`ops/Ops@2026`、`leader/Leader@2026`、`entuser/Ent@2026`）

## 四、人工验收清单执行指引（实施计划 5.6）

以下项无法确定性自动化（需真实模型/真实部署），部署后人工执行并记录：

1. **真实模型完整咨询**（必须经真实 `POST /api/v1/sessions` 入口创建会话）：企业用户提问 → assistant 流式回答带文档名+行号引用 → 自动 inquiry.append（含 intent）→ 有意向时自动 lead.propose。
2. 无依据问题 → 回答明确"不确定"并转人工。
3. 性能计时：首 token ≤2s、完整响应 ≤5s、WebUI 首屏 ≤3s、LeadProposal 回答完成后 ≤5s 生成或进入处理中。
4. 桌面端（Electron）启动目视确认无园区入口。
