# Sudowork 质量管理接入 Moss

质量管理位于 Moss「运营中心 → 质量管理」，包含总览、会话质量、安装统计、性能、用户统计、Crash、告警和配置。本次只接收切换后的新数据，不导入 sudowork-server 历史数据。

## 存储与队列

- **数据库**：复用 Moss 现有 PostgreSQL 和 `DbDriver`，共用 `MOSS_DATABASE_URL` 对应的连接池。QMS 不创建或关闭自己的数据库连接池。
- **表隔离**：优先复用同一数据库中已存在的 `moss_qms` schema；有权限时可自动创建。普通 Moss 账号没有建 schema 权限时，自动在主业务 schema 中创建 `moss_qms_*` 前缀表，仅使用 Moss 现有的建表权限。重启保持原存储位置。查询使用明确的 schema 限定，不改变主连接的 `search_path`，不读写其他模块的同名表。QMS 数据库操作默认最多并发 2 个，事务中的操作复用同一连接。
- **队列**：遥测使用每个 Moss 实例内的有界 FIFO 内存队列。无 Redis、数据库收件表或本地持久化队列。
- **去重**：事件真正写库时，在同一事务中保存已处理事件 ID 和业务记录。`qms_ingest_receipts` 是已写入事件的去重元数据，没有待处理 payload，不承担队列或收件箱功能。
- **统计**：使用普通 PostgreSQL 表和后台聚合、清理任务，不安装或依赖 TimescaleDB。
- **凭据**：继续使用 Moss 的 Nexus / ConfigStore，保存 API Key 和通知凭据。

每个实例独立消费自己的内存队列；只有共享的聚合、清理、告警任务使用数据库租约。内存队列统计表示当前请求落到的实例，不是整个集群的队列总数。

## 配置

Moss 已使用 PostgreSQL 后端时，只需更新代码镜像：继续使用现有 PostgreSQL（兼容 14+）、Nexus、环境变量和数据卷。旧配置没有 QMS 段时会自动启用质量服务、建表和初始化凭据；不用新增环境变量或手工执行 SQL。显式 `qms.enabled: false` 或 `QMS_ENABLED=false` 继续表示关闭。SQLite 部署默认不启用 QMS，其他功能保持原状。

以下是可选的调优配置，不是升级前置要求：

```json
{
  "qms": {
    "enabled": true,
    "apiKeyHeader": "X-API-Key",
    "queueFlushIntervalMs": 3000,
    "queueBatchSize": 50,
    "queueMaxItems": 10000,
    "queueMaxBytes": 16777216,
    "queueRetryIntervalMs": 1000,
    "queueDrainTimeoutMs": 15000
  }
}
```

平台配置中的 QMS 分组沿用相同的共享存储与内存队列，仅配置服务开关、队列参数、API Key 和通知凭据。旧的平台 QMS 数据库、Redis 和加密配置会被忽略；已有配置无需人工迁移。后台生成的 API Key 会同步到未接管的配置快照，便于平台页面接管；接管后以平台保存值为准，旧环境变量不能覆盖它。

队列上限包含等待中和写入中的事件，同时限制事件数与 payload 字节数。超过容量时整批拒绝，返回 HTTP 503、`QUEUE_FULL` 和 `Retry-After`；不会为了接收新事件而删除旧事件。数据库写入失败后保留原批次，按退避间隔重试，最长重试间隔 30 秒。

启动时优先使用已配置的 QMS API Key 或原来下发给客户端的产品改进 API Key；均不存在时，在已有 Nexus 中自动生成并保存随机密钥。多实例通过现有 PostgreSQL 锁协调，重启复用同一密钥。无需新增部署 Secret。以下凭据入口保留给手动配置或轮换：

| Moss 服务器凭据 | 对应环境变量 | 用途 |
| --- | --- | --- |
| `server.qms-api-key` | `QMS_API_KEY` | 客户端上报鉴权 |

继续兼容 `QMS_ENABLED` 和旧 API Key 别名 `QMS_DEFAULT_API_KEY`。不再配置 `QMS_POSTGRES_URL`、`QMS_REDIS_URL` 或独立的 QMS 数据库凭据。

QMS 业务采集开关沿用现有组织策略，不会因自动初始化而擅自开启产品改进数据上报。Moss 主服务先监听端口并正常提供登录和业务接口，QMS 在后台异步初始化。未就绪或初始化失败时，仅质量接口返回带 `Retry-After` 的 503；初始化完成后自动启用这些接口。启用了质量上报的凭据请求会按需等待初始化，避免下发空 API Key。后台初始化最多 15 秒，建表事务使用局部 `lock_timeout=2s` / `statement_timeout=5s`，不修改共享连接的会话设置；超时后取消初始化，主服务继续运行。QMS 停止时先停止接受新遥测，等待正在执行的任务，再尝试在配置的等待时间内排空队列；数据库连接由 Moss 统一关闭。

**可靠性边界**：遥测上报成功及 `queued: true` 表示进入当前进程内存，不表示已经落库。进程崩溃、强制退出或停机排空超时可能丢失尚未写入的事件；客户端已收到成功响应的事件不会因此自动补报。停机超时会记录尚未写入的数量。Crash 沿用直接写入 PostgreSQL 的链路，不经过遥测内存队列。

## 客户端切换

1. 部署更新后的 Moss 和支持质量地址配置的 Sudowork 客户端。
2. 在「运营中心 → Sudowork 系统设置 → 客户端上报与更新」选择组织或平台范围。
3. 开启「产品改进数据」，将「质量上报地址」设为 Moss 根地址，例如 `https://agent.example.com`；同域部署可点击「使用当前 Moss 地址」。不要包含 `/admin` 或 `/api/v1`。
4. 保存后重新登录客户端，取得组织配置与上报凭据。
5. 在质量管理检查当天统计与 Crash；「配置」页可以查看当前实例内存队列容量和写入状态。

质量上报通过 `X-API-Key` 鉴权，消息正文直接使用 JSON，不再进行 RSA/AES 混合加解密，也不需要遥测公私钥。旧的 `encryptionRequired` / `QMS_TELEMETRY_ENCRYPTION_REQUIRED` 配置不再生效；服务端固定下发 `encryption_required: false` 以兼容旧客户端。HTTPS 传输加密以及 API Key 的凭据分发机制保持不变。

普通日志仍使用「日志域名」对应的 `/v1/logs/batch`；版本更新继续使用原资源域名。质量上报地址留空时沿用客户端当前服务端地址；显式的本地 `telemetry.serverUrl` 仍优先，需要切换这类客户端时应清除该覆盖。

统一登录后的质量上报不再区分个人/企业模式。客户端按每个任务保存的执行位置判断：仅本地任务上报会话、轮次、步骤、首 token 和关联异常；云端任务由云端执行，客户端不采集这些质量事件。首页当前选择本地还是云端，不影响其他任务的判断。离线事件保存采集时的执行位置，重试和质量日志副本同样过滤云端事件；找不到归属任务的任务事件不予上报。

安装、启动性能及未关联任务的客户端进程崩溃仍属于本机质量数据。服务端「产品改进数据」及客户端「系统设置 → 产品体验改进计划」开关继续生效；旧版本已经保存为关闭的用户选择不会被自动开启。统一登录及重启恢复会使用当前 Moss 登录凭据加载组织质量配置和加密凭据，无需修改 Moss 中间件。

| 用途 | 接口 |
| --- | --- |
| 五类遥测批量上报 | `POST /api/v1/telemetry/batch` |
| Crash 批量上报 | `POST /api/v1/crash/events/batch` |
| 管理查询与操作 | `/api/moss/v1/operations/qms/*` |
| 非敏感配置 | `GET /api/v1/system-config`，登录后携带 Bearer 获取组织策略 |
| 客户端凭据 | `GET /api/v1/system-config/credentials`，需要登录 |

旧单条上报及 Crash 别名保留。客户端上报直接访问 Moss 域名，其他旧协议接口的主机路由范围保持原状。组织管理员只读本组织数据；平台超级管理员可切换统计范围。

## 验证

```sh
node scripts/run-node-tests.js qms api/compat/sudowork
bun test admin/__tests__/quality.test.ts admin/tests/config-scope.test.ts \
  src/server/__tests__/publicSystemConfig.test.ts src/server/__tests__/credentialsEnvelope.test.ts
```

真实集成测试通过 `QMS_TEST_DATABASE_URL` 指定独立、可丢弃的 PostgreSQL 测试库。测试调用 Moss 实际的 `openStoreAsync`，在同一数据库中初始化 Moss 主表和隔离的 QMS 质量表，并检查正常模块的同名数据、连接池生命周期与查询范围不受影响。不需要 Redis 或 TimescaleDB 测试服务。

```sh
QMS_TEST_DATABASE_URL="$DISPOSABLE_MOSS_DATABASE_URL" \
  node scripts/run-node-tests.js qms/qmsInfrastructure.integration.node-test.ts
```

跨仓库客户端联调：使用同一个测试库变量，在 Moss 运行 `node node_modules/tsx/dist/cli.mjs scripts/test-qms-client-server.ts`。服务仅监听 `127.0.0.1:43139`，使用固定测试身份，不可用于生产部署。在 Sudowork 的 `apps/desktop` 中运行：

```sh
QMS_CLIENT_TEST_URL=http://127.0.0.1:43139 bunx vitest run tests/unit/qualityReporting.test.ts
bunx vitest run tests/unit/sudoLogTelemetryReporter.test.ts tests/unit/sudoworkLogUploader.test.ts
bunx vitest run tests/unit/localQualityReporting.test.ts tests/unit/acpConnectionResponseOrder.test.ts
```

## 仅替换代码镜像的升级检查

检查覆盖旧配置缺省 QMS 配置、PG 14、非超级用户且没有数据库 CREATE 权限、重复启动、重复统计聚合、自动 API Key 初始化和已有密钥复用。运行依赖继续来自既有 `deploy/runtime-deps.package.json`，没有增加 npm 依赖、中间件镜像、端口或数据卷要求。

升级演练应保持数据库、Nexus、配置文件和数据卷不变，只替换应用镜像；检查 `/healthz`、`/readyz`、原账号登录、原业务数据和质量管理接口。密钥与新增质量表属于应用运行数据，自动存入已有 PostgreSQL/Nexus。

2026-09-24 升级演练记录：使用生产 Node 22.22.1 和原有运行依赖清单，先运行仓库原版代码镜像，再替换为当前代码镜像。PostgreSQL 14.24、非超级用户账号（无数据库 CREATE 权限）、同一 Nexus 进程、配置文件及数据卷均保持不变，配置文件没有 QMS 段。

| 检查项 | 原代码镜像 | 更新代码镜像 |
| --- | --- | --- |
| `/healthz` | 200 | 200 |
| `/readyz` | 200 | 200 |
| 原 token 访问 `/api/v1/auth/me` | 200 | 200 |
| `/api/v1/users` | 200 | 200 |
| `/api/v1/sessions` | 200 | 200 |
| QMS health | 503（原默认未启用） | 200（自动初始化） |

随后验证了自动生成的凭据下发、五类遥测、Crash 及统计查询；再次重启新版容器后，上报密钥、质量数据、原用户和原 token 均保留。全过程没有修改部署 YAML、数据库权限、数据库版本、Nexus 版本、运行依赖清单或配置文件。演练使用隔离测试数据，没有修改线上环境。


### 2026-09-28 启动与升级复核

在 Linux Node 22.22.1 / PostgreSQL 14 上，使用非超级用户且没有数据库 CREATE 权限的应用账号，保持数据库、Nexus、配置、运行依赖和数据卷不变，先运行 HEAD 构建产物再替换为本地修改产物。验证旧账号、既有登录令牌及业务数据保留；QMS 无配置段、无新增环境变量时在后台自动初始化，并使用已有 schema 下的前缀表。

人为删除一个 QMS 测试索引并用长事务锁住对应表后，Moss 主服务仍正常就绪、登录仍可用，QMS 建表超时后仅质量接口返回 503。释放锁后再次启动，QMS 自动恢复。另用同一条 PostgreSQL 池连接验证，重复建表后原 `lock_timeout`、`statement_timeout` 和 `search_path` 均保持不变。没有变更部署文件、依赖清单或 Moss 主库迁移代码。
