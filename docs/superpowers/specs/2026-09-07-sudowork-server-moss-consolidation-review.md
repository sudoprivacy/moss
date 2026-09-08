# Spec 评审意见：Sudowork Server 能力整合到 Moss

评审对象：[2026-09-07-sudowork-server-moss-consolidation-design.md](./2026-09-07-sudowork-server-moss-consolidation-design.md)
评审日期：2026-09-07（v2，已修订初版两处事实误判）
评审基线：Moss `bc3125a`、sudowork-server `311636c`（与 spec §2 一致，已抽查源码核实）

## 0. 总体结论

方案**整体成立**，架构方向稳健，对两个仓库现状的描述经抽查基本属实。**不需要推翻重做**，需要的是补强"实现决策"与"验收门禁"。

> **初版勘误**：本评审 v1 曾提出两条"[阻塞]"判断，经代码复核**均为误判**，已在下文纠正——
> 1. "Moss 是两个 SQLite 文件、跨库无法单事务" → 错。AuthCenter 与主 Store **共享同一个 `DatabaseSync` 连接**。真实风险是事务边界，而非跨库。
> 2. "crash 路由 15 条、应改为 217" → 错。crash 实为 **14 条**，spec 的 216 统计正确，无需修改。

意见分级：**[决策]** 需在开工前拍板的实现方向 / **[门禁]** 应纳入验收/合并门禁 / **[事实]** 事实订正与证据补充。

---

## 1. [事实纠正] Moss 共享单一 DB 连接，风险是事务边界而非跨库

**初版误判**：曾认为 `organizations`/`users`（authCenter 模块）与 `tenant_assistants`/`billing`（主库）分属两个 SQLite 文件，无法保证 §6.6 的单事务原子性。

**实际代码**：二者是不同业务模块，但**共享同一个数据库连接**：
- `moss/src/server/startStandaloneServer.ts:84` — `openDirectConnectStore(config)` 创建统一 store
- `moss/src/server/startStandaloneServer.ts:100` — 把同一个 `store.db` 传给 `createAuthService`
- `moss/src/server/auth/service.ts:185` — `new AuthCenterDb(options.db, ...)` 接收该连接
- `moss/src/server/authCenter/db.ts:189-192` — else 分支复用传入的 `DatabaseSync`（`#ownsConnection = false`），不新开文件

**因此**：单事务原子性在物理上**可实现**，spec §6.6 / §8.2 的硬约束成立。

**仍存在的真实风险**：多个模块各自 `BEGIN`/`COMMIT` 时，可能出现嵌套事务或提前提交，破坏"用户 + 数字别名 + 钱包初始化在同一事务内完成"。

**建议采纳**：
- 引入统一 **UnitOfWork**，让跨模块的写操作在同一事务边界内提交/回滚。
- 配套**事务集成测试**（验证嵌套/回滚正确性），而非验证"是否存在两个数据库"。

## 2. [决策] 旧接口明确用 Hono 承载，作为 Adapter 内部实现

**属实的部分**：Moss 原生接口用 `node:http`（`moss/src/server/server.ts:1887`，无 hono 依赖），sudowork-server 用 Hono（`sudowork-server/src/index.ts:54`）。

**修正定位**：此差异**不否定** `SudoworkHttpAdapter`——Adapter 是边界设计，不绑定具体框架。初版把它拔高为"阻塞前提错误"不准确，实为一项待拍板的实现决策。

**建议正式确定**：
- Moss 原生接口继续使用现有 `node:http`。
- Sudowork 兼容接口在 Adapter 内使用 **Hono**。
- **Hono 必须成为 Moss 的直接依赖**（写入 `package.json` dependencies），不能依赖锁文件里的间接依赖。
- Hono 路由**只能调用 Moss 统一领域服务**，不保留任何 sudowork 业务实现（与 spec §6.2 禁止职责一致）。
- 开工前做一个小型验证 PoC，覆盖：Host 分流、请求体只读取一次、multipart、SSE、客户端断开、CORS、以及**原 Moss 接口不受影响**。

## 3. [门禁] 契约测试必须成为每个领域的合并门禁

**认可**：spec §12 已诚实拆为 9 个独立项目，且提出"兼容接口随领域同步实现，不最后一次性复制路由"。

**强化为强制门禁**：不能等全部开发完成才做全量差异测试。每迁移一个领域，合并前必须同时提交：
- 旧接口请求样本；
- 响应、状态码、Header 基线；
- 新旧服务差异测试；
- SSE / 上传 / 重定向等传输测试；
- 支付、积分等副作用幂等测试。

未通过契约测试的领域**不允许合并**。建议在 spec §13.3 增加对应的领域级门禁条目，而非只在总发布前校验。

## 4. [决策] 迁移工具用 Node 运行，不用 Bun

生产 Moss 是 **Node 运行时**（`bin/moss-server.mjs`，构建走 `--target=node`，Dockerfile 跑 `build:node`）；Bun 的 `node:sqlite` 问题仅是测试运行器问题，不影响生产。

**建议**：spec §11.1 的
```
bun run migrate:sudowork -- --dry-run
```
改为编译后的 Node CLI：
```
node bin/migrate-sudowork.mjs --dry-run
node bin/migrate-sudowork.mjs --execute
node bin/migrate-sudowork.mjs --verify
```
源库可用 `better-sqlite3` **只读**读取，目标库必须通过 Moss 的 `node:sqlite` Repository 写入，**不能直接复制 sudowork 的 SQL**（方言/预处理 API 不同）。

## 5. [事实] 精确表名、crash 计数与企业单例证据

- **crash 路由 = 14 条**（`sudowork-server/src/qms/routes/crash.ts` 精确匹配 `crash.` 前缀共 14 个声明，`src/index.ts:106,109` 双挂载）。spec §2 的统计**正确**：Hono 声明 204 − 根页面 2 + crash 第二前缀 14 = **对外 216 个 method/path**。初版建议改 15/217 **作废**。
- **云端会话表名**应在 spec 中精确写为：`sessions`、`session_attempts`、`session_events`（`moss/src/server/db.ts:148,177,208`）。
- **企业单例证据**：Moss 当前企业配置确为 `id='default'` 单例（`moss/src/server/db.ts:1920` `SELECT * FROM enterprises WHERE id = 'default'`）。spec §7.5 的"单行配置无法代表多组织"判断成立，建议在 spec 中补上该代码引用。

## 6. [认可] 已想清楚的部分

- 数据所有权（§5.2）、已确认取舍（§16）、回滚观察期覆盖"一个完整支付对账周期 + 定时任务周期"（§14.3）。
- 拒绝迁移不安全默认值（§4/§9/§15）经核实确有其物：默认 JWT secret `"sudowork-secret-key"`、`DEBUG_SKIP_VERIFY_CODE`、默认 Postgres `postgres/postgres`、QMS `defaultApiKey`、硬编码 Sudorouter 默认值——约束必要且正确。
- diff/影子测试对副作用（SMS/支付/退款/Dify 写入）要求 Fake Adapter 不重复执行（§13.1）。

---

## 7. 建议调整后的实施顺序

1. 冻结所有受支持客户端版本和旧接口契约。
2. 完成 Hono 与 Moss 原生 HTTP Server 的挂载验证 PoC（第 2 条）。
3. 完成共享连接的事务边界测试 / UnitOfWork 设计（第 1 条）。
4. 建立逐领域契约测试门禁（第 3 条）。
5. 再进入统一用户、组织、钱包、Agent、Skill、任务和渠道的正式开发。
6. 最后执行数据迁移演练、停机迁移和域名切换（Node CLI，第 4 条）。

**总体判断**：评审 v1 指出了真实的工程缺口（HTTP 框架决策、Node CLI、逐领域门禁、事务边界），这些应纳入方案；但"两个数据库文件"和"15 条 crash 路由"属误判，已在 v2 纠正。方案无需推翻，按上述顺序补强实现决策与门禁即可推进。
