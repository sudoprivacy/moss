# Sudowork Server 迁移到 Moss 切换与回滚手册

## 1. 适用范围

本手册用于在维护窗口内，将旧 Sudowork Server 的服务端数据一次性迁移到 Moss 统一领域模型，并把原 Sudowork 域名切换到 Moss 兼容接口。

- Sudowork 客户端不修改；升级前继续访问旧服务，切换后由原域名访问 Moss。
- 本地任务仍由 Sudowork 客户端执行，不迁移本地 Session、本地 Cron、本地 Channel。
- 企业模式继续由 Moss 云端执行，统一使用 Moss 的组织、用户、Agent、Skill、配置、计费、QMS 和自动化领域。
- 不建立长期双写，不在 Moss 中维护第二套 Sudowork 业务模型。

## 2. 角色与四眼原则

| 角色 | 职责 |
| --- | --- |
| 发布负责人 | 决定开始、继续、回滚，记录时间点 |
| 数据负责人 | 生成冻结快照、执行迁移、核对报告 |
| 业务验收人 | 验证登录、本地模式、企业模式、计费与管理端 |
| 基础设施负责人 | DNS/网关、Redis、PostgreSQL/TimescaleDB、Nexus、备份恢复 |

执行、放行和外部副作用 redelivery 至少由两人复核。密钥、Token、数据库 URL 不得写入配置文件、报告或工单正文。

## 3. T-7 天至 T-1 天演练

1. 从生产备份恢复两份相互独立的代表性副本，源 SQLite 与文件目录只读挂载。
2. 分别执行完整 `dry-run -> execute -> verify`；两次报告的源指纹、领域计数、财务结果必须一致。
3. 使用受支持的正式 Sudowork 客户端版本验证：旧密码登录、Refresh Token、邀请码、Agent/Skill 下载、上传、SSE、Dify、本地模式和企业云端会话。
4. 验证 QMS 时间范围、行数和校验值；验证 Redis 有效 TTL 数据；验证 Nexus 密钥仅能读取，响应和日志中没有明文。
5. 使用真实 Fuiou 脱敏验签样本验证回调幂等，不发起真实扣款或退款。
6. 完成一次开放写入前回滚演练和一次开放写入后回滚/replay 演练。

任一结果不一致、财务差异非零、可投递迁移 Outbox 非零，或正式客户端矩阵仍有失败，均禁止安排切流。

## 4. 配置与快照

迁移入口仅允许以下命令，必须使用 Node.js：

```bash
node bin/migrate-sudowork.mjs --config /absolute/path/migration.json --dry-run
node bin/migrate-sudowork.mjs --config /absolute/path/migration.json --execute
node bin/migrate-sudowork.mjs --config /absolute/path/migration.json --resume <migration_run_id>
node bin/migrate-sudowork.mjs --config /absolute/path/migration.json --verify <migration_run_id>
```

配置文件只保存环境变量名称，不保存秘密。示例：

```json
{
  "version": 1,
  "source": {
    "snapshotDir": "/srv/migration/sudowork-frozen",
    "redisUrlEnv": "SUDOWORK_SOURCE_REDIS_URL",
    "qmsPostgresUrlEnv": "SUDOWORK_SOURCE_QMS_URL",
    "legacyJwtSecretEnv": "SUDOWORK_SOURCE_JWT_SECRET",
    "fileAllowlist": ["uploads", "hub-export.json"]
  },
  "target": {
    "mossDbPath": "/srv/moss/data/moss.sqlite",
    "runtimeDir": "/srv/moss/runtime",
    "publicBaseUrl": "https://sudowork.example.com",
    "redisUrlEnv": "MOSS_REDIS_URL",
    "qmsPostgresUrlEnv": "MOSS_QMS_URL",
    "legacyJwtSecretEnv": "MOSS_LEGACY_JWT_SECRET",
    "nexusEndpoint": "https://nexus.internal.example.com",
    "nexusAuthTokenEnv": "MOSS_NEXUS_TOKEN",
    "loginMethod": "password",
    "skillhubBaseUrl": "https://skillhub.example.com",
    "sudorouterBaseUrl": "https://router.example.com",
    "smsConfigured": true
  },
  "migration": {
    "platformCatalogOrgId": "platform",
    "platformConfigOrgId": "platform",
    "qmsBatchSize": 500,
    "defaultInitialQuotaEnv": "SUDOWORK_INITIAL_QUOTA",
    "identityResolutions": [],
    "governanceResolutions": {}
  },
  "reportsDir": "/srv/migration/reports"
}
```

快照必须包含 SQLite、白名单文件、Redis 有效访问态和 QMS 数据，且执行期间保持同一指纹。SQLite/文件目录权限设为只读；Redis 与 QMS 源账号只授予读取权限。TTL 数据应在停止旧服务后尽快迁移，避免因自然过期造成指纹变化。

## 5. 切换前检查

- 旧 Sudowork Server、Moss 和全部依赖健康；时钟同步。
- Moss 目标 SQLite、Redis、Nexus、PostgreSQL/TimescaleDB 已备份并完成恢复抽查。
- 原 Sudowork 域名证书已部署到 Moss 网关；DNS TTL 已提前降低。
- Moss 兼容路由 216/216、云端 Session 回归、正式客户端矩阵全部通过。
- 确认迁移配置中的旧 JWT 密钥与 Moss 兼容密钥指纹一致。
- 确认不存在处理中的支付、退款、积分审批和 QMS 批次。
- 确认只有一个发布负责人可以启动后台任务。

## 6. 维护窗口执行

1. 公告维护开始，拒绝旧服务的新登录和业务写入。
2. 停止旧 Sudowork Server 的定时任务、队列消费者、支付处理、通知与所有外部副作用执行器。
3. 停止 Moss 后台任务和外部副作用执行器；Moss 兼容入口保持不可写、不可对公网访问。
4. 等待在途请求清零，记录旧库、Redis、QMS 与文件的冻结时间。
5. 生成并校验完整备份，建立只读冻结快照。
6. 执行 `--dry-run`。有任何 blocker 时停止，不得执行迁移。
7. 执行 `--execute`，立即记录输出的 `migration_run_id`。命令中断时只允许用同一快照执行 `--resume <id>`，不得重新 `--execute` 代替恢复。
8. 执行 `--verify <id>`。JSON 与中文 Markdown 报告归档；财务差异、引用差异、QMS 差异必须为零，迁移来源可投递 Outbox 必须为零。
9. 在后台任务仍关闭时执行只读烟测：历史用户和新 Moss 用户登录、Refresh Token、邀请码、Agent/Skill、配置、上传、Dify、QMS、本地模式、企业云端会话。
10. 将原 Sudowork 域名切到 Moss 兼容接口，确认 Host、TLS、代理超时、SSE、上传大小、302 和静态资源行为。
11. 先开放登录和只读流量，再开放业务写入；确认错误率与延迟稳定后，只启动一份 Moss 后台任务及 Outbox 执行器。
12. 观察支付、积分、Dify、Sudorouter、QMS、Cron、Trigger、Channel 和云端 Session 指标。旧服务保持停止和只读，不删除数据。

## 7. 放行标准

以下条件必须同时满足：

- 源指纹与执行批次一致，十个迁移阶段和十项最终校验均为 `matched`。
- 组织、用户、数字别名和引用完整；钱包可由账本重建，差异为零。
- Catalog 制品、配置、Nexus 引用、上传文件与 QMS 范围校验通过。
- 历史 JWT/Refresh Token/登录抽样通过，迁移及 replay 没有可投递外部副作用。
- Moss 云端 Session 创建、执行、断线恢复和组织隔离无回退。
- 旧接口状态码、字段、错误文案及流式/文件传输行为通过正式客户端验证。

## 8. 回滚决策

### 8.1 Moss 开放业务写入前

1. 保持原域名或网关指向旧服务。
2. 停止 Moss 迁移进程与后台任务。
3. 从切换前备份恢复 Moss SQLite、Redis、Nexus、QMS 和文件目录，或丢弃本次全新目标环境。
4. 恢复旧 Sudowork Server 及其单实例后台任务。
5. 记录失败批次和报告，修复后必须重新生成冻结快照并从 `dry-run` 开始。

此阶段旧服务没有遗漏的新写入，不需要 replay。

### 8.2 Moss 已开放业务写入后

不得直接把域名切回旧服务，否则会丢失 Moss 新写入。执行顺序：

1. 立即重新进入维护模式，同时停止 Moss 和旧服务写入及所有后台任务。
2. 冻结并备份 Moss 当前状态，导出切换后的 append-only change log。
3. 评估变更能否由已验证的 replay 命令安全回放到旧服务；不能安全回放时继续修复 Moss，不得强制回切。
4. replay 固定使用原事件 ID 和稳定幂等键，默认 `suppress_external`；先完成内部状态对账。
5. 确需重新发送短信、支付回调、Dify/Sudorouter 等外部动作时，逐项进入 redelivery 白名单，由两人审批；已成功动作不得再次投递。
6. replay 后重新核对身份、财务、订单、QMS 和外部副作用审计，全部通过后才允许恢复旧服务流量。

## 9. 观察与收尾

切换后至少观察 24 小时，并在 15 分钟、1 小时、4 小时、24 小时保存指标快照：

- 兼容接口 4xx/5xx、P95/P99、SSE 中断率、上传失败率；
- 登录和 Token 刷新失败率；
- 云端 Session 排队、执行、断线恢复和租约冲突；
- 钱包/账本差异、支付回调重复、待处理 Outbox；
- Dify、Sudorouter、Nexus、QMS、Cron、Trigger、Channel 错误率。

观察期结束后仍保留旧数据只读备份和不可变报告，按数据保留策略审批后再下线旧基础设施。禁止在观察期内删除旧服务数据或复用旧 Redis/QMS 名称。

## 10. 尚未由本地开发关闭的门禁

- 两次代表性生产副本迁移结果一致；
- 真实 Redis、Nexus、PostgreSQL/TimescaleDB 连通与权限验证；
- 正式客户端版本矩阵；
- Fuiou 真实脱敏验签样本；
- 完整开放写入前/后回滚演练。

这些项目必须由实际环境验证，不能用单元测试或本地 fixture 替代。
