# Sudowork-server 兼容能力补齐到 Moss 的完整 PR 方案

日期：2026-09-16

目标分支：从最新 `origin/dev` 新建 `codex/sudowork-compat-gap-port`

目标 PR：一个完整 PR 合入 `dev`，不拆多个 PR。

## 1. 目标

本 PR 的目标是把此前完整迁移分支 `codex/sudowork-moss-consolidation` 中尚未进入最新 `dev` 的 Sudowork-server 能力补齐到 Moss，并满足两个硬约束：

1. Sudowork 客户端不需要修改代码。
   - 客户端继续请求原 Sudowork 域名和旧 API path。
   - 原 path、method、query/body、响应字段、错误格式尽量保持兼容。
   - 切换时只需要将原 Sudowork 域名流量指向 Moss。

2. Moss 管理端必须具备对应入口。
   - 不再维护旧 Sudowork 管理后台。
   - 旧后台的运营能力迁到 Moss admin。
   - 所有页面接入 Moss 当前组织、用户、权限、凭据体系。

最终效果：

- Sudowork 本地执行模式：任务仍由 Sudowork 客户端本地执行，Moss 统一管理用户、组织、配置、邀请码、agent/skill、余额、用量、Dify、QMS。
- Sudowork 云端/企业模式：继续使用 Moss 当前云端执行能力。
- 用户、组织、SudoRouter 账号、token/api key、余额、用量统一维护。
- 管理端入口统一到 Moss admin。

## 2. 当前 dev 已有能力

最新 `dev` 已经具备以下能力，新的完整 PR 不应重复实现：

- 手机号验证码登录。
- 腾讯 SMS 发送。
- `/api/v1/system-config` 客户端启动配置。
- SudoRouter 用户创建、token/api key、余额、用量。
- 用户初始额度。
- 积分申请与管理员审批。
- 手机号用户导入/迁移。
- 富友支付、充值订单、退款、同步、重试、人工对账。
- 支付运营页面 `/operations/billing`。
- 服务器凭据入口：SudoRouter、富友、SMS 等。
- 最新 `bun run test`、`bun run typecheck`、`bun run build:node` 门禁。

因此本 PR 不应整套搬运完整迁移分支中的 `src/server/billing/*`，避免与 dev 当前 `src/server/credits/recharge.ts` 形成两套支付域。

## 3. dev 仍缺的能力

完整迁移分支中仍未进入 dev 的主要能力：

- Sudowork 旧接口兼容层：`src/server/api/compat/sudowork/*`
- 旧 Sudowork API 合同文件：`contracts/sudowork/*`
- 合同抽取与校验脚本：`scripts/contracts/*`
- Dify 集成：`src/server/dify/*`
- QMS / Telemetry / Crash / Alert：`src/server/qms/*`
- Sudowork 数据迁移模块：`src/server/migration/*`
- Moss admin 运营中心完整入口：
  - 运营总览
  - 用户运营
  - 邀请码管理
  - 计费运营
  - 质量监控 / QMS
  - 操作审计
  - Sudowork 设置
  - Dify 数据集
- QMS 迁移脚本：`scripts/migrate-sudowork-p5-qms.ts`

## 4. 单 PR 范围

本 PR 是一个完整补齐 PR，包含以下模块：

1. API 合同与兼容基线。
2. Sudowork 旧 API 兼容层。
3. 身份、注册、邀请码、用户投影、客户端配置兼容。
4. agent / skill / catalog 兼容。
5. 支付旧接口兼容，但内部接 dev 当前支付实现。
6. Dify 集成与管理端入口。
7. QMS / Telemetry / Crash 集成与管理端入口。
8. Moss admin 运营中心完整入口。
9. Sudowork 数据迁移工具。
10. 合同校验、测试、构建验证。

虽然是一个 PR，但提交应按模块拆清楚，便于 review。

## 5. 后端兼容层设计

新增或恢复：

- `src/server/api/compat/sudowork/app.ts`
- `src/server/api/compat/sudowork/hostDispatch.ts`
- `src/server/api/compat/sudowork/routeInventory.ts`
- `src/server/api/compat/sudowork/transportContract.node-test.ts`

兼容层职责：

- 接收旧 Sudowork 客户端请求。
- 保持旧 path、method、参数、响应结构。
- 将请求转换为 Moss 内部统一服务调用。
- 不维护第二套 Sudowork-server 业务状态机。

接入方式：

- 在 Moss server 主路由中挂载 Sudowork compatibility app。
- 原 Sudowork 域名指向 Moss 后，请求仍按旧 path 进入兼容层。
- Moss 自有 API 不受影响。

兼容层必须覆盖：

- 登录 / 注册 / 验证码。
- 邀请码注册。
- 用户资料。
- 客户端配置。
- agent / skill 列表。
- 模型列表。
- 余额 / 用量。
- 积分申请。
- 支付 / 充值兼容接口。
- Dify 相关接口。
- QMS / telemetry / crash 上报接口。
- 管理端旧接口中仍需要保留的运营接口。

## 6. 身份、配置、用户投影

提取并适配：

- `identityService.ts`
- `configService.ts`
- `systemConfigService.ts`
- `userProjectionService.ts`
- `casService.ts`
- `legacyRateLimit.ts`
- `redisLegacyStore.ts`

实现要求：

- 旧 Sudowork 登录注册接口接 Moss `AuthService`。
- 企业映射为 Moss organization。
- 邀请码按 Moss organization 隔离。
- 用户返回字段兼容旧客户端。
- 客户端 system config 保持旧字段兼容。
- CAS / 第三方登录兼容旧协议。
- refresh token、验证码、限流行为兼容旧客户端预期。

用户注册或创建时必须保证：

- 创建 Moss 用户。
- 建立组织关系。
- 创建或复用 SudoRouter 用户。
- 获取并保存 SudoRouter token / api key。
- 发放初始额度，且幂等。
- 返回旧 Sudowork 客户端需要的字段。

## 7. agent / skill / catalog 兼容

提取并适配：

- `catalogService.ts`
- 相关 legacy routes。

实现要求：

- Sudowork 客户端获取专属智能体、技能、SkillHub/SudoHub 数据时不改接口。
- 内部接 Moss 当前 agent / skill / hub 能力。
- 支持组织隔离。
- 支持本地模式客户端配置下发。
- 支持企业模式继续走 Moss 云端执行能力。

## 8. 支付兼容策略

dev 已经有支付实现：

- `src/server/credits/fuiou.ts`
- `src/server/credits/recharge.ts`
- 充值订单、退款、同步、人工对账、支付运营页。

本 PR 不搬完整迁移分支中的 `src/server/billing/*` 作为第二套支付域。

本 PR 只补：

- 旧 Sudowork 支付/充值 API path 兼容。
- 旧响应字段兼容。
- 管理端运营入口与现有支付页整合。

旧接口内部调用 dev 当前支付实现：

- 创建订单。
- 查询订单。
- 处理富友回调。
- 同步订单。
- 退款。
- 人工对账。

必须继续保留支付安全语义：

- `SYNC_FAILED`：网关明确拒绝，允许安全重试。
- `SYNC_UNKNOWN`：网关无回音，禁止自动重试，进入人工对账。
- `SYNC_INVALID`：金额不一致等不可重试异常。
- 支付回调、手动同步、模拟支付都必须走同一个幂等结算入口。

## 9. Dify 集成

提取并适配：

- `src/server/dify/*`
- `difyRoutes.ts`
- `difyAdministrationRoutes.ts`
- `difyDatasetRoutes.ts`
- `admin/lib/api/dify-datasets.ts`
- `admin/src/pages/dify-datasets-page.tsx`

实现要求：

- 支持 Sudowork 旧 Dify 接口。
- 支持 Moss admin 管理 Dify 数据集 / 应用。
- Dify base URL、SSO secret、system secret、system token 等敏感配置进入服务器凭据或系统配置。
- 不向客户端下发 Dify 密钥。
- Dify 数据按 Moss organization 隔离。

## 10. QMS / Telemetry / Crash

提取并适配：

- `src/server/qms/*`
- `qmsRoutes.ts`
- `legacyUsageRoutes.ts`
- `legacyUsageService.ts`
- `admin/src/pages/operations-quality-page.tsx`
- `scripts/migrate-sudowork-p5-qms.ts`

实现要求：

- 兼容 Sudowork 客户端 telemetry / crash / performance 上报。
- 支持旧 `X-API-Key` 或配置中的 QMS API key。
- 支持 Redis queue。
- 支持 PostgreSQL / TimescaleDB 写入。
- 支持可选 hybrid-v1 解密。
- 支持 retention / cleanup。
- 支持 QMS 后台任务租约，避免多实例重复消费。
- Moss admin 提供质量监控页面。

## 11. Moss admin 前端入口

新增或恢复：

- `admin/lib/api/operations-core.ts`
- `admin/lib/api/operations.ts`
- `admin/src/operations-navigation.ts`
- `admin/src/operations-dashboard.ts`
- `admin/src/user-operations.ts`
- `admin/src/qms-operations.ts`
- `admin/src/sudowork-settings.ts`
- `admin/src/components/user-operations-dialogs.tsx`
- `admin/src/pages/operations-audit-page.tsx`
- `admin/src/pages/operations-invitations-page.tsx`
- `admin/src/pages/operations-quality-page.tsx`
- `admin/src/pages/sudowork-settings-page.tsx`
- `admin/src/pages/dify-datasets-page.tsx`

导航要求：

- 在 Moss admin 左侧导航补齐运营中心入口。
- 页面名称建议：
  - 运营总览
  - 用户运营
  - 邀请码管理
  - 计费运营
  - 质量监控
  - 操作审计
  - Sudowork 设置
  - Dify 数据集

组织隔离要求：

- 所有运营数据必须按当前组织过滤。
- 左上角切换组织后，邀请码、用户、订单、QMS、Dify 数据必须随组织变化。
- super admin 可以跨组织查看或切换，普通管理员只能看本组织。

页面要求：

- 不做营销页。
- 不做旧后台复制粘贴式孤岛。
- 使用 Moss 当前 admin 组件、权限、API client、错误提示模式。
- 支付页复用 dev 已有 `/operations/billing` 能力，不直接覆盖。

## 12. 配置入口

敏感配置放在服务器凭据或 Nexus-backed config：

- SudoRouter admin token。
- 富友商户私钥 / 富友公钥。
- SMS secret id / secret key。
- Dify SSO secret / system secret / system token。
- SkillHub / SudoHub token。
- QMS API key / telemetry private key。

非敏感配置放在 Sudowork 设置页：

- 登录方式。
- 客户端配置下发策略。
- CAS Provider。
- 自动模型策略。
- 充值模式。
- 积分申请最小 / 最大值。
- 是否允许重复待审批申请。
- QMS 开关。
- Dify 开关。
- 客户端版本更新策略。
- 日志 / 遥测上报开关。

## 13. 数据迁移

提取并适配：

- `src/server/migration/*`
- `scripts/migrate-sudowork-p5-qms.ts`

迁移要求：

- 读取旧 Sudowork-server 数据。
- 写入 Moss 当前表结构。
- 迁移企业到 Moss organization。
- 迁移用户、邀请码、配置、agent/skill 关系、QMS、Dify。
- 充值/支付数据按 dev 当前支付模型落库。

迁移模式必须：

- 禁止触发在线 Outbox 副作用。
- 禁止发送欢迎短信、通知、回调。
- 禁止重复给 SudoRouter 加额。
- 生成迁移报告。
- 支持 dry run。
- 支持幂等重跑。

## 14. 合同与校验

新增或恢复：

- `contracts/sudowork/routes.json`
- `contracts/sudowork/billing-api.json`
- `contracts/sudowork/dify-api.json`
- `contracts/sudowork/hub-client-api.json`
- `contracts/sudowork/qms-api.json`
- `contracts/sudowork/supported-clients.json`
- `contracts/sudowork/supported-clients.schema.json`
- `scripts/contracts/*`

校验内容：

- 旧 Sudowork routes 是否都有 Moss 实现。
- 关键响应字段是否保持兼容。
- 支付接口是否接到 dev 当前支付服务。
- QMS / Dify / hub-client 合同是否覆盖。
- 支持的客户端版本是否明确。

合同校验可以分两阶段：

1. PR 初期：生成缺口报告，允许未完成项。
2. PR 完成：关键客户端路径必须通过。

## 15. 不纳入本 PR 的内容

不搬完整迁移分支中的整套 `src/server/billing/*` 作为新支付域。

不搬旧部署方案中的大规模 k3s/nginx/compose 改动，除非是当前 dev 运行必须项。

不修改 Sudowork 客户端。

不引入新的独立 Sudowork-server 服务进程。

## 16. 提交组织

虽然是一个 PR，但建议按以下 commit 切分：

1. `feat(sudowork): add compatibility contracts`
2. `feat(sudowork): mount compatibility route shell`
3. `feat(sudowork): adapt identity and client config`
4. `feat(sudowork): adapt catalog and operational APIs`
5. `feat(sudowork): add admin operations surfaces`
6. `feat(sudowork): integrate Dify compatibility`
7. `feat(sudowork): integrate QMS telemetry`
8. `feat(sudowork): add migration tooling`
9. `test(sudowork): validate compatibility contracts`

## 17. 验证标准

每个阶段至少跑：

```bash
bun run test
bun run typecheck
bun run build:node
```

新增专项验证：

```bash
bun test scripts/contracts/*.test.ts
bun test admin/src/*operations*.node-test.ts
bun test src/server/api/compat/sudowork/*.node-test.ts
bun test src/server/dify/*.node-test.ts
bun test src/server/qms/*.node-test.ts
```

最终验收：

- Sudowork 客户端使用旧域名和旧接口可以登录。
- 老用户可以登录。
- 新用户可以通过邀请码注册。
- 注册时创建 Moss 用户、组织关系、SudoRouter 账号、token/api key。
- 客户端可以查询模型、余额、用量。
- 本地模式任务仍由客户端执行，Moss 只下发配置。
- 云端 / 企业模式仍走 Moss 当前云端执行能力。
- Moss admin 可以完成旧 Sudowork 后台主要操作。
- 组织切换后所有运营数据正确过滤。
- 支付使用 dev 当前支付实现，不维护第二套支付域。
- Dify / QMS 功能可通过旧客户端接口和 Moss admin 验证。
- 迁移工具支持 dry run、幂等重跑、报告输出。

## 18. 风险与控制

风险 1：旧完整迁移分支落后 dev，直接 merge 会回退新能力。

控制：只从旧分支提取缺失模块，基于最新 `origin/dev` 新建分支实现。

风险 2：支付域重复。

控制：不搬 `src/server/billing/*` 作为第二套支付系统，旧接口 adapter 接 dev 当前 `credits/recharge`。

风险 3：客户端兼容不完整。

控制：引入 `contracts/sudowork/*` 和 route inventory，合同校验覆盖旧客户端关键路径。

风险 4：组织隔离遗漏。

控制：所有 admin API 和页面必须带 org scope 测试，重点覆盖邀请码、订单、QMS、Dify。

风险 5：迁移触发副作用。

控制：迁移模式禁用在线 Outbox 副作用，SudoRouter 加额必须幂等，QMS 后台任务在迁移阶段不启动。

## 19. 开工步骤

1. 确认当前主目录无未提交改动。
2. 拉取最新 `origin/dev`。
3. 新建分支：

```bash
git checkout dev
git pull origin dev
git checkout -b codex/sudowork-compat-gap-port
```

4. 从 `origin/codex/sudowork-moss-consolidation` 按模块提取文件。
5. 逐模块适配最新 dev。
6. 每完成一个模块跑对应测试。
7. 全部完成后跑完整验证。
8. 提交并创建一个完整 PR 到 `dev`。
