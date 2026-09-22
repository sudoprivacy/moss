# 智能体与技能的组织隔离

公共 Hub 目录可以共享，安装关系保存在 `org_resource_installations`，按组织、资源类型、Hub 地址和上游 ID 唯一。磁盘上存在包不代表当前组织已安装。A 安装资源后，未安装的 B 仍显示零项；超管切到 B 也遵守这一规则。

专属和自定义资源保存在原有 tenant 表，分别标记为 `source_type=tenant/custom`。先要求 `org_id` 等于当前组织，再应用原有作者、用户和部门权限。`org_id IS NULL` 的历史资源默认不可见。兼容目录只有显式创建为 `source_type=catalog` 的条目保留公共/分配目录能力，私有资源的 `availability=all` 和旧分配记录不能跨过组织边界。

## 运行与配置

- HTTP 请求和后台同步任务通过 AsyncLocalStorage 固定经过认证的组织。没有进程级“当前组织”变量。
- 安装先验证、暂存并发布包，再写组织安装记录。升级只切换本组织的包引用；配置写入数据库覆盖项；卸载只移除本组织记录。资源名称仅作为组织内兼容查找，有歧义时要求使用 ID。
- 智能体依赖技能按当前组织判断是否安装，绑定保存稳定 ID。被本组织智能体引用的技能不能直接卸载；其他组织的引用不会阻止卸载。
- 下载合成本组织有效配置。专属资源审批只改变数据库状态，不再按名称复制、覆盖或删除共享目录。
- 会话首次运行固定资源版本、配置和技能选择。恢复时重新检查本组织可见性与启用状态，已撤销的资源不能借旧快照继续使用。Runner 只收到授权快照，不扫描全局包目录；无快照的旧 manifest 使用空资源集。
- Wiki 构建使用自身的固定提示词和空技能集，不伪造商店安装。

包仍可以集中复用，本改动不提供文件系统沙箱。无引用包暂不自动清理，避免破坏其他组织或活动会话。同步进度仍是进程内状态，已按组织分开；多实例持久化任务协调不在本次改动范围。

## 历史数据迁移

新版本不会把全局包自动登记给任何组织。上线前应备份数据库和资源目录，停止旧版本的资源写入，用以下步骤明确归属，再启用新版本流量。脚本只操作指定数据库和目录，默认 dry-run，不删除原始包。SQLite 和 PostgreSQL 都须先完成新版本 schema 初始化。

1. 导出文件清单：

   ```sh
   node --import tsx scripts/migrate-organization-resources.ts \
     --home /data/moss --inventory > resource-inventory.json
   ```

2. 核对清单，为要保留的资源创建 `resource-mapping.json`。不要直接应用含空归属的清单。示例：

   ```json
   [
     {
       "kind": "skill",
       "sourceType": "hub",
       "id": "upstream-skill-id",
       "orgId": "confirmed-org-id",
       "userId": "user-in-that-org",
       "path": "/data/moss/skills/hub/example",
       "provider": "https://configured-hub-base-url"
     }
   ]
   ```

   `kind` 为 `agent/skill`；`sourceType` 为 `hub/custom/tenant`。Hub 的 `provider` 必须与服务器配置的 Hub base URL 一致。自定义资源填写其确认的作者；专属资源填写已有数据库 ID，脚本不会凭空新建专属审批记录。预置文件如需出现在商店中，也须明确登记归属和稳定身份。未归属或没有元数据的资源应保留在原处人工核查。

   除文件清单外，还应核查数据库中 `org_id IS NULL`、`file_path IS NULL` 的 tenant 行：文件清单不能发现没有包文件的数据库记录。显式公共 Catalog 历史条目的分类需单独核对，不能将私有行批量改为公共。

3. 预检并审阅记录数与目标引用：

   ```sh
   node --import tsx scripts/migrate-organization-resources.ts \
     --home /data/moss --db /data/moss/moss.db --manifest resource-mapping.json
   ```

4. 对同一命令增加 `--apply` 执行。PostgreSQL 用 `--postgres` 替代 `--db ...`，连接字符串从 `MOSS_DATABASE_URL` 读取。

迁移验证组织和用户归属、资源身份及所有文件，冻结包副本后在事务中写入映射。重复执行不覆盖已有安装和配置；冲突归属直接报错。一个公共资源可以显式映射到多个组织，自定义或专属资源只能有一个所属组织。新组织不会自动继承历史安装。

## 验证入口

```sh
node --import tsx --test src/server/catalog/organizationResources.node-test.ts \
  src/server/catalog/organizationResourceRoutes.node-test.ts
bun test src/server/tenantAssistantRoutes.test.ts
npm test
npm run typecheck
npm run lint
bun run build:node
```

PostgreSQL 回归通过 `MOSS_PG_TEST_URL` 指向独立测试实例运行 `src/server/__tests__/pgBackend.test.ts`。该测试会创建和删除自己的临时数据库，不得将连接配置到业务数据库。
