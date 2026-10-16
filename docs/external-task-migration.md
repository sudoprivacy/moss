# 外部 Pilot 任务持久化迁移维护流程

适用：从 `external_pilot_sessions/tasks/attempts/events` 升级到 canonical Task/Session/Attempt/Event。此切换不支持新旧 writer 混跑，不能以滚动发布执行。

## 常规启动

- 无旧 Pilot 任务表的新库：事务初始化 canonical schema，无数据复制、删除或旧表封禁。
- 已完成 `canonical-v1` 的库：直接使用既有 canonical 数据，不重复迁移。
- 存在任意旧 Pilot 任务表且无完成标记的库（包括空表）：初始化拒绝，报 `EXTERNAL_TASK_MIGRATION_REQUIRED`。Moss 的 HTTP 启动 ready promise 拒绝，管理/API 和 callback 端口不会开始监听。旧表数据及写入能力保留。

不要手工补 `completed=1` 或以清空旧表绕过门禁。应用发布与数据库迁移是两个操作。

## 执行前

1. 在入口暂停新任务，停止所有连接该库的旧版及新版 Moss 实例、后台 writer 和运维脚本。关闭自动重启、扩容和发布控制器的重新拉起；直到核验结束保持数据库访问隔离。
2. 记录部署清单、实例数为 0、数据库连接清单、待完成/unknown 任务与远端 provider run。停止 Moss 不代表取消 Dify/HTTP 远端执行。
3. 使用目标新版源码及已安装依赖，在数据库维护主机执行下列命令。确认实际数据库路径/地址；不对线上数据库运行测试夹具。备份目录须提前建立并受限访问，路径必须为新文件。

SQLite（单机，Linux/macOS；需要 `lsof`、支持 `node:sqlite.backup` 的 Node 22.21+/24 和 `tsx`）：

```sh
node --import tsx scripts/migrate-external-tasks.ts \
  --sqlite /absolute/path/moss.db \
  --backup /protected/backups/moss-before-canonical.sqlite \
  --confirm-old-writers-stopped
```

PostgreSQL（需要匹配数据库主版本的 `pg_dump`、`pg_restore`；连接 URL 使用受保护的 `MOSS_MIGRATION_DATABASE_URL` 环境变量，不在命令行或报告贴凭据）：

```sh
node --import tsx scripts/migrate-external-tasks.ts \
  --postgres \
  --backup /protected/backups/moss-before-canonical.dump \
  --confirm-old-writers-stopped
```

命令检查 SQLite 文件是否被其他进程打开，或 PostgreSQL 是否还有其他 client session（包括 idle）；有则拒绝。这些是额外的观测检查，不能保证检查后没有旧进程重新连接，所以第 1 步的部署停写和访问隔离必须由运维保持；确认参数是操作者对这一事实的明确声明，不是自动证明。SQLite 的进程检查要求在持有本地卷的主机上执行；Windows/共享卷不支持此维护命令，不能跳过检查直接切换。

## 备份、迁移和核验

命令先生成完整备份，SQLite 用在线备份 API 保存 WAL 中已提交内容并执行 integrity_check，PostgreSQL 用 pg_dump custom archive 并核验 archive 目录。备份权限为 0600，既有文件不覆盖。计算 SHA-256 并创建 `<backup>.receipt.json` 后才开始切换。PostgreSQL archive 目录校验不等于恢复演练；生产升级前还应在隔离数据库演练恢复。

迁移使用单一事务及数据库锁，保留 Session/Task/Attempt ID、幂等请求 key/hash、原始 checkpoint、checkpoint 后增量事件、会话上下文和人工核对记录。逐项校验任务、会话、尝试和事件后，才清理四张旧任务表的 payload、安装拒绝旧写入的 trigger 并设置完成标记。任何复制/校验失败，事务回滚，旧 writer 仍可用；继续保持维护状态排查。

成功时 receipt 的 `completed=true`，包含备份摘要和完成时间；重复执行已完成迁移不会复制或删除数据。若命令中断或 receipt 未标记成功，不应假定迁移失败或重放远端任务：先核对数据库完成标记及日志。事务可能已提交但 receipt 最后写入尚未完成。

4. 核对 receipt、备份摘要及 `SELECT completed FROM federation_task_migrations WHERE id='canonical-v1'`。在仍未放流的状态启动新版，检查 readyz、外部任务历史/事件、unknown 会话及远端 run 的对应关系。
5. 确认旧部署不会重启后再恢复新流量。对于只存在旧批准 binding、尚无 Version 的智能体，管理员显式“审核发布”生成版本和 stable；版本列表 GET 和用户提交任务均不会代为发布。

## 回退

只允许在新流量尚未进入、全部新 writer 已停止的维护窗口内恢复完整备份，并以旧版本重启。禁止只解除旧表 trigger 或把旧镜像接到迁移后的库。若切换后已有新任务，不能直接恢复旧快照：需先保存并核对新 Task/Attempt、幂等记录与远端运行事实，制定专门恢复方案，避免丢数据或重复执行。
